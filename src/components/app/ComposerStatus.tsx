import { useEffect } from "react";
import { GitBranch, Target } from "lucide-react";
import { useAppStore } from "@/lib/omp/store";
import { stripAnsi, stripPrivateUse } from "@/lib/omp/format";
import { sessionPathKey, useSessionNavigation } from "@/lib/omp/navigation";
import { WorktreeSelector, worktreeName } from "./WorktreeSelector";

export function ComposerStatus({ active }: { active: boolean }) {
  const cwd = useAppStore((state) => state.cwd);
  const status = useAppStore((state) => state.status);
  const busy = useAppStore((state) => state.busy);
  const session = useAppStore((state) => state.session);
  const git = useAppStore((state) => state.gitStatus);
  const gitError = useAppStore((state) => state.gitStatusError);
  const statusMarks = useAppStore((state) => state.statusMarks);
  const refreshGitStatus = useAppStore((state) => state.refreshGitStatus);
  const messages = useAppStore((state) => state.messages);
  const newSession = useAppStore((state) => state.newSession);
  const directories = useSessionNavigation((state) => state.sessionListing?.directories);
  const directory = directories?.find((item) => sessionPathKey(item.cwd) === sessionPathKey(cwd));
  const canChooseWorktree = !busy && !session?.hasPendingAsyncWork && messages.length === 0 && status === "ready";

  useEffect(() => {
    if (!active || status !== "ready") return;
    void refreshGitStatus();
    const refresh = () => { void refreshGitStatus(); };
    const timer = window.setInterval(refresh, 10_000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [active, status, cwd, busy, refreshGitStatus]);

  const goal = session?.goal?.goal;
  const clean = git && !git.staged && !git.unstaged && !git.untracked && !git.conflicted;
  const markEntries = Object.entries(statusMarks)
    .map(([key, value]) => [key, stripPrivateUse(stripAnsi(value))] as const)
    .filter(([, value]) => value.trim());

  return (
    <div aria-label="Session and Git status" className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[10px] text-muted-foreground">
      {cwd && (canChooseWorktree
        ? <WorktreeSelector value={cwd} allowAll={false} className="w-auto max-w-full py-1 text-[10px]" onSelect={(target) => { if (sessionPathKey(target) !== sessionPathKey(cwd)) void newSession(target); }} />
        : <span className="inline-flex min-w-0 max-w-full items-center gap-1" title={cwd}><GitBranch aria-hidden="true" className="size-3 shrink-0" /><span className="truncate">{worktreeName(cwd, directory?.branch)}</span></span>)}
      {goal && (
        <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
          <Target aria-hidden="true" className="size-3 shrink-0" />
          <span className="shrink-0 font-mono text-foreground/80">/goal</span>
          <span className="truncate">{session?.goal?.mode === "exiting" ? "exiting" : goal.status}</span>
        </span>
      )}
      {session?.fastModeEnabled && <span>fast{session.fastModeActive === false ? " (inactive)" : ""}</span>}
      {session?.slowModeEnabled && <span>slow</span>}
      <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1 sm:ml-auto" title={gitError ?? cwd}>
        <GitBranch aria-hidden="true" className="size-3 shrink-0" />
        {git ? (
          <>
            <span className="max-w-56 truncate font-mono text-foreground/80" title={git.branch}>{git.branch}</span>
            {clean ? <span>clean</span> : (
              <>
                {git.staged > 0 && <span>{git.staged} staged</span>}
                {git.unstaged > 0 && <span>{git.unstaged} unstaged</span>}
                {git.untracked > 0 && <span>{git.untracked} untracked</span>}
                {git.conflicted > 0 && <span className="text-destructive">{git.conflicted} conflicted</span>}
                <span title="Tracked line changes against HEAD; untracked files and binary contents excluded">
                  <span className="text-emerald-500">+{git.additions}</span>{" "}<span className="text-destructive">−{git.deletions}</span>
                </span>
              </>
            )}
          </>
        ) : <span>{gitError ? "Git unavailable" : git === null ? "Not a Git repository" : "Reading Git…"}</span>}
      </span>
      {markEntries.map(([key, value]) => <span key={key} className="max-w-full truncate" title={value}>{value}</span>)}
    </div>
  );
}
