/**
 * Thin Tauri bridge to an `omp --mode rpc-ui` child process.
 *
 * Rust owns spawning/stdout and its chunk reassembly; this client owns request
 * correlation, protocol negotiation and the ready/process lifecycle.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  ExtensionUIResponse,
  ProcessEvent,
  ProtocolEvent,
  ReadyFrame,
  RpcCommand,
  RpcFrame,
  RpcResponse,
  StartInfo,
  StartOptions,
} from "./types";

export type OmpClientEvent =
  | { type: "frame"; frame: RpcFrame }
  | { type: "ready"; ready: ReadyFrame; generation: number }
  | { type: "process"; event: ProcessEvent }
  | { type: "stderr"; line: string; generation: number }
  | { type: "protocol"; event: ProtocolEvent }
  | { type: "disconnected"; reason: string };

type NativeEvent =
  | { type: "frame"; frame: RpcFrame; generation: number }
  | { type: "process"; event: ProcessEvent }
  | { type: "stderr"; line: string; generation: number }
  | { type: "protocol"; event: ProtocolEvent };

export class RpcFailure extends Error {
  readonly command: string;
  readonly code?: string;
  constructor(message: string, command: string, code?: string) {
    super(message);
    this.name = "RpcFailure";
    this.command = command;
    this.code = code;
  }
}

type Pending = {
  command: string;
  resolve: (response: RpcResponse<unknown>) => void;
  reject: (error: Error) => void;
  timer?: number;
};

type Waiter = {
  resolve: (ready: ReadyFrame) => void;
  reject: (error: Error) => void;
  timer: number;
};

const READY_TIMEOUT_MS = 45_000;

export class OmpClient {
  private unlisteners: UnlistenFn[] = [];
  private listeners = new Set<EventListener>();
  private pending = new Map<string, Pending>();
  private earlyEvents: NativeEvent[] = [];
  private readyWaiters = new Map<number, Waiter>();
  private readyHandled = new Set<number>();
  private counter = 0;
  private binding: Promise<void> | undefined;
  private lifecycle: Promise<unknown> = Promise.resolve();
  private activeSeq = 0;
  private readyFailure: string | undefined;
  private starting = false;
  private startSeq = 0;

  generation: number | undefined;
  startInfo: StartInfo | undefined;
  ready: ReadyFrame | undefined;

  on(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: OmpClientEvent) {
    for (const listener of this.listeners) listener(event);
  }

  private async bind(): Promise<void> {
    this.binding ??= Promise.all([
      listen<{ generation: number; frame: RpcFrame }>("omp://frame", ({ payload }) => {
        this.receive({ type: "frame", ...payload });
      }),
      listen<ProcessEvent>("omp://process", ({ payload }) => {
        this.receive({ type: "process", event: payload });
      }),
      listen<{ generation: number; line: string }>("omp://stderr", ({ payload }) => {
        this.receive({ type: "stderr", ...payload });
      }),
      listen<ProtocolEvent>("omp://protocol", ({ payload }) => {
        this.receive({ type: "protocol", event: payload });
      }),
    ]).then((unlisteners) => {
      this.unlisteners = unlisteners;
    });
    await this.binding;
  }

  private receive(event: NativeEvent) {
    if (this.activeSeq !== this.startSeq) return;
    const generation = event.type === "process" || event.type === "protocol"
      ? event.event.generation
      : event.generation;
    // The invoke result is the only authority for ownership. Buffer during that
    // gap, then replay only this start's generation, never another client's.
    if (this.starting && this.generation === undefined) {
      this.earlyEvents.push(event);
      return;
    }
    if (generation === undefined || generation !== this.generation) return;
    if (event.type === "frame") {
      this.handleFrame(generation, event.frame);
      return;
    }
    this.emit(event);
    if (event.type === "process") {
      const payload = event.event;
      if (payload.kind === "eof" || payload.kind === "exit" || payload.kind === "error") {
        const reason =
          payload.kind === "eof"
            ? "The agent process ended. Stdin/stdout closed."
            : payload.kind === "exit"
              ? `The agent process exited ${payload.exitCode == null ? "unexpectedly" : `with code ${payload.exitCode}`}.`
              : payload.message ?? "The agent process failed.";
        this.readyFailure = reason;
        this.failPending(reason);
        this.emit({ type: "disconnected", reason });
      }
    }
  }

  private handleFrame(generation: number, frame: RpcFrame) {
    if (generation !== this.generation) return;
    if (frame.type === "ready") {
      const ready = frame as unknown as ReadyFrame;
      const waiter = this.readyWaiters.get(generation);
      if (waiter) {
        window.clearTimeout(waiter.timer);
        this.readyWaiters.delete(generation);
        this.ready = ready;
        waiter.resolve(ready);
      }
      if (generation === this.generation) this.adoptReady(generation, ready);
      return;
    }

    if (generation !== this.generation) return;

    if (frame.type === "response") {
      const response = frame as unknown as RpcResponse;
      if (response.id) {
        const pending = this.pending.get(response.id);
        if (pending) {
          this.pending.delete(response.id);
          window.clearTimeout(pending.timer);
          if (response.success) {
            pending.resolve(response);
          } else {
            pending.reject(new RpcFailure(response.error ?? "RPC command failed", response.command, response.code));
          }
        }
      }
    }

    this.emit({ type: "frame", frame });
  }

  /** Emit the ready event and negotiate v2 once per process generation. */
  private adoptReady(generation: number, ready: ReadyFrame) {
    if (this.readyHandled.has(generation)) return;
    this.readyHandled.add(generation);
    this.ready = ready;
    this.emit({ type: "ready", ready, generation });
    if (ready.supportedProtocolVersions?.includes(2)) {
      void this.send({ type: "negotiate_protocol", protocolVersion: 2 }, { timeoutMs: 10_000 }).catch((error) => {
        if (generation !== this.generation || this.activeSeq !== this.startSeq) return;
        this.emit({
          type: "protocol",
          event: { kind: "protocol_error", generation, message: `v2 negotiation failed: ${String(error)}` },
        });
      });
    }
  }

  private failPending(reason: string) {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      window.clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    for (const waiter of this.readyWaiters.values()) {
      window.clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
    }
    this.readyWaiters.clear();
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation);
    this.lifecycle = result.catch(() => {});
    return result;
  }

  private async stopOwned(): Promise<void> {
    const generation = this.generation;
    this.generation = undefined;
    this.startInfo = undefined;
    this.ready = undefined;
    this.readyFailure = undefined;
    this.readyHandled.clear();
    this.earlyEvents = [];
    if (generation !== undefined) await invoke("stop_agent", { generation });
  }

  start(options: StartOptions): Promise<StartInfo> {
    const seq = ++this.startSeq;
    this.failPending("Restarting the agent");
    return this.serialize(async () => {
      if (seq !== this.startSeq) throw new Error("Agent start superseded");
      await this.stopOwned();
      await this.bind();
      if (seq !== this.startSeq) throw new Error("Agent start superseded");
      this.activeSeq = seq;
      this.starting = true;
      try {
        const info = await invoke<StartInfo>("start_agent", { options });
        this.generation = info.generation;
        this.startInfo = info;
        if (seq !== this.startSeq) throw new Error("Agent start superseded");
        this.starting = false;
        const earlyEvents = this.earlyEvents;
        this.earlyEvents = [];
        for (const event of earlyEvents) this.receive(event);
        if (seq !== this.startSeq) throw new Error("Agent start superseded");
        await this.waitForReady(info.generation);
        if (seq !== this.startSeq) throw new Error("Agent start superseded");
        return info;
      } catch (error) {
        this.failPending(String(error));
        await this.stopOwned();
        throw error;
      } finally {
        this.starting = false;
        this.earlyEvents = [];
      }
    });
  }

  private waitForReady(generation: number): Promise<void> {
    if (this.readyFailure) return Promise.reject(new Error(this.readyFailure));
    if (this.ready) return Promise.resolve();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const timer = window.setTimeout(() => {
      this.readyWaiters.delete(generation);
      reject(new Error("Timed out waiting for the agent to become ready."));
    }, READY_TIMEOUT_MS);
    this.readyWaiters.set(generation, { resolve: () => resolve(), reject, timer });
    return promise;
  }

  stop(): Promise<void> {
    ++this.startSeq;
    this.failPending("Agent stopped");
    return this.serialize(() => this.stopOwned());
  }

  /** Send a command and resolve with its `success: true` response. */
  send<T = unknown>(
    command: { type: string; id?: string } & Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<RpcResponse<T>> {
    const generation = this.generation;
    if (generation === undefined || this.activeSeq !== this.startSeq) {
      return Promise.reject(new Error("Agent is not running"));
    }
    const id = command.id ?? `ui-${++this.counter}`;
    const payload = { ...command, id };
    const { promise, resolve, reject } = Promise.withResolvers<RpcResponse<T>>();
    const timer = options?.timeoutMs
      ? window.setTimeout(() => {
          this.pending.delete(id);
          reject(new RpcFailure(`Command "${command.type}" timed out.`, command.type, "timeout"));
        }, options.timeoutMs)
      : undefined;
    const entry: Pending = {
      command: command.type,
      resolve: (response) => resolve(response as RpcResponse<T>),
      reject,
      timer,
    };
    this.pending.set(id, entry);
    invoke("rpc_send", { generation, command: payload }).catch((error) => {
      if (this.pending.get(id) !== entry) return;
      const pending = this.pending.get(id);
      window.clearTimeout(pending?.timer);
      this.pending.delete(id);
      reject(new Error(String(error)));
    });
    return promise;
  }

  /** Fire a frame without expecting a response (extension UI answers). */
  async sendRaw(frame: ExtensionUIResponse | RpcCommand): Promise<void> {
    const generation = this.generation;
    if (generation === undefined || this.activeSeq !== this.startSeq) {
      throw new Error("Agent is not running");
    }
    await invoke("rpc_send", { generation, command: frame });
  }

  dispose(): Promise<void> {
    ++this.startSeq;
    this.failPending("Agent disposed");
    return this.serialize(async () => {
      try {
        await this.stopOwned();
      } finally {
        for (const unlisten of this.unlisteners) unlisten();
        this.unlisteners = [];
        this.binding = undefined;
      }
    });
  }
}

type EventListener = (event: OmpClientEvent) => void;

