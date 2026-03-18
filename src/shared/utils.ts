// shared/utils.ts — Common utilities for skill scripts

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

export function nowISO(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Recursively copy a directory or file from src to dest.
 * Silently skips if src does not exist — never throws on missing files.
 */
export function copyDirIfExists(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;

  const stat = fs.statSync(src);
  if (stat.isFile()) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return;
  }

  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    // Skip .state dirs — they contain session-specific data
    if (entry === ".state") continue;
    copyDirIfExists(path.join(src, entry), path.join(dest, entry));
  }
}
