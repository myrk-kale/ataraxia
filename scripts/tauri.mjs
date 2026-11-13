// Runs the Tauri CLI from src-tauri, on any system (`pnpm tauri dev`, `pnpm tauri build`, ...).
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const windows = process.platform === "win32";
const bin = join(root, "apps", "desktop", "node_modules", ".bin", windows ? "tauri.cmd" : "tauri");

const result = spawnSync(bin, process.argv.slice(2), {
  cwd: join(root, "src-tauri"),
  stdio: "inherit",
  // A .cmd file can only be run through the shell on Windows.
  shell: windows,
});
if (result.error) {
  console.error(`could not run ${bin}: ${result.error.message}. Did you run \`pnpm install\`?`);
  process.exit(1);
}
process.exit(result.status ?? 1);
