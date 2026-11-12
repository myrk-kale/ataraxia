import React from "react";
import ReactDOM from "react-dom/client";
import { AppShell } from "./app/AppShell";
import { Imprint } from "./intro/Imprint";
import { introEnabled } from "./intro/timeline";
import "./styles/index.css";

async function start() {
  if (introEnabled()) {
    document.documentElement.setAttribute("data-intro-running", "");
  }
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    await import("./dev/tauriMock");
  }
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <AppShell />
      <Imprint />
    </React.StrictMode>,
  );
}

void start();
