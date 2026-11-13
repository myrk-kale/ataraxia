import { I18nProvider } from "@heroui/react";
import React from "react";
import ReactDOM from "react-dom/client";
import { AppShell } from "./app/AppShell";
import { AppearanceProvider } from "./app/appearance/store";
import { Intro } from "./intro/Intro";
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
      <I18nProvider locale="en-US">
        <AppearanceProvider>
          <AppShell />
          <Intro />
        </AppearanceProvider>
      </I18nProvider>
    </React.StrictMode>,
  );
}

void start();
