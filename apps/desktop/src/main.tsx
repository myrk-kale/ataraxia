import React from "react";
import ReactDOM from "react-dom/client";
import { AppShell } from "./app/AppShell";
import "./styles/index.css";

async function start() {
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    await import("./dev/tauriMock");
  }
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <AppShell />
    </React.StrictMode>,
  );
}

void start();
