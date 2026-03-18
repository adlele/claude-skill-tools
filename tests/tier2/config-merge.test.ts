import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  readUserConfig,
  readConfig,
  writeConfig,
} from "../../src/shared/config.js";
import { _resetRepoRootCache } from "../../src/shared/paths.js";
import { createTempDir, removeTempDir, writeJson } from "../helpers/fixtures.js";

const originalCwd = process.cwd();
const originalHome = process.env.HOME;
let tmpDir: string;
let fakeHome: string;

// Suppress console noise
vi.spyOn(console, "log").mockImplementation(() => {});

beforeEach(() => {
  tmpDir = createTempDir("cst-config-");
  fakeHome = path.join(tmpDir, "home");
  fs.mkdirSync(fakeHome, { recursive: true });
  process.env.HOME = fakeHome;

  // Create .git directory so resolveRepoRoot finds it
  const repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
  process.chdir(repoDir);
  _resetRepoRootCache();
});

afterAll(() => {
  process.chdir(originalCwd);
  process.env.HOME = originalHome;
  _resetRepoRootCache();
  if (tmpDir) removeTempDir(tmpDir);
});

describe("readUserConfig", () => {
  it("returns empty object when no file exists", () => {
    expect(readUserConfig()).toEqual({});
  });
});

describe("writeConfig + readUserConfig round-trip", () => {
  it("persists and reads back config", () => {
    writeConfig({ adoOrg: "https://dev.azure.com/testorg" });
    const cfg = readUserConfig();
    expect(cfg.adoOrg).toBe("https://dev.azure.com/testorg");
  });
});

describe("readConfig merge", () => {
  it("repo adoOrg overrides user adoOrg", () => {
    writeConfig({ adoOrg: "https://dev.azure.com/user-org" });

    const repoDir = path.join(tmpDir, "repo");
    writeJson(
      path.join(repoDir, ".claude", ".skill-state", "config.json"),
      { adoOrg: "https://dev.azure.com/repo-org" },
    );
    _resetRepoRootCache();

    const cfg = readConfig();
    expect(cfg.adoOrg).toBe("https://dev.azure.com/repo-org");
  });

  it("deep merges adoFields sub-keys", () => {
    writeConfig({
      adoFields: {
        skipFields: { system: ["System.Id"] },
      },
    });

    const repoDir = path.join(tmpDir, "repo");
    writeJson(
      path.join(repoDir, ".claude", ".skill-state", "config.json"),
      {
        adoFields: {
          renderedFields: { system: ["System.Description"] },
        },
      },
    );
    _resetRepoRootCache();

    const cfg = readConfig();
    expect(cfg.adoFields?.renderedFields?.system).toEqual([
      "System.Description",
    ]);
    // User's skipFields should still be present (merged from user config)
    // The deep merge uses spread: {...user.adoFields, ...repo.adoFields}
    // Since repo doesn't have skipFields, user's skipFields should survive
    expect(cfg.adoFields?.skipFields?.system).toEqual(["System.Id"]);
  });

  it("falls back to user-only config when no repo config exists", () => {
    writeConfig({ adoOrg: "https://dev.azure.com/user-only" });
    _resetRepoRootCache();

    const cfg = readConfig();
    expect(cfg.adoOrg).toBe("https://dev.azure.com/user-only");
  });
});
