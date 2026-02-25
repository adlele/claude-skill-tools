// Fetch an ADO work item by ID and format all non-empty fields as markdown context
// Usage: node fetch-ado-item.js --id <work-item-id>

import { spawnSync } from "node:child_process";
import { die } from "../shared/utils.js";

const ADO_ORG = "https://dev.azure.com/domoreexp";

// ── Fields to skip (internal/noise) ────────────────────────
const SKIP_KEYS = new Set([
  "System.Id",
  "System.Rev",
  "System.Watermark",
  "System.PersonId",
  "System.AreaId",
  "System.IterationId",
  "System.NodeName",
  "System.TeamProject",
  "System.AuthorizedAs",
  "System.AuthorizedDate",
  "System.RevisedDate",
  "System.CommentCount",
  "System.BoardColumn",
  "System.BoardColumnDone",
  "System.AreaLevel1",
  "System.AreaLevel2",
  "System.AreaLevel3",
  "System.IterationLevel1",
  "System.IterationLevel2",
  "System.IterationLevel3",
  "System.IterationLevel4",
  "System.IterationLevel5",
  "System.IterationLevel6",
  "System.ExternalLinkCount",
  "System.HyperLinkCount",
  "System.AttachedFileCount",
  "System.RelatedLinkCount",
  "System.RemoteLinkCount",
  "System.Parent",
]);

// Fields rendered explicitly in the header or key-content sections
const RENDERED_KEYS = new Set([
  "System.Title",
  "System.Description",
  "System.State",
  "System.WorkItemType",
  "System.AreaPath",
  "System.IterationPath",
  "System.AssignedTo",
  "System.History",
  "System.Tags",
  "System.CreatedDate",
  "System.CreatedBy",
  "System.ChangedDate",
  "System.ChangedBy",
  "System.Reason",
  "Microsoft.VSTS.Common.Priority",
  "Microsoft.VSTS.Common.Severity",
  "Microsoft.VSTS.Common.StateChangeDate",
  "Microsoft.VSTS.Common.ActivatedDate",
  "Microsoft.VSTS.Common.ClosedDate",
  "Microsoft.VSTS.Common.ResolvedDate",
  "Microsoft.VSTS.Common.ActivatedBy",
  "Microsoft.VSTS.Common.ClosedBy",
  "Microsoft.VSTS.Common.ResolvedBy",
  "Microsoft.VSTS.Common.ValueArea",
  "Microsoft.VSTS.TCM.ReproSteps",
  "Microsoft.VSTS.TCM.SystemInfo",
  "Microsoft.VSTS.Common.AcceptanceCriteria",
  "Microsoft.VSTS.Common.Resolution",
]);

// Key content fields rendered in order before the catch-all
const KEY_CONTENT_FIELDS: [string, string][] = [
  ["Description", "System.Description"],
  ["Repro Steps", "Microsoft.VSTS.TCM.ReproSteps"],
  ["Acceptance Criteria", "Microsoft.VSTS.Common.AcceptanceCriteria"],
  ["Resolution", "Microsoft.VSTS.Common.Resolution"],
  ["System Info", "Microsoft.VSTS.TCM.SystemInfo"],
  ["History", "System.History"],
  ["Tags", "System.Tags"],
];

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

export function fetchAdoItem(workItemId: string): string {
  // Validate Azure CLI auth
  const authCheck = spawnSync("az", ["account", "show"], { stdio: "ignore" });
  if (authCheck.status !== 0) {
    throw new Error("Not logged in to Azure CLI. Run 'az login' first.");
  }

  console.error(`Fetching ADO work item #${workItemId}...`);

  const rawJson = runAz(
    "boards",
    "work-item",
    "show",
    "--id",
    workItemId,
    "--org",
    ADO_ORG,
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
  if (f["Microsoft.VSTS.Common.Priority"] != null)
    meta.push(`Priority: ${renderValue(f["Microsoft.VSTS.Common.Priority"])}`);
  if (f["Microsoft.VSTS.Common.Severity"] != null)
    meta.push(`Severity: ${renderValue(f["Microsoft.VSTS.Common.Severity"])}`);
  if (f["System.AreaPath"])
    meta.push(`Area: ${renderValue(f["System.AreaPath"])}`);
  if (f["System.IterationPath"])
    meta.push(`Iteration: ${renderValue(f["System.IterationPath"])}`);
  if (f["System.AssignedTo"])
    meta.push(`Assigned: ${renderValue(f["System.AssignedTo"])}`);
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
    if (key.startsWith("WEF_")) continue;
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

const isMain = process.argv[1]?.replace(/\.js$/, "").endsWith("fetch-ado-item");

if (isMain) {
  let workItemId = "";
  const cliArgs = process.argv.slice(2);
  for (let j = 0; j < cliArgs.length; j++) {
    switch (cliArgs[j]) {
      case "--id":
        workItemId = cliArgs[++j] ?? "";
        break;
      default:
        die(`Unknown option: ${cliArgs[j]}`);
    }
  }

  if (!workItemId) {
    die("--id is required\nUsage: node fetch-ado-item.js --id <work-item-id>");
  }

  console.log(fetchAdoItem(workItemId));
}
