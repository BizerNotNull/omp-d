import { useState } from "react";
import { HelpCircle } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useAppStore, type DialogRequest } from "@/lib/omp/store";
export function AgentRequestCard() {
  const dialogs = useAppStore((state) => state.dialogs);
  const dialog = dialogs[0];
  if (!dialog) return null;
  return (
    <section aria-label="Agent request" className="mb-3 flex max-h-[45vh] min-h-0 flex-col overflow-hidden rounded-2xl border border-ring/30 bg-card shadow-sm">
      <div className="scroll-thin min-h-0 overflow-y-auto p-4">
        <RequestBody key={dialog.id} dialog={dialog} />
      </div>
    </section>
  );
}

function RequestBody({ dialog }: { dialog: DialogRequest }) {
  const cancelDialog = useAppStore((state) => state.cancelDialog);
  const answerDialog = useAppStore((state) => state.answerDialog);

  if (dialog.method === "ask") {
    return <AskDialog dialog={dialog} onAnswer={answerDialog} onCancel={cancelDialog} />;
  }

  const title = dialog.title;
  return (
    <div className="space-y-3">
      <header className="space-y-1">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <HelpCircle className="size-4 shrink-0 text-muted-foreground" />
          {title || "The agent needs input"}
        </h2>
        <p className="text-xs whitespace-pre-wrap text-muted-foreground">
          {dialog.method === "confirm" && dialog.message}
          {dialog.method === "select" && "Choose one option to continue the agent's work."}
          {dialog.method === "input" && (title ? "Enter a value below." : "The agent is waiting for a value.")}
          {dialog.method === "editor" && "Review or edit the text, then submit it."}
        </p>
      </header>
        <DialogBody
          dialog={dialog}
          onCancel={() => void cancelDialog(dialog.id)}
          onSubmit={(response) => void answerDialog(dialog.id, response)}
        />
    </div>
  );
}

function RequestFooter({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap justify-end gap-2">{children}</div>;
}

function DialogBody({
  dialog,
  onCancel,
  onSubmit,
}: {
  dialog: Extract<DialogRequest, { method: "select" | "confirm" | "input" | "editor" }>;
  onCancel: () => void;
  onSubmit: (response: { value: string } | { confirmed: boolean }) => void;
}) {
  const [value, setValue] = useState(
    dialog.method === "editor" ? dialog.prefill ?? "" : dialog.method === "input" ? "" : "",
  );

  if (dialog.method === "confirm") {
    return (
      <RequestFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={() => onSubmit({ confirmed: true })}>Confirm</Button>
      </RequestFooter>
    );
  }

  if (dialog.method === "select") {
    return (
      <div className="space-y-2">
        <div className="grid gap-1.5">
          {dialog.options.map((option, index) => (
            <button
              key={`${option}-${index}`}
              type="button"
              onClick={() => onSubmit({ value: option })}
              className="group flex flex-col gap-0.5 rounded-lg border bg-card px-3 py-2 text-left transition-colors hover:border-ring/60 hover:bg-muted/40"
            >
              <span className="text-[12.5px] font-medium">{option}</span>
              {dialog.optionDetails?.[index]?.description && (
                <span className="text-[11px] text-muted-foreground">{dialog.optionDetails[index]?.description}</span>
              )}
            </button>
          ))}
        </div>
        <RequestFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </RequestFooter>
      </div>
    );
  }

  if (dialog.method === "input") {
    return (
      <div className="space-y-3">
        <Input
          type={dialog.secret ? "password" : "text"}
          value={value}
          placeholder={dialog.placeholder}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onSubmit({ value });
            }
          }}
          autoFocus
        />
        <RequestFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={() => onSubmit({ value })}>{dialog.secret ? "Submit" : "OK"}</Button>
        </RequestFooter>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Textarea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        rows={8}
        className="max-h-80 font-mono text-[12px]"
        autoFocus
      />
      <RequestFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={() => onSubmit({ value })}>Submit</Button>
      </RequestFooter>
    </div>
  );
}

interface AskState {
  selected: string[];
  custom: string;
}

function AskDialog({
  dialog,
  onAnswer,
  onCancel,
}: {
  dialog: Extract<DialogRequest, { method: "ask" }>;
  onAnswer: (id: string, response: { answers: Array<{ id: string; selectedOptions: string[]; customInput?: string }> }) => Promise<void>;
  onCancel: (id: string) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, AskState>>(() => {
    const initial: Record<string, AskState> = {};
    for (const question of dialog.questions) initial[question.id] = { selected: [], custom: "" };
    return initial;
  });

  function toggle(questionId: string, label: string, multi: boolean) {
    setAnswers((current) => {
      const previous = current[questionId] ?? { selected: [], custom: "" };
      if (multi) {
        const selected = previous.selected.includes(label)
          ? previous.selected.filter((entry) => entry !== label)
          : [...previous.selected, label];
        return { ...current, [questionId]: { ...previous, selected } };
      }
      return { ...current, [questionId]: { selected: [label], custom: "" } };
    });
  }

  function submit() {
    void onAnswer(dialog.id, {
      answers: dialog.questions.map((question) => {
        const state = answers[question.id] ?? { selected: [], custom: "" };
        const customInput = state.custom.trim();
        return {
          id: question.id,
          selectedOptions: state.selected,
          ...(customInput ? { customInput } : {}),
        };
      }),
    });
  }

  return (
    <div className="space-y-3">
      <header className="space-y-1">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <HelpCircle className="size-4 shrink-0 text-muted-foreground" />
          A question from the agent
        </h2>
        <p className="text-xs text-muted-foreground">Answers are returned to the running tool. Free text is always accepted.</p>
      </header>

        <div className="space-y-4">
          {dialog.questions.map((question) => {
            const state = answers[question.id] ?? { selected: [], custom: "" };
            return (
              <div key={question.id} className="rounded-xl border bg-card/60 p-3">
                {question.header && (
                  <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {question.header}
                  </div>
                )}
                <div className="text-[12.5px] font-medium leading-snug">{question.question}</div>
                <div className="mt-2 grid gap-1.5">
                  {question.options.map((option, index) => {
                    const checked = state.selected.includes(option.label);
                    return (
                      <button
                        key={`${option.label}-${index}`}
                        type="button"
                        aria-pressed={checked}
                        onClick={() => toggle(question.id, option.label, Boolean(question.multi))}
                        className={cn(
                          "flex items-start gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors",
                          checked ? "border-emerald-500/50 bg-emerald-500/10" : "bg-background hover:bg-muted/40",
                        )}
                      >
                        <span
                          className={cn(
                            "mt-0.5 flex size-3.5 shrink-0 items-center justify-center border",
                            question.multi ? "rounded-sm" : "rounded-full",
                            checked && "border-emerald-500 bg-emerald-500",
                          )}
                        >
                          {checked && <span className="size-1.5 rounded-full bg-background" />}
                        </span>
                        <span className="min-w-0">
                          <span className="flex flex-wrap items-baseline gap-1.5">
                            <span className="text-[12px]">{option.label}</span>
                            {question.recommended === index && (
                              <span className="rounded border border-emerald-500/40 px-1 text-[9px] uppercase tracking-wide text-emerald-500">
                                recommended
                              </span>
                            )}
                          </span>
                          {option.description && (
                            <span className="mt-0.5 block text-[10.5px] leading-relaxed text-muted-foreground">
                              {option.description}
                            </span>
                          )}
                          {option.preview && (
                            <span className="mt-1 block rounded border bg-background/60 px-2 py-1 font-mono text-[10px] whitespace-pre-wrap text-muted-foreground">
                              {option.preview}
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div className="mt-2">
                  <Input
                    aria-label={`Your answer: ${question.question}`}
                    value={state.custom}
                    placeholder="Other — type your own answer"
                    onChange={(event) =>
                      setAnswers((current) => ({
                        ...current,
                        [question.id]: {
                          selected: !question.multi && event.target.value.trim() ? [] : state.selected,
                          custom: event.target.value,
                        },
                      }))
                    }
                    className="h-8 text-[11px]"
                  />
                </div>
              </div>
            );
          })}
        </div>

        <RequestFooter>
          <Button variant="outline" onClick={() => void onCancel(dialog.id)}>
            Cancel
          </Button>
          <Button onClick={submit}>Send answers</Button>
        </RequestFooter>
    </div>
  );
}
