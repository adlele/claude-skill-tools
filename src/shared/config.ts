// shared/config.ts — Configuration with repo-level overrides and user-level fallback

import * as fs from "node:fs";
import { getConfigFilePath, getRepoConfigFilePath } from "./paths.js";
import { promptUser } from "./utils.js";

// ── Config types ─────────────────────────────────────────────

export interface ToolConfig {
  adoOrg?: string;
  adoFields?: {
    skipFields?: Partial<{ system: string[]; template: string[]; custom: string[] }>;
    skipPrefixes?: string[];
    renderedFields?: Partial<{ system: string[]; template: string[]; custom: string[] }>;
    metadataFields?: { label: string; fieldRef: string; category: string }[];
    contentFields?: { label: string; fieldRef: string; category: string }[];
  };
}

// ── Read / Write ─────────────────────────────────────────────

/** Read only the user-level config (~/claude-skill-tools/config.json). */
export function readUserConfig(): ToolConfig {
  const file = getConfigFilePath();
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return {};
  }
}

/** Read repo-level config (<repo>/.claude/.skill-state/config.json) if it exists. */
function readRepoConfig(): ToolConfig {
  const file = getRepoConfigFilePath();
  if (!file) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Read merged config: repo-level overrides user-level per field.
 * For adoFields, sub-keys are merged (repo sub-keys override user sub-keys).
 */
export function readConfig(): ToolConfig {
  const user = readUserConfig();
  const repo = readRepoConfig();

  const merged: ToolConfig = { ...user, ...repo };

  // Deep merge for adoFields if both sides have it
  if (user.adoFields && repo.adoFields) {
    merged.adoFields = { ...user.adoFields, ...repo.adoFields };
  }

  return merged;
}

export function writeConfig(cfg: ToolConfig): void {
  const file = getConfigFilePath();
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
}

// ── Config countdown ─────────────────────────────────────────

/**
 * Show a countdown with a config value. Auto-proceeds on timeout.
 * Returns true if timeout (proceed), false if user pressed any key (interrupt).
 */
function configCountdown(label: string, value: string, seconds: number): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(true);

  return new Promise<boolean>(resolve => {
    let remaining = seconds;
    let settled = false;

    const settle = (proceed: boolean) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      if (process.stdout.isTTY) {
        process.stdout.write("\r\x1b[2K");
      }
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      resolve(proceed);
    };

    const render = () => {
      if (process.stdout.isTTY) {
        const dots = ".".repeat(remaining);
        process.stdout.write(
          `\r\x1b[2K  \x1b[2m${label}:\x1b[0m ${value}  \x1b[2mAuto-proceeding in\x1b[0m \x1b[1m${remaining}\x1b[0m${dots} \x1b[2m(press any key to change)\x1b[0m`,
        );
      }
    };

    const onData = () => {
      settle(false);
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);

    render();
    const timer = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        settle(true);
        console.log("");
      } else {
        render();
      }
    }, 1000);
  });
}

// ── ADO org normalization ─────────────────────────────────────

/**
 * Normalize user input to a full ADO org URL.
 * Accepts either a bare org name ("myorg") or a full URL ("https://dev.azure.com/myorg").
 */
export function normalizeAdoOrg(input: string): string {
  const trimmed = input.trim();
  if (/^https?:\/\//.test(trimmed)) return trimmed.replace(/\/+$/, "");
  return `https://dev.azure.com/${trimmed}`;
}

// ── ADO org resolution ───────────────────────────────────────

/**
 * Resolve the ADO organization URL. Reads from config, prompts if missing,
 * shows a countdown timer if already configured.
 * Accepts either a bare org name or full URL.
 */
export async function resolveAdoOrg(): Promise<string> {
  const cfg = readConfig();

  if (!cfg.adoOrg) {
    console.log("  No ADO organization configured.");
    const org = await promptUser(
      "  Enter ADO org name or URL (e.g. myorg or https://dev.azure.com/myorg): ",
    );
    if (!org.trim()) {
      console.error("ERROR: ADO org is required.");
      process.exit(1);
    }
    cfg.adoOrg = normalizeAdoOrg(org);
    writeConfig(cfg);
    console.log(`  Saved ${cfg.adoOrg} to ${getConfigFilePath()}`);
    return cfg.adoOrg;
  }

  const proceed = await configCountdown("ADO org", cfg.adoOrg, 5);
  if (proceed) {
    return cfg.adoOrg;
  }

  const newOrg = await promptUser(
    `  Enter ADO org name or URL (or press Enter to keep ${cfg.adoOrg}): `,
  );
  if (newOrg.trim()) {
    cfg.adoOrg = normalizeAdoOrg(newOrg);
    writeConfig(cfg);
    console.log(`  Updated to ${cfg.adoOrg} — saved to ${getConfigFilePath()}`);
  }
  return cfg.adoOrg;
}
