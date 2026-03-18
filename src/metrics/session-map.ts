import * as fs from "node:fs";
import * as path from "node:path";
import { getConfigDir } from "../shared/paths.js";
import type { ComposerSessionMap, ClaudeSessionEntry } from "./types.js";

function getSessionMapsDir(): string {
  const dir = path.join(getConfigDir(), "session-maps");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getMapFilePath(composerSessionId: string): string {
  return path.join(getSessionMapsDir(), `${composerSessionId}.json`);
}

export function loadSessionMap(
  composerSessionId: string,
): ComposerSessionMap | null {
  const file = getMapFilePath(composerSessionId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as ComposerSessionMap;
  } catch {
    return null;
  }
}

export function createSessionMap(
  composerSessionId: string,
  compositionType: string,
  branch: string,
): ComposerSessionMap {
  const map: ComposerSessionMap = {
    composerSessionId,
    compositionType,
    branch,
    startedAt: new Date().toISOString(),
    claudeSessions: [],
  };
  saveSessionMap(map);
  return map;
}

export function addClaudeSession(
  composerSessionId: string,
  entry: ClaudeSessionEntry,
): void {
  const map = loadSessionMap(composerSessionId);
  if (!map) return; // Gracefully skip if no map (standalone sandbox runs)
  map.claudeSessions.push(entry);
  saveSessionMap(map);
}

function saveSessionMap(map: ComposerSessionMap): void {
  const dir = getSessionMapsDir();
  const file = path.join(dir, `${map.composerSessionId}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export function listAllSessionMaps(): ComposerSessionMap[] {
  const dir = getSessionMapsDir();
  if (!fs.existsSync(dir)) return [];
  const results: ComposerSessionMap[] = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".json"))) {
    try {
      results.push(
        JSON.parse(
          fs.readFileSync(path.join(dir, f), "utf-8"),
        ) as ComposerSessionMap,
      );
    } catch {
      // skip corrupted
    }
  }
  return results;
}

/** Resolve the Claude project directory path(s) for a given worktree path. */
export function claudeProjectDirPaths(worktreePath: string): string[] {
  const home = process.env.HOME ?? "";
  const slug = worktreePath.replace(/\//g, "-");
  const slugNoLeadDash = slug.replace(/^-/, "");
  return [
    path.join(home, ".claude", "projects", slugNoLeadDash),
    path.join(home, ".claude", "projects", slug),
  ];
}
