import { useLayoutEffect, useRef, useState } from "react";
import { LoaderCircle, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppStore } from "@/lib/omp/store";
import type { BtwRecord } from "@/lib/omp/types";
import { ContentImage } from "./ContentImage";
import { Markdown } from "./Markdown";

export function BtwPanel() {
  const view = useAppStore((state) => state.btwView);
  const records = useAppStore((state) => state.btwRecords);
  const runningId = useAppStore((state) => state.btwRunningId);
  const starting = useAppStore((state) => state.btwStarting);
  const loading = useAppStore((state) => state.btwLoading);
  const error = useAppStore((state) => state.btwHistoryError);
  const close = useAppStore((state) => state.closeBtw);
  const cancel = useAppStore((state) => state.cancelBtw);
  const branching = useAppStore((state) => state.branching);
  const runtimeId = useAppStore((state) => state.activeRuntimeId);
  if (!view) return null;

  const record = records[0];
  const history = view === "history";
  const disabled = Boolean(runningId || starting || branching);
  const actionLabel = runningId ? "Stop side question" : "Close side questions";
  return (
    <section aria-label="Side questions" className="mb-2 overflow-hidden rounded-xl border bg-card text-sm">
      <header className="flex items-center gap-2 border-b px-3 py-1.5">
        <h2 className="min-w-0 flex-1 font-medium">Side questions <span className="font-mono text-xs text-muted-foreground">/btw</span></h2>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={actionLabel}
          title={actionLabel}
          onClick={runningId ? () => void cancel() : close}
        >
          {runningId ? <Square className="size-3.5 fill-current" /> : <X className="size-4" />}
        </Button>
      </header>
      {starting && !runningId && <p role="status" className="px-3 py-2 text-xs text-muted-foreground">Starting side question…</p>}
      {history && loading && <p role="status" className="px-3 py-2 text-xs text-muted-foreground">Loading side question history…</p>}
      {history && error && <p role="alert" className="px-3 py-2 text-xs text-destructive">{error}</p>}
      {record ? (
        history ? (
          <div className="max-h-[min(45vh,28rem)] divide-y overflow-y-auto">
            {records.map((topic) => (
              <article key={`${runtimeId}:${topic.id}`}>
                <BtwTopic record={topic} disabled={disabled} />
              </article>
            ))}
          </div>
        ) : (
          <BtwTopic key={`${runtimeId}:${record.id}`} record={record} disabled={disabled} scroll />
        )
      ) : !starting && (!history || (!loading && !error)) && (
        <p className="px-3 py-3 text-xs text-muted-foreground">No side questions yet. Type <code>/btw &lt;question&gt;</code> in the composer.</p>
      )}
    </section>
  );
}

function BtwTopic({ record, disabled, scroll }: { record: BtwRecord; disabled: boolean; scroll?: boolean }) {
  const ask = useAppStore((state) => state.askBtw);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node && stickToBottom.current) node.scrollTop = node.scrollHeight;
  }, [record]);

  return (
    <>
      <div ref={scroll ? scrollRef : undefined} className={scroll ? "max-h-[min(30vh,20rem)] space-y-3 overflow-y-auto px-3 py-2" : "space-y-3 px-3 py-2"} onScroll={(event) => {
        const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
        stickToBottom.current = scrollHeight - scrollTop - clientHeight < 24;
      }}>
        {[record, ...(record.followUps ?? [])].map((turn, index) => (
          <div key={index} className="space-y-1 border-l-2 pl-2">
            <p className="whitespace-pre-wrap wrap-anywhere font-medium">{turn.question}</p>
            {turn.images?.map((image, imageIndex) => <ContentImage key={imageIndex} image={image} alt="Side question attachment" />)}
            {turn.answer && <Markdown text={turn.answer} streaming={turn.status === "running"} />}
            {turn.status === "running" && (
              <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground"><LoaderCircle className="size-3 animate-spin" /> Answering…</p>
            )}
            {turn.status === "cancelled" && <p className="text-xs text-muted-foreground">Side question stopped.</p>}
            {turn.status === "interrupted" && <p className="text-xs text-muted-foreground">Side question interrupted.</p>}
            {turn.status === "error" && <p role="alert" className="text-xs text-destructive">{turn.error || "Side question failed."}</p>}
          </div>
        ))}
      </div>
      <form className="flex gap-2 border-t px-3 py-2" onSubmit={async (event) => {
        event.preventDefault();
        if (disabled || !draft.trim()) return;
        stickToBottom.current = true;
        if (await ask(draft, record.id)) setDraft((current) => current === draft ? "" : current);
      }}>
        <Input aria-label="Side question follow-up" placeholder="Ask a follow-up…" value={draft} onChange={(event) => setDraft(event.target.value)} className="h-7 min-w-0 flex-1 text-xs" />
        <Button type="submit" size="xs" disabled={disabled || !draft.trim()}>Ask</Button>
      </form>
    </>
  );
}
