import { spawn } from "node:child_process";
import { runMigrations } from "./db-migrate.mjs";

await runMigrations();

const child = spawn(process.execPath, ["server.js"], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}
