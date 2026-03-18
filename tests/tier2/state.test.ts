import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  writeState,
  readState,
  resolveSessionId,
  listStateSessions,
  deleteSession,
  renameSession,
} from "../../src/composer/state.js";
import { _resetRepoRootCache } from "../../src/shared/paths.js";
import type { SessionState } from "../../src/composer/config/types.js";
import { createTempDir, removeTempDir } from "../helpers/fixtures.js";

const originalCwd = process.cwd();
let tmpDir: string;

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: "test-session-abc123",
    composition: "full",
    currentStep: 0,
    totalSteps: 6,
    status: "in_progress",
    context: "test context",
    model: "opus",
    maxIterations: 5,
    branch: "users/dev/test",
    worktree: "/tmp/worktree",
    adoId: "12345",
    baseBranch: "master",
    stepTimings: [],
    started: "2026-01-01T00:00:00Z",
    updated: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = createTempDir("cst-state-");
  // Create .git directory so resolveRepoRoot finds it
  fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
  process.chdir(tmpDir);
  _resetRepoRootCache();
});

afterAll(() => {
  process.chdir(originalCwd);
  _resetRepoRootCache();
  if (tmpDir) removeTempDir(tmpDir);
});

// Suppress console noise from warn()
vi.spyOn(console, "log").mockImplementation(() => {});

describe("writeState + readState round-trip", () => {
  it("preserves all fields", () => {
    const state = makeState();
    writeState(state);
    const loaded = readState("test-session-abc123");
    expect(loaded.sessionId).toBe(state.sessionId);
    expect(loaded.composition).toBe(state.composition);
    expect(loaded.currentStep).toBe(state.currentStep);
    expect(loaded.totalSteps).toBe(state.totalSteps);
    expect(loaded.status).toBe(state.status);
    expect(loaded.context).toBe(state.context);
    expect(loaded.model).toBe(state.model);
    expect(loaded.maxIterations).toBe(state.maxIterations);
    expect(loaded.branch).toBe(state.branch);
    expect(loaded.worktree).toBe(state.worktree);
    expect(loaded.adoId).toBe(state.adoId);
    expect(loaded.baseBranch).toBe(state.baseBranch);
    expect(loaded.started).toBe(state.started);
  });

  it("sets updated timestamp on write", () => {
    const state = makeState({ updated: "old-value" });
    writeState(state);
    const loaded = readState("test-session-abc123");
    expect(loaded.updated).not.toBe("old-value");
    expect(loaded.updated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("resolveSessionId", () => {
  it("resolves exact match", () => {
    writeState(makeState({ sessionId: "exact-match-id" }));
    expect(resolveSessionId("exact-match-id")).toBe("exact-match-id");
  });

  it("resolves suffix match", () => {
    writeState(makeState({ sessionId: "my-feature-a1b2" }));
    expect(resolveSessionId("a1b2")).toBe("my-feature-a1b2");
  });

  it("resolves prefix match", () => {
    writeState(makeState({ sessionId: "my-feature-a1b2" }));
    expect(resolveSessionId("my-feature")).toBe("my-feature-a1b2");
  });

  it("calls process.exit on ambiguous match", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => { throw new Error("exit"); });
    writeState(makeState({ sessionId: "feature-abc" }));
    writeState(makeState({ sessionId: "feature-abd" }));
    expect(() => resolveSessionId("feature")).toThrow("exit");
    exitSpy.mockRestore();
  });
});

describe("listStateSessions", () => {
  it("returns all sessions", () => {
    writeState(makeState({ sessionId: "session-1" }));
    writeState(makeState({ sessionId: "session-2" }));
    const sessions = listStateSessions();
    const ids = sessions.map(s => s.sessionId);
    expect(ids).toContain("session-1");
    expect(ids).toContain("session-2");
  });

  it("skips corrupted JSON files", () => {
    writeState(makeState({ sessionId: "good-session" }));
    const stateDir = path.join(tmpDir, ".claude", ".skill-state", "composer");
    fs.writeFileSync(path.join(stateDir, "bad.json"), "not valid json{{{");
    const sessions = listStateSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("good-session");
  });
});

describe("deleteSession", () => {
  it("removes the session file", () => {
    writeState(makeState({ sessionId: "to-delete" }));
    expect(deleteSession("to-delete")).toBe(true);
    const sessions = listStateSessions();
    expect(sessions.find(s => s.sessionId === "to-delete")).toBeUndefined();
  });

  it("returns false for non-existent session", () => {
    expect(deleteSession("nonexistent")).toBe(false);
  });
});

describe("renameSession", () => {
  it("renames session: old gone, new exists with updated ID", () => {
    const state = makeState({ sessionId: "old-name" });
    writeState(state);
    renameSession("old-name", "new-name", state);

    const stateDir = path.join(tmpDir, ".claude", ".skill-state", "composer");
    expect(fs.existsSync(path.join(stateDir, "old-name.json"))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "new-name.json"))).toBe(true);

    const loaded = readState("new-name");
    expect(loaded.sessionId).toBe("new-name");
  });
});
