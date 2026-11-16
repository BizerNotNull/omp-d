import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installDiagnostics } from "./lib/diagnostics";
import "./index.css";

const uninstallDiagnostics = installDiagnostics();
if (import.meta.hot) import.meta.hot.dispose(uninstallDiagnostics);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
