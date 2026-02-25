// audit.ts — Audit summary generation from JSONL tool call logs

import * as fs from "node:fs";
import * as path from "node:path";

import { nowISO } from "../shared/utils.js";
import type { AuditEntry, AuditDetail } from "./config/types.js";

function formatDetail(d: AuditDetail): string {
  return `- **${d.tool}**: \`${d.input}\`\n  - ${d.ts} — ${d.reason}`;
}

export function generateAuditSummary(worktree: string): void {
  const auditFile = path.join(worktree, "audit-raw.jsonl");
  const outputFile = path.join(worktree, "audit-log.md");

  if (!fs.existsSync(auditFile)) return;

  const lines = fs
    .readFileSync(auditFile, "utf-8")
    .split("\n")
    .filter(l => l.trim());

  if (lines.length === 0) return;

  const flagged: AuditDetail[] = [];
  const high: AuditDetail[] = [];
  const medium: AuditDetail[] = [];
  const low: AuditDetail[] = [];
  let total = 0;

  for (const line of lines) {
    total++;
    let entry: AuditEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const input =
      (entry.input ?? "").length > 120
        ? (entry.input ?? "").slice(0, 120) + "..."
        : (entry.input ?? "");
    const detail: AuditDetail = {
      tool: entry.tool || "?",
      input,
      ts: entry.ts || "?",
      reason: entry.reason || "?",
    };

    if (entry.decision === "flagged") {
      flagged.push(detail);
    } else if (entry.severity === "high" && entry.confidence === "low") {
      high.push(detail);
    } else if (entry.severity === "medium" && entry.confidence === "low") {
      medium.push(detail);
    } else if (entry.severity === "low" && entry.confidence === "high") {
      low.push(detail);
    }
  }

  const now = nowISO();

  // Categories to render
  const categories: { name: string; items: AuditDetail[] }[] = [];
  if (flagged.length > 0) categories.push({ name: "Flagged", items: flagged });
  if (high.length > 0)
    categories.push({ name: "High Severity / Low Confidence", items: high });
  if (medium.length > 0)
    categories.push({
      name: "Medium Severity / Low Confidence",
      items: medium,
    });
  if (low.length > 0)
    categories.push({ name: "Low Severity / High Confidence", items: low });

  // Build full report (written to file)
  const fullLines: string[] = [
    "# Sandbox Audit Summary",
    "",
    `Generated: ${now}  `,
    `Total tool calls: ${total}`,
    "",
    "| Category | Count |",
    "|----------|-------|",
  ];
  for (const cat of categories) {
    fullLines.push(`| ${cat.name} | ${cat.items.length} |`);
  }
  fullLines.push("");
  for (const cat of categories) {
    fullLines.push(`## ${cat.name}`, "");
    for (const item of cat.items) {
      fullLines.push(formatDetail(item));
    }
    fullLines.push("");
  }
  fs.writeFileSync(outputFile, fullLines.join("\n") + "\n");

  // Print to stdout (skip Low Severity / High Confidence — too noisy)
  console.log("# Sandbox Audit Summary");
  console.log("");
  console.log(`Generated: ${now}  `);
  console.log(`Total tool calls: ${total}`);
  console.log("");
  console.log("| Category | Count |");
  console.log("|----------|-------|");
  for (const cat of categories) {
    if (cat.name === "Low Severity / High Confidence") continue;
    console.log(`| ${cat.name} | ${cat.items.length} |`);
  }
  console.log("");
  for (const cat of categories) {
    if (cat.name === "Low Severity / High Confidence") continue;
    console.log(`## ${cat.name}`);
    console.log("");
    for (const item of cat.items) {
      console.log(formatDetail(item));
    }
    console.log("");
  }
}
