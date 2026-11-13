import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import process from "node:process";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  // The built app lives inside the Rust crate, so the crate that is published carries it too and
  // `cargo install` needs no Node: src-tauri/tauri.conf.json embeds this folder.
  build: {
    outDir: "../../src-tauri/web",
    emptyOutDir: true,
  },
  // The editor is loaded only when Code opens a file, so Vite would find it mid-session and
  // re-bundle it, answering the first request with "504 Outdated Optimize Dep" and leaving the
  // file blank. Bundling it at start-up avoids that.
  optimizeDeps: {
    include: ["monaco-editor"],
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
