import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { StartOptions } from "./types";

export interface LoginMethod {
  id: string;
  name: string;
  available: boolean;
  authenticated: boolean;
}

type LoginPrompt = { type: "prompt"; id: string; message: string; placeholder?: string; secret?: boolean };
type LoginUrl = { type: "url"; url: string; launchUrl?: string; instructions?: string };
type AuthEvent =
  | { type: "methods"; methods: LoginMethod[]; authenticated: boolean }
  | LoginPrompt | LoginUrl
  | { type: "progress"; message: string }
  | { type: "success" }
  | { type: "error"; message: string };

interface LoginState {
  phase: "loading" | "choosing" | "running" | "success" | "error";
  methods: LoginMethod[];
  authenticated: boolean;
  prompt?: LoginPrompt;
  url?: LoginUrl;
  progress?: string;
  error?: string;
}

const initialState: LoginState = { phase: "loading", methods: [], authenticated: false };

export function useProviderAuth(provider: string, options: StartOptions) {
  const [state, setState] = useState<LoginState>(initialState);
  const attemptRef = useRef<string | undefined>(undefined);
  const sending = useRef(false);
  const { cwd, binary } = options;
  const args = JSON.stringify(options.extraArgs ?? []);

  useEffect(() => {
    const attempt = crypto.randomUUID();
    attemptRef.current = attempt;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    setState(initialState);
    sending.current = false;
    void (async () => {
      try {
        unlisten = await listen<{ attempt: string; event: AuthEvent }>("omp://auth", ({ payload }) => {
          if (disposed || payload.attempt !== attempt || attemptRef.current !== attempt) return;
          const event = payload.event;
          sending.current = false;
          if (event.type === "success" || event.type === "error") attemptRef.current = undefined;
          setState((previous) => {
            switch (event.type) {
              case "methods": return { ...initialState, phase: "choosing", methods: event.methods, authenticated: event.authenticated };
              case "prompt": return { ...previous, phase: "running", prompt: event, error: undefined };
              case "url": return { ...previous, phase: "running", url: event, error: undefined };
              case "progress": return { ...previous, progress: event.message };
              case "success": return { ...previous, phase: "success", authenticated: true, prompt: undefined, url: undefined, progress: undefined, error: undefined };
              case "error": return { ...previous, phase: "error", prompt: undefined, url: undefined, progress: undefined, error: event.message };
            }
          });
        });
        if (disposed) { unlisten(); return; }
        await invoke("auth_start", { attempt, provider, options: { cwd, binary, extraArgs: JSON.parse(args) } });
        if (disposed) void invoke("auth_stop", { attempt }).catch(() => {});
      } catch (error) {
        if (!disposed && attemptRef.current === attempt) {
          attemptRef.current = undefined;
          sending.current = false;
          unlisten?.();
          void invoke("auth_stop", { attempt }).catch(() => {});
          setState((previous) => ({ ...previous, phase: "error", prompt: undefined, url: undefined, progress: undefined, error: String(error) }));
        }
      }
    })();
    return () => {
      disposed = true;
      if (attemptRef.current === attempt) attemptRef.current = undefined;
      unlisten?.();
      void invoke("auth_stop", { attempt }).catch(() => {});
    };
  }, [provider, cwd, binary, args]);

  async function send(command: { type: "login"; method: string } | { type: "answer"; id: string; value: string }) {
    const attempt = attemptRef.current;
    if (!attempt || sending.current) return;
    sending.current = true;
    if (command.type === "login") setState((previous) => ({ ...previous, phase: "running", error: undefined, prompt: undefined, url: undefined, progress: undefined }));
    else setState((previous) => ({ ...previous, prompt: undefined, error: undefined }));
    try {
      await invoke("auth_send", { attempt, command });
    } catch {
      if (attemptRef.current === attempt) {
        attemptRef.current = undefined;
        sending.current = false;
        void invoke("auth_stop", { attempt }).catch(() => {});
        setState((previous) => ({ ...previous, phase: "error", prompt: undefined, url: undefined, progress: undefined, error: "Could not send authentication input. Return to models and try again." }));
      }
    }
  }

  async function openBrowser() {
    const url = state.url?.launchUrl ?? state.url?.url;
    const attempt = attemptRef.current;
    if (!url || !attempt) return;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Unsupported authentication URL scheme");
      await openUrl(url);
    } catch {
      if (attempt && attemptRef.current === attempt) setState((previous) => ({ ...previous, error: "Could not open the browser. Copy the authorization URL below." }));
    }
  }

  return { ...state, login: (method: string) => send({ type: "login", method }), answer: (id: string, value: string) => send({ type: "answer", id, value }), openBrowser };
}
