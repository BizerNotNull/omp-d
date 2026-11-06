import { AppShell } from "@/components/app/AppShell";
import { ErrorBoundary } from "@/components/app/ErrorBoundary";

export default function App() {
  return (
    <ErrorBoundary>
      <AppShell />
    </ErrorBoundary>
  );
}
