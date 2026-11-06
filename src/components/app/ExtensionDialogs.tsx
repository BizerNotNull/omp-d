import { useState } from "react";
import { HelpCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useAppStore, type DialogRequest } from "@/lib/omp/store";
export function ExtensionDialogs() {
  const dialogs = useAppStore((state) => state.dialogs);
  const dialog = dialogs[0];
  if (!dialog) return null;
  return <DialogHost key={dialog.id} dialog={dialog} />;
}

function DialogHost({ dialog }: { dialog: DialogRequest }) {
  const cancelDialog = useAppStore((state) => state.cancelDialog);
  const answerDialog = useAppStore((state) => state.answerDialog);

  if (dialog.method === "ask") {
    return <AskDialog dialog={dialog} onAnswer={answerDialog} onCancel={cancelDialog} />;
  }

  const title = dialog.method === "confirm" ? dialog.title : dialog.title;
  return (
    <Dialog open onOpenChange={(open) => (!open ? void cancelDialog(dialog.id) : undefined)}>
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title || "The agent needs input"}</DialogTitle>
          {dialog.method === "confirm" && <DialogDescription>{dialog.message}</DialogDescription>}
          {dialog.method === "select" && (
            <DialogDescription>Choose one option to continue the agent's work.</DialogDescription>
          )}
          {dialog.method === "input" && (
            <DialogDescription>{title ? "Enter a value below." : "The agent is waiting for a value."}</DialogDescription>
          )}
          {dialog.method === "editor" && (
            <DialogDescription>Review or edit the text, then submit it.</DialogDescription>
          )}
        </DialogHeader>
        <DialogBody
          dialog={dialog}
          onCancel={() => void cancelDialog(dialog.id)}
          onSubmit={(response) => void answerDialog(dialog.id, response)}
        />
      </DialogContent>
    </Dialog>
  );
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
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={() => onSubmit({ confirmed: true })}>Confirm</Button>
      </DialogFooter>
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
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </DialogFooter>
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
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={() => onSubmit({ value })}>{dialog.secret ? "Submit" : "OK"}</Button>
        </DialogFooter>
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
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={() => onSubmit({ value })}>Submit</Button>
      </DialogFooter>
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
      return { ...current, [questionId]: { ...previous, selected: [label] } };
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
    <Dialog open onOpenChange={(open) => (!open ? void onCancel(dialog.id) : undefined)}>
      <DialogContent className="sm:max-w-2xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HelpCircle className="size-4 text-muted-foreground" />
            A question from the agent
          </DialogTitle>
          <DialogDescription>Answers are returned to the running tool. Free text is always accepted.</DialogDescription>
        </DialogHeader>

        <div className="scroll-thin max-h-[60vh] space-y-4 overflow-y-auto pr-1">
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
                    value={state.custom}
                    placeholder="Other — type your own answer"
                    onChange={(event) =>
                      setAnswers((current) => ({
                        ...current,
                        [question.id]: { ...state, custom: event.target.value },
                      }))
                    }
                    className="h-8 text-[11px]"
                  />
                </div>
              </div>
            );
          })}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => void onCancel(dialog.id)}>
            Cancel
          </Button>
          <Button onClick={submit}>Send answers</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
