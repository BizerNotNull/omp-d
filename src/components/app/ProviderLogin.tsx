import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ExternalLink, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useProviderAuth } from "@/lib/omp/provider-auth";
import type { StartOptions } from "@/lib/omp/types";

export function ProviderLogin({ provider, options, onBack, onSuccess }: { provider: string; options: StartOptions; onBack: () => void; onSuccess: () => void }) {
  const auth = useProviderAuth(provider, options);
  const [value, setValue] = useState("");
  const completed = useRef(false);
  useEffect(() => { setValue(""); }, [provider, auth.prompt?.id]);
  useEffect(() => {
    if (auth.phase === "success" && !completed.current) {
      completed.current = true;
      onSuccess();
    }
  }, [auth.phase, onSuccess]);
  const methods = auth.methods.filter((method) => method.available && !method.authenticated);

  return (
    <section aria-labelledby="provider-login-title" className="flex min-h-0 flex-1 flex-col" onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onBack(); }
    }}>
      <header className="flex items-center justify-between gap-2 border-b px-3 py-3 sm:px-5">
        <div><div className="font-mono text-[10px] text-muted-foreground">/models · /login</div><h1 id="provider-login-title" className="text-base font-semibold">Sign in to {provider}</h1></div>
        <Button autoFocus variant="ghost" size="sm" onClick={onBack}><ArrowLeft className="size-3.5" /> Cancel</Button>
      </header>
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 overflow-y-auto p-4 sm:p-6">
        {auth.phase === "loading" && <p role="status" className="text-sm text-muted-foreground">Loading login methods…</p>}
        {auth.phase === "choosing" && <>
          {auth.authenticated && <p role="status" className="text-sm text-muted-foreground">This provider already has credentials. Choose a login method to add an account.</p>}
          {methods.length > 0 ? <div className="grid gap-2">{methods.map((method) => <Button key={method.id} variant="outline" className="justify-start" onClick={() => void auth.login(method.id)}>{method.name}</Button>)}</div> : <p className="text-sm text-muted-foreground">No OAuth login method is available for this provider. Configure its credentials, then return to models.</p>}
          <p className="text-xs text-muted-foreground">Other providers use their own credentials or configuration; this page only supports login methods registered by omp.</p>
        </>}
        {auth.progress && <p role="status" className="text-sm text-muted-foreground">{auth.progress}</p>}
        {auth.phase === "running" && !auth.prompt && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" /> Waiting for {provider}…</p>}
        {auth.url && <div className="space-y-2 rounded-lg border p-3"><p className="whitespace-pre-wrap text-sm">{auth.url.instructions ?? "Authorize this app in your browser, then return here."}</p><code className="block break-all rounded bg-muted p-2 text-xs">{auth.url.url}</code><Button variant="outline" onClick={() => void auth.openBrowser()}><ExternalLink className="size-3.5" /> Open authorization page</Button></div>}
        {auth.prompt && <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); const prompt = auth.prompt; if (prompt) void auth.answer(prompt.id, value); setValue(""); }}>
          <label htmlFor="provider-login-input" className="text-sm">{auth.prompt.message}</label><Input key={auth.prompt.id} id="provider-login-input" autoFocus type={auth.prompt.secret ? "password" : "text"} autoComplete="off" value={value} placeholder={auth.prompt.placeholder} onChange={(event) => setValue(event.target.value)} />
          <Button type="submit">Continue</Button>
        </form>}
        {auth.phase === "success" && <p role="status" className="text-sm">Sign-in completed. Refreshing model availability…</p>}
        {auth.error && <p role="alert" className="text-sm text-destructive">{auth.error}</p>}
        {auth.phase === "error" && <Button variant="outline" onClick={onBack}>Back to models</Button>}
      </main>
    </section>
  );
}
