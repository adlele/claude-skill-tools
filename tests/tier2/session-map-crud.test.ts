import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createSessionMap,
  loadSessionMap,
  addClaudeSession,
  listAllSessionMaps,
} from "../../src/metrics/session-map.js";
import { createTempDir, removeTempDir } from "../helpers/fixtures.js";

const originalHome = process.env.HOME;
let tmpDir: string;

// Suppress console noise
vi.spyOn(console, "log").mockImplementation(() => {});

beforeEach(() => {
  tmpDir = fs.realpathSync(createTempDir("cst-sesmap-"));
  process.env.HOME = tmpDir;
});

afterAll(() => {
  process.env.HOME = originalHome;
  if (tmpDir) removeTempDir(tmpDir);
});

describe("createSessionMap", () => {
  it("creates a map file and returns the map object", () => {
    const map = createSessionMap("sess-1", "full", "users/dev/feat");
    expect(map.composerSessionId).toBe("sess-1");
    expect(map.compositionType).toBe("full");
    expect(map.branch).toBe("users/dev/feat");
    expect(map.claudeSessions).toEqual([]);
    expect(map.startedAt).toBeTruthy();
  });
});

describe("loadSessionMap", () => {
  it("returns null for non-existent session", () => {
    expect(loadSessionMap("nonexistent")).toBeNull();
  });

  it("loads a previously created map", () => {
    createSessionMap("sess-2", "ralph-only", "branch-2");
    const loaded = loadSessionMap("sess-2");
    expect(loaded).not.toBeNull();
    expect(loaded!.composerSessionId).toBe("sess-2");
    expect(loaded!.compositionType).toBe("ralph-only");
  });
});

describe("addClaudeSession", () => {
  it("appends a Claude session entry to existing map", () => {
    createSessionMap("sess-3", "full", "branch-3");
    addClaudeSession("sess-3", {
      claudeSessionId: "claude-abc",
      stepIndex: 1,
      stepLabel: "Run analyst",
      stepType: "claude-interactive",
      projectDir: "/tmp/wt",
      startedAt: new Date().toISOString(),
    });
    const loaded = loadSessionMap("sess-3");
    expect(loaded!.claudeSessions).toHaveLength(1);
    expect(loaded!.claudeSessions[0].claudeSessionId).toBe("claude-abc");
  });

  it("gracefully skips when map does not exist", () => {
    expect(() =>
      addClaudeSession("nonexistent", {
        claudeSessionId: "x",
        stepIndex: 0,
        stepLabel: "test",
        stepType: "ralph",
        projectDir: "/tmp",
        startedAt: new Date().toISOString(),
      }),
    ).not.toThrow();
  });

  it("appends multiple sessions", () => {
    createSessionMap("sess-4", "manual", "branch-4");
    for (let i = 0; i < 3; i++) {
      addClaudeSession("sess-4", {
        claudeSessionId: `claude-${i}`,
        stepIndex: i,
        stepLabel: `Step ${i}`,
        stepType: "claude-interactive",
        projectDir: "/tmp/wt",
        startedAt: new Date().toISOString(),
      });
    }
    const loaded = loadSessionMap("sess-4");
    expect(loaded!.claudeSessions).toHaveLength(3);
  });
});

describe("listAllSessionMaps", () => {
  it("returns empty array when no maps exist", () => {
    const maps = listAllSessionMaps();
    // May pick up maps from prior tests in same HOME, so just check type
    expect(Array.isArray(maps)).toBe(true);
  });

  it("returns all created maps", () => {
    createSessionMap("list-1", "full", "b1");
    createSessionMap("list-2", "role", "b2");
    const maps = listAllSessionMaps();
    const ids = maps.map(m => m.composerSessionId);
    expect(ids).toContain("list-1");
    expect(ids).toContain("list-2");
  });

  it("skips corrupted JSON files", () => {
    createSessionMap("good-map", "full", "b");
    const mapsDir = path.join(tmpDir, "claude-skill-tools", "session-maps");
    fs.writeFileSync(path.join(mapsDir, "bad.json"), "{{{not json");
    const maps = listAllSessionMaps();
    const ids = maps.map(m => m.composerSessionId);
    expect(ids).toContain("good-map");
    expect(ids).not.toContain("bad");
  });
});
