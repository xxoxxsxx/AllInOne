import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const repoRoot = path.resolve(__dirname, "..");

function parseEnvFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, "");

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

export function loadEnvFiles() {
  const candidates = [
    path.join(repoRoot, ".env.local"),
    path.join(repoRoot, ".env"),
  ];

  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      parseEnvFile(filePath);
    }
  }
}

export function getDatabaseUrl() {
  loadEnvFiles();

  const value = process.env.DATABASE_URL;
  if (!value) {
    throw new Error(
      "DATABASE_URL is required. Set it in the environment or in .env.local.",
    );
  }

  return value;
}

export function createClient() {
  return new Client({
    connectionString: getDatabaseUrl(),
  });
}

export function readSqlFiles(relativeDir) {
  const directory = path.join(repoRoot, relativeDir);
  const files = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  return files.map((name) => ({
    name,
    sql: fs.readFileSync(path.join(directory, name), "utf8"),
  }));
}
