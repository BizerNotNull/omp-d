import { Channel, invoke, isTauri } from "@tauri-apps/api/core";

export type TerminalEvent =
  | { type: "data"; data: number[] }
  | { type: "exit"; code: number }
  | { type: "error"; message: string };

export function terminalError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One ordered command stream per PTY, including create and teardown. */
export class TerminalSession {
  private readonly id = crypto.randomUUID();
  private readonly channel = isTauri() ? new Channel<TerminalEvent>() : undefined;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private ended = false;
  private created = false;

  constructor(
    cwd: string,
    cols: number,
    rows: number,
    private readonly onEvent: (event: TerminalEvent) => void,
    private readonly onReady: () => void,
  ) {
    if (this.channel) this.channel.onmessage = (event) => {
      if (this.closed) return;
      if (event.type === "exit") this.ended = true;
      // Preserve raw bytes; xterm maintains its decoder across channel messages.
      this.onEvent(event);
    };
    this.queue = this.start(cwd, cols, rows).catch((error: unknown) => {
      this.ended = true;
      if (!this.closed) this.onEvent({ type: "error", message: terminalError(error) });
    });
  }

  private async start(cwd: string, cols: number, rows: number): Promise<void> {
    if (!isTauri()) throw new Error("The terminal requires the desktop app. Native shells are unavailable in a browser.");
    await invoke<void>("terminal_create", { id: this.id, cwd, cols, rows, onEvent: this.channel });
    this.created = true;
    if (!this.closed && !this.ended) this.onReady();
  }

  private enqueue(command: "terminal_write" | "terminal_resize", args: Record<string, unknown>): void {
    if (this.closed || this.ended) return;
    this.queue = this.queue.then(async () => {
      if (this.closed || this.ended || !this.created) return;
      await invoke<void>(command, { id: this.id, ...args });
    }).catch((error: unknown) => {
      if (!this.closed && !this.ended) this.onEvent({ type: "error", message: terminalError(error) });
    });
  }

  write(data: string): void {
    this.enqueue("terminal_write", { data });
  }

  resize(cols: number, rows: number): void {
    this.enqueue("terminal_resize", { cols, rows });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Waiting for create also closes a process whose spawn completed after unmount.
    this.queue = this.queue.then(async () => {
      if (isTauri()) await invoke<void>("terminal_close", { id: this.id });
    }).catch((error: unknown) => {
      this.onEvent({ type: "error", message: `Could not close terminal: ${terminalError(error)}` });
    });
  }
}
