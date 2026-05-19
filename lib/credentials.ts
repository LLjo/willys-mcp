import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function readCredentialsFile():
  | { username: string; password: string }
  | null {
  const path = process.env.WILLYS_CREDENTIALS_PATH
    ? resolve(process.env.WILLYS_CREDENTIALS_PATH)
    : resolve(process.cwd(), ".credentials");
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return null;
  return { username: lines[0], password: lines[1] };
}
