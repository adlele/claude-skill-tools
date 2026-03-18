// Fetch an ADO work item by ID and format all non-empty fields as markdown context
// Usage: node fetch-ado-item.js --id <work-item-id> [--org <url>]

import { spawnSync } from "node:child_process";
import { die } from "../../shared/ui.js";
import { resolveAdoOrg, normalizeAdoOrg } from "../../shared/config.js";
import { buildFieldSets } from "./config/resolve.js";

// Field sets resolved from defaults + config (repo-level overrides user-level)
const {
  skipKeys: SKIP_KEYS,
  skipPrefixes: SKIP_PREFIXES,
  renderedKeys: RENDERED_KEYS,
  metadataFields: METADATA_FIELDS,
  keyContentFields: KEY_CONTENT_FIELDS,
} = buildFieldSets();

// ── Helpers ────────────────────────────────────────────────

function renderValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return (obj.displayName as string) ?? (obj.uniqueName as string) ?? JSON.stringify(value);
  }
  return String(value);
}

function stripHtml(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function runAz(...azArgs: string[]): string {
  const result = spawnSync("az", azArgs, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`az command failed: ${result.stderr || "unknown error"}`);
  }
  return result.stdout;
}

// ── Exported fetch function ────────────────────────────────

export function fetchAdoItem(workItemId: string, adoOrg: string): string {
  // Validate Azure CLI auth
  const authCheck = spawnSync("az", ["account", "show"], { stdio: "ignore" });
  if (authCheck.status !== 0) {
    throw new Error("Not logged in to Azure CLI. Run 'az login' first.");
  }

  console.error(`Fetching ADO work item #${workItemId} from ${adoOrg}...`);

  const rawJson = runAz(
    "boards",
    "work-item",
    "show",
    "--id",
    workItemId,
    "--org",
    adoOrg,
    "--output",
    "json",
  );

  const workItem = JSON.parse(rawJson) as {
    id: number;
    fields: Record<string, unknown>;
  };
  const f = workItem.fields;

  // ── Format as markdown ───────────────────────────────────

  const lines: string[] = [];

  lines.push(`# ${renderValue(f["System.Title"]) || "Untitled"}`);
  lines.push("");

  lines.push(
    `**Work Item:** #${workItem.id} | **Type:** ${renderValue(f["System.WorkItemType"]) || "Unknown"} | **State:** ${renderValue(f["System.State"]) || "Unknown"}`,
  );
  lines.push("");

  const meta: string[] = [];
  for (const [label, ref] of METADATA_FIELDS) {
    const val = renderValue(f[ref]);
    if (val) meta.push(`${label}: ${val}`);
  }
  if (meta.length > 0) {
    lines.push(meta.join(" | "));
    lines.push("");
  }

  for (const [label, key] of KEY_CONTENT_FIELDS) {
    const val = renderValue(f[key]);
    if (val) {
      lines.push("");
      lines.push(`## ${label}`);
      lines.push("");
      lines.push(val);
    }
  }

  for (const [key, value] of Object.entries(f)) {
    if (RENDERED_KEYS.has(key) || SKIP_KEYS.has(key)) continue;
    if (SKIP_PREFIXES.some((p) => key.startsWith(p))) continue;
    const val = renderValue(value);
    if (!val) continue;
    const shortKey = key.split(".").pop() ?? key;
    lines.push("");
    lines.push(`## ${shortKey}`);
    lines.push("");
    lines.push(val);
  }

  return stripHtml(lines.join("\n"));
}

// ── CLI entrypoint ─────────────────────────────────────────

const isMain = process.argv[1]?.replace(/\.js$/, "").endsWith("fetch");

if (isMain) {
  let workItemId = "";
  let orgOverride = "";
  const cliArgs = process.argv.slice(2);
  for (let j = 0; j < cliArgs.length; j++) {
    switch (cliArgs[j]) {
      case "--id":
        workItemId = cliArgs[++j] ?? "";
        break;
      case "--org":
        orgOverride = cliArgs[++j] ?? "";
        break;
      default:
        die(`Unknown option: ${cliArgs[j]}`);
    }
  }

  if (!workItemId) {
    die("--id is required\nUsage: node fetch-ado-item.js --id <work-item-id> [--org <url>]");
  }

  const adoOrg = orgOverride ? normalizeAdoOrg(orgOverride) : await resolveAdoOrg();
  console.log(fetchAdoItem(workItemId, adoOrg));
}
