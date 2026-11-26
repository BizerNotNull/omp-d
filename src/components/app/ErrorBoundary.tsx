import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { reportFrontendError } from "@/lib/diagnostics";
import { WindowTitleBar } from "./WindowTitleBar";

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportFrontendError("react_boundary");
    console.error("omp-d renderer error", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col bg-background text-foreground">
          <WindowTitleBar />
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-8">
            <div className="w-full max-w-lg rounded-xl border border-destructive/40 bg-card p-5 shadow-sm">
              <div className="flex items-center gap-2 text-sm font-medium text-destructive">
                <AlertTriangle className="size-4" /> The interface hit an error
              </div>
              <p className="mt-2 break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
                {this.state.error.message}
              </p>
              <Button className="mt-4" onClick={() => window.location.reload()}>
                Reload window
              </Button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
