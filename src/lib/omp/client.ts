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
  private readyByGeneration = new Map<number, ReadyFrame>();
  private readyWaiters = new Map<number, Waiter>();
  private readyHandled = new Set<number>();
  private counter = 0;
  private started = false;
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
    if (this.started) return;
    this.started = true;
    this.unlisteners = await Promise.all([
      listen<{ generation: number; frame: RpcFrame }>("omp://frame", ({ payload }) => {
        this.handleFrame(payload.generation, payload.frame);
      }),
      listen<ProcessEvent>("omp://process", ({ payload }) => {
        this.emit({ type: "process", event: payload });
        if (payload.generation !== undefined && payload.generation !== this.generation) return;
        if (this.starting && payload.kind !== "error") return;
        if (payload.kind === "eof" || payload.kind === "exit" || payload.kind === "error") {
          const reason =
            payload.kind === "eof"
              ? "The agent process ended. Stdin/stdout closed."
              : payload.kind === "exit"
                ? `The agent process exited ${payload.exitCode == null ? "unexpectedly" : `with code ${payload.exitCode}`}.`
                : payload.message ?? "The agent process failed.";
          this.failPending(reason);
          this.emit({ type: "disconnected", reason });
        }
      }),
      listen<{ generation: number; line: string }>("omp://stderr", ({ payload }) => {
        this.emit({ type: "stderr", line: payload.line, generation: payload.generation });
      }),
      listen<ProtocolEvent>("omp://protocol", ({ payload }) => {
        this.emit({ type: "protocol", event: payload });
      }),
    ]);
  }

  private handleFrame(generation: number, frame: RpcFrame) {
    // `ready` can arrive before the invoke that returned this generation is
    // delivered to JS; capture it regardless of the active generation.
    if (frame.type === "ready") {
      const ready = frame as unknown as ReadyFrame;
      this.readyByGeneration.set(generation, ready);
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

  async start(options: StartOptions): Promise<StartInfo> {
    const seq = ++this.startSeq;
    await this.bind();
    this.failPending("Restarting the agent");
    this.ready = undefined;
    this.starting = true;

    try {
      const info = await invoke<StartInfo>("start_agent", { options });
      // A newer start superseded this one; do not adopt its (already stopped) process.
      if (seq !== this.startSeq) return info;
      this.generation = info.generation;
      this.startInfo = info;
      const arrived = this.readyByGeneration.get(info.generation);
      if (arrived) this.adoptReady(info.generation, arrived);
      await this.waitForReady(info.generation);
      return info;
    } finally {
      this.starting = false;
    }
  }

  private waitForReady(generation: number): Promise<void> {
    const stored = this.readyByGeneration.get(generation);
    if (stored) return Promise.resolve();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const timer = window.setTimeout(() => {
      this.readyWaiters.delete(generation);
      reject(new Error("Timed out waiting for the agent to become ready."));
    }, READY_TIMEOUT_MS);
    this.readyWaiters.set(generation, { resolve: () => resolve(), reject, timer });
    return promise;
  }

  async stop(): Promise<void> {
    this.failPending("Agent stopped");
    await invoke("stop_agent").catch(() => {});
    this.generation = undefined;
    this.ready = undefined;
  }

  /** Send a command and resolve with its `success: true` response. */
  send<T = unknown>(
    command: { type: string; id?: string } & Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<RpcResponse<T>> {
    const id = command.id ?? `ui-${++this.counter}`;
    const payload = { ...command, id };
    const { promise, resolve, reject } = Promise.withResolvers<RpcResponse<T>>();
    const timer = options?.timeoutMs
      ? window.setTimeout(() => {
          this.pending.delete(id);
          reject(new RpcFailure(`Command "${command.type}" timed out.`, command.type, "timeout"));
        }, options.timeoutMs)
      : undefined;
    this.pending.set(id, {
      command: command.type,
      resolve: (response) => resolve(response as RpcResponse<T>),
      reject,
      timer,
    });
    invoke("rpc_send", { command: payload }).catch((error) => {
      const pending = this.pending.get(id);
      window.clearTimeout(pending?.timer);
      this.pending.delete(id);
      reject(new Error(String(error)));
    });
    return promise;
  }

  /** Fire a frame without expecting a response (extension UI answers). */
  async sendRaw(frame: ExtensionUIResponse | RpcCommand): Promise<void> {
    await invoke("rpc_send", { command: frame });
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.started = false;
    for (const unlisten of this.unlisteners) unlisten();
    this.unlisteners = [];
  }
}

type EventListener = (event: OmpClientEvent) => void;

export const omp = new OmpClient();
