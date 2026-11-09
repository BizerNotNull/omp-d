import { getOAuthProviders, getOAuthCredentialProvider, PASTE_CODE_LOGIN_PROVIDERS } from "@oh-my-pi/pi-ai";

// RPC owns stdin. A private UI input request is the supported side channel:
// native answers it over stdin, without submitting prompts or invoking a model.
export default function (omp) {
  const provider = process.env.OMP_D_AUTH_PROVIDER;
  const inbox = `__omp_d_auth_inbox__:${process.env.OMP_D_AUTH_ATTEMPT}`;
  const controller = new AbortController();
  const pending = new Map();
  const answers = new Set();
  let running = false;
  let finished = false;
  let sequence = 0;
  const clean = (value) => {
    if (typeof value === "string") {
      for (const answer of answers) value = value.split(answer).join("[redacted]");
      return value;
    }
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)]));
    return value;
  };
  const emit = (event) => {
    if (!controller.signal.aborted) process.stdout.write(`\nOMP_D_AUTH:${JSON.stringify(clean(event))}\n`);
  };
  const cancel = () => {
    controller.abort();
    for (const request of pending.values()) request.reject(new Error("Login cancelled"));
    pending.clear();
  };
  const prompt = (request, signal = controller.signal) => new Promise((resolve, reject) => {
    if (signal?.aborted || controller.signal.aborted) return reject(new Error("Login cancelled"));
    const id = String(++sequence);
    const abort = () => settle(undefined, new Error("Login cancelled"));
    const settle = (value, error) => {
      pending.delete(id);
      signal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value);
    };
    pending.set(id, { secret: request.secret === true, resolve: (value) => settle(value), reject: (error) => settle(undefined, error) });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal !== controller.signal) controller.signal.addEventListener("abort", abort, { once: true });
    emit({ type: "prompt", id, message: request.message, placeholder: request.placeholder, secret: request.secret ?? false });
  });
  omp.on("session_shutdown", cancel);
  omp.on("session_start", (_event, context) => {
    const registry = context.modelRegistry;
    const storage = registry.authStorage;
    const methods = getOAuthProviders().filter((method) => getOAuthCredentialProvider(method.id) === provider);
    const authenticated = storage.credentials.has(provider) || Boolean(storage.keys.describe(provider));
    emit({ type: "methods", authenticated, methods: methods.map(({ id, name, available }) => ({ id, name, available, authenticated })) });
    const login = async (method) => {
      if (running || finished) return;
      if (!methods.some((candidate) => candidate.id === method && candidate.available)) {
        emit({ type: "error", message: "This login method is not available for this provider." });
        return;
      }
      running = true;
      try {
        await storage.oauth.login(method, {
          signal: controller.signal,
          onAuth: (info) => emit({ type: "url", url: info.url, launchUrl: info.launchUrl, instructions: info.instructions }),
          onProgress: (message) => emit({ type: "progress", message }),
          onPrompt: (request) => prompt(request),
          onManualCodeInput: PASTE_CODE_LOGIN_PROVIDERS.has(method)
            ? (signal) => prompt({ message: "Paste the authorization code (or full redirect URL):", secret: true }, signal)
            : undefined,
          onBrowserSession: async (request, signal) => {
            emit({ type: "url", url: request.url, instructions: "Complete sign-in in your browser, then supply the requested session cookie privately." });
            return prompt({ message: `Paste session cookie (${request.cookieNames.join(" or ")}):`, secret: true }, signal);
          },
        });
        if (controller.signal.aborted) return;
        await registry.refreshProvider(provider, "online");
        if (!controller.signal.aborted) {
          finished = true;
          emit({ type: "success" });
        }
      } catch {
        if (!controller.signal.aborted) emit({ type: "error", message: "Login failed. Please retry the provider sign-in." });
      } finally {
        running = false;
        for (const request of pending.values()) request.reject(new Error("Login finished"));
        pending.clear();
      }
    };
    // Return from session_start immediately: normal extension hook budgets must
    // not bound a human's login. RPC keeps the context alive until native stops.
    void (async () => {
      try {
        while (!controller.signal.aborted && !finished) {
          const value = await context.ui.input(inbox, undefined, { secret: true });
          if (value === undefined) break;
          let command;
          try { command = JSON.parse(value); } catch { continue; }
          if (command.type === "login" && typeof command.method === "string") void login(command.method);
          else if (command.type === "answer" && typeof command.id === "string" && typeof command.value === "string") {
            const request = pending.get(command.id);
            if (request) {
              if (request.secret && command.value) answers.add(command.value);
              request.resolve(command.value);
            }
          } else if (command.type === "stop") break;
        }
      } catch {
        if (!controller.signal.aborted && !finished) emit({ type: "error", message: "Authentication connection closed." });
      } finally {
        cancel();
        answers.clear();
      }
    })();
  });
}
