import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionState } from "./config/types.js";
import { getComposerStateDir } from "../shared/paths.js";
import { composerDie } from "./ui.js";

// Re-export shared utilities so existing imports from "./state" keep working
export { nowISO, promptUser } from "../shared/utils.js";
import { nowISO } from "../shared/utils.js";

// Re-export composerDie as die so all existing die() call sites get formatted output
export { composerDie as die } from "./ui.js";

// Module-level reference to the active session for signal handler access
export let currentSession: SessionState | null = null;

export function setCurrentSession(session: SessionState | null): void {
  currentSession = session;
}

export function writeState(state: SessionState): void {
  const stateDir = getComposerStateDir();
  const file = path.join(stateDir, `${state.sessionId}.json`);
  state.updated = nowISO();
  state.stepTimings ??= [];
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
}

export function resolveSessionId(partial: string): string {
  const stateDir = getComposerStateDir();
  // Exact match first
  const exact = path.join(stateDir, `${partial}.json`);
  if (fs.existsSync(exact)) return partial;

  // Suffix match (short hash like "6a63")
  if (!fs.existsSync(stateDir))
    composerDie(`No session found matching '${partial}'`);
  const matches = fs
    .readdirSync(stateDir)
    .filter(f => f.endsWith(".json"))
    .map(f => f.replace(/\.json$/, ""))
    .filter(id => id.endsWith(partial) || id.startsWith(partial));

  if (matches.length === 1) return matches[0];
  if (matches.length === 0)
    composerDie(`No session found matching '${partial}'`);
  composerDie(
    `Ambiguous ID '${partial}' matches ${matches.length} sessions:\n` +
      matches.map(m => `  - ${m}`).join("\n"),
  );
}

export function readState(sessionId: string): SessionState {
  const stateDir = getComposerStateDir();
  const resolved = resolveSessionId(sessionId);
  const file = path.join(stateDir, `${resolved}.json`);
  const state = JSON.parse(fs.readFileSync(file, "utf-8")) as SessionState;
  state.stepTimings ??= [];
  return state;
}

export function listStateSessions(): SessionState[] {
  const stateDir = getComposerStateDir();
  if (!fs.existsSync(stateDir)) return [];
  return fs
    .readdirSync(stateDir)
    .filter(f => f.endsWith(".json"))
    .map(f => {
      const state = JSON.parse(
        fs.readFileSync(path.join(stateDir, f), "utf-8"),
      ) as SessionState;
      state.stepTimings ??= [];
      return state;
    });
}

export function renameSession(
  oldId: string,
  newId: string,
  state: SessionState,
): void {
  const stateDir = getComposerStateDir();
  const oldFile = path.join(stateDir, `${oldId}.json`);
  state.sessionId = newId;
  state.updated = nowISO();
  const newFile = path.join(stateDir, `${newId}.json`);
  fs.writeFileSync(newFile, JSON.stringify(state, null, 2) + "\n");
  if (fs.existsSync(oldFile) && oldFile !== newFile) {
    fs.unlinkSync(oldFile);
  }
}

export function deleteSession(sessionId: string): boolean {
  const stateDir = getComposerStateDir();
  const file = path.join(stateDir, `${sessionId}.json`);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}
