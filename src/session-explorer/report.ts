// session-explorer/report.ts — Generates a self-contained HTML report with
// embedded CSS + vanilla JS. Two tabs: Metrics and Timeline.

import { formatCost, computeCost } from "../metrics/session-metrics.js";
import type {
  SessionAnalysis,
  SessionListEntry,
  TokenUsage,
  ModelTokens,
} from "./types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDuration(ms: number): string {
  if (ms < 0) return "0s";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `${hours}h ${remainMins}m`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function totalTokensFor(m: TokenUsage): number {
  return (
    m.inputTokens + m.outputTokens + m.cacheCreationTokens + m.cacheReadTokens
  );
}

function cleanDescription(desc: string): string {
  return desc
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const CATEGORY_COLORS: Record<string, string> = {
  "code-editing": "#58a6ff",
  exploration: "#3fb950",
  "git-operations": "#f97583",
  testing: "#d2a8ff",
  planning: "#f0883e",
  "shell-commands": "#79c0ff",
  conversation: "#8b949e",
  other: "#6e7681",
};

// ─── Report generator ───────────────────────────────────────────────────────

export function generateReport(analysis: SessionAnalysis): string {
  const a = analysis;
  const tokens = totalTokensFor(a.totalTokens);
  const activePercent =
    a.wallClockMs > 0
      ? ((a.activeTimeMs / a.wallClockMs) * 100).toFixed(1)
      : "0";

  // ── Metrics tab content ──

  const overviewCards = `
    <div class="metrics-cards">
      <div class="card"><div class="card-value cost-value">${formatCost(a.cost)}</div><div class="card-label">Est. Cost</div></div>
      <div class="card"><div class="card-value">${formatTokens(tokens)}</div><div class="card-label">Total Tokens</div></div>
      <div class="card"><div class="card-value">${formatDuration(a.wallClockMs)}</div><div class="card-label">Wall Clock</div></div>
      <div class="card"><div class="card-value">${formatDuration(a.activeTimeMs)}</div><div class="card-label">Active (${activePercent}%)</div></div>
      <div class="card"><div class="card-value">${a.userTurns}</div><div class="card-label">User Turns</div></div>
      <div class="card"><div class="card-value">${a.assistantTurns}</div><div class="card-label">Assistant Turns</div></div>
    </div>`;

  // Token breakdown stacked bar
  const tokenParts = [
    { label: "Input", value: a.totalTokens.inputTokens, color: "#58a6ff" },
    { label: "Output", value: a.totalTokens.outputTokens, color: "#3fb950" },
    {
      label: "Cache Create",
      value: a.totalTokens.cacheCreationTokens,
      color: "#f0883e",
    },
    {
      label: "Cache Read",
      value: a.totalTokens.cacheReadTokens,
      color: "#d2a8ff",
    },
  ];
  const tokenTotal = tokens || 1;
  const tokenBarHtml = tokenParts
    .map(
      (p) =>
        `<div class="stacked-seg" style="width:${(p.value / tokenTotal) * 100}%;background:${p.color}" title="${p.label}: ${formatTokens(p.value)}"></div>`,
    )
    .join("");
  const tokenLegendHtml = tokenParts
    .map(
      (p) =>
        `<span class="legend-item"><span class="legend-dot" style="background:${p.color}"></span>${p.label}: ${formatTokens(p.value)}</span>`,
    )
    .join("");

  // Cost by model bars
  const modelCosts = Object.entries(a.modelTokens)
    .map(([model, tok]) => ({
      model,
      cost: computeCost({ [model]: tok }),
      tokens: totalTokensFor(tok),
    }))
    .sort((a, b) => b.cost - a.cost);
  const maxModelCost = modelCosts.length > 0 ? modelCosts[0].cost : 1;
  const modelBarsHtml = modelCosts
    .map(
      ({ model, cost }) =>
        `<div class="bar-row"><span class="bar-label">${esc(model)}</span><div class="bar-track"><div class="bar-fill" style="width:${(cost / maxModelCost) * 100}%;background:#f97583"></div></div><span class="bar-value">${formatCost(cost)}</span></div>`,
    )
    .join("");

  // Tool usage bars
  const sortedTools = Object.entries(a.toolCalls).sort((a, b) => b[1] - a[1]);
  const maxToolCount = sortedTools.length > 0 ? sortedTools[0][1] : 1;
  const toolBarsHtml = sortedTools
    .map(
      ([name, count]) =>
        `<div class="bar-row"><span class="bar-label">${esc(name)}</span><div class="bar-track"><div class="bar-fill" style="width:${(count / maxToolCount) * 100}%;background:#58a6ff"></div></div><span class="bar-value">${count}</span></div>`,
    )
    .join("");

  // Task categories
  const categoryCounts: Record<string, number> = {};
  for (const t of a.tasks) {
    categoryCounts[t.category] = (categoryCounts[t.category] ?? 0) + 1;
  }
  const sortedCats = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1]);
  const maxCatCount = sortedCats.length > 0 ? sortedCats[0][1] : 1;
  const catBarsHtml = sortedCats
    .map(
      ([cat, count]) =>
        `<div class="bar-row"><span class="bar-label">${esc(cat)}</span><div class="bar-track"><div class="bar-fill" style="width:${(count / maxCatCount) * 100}%;background:${CATEGORY_COLORS[cat] ?? "#6e7681"}"></div></div><span class="bar-value">${count}</span></div>`,
    )
    .join("");

  // Subagent summary table
  let subagentHtml = "";
  if (a.subagents.length > 0) {
    const subRows = a.subagents
      .map(
        (s) =>
          `<tr><td><span class="badge" style="background:#d2a8ff">${esc(s.agentType)}</span></td><td>${formatTokens(totalTokensFor(s.tokenUsage))}</td><td>${formatCost(s.cost)}</td><td>${s.eventCount}</td><td class="tools-cell">${Object.entries(
            s.toolCalls,
          )
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([n, c]) => `${esc(n)}(${c})`)
            .join(", ")}</td></tr>`,
      )
      .join("");
    subagentHtml = `
      <h3 style="margin-top:24px">Subagents (${a.subagents.length})</h3>
      <table class="tasks-table">
        <thead><tr><th>Type</th><th>Tokens</th><th>Cost</th><th>Events</th><th>Top Tools</th></tr></thead>
        <tbody>${subRows}</tbody>
      </table>`;
  }

  // Tasks table
  let tasksHtml = "";
  if (a.tasks.length > 0) {
    const taskRows = a.tasks
      .map((t) => {
        const tTokens = totalTokensFor(t);
        const tToolCount = Object.values(t.toolCalls).reduce(
          (a, b) => a + b,
          0,
        );
        const desc = cleanDescription(t.description);
        const toolStr = Object.entries(t.toolCalls)
          .sort((a, b) => b[1] - a[1])
          .map(([n, c]) => `${esc(n)}(${c})`)
          .join(", ");
        return `<tr>
          <td>${t.index}</td>
          <td><span class="badge" style="background:${CATEGORY_COLORS[t.category] ?? "#6e7681"}">${esc(t.category)}</span></td>
          <td>${formatDuration(t.wallClockMs)}</td>
          <td>${formatTokens(tTokens)}</td>
          <td>${formatCost(t.cost)}</td>
          <td>${tToolCount}</td>
          <td class="desc-cell" title="${esc(desc)}">${esc(desc.length > 80 ? desc.slice(0, 77) + "..." : desc)}</td>
          <td class="tools-cell">${toolStr}</td>
        </tr>`;
      })
      .join("");

    tasksHtml = `
      <h3 style="margin-top:24px">Tasks (${a.tasks.length})</h3>
      <table class="tasks-table">
        <thead><tr><th>#</th><th>Category</th><th>Duration</th><th>Tokens</th><th>Cost</th><th>Tools</th><th>Description</th><th>Tool Breakdown</th></tr></thead>
        <tbody>${taskRows}</tbody>
      </table>`;
  }

  const metricsTabContent = `
    ${overviewCards}
    <div class="charts-row">
      <div class="chart-box">
        <h3>Token Breakdown</h3>
        <div class="stacked-bar">${tokenBarHtml}</div>
        <div class="legend">${tokenLegendHtml}</div>
      </div>
      <div class="chart-box">
        <h3>Cost by Model</h3>
        <div class="chart-scroll">${modelBarsHtml || '<p class="muted">No model data</p>'}</div>
      </div>
    </div>
    <div class="charts-row">
      <div class="chart-box">
        <h3>Tool Usage</h3>
        <div class="chart-scroll">${toolBarsHtml || '<p class="muted">No tool calls</p>'}</div>
      </div>
      <div class="chart-box">
        <h3>Task Categories</h3>
        <div class="chart-scroll">${catBarsHtml || '<p class="muted">No tasks</p>'}</div>
      </div>
    </div>
    ${subagentHtml}
    ${tasksHtml}`;

  // ── Build the full HTML ──

  const title = a.customTitle || a.slug || a.sessionId.slice(0, 8);
  const createdDate = a.created
    ? a.created.slice(0, 16).replace("T", " ")
    : "—";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Session: ${esc(title)}</title>
<style>
${CSS}
</style>
</head>
<body>

<nav class="top-nav">
  <div class="nav-left">
    <h1>${esc(title)}</h1>
    <span class="nav-meta">Branch: <strong>${esc(a.gitBranch || "—")}</strong></span>
    <span class="nav-meta">${createdDate}</span>
    <span class="nav-meta"><code>${esc(a.sessionId.slice(0, 12))}...</code></span>
  </div>
  <div class="nav-right">
    <span class="nav-meta">${formatCost(a.cost)} | ${formatTokens(tokens)} tokens | ${formatDuration(a.wallClockMs)}</span>
  </div>
</nav>

<div class="tab-bar">
  <button class="tab active" data-tab="metrics" onclick="switchTab('metrics')">Metrics</button>
  <button class="tab" data-tab="timeline" onclick="switchTab('timeline')">Timeline (${a.timeline.length})</button>
</div>

<div class="container">
  <div id="tab-metrics" class="tab-content active">
    ${metricsTabContent}
  </div>

  <div id="tab-timeline" class="tab-content" style="display:none">
    <div class="tl-controls">
      <div class="tl-filters">
        <button class="filter-btn active" data-filter="all" onclick="setFilter('all')">All</button>
        <button class="filter-btn" data-filter="user" onclick="setFilter('user')">User</button>
        <button class="filter-btn" data-filter="claude" onclick="setFilter('claude')">Claude</button>
        <button class="filter-btn" data-filter="tools" onclick="setFilter('tools')">Tools</button>
      </div>
      <div class="tl-view-toggle">
        <button class="view-btn active" data-view="chat" onclick="setView('chat')" title="Chat view">&#9776;</button>
        <button class="view-btn" data-view="table" onclick="setView('table')" title="Table view">&#9866;</button>
      </div>
      <input type="text" class="tl-search" placeholder="Search timeline..." oninput="onSearch(this.value)" />
      <label class="tl-toggle"><input type="checkbox" id="show-thinking" onchange="toggleThinking(this.checked)" /> Show thinking blocks</label>
      <span class="tl-count" id="tl-count"></span>
    </div>
    <div id="timeline-list" class="tl-list view-chat"></div>
    <button id="load-more-btn" class="load-more-btn" onclick="loadMore()" style="display:none">Load more</button>
  </div>
</div>

<div class="generated">Generated by session-explorer</div>

<script>
// ── Embedded data ──
var DATA = ${JSON.stringify({
    timeline: a.timeline,
    fullResults: a.fullResults,
  })};

// ── State ──
var visibleCount = 100;
var currentFilter = 'all';
var searchText = '';
var showThinking = false;
var expandedSet = {};
var currentView = 'chat';

${TIMELINE_JS}
</script>
</body>
</html>`;
}

// ─── CSS ────────────────────────────────────────────────────────────────────

const CSS = `
:root {
  --bg: #0d1117; --bg2: #161b22; --bg3: #21262d; --border: #30363d;
  --text: #e6edf3; --text2: #8b949e; --accent: #58a6ff; --cost: #f97583;
  --user-color: #58a6ff; --assistant-color: #3fb950; --tool-color: #f0883e;
  --thinking-color: #d2a8ff; --result-color: #8b949e; --system-color: #f97583;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; overflow-y: scroll; }
code { background: var(--bg3); padding: 2px 6px; border-radius: 4px; font-size: 0.85em; }

/* Nav */
.top-nav { position: sticky; top: 0; z-index: 100; background: var(--bg2); border-bottom: 1px solid var(--border); padding: 14px 24px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
.nav-left { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.nav-left h1 { font-size: 1.15rem; font-weight: 700; }
.nav-right { color: var(--text2); font-size: 0.85rem; }
.nav-meta { color: var(--text2); font-size: 0.85rem; }

/* Tabs */
.tab-bar { position: sticky; top: 49px; z-index: 99; background: var(--bg); border-bottom: 1px solid var(--border); padding: 0 24px; display: flex; gap: 0; }
.tab { background: none; border: none; color: var(--text2); font-size: 0.9rem; padding: 12px 20px; cursor: pointer; border-bottom: 2px solid transparent; transition: color 0.15s, border-color 0.15s; }
.tab:hover { color: var(--text); }
.tab.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }

.container { max-width: 1400px; margin: 0 auto; padding: 24px; width: 100%; overflow: hidden; }
.tab-content { display: none; }
.tab-content.active { display: block; }

/* Metrics cards */
.metrics-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px; margin-bottom: 28px; }
.card { border: none; border-radius: 12px; padding: 20px; text-align: left; position: relative; overflow: hidden; }
.card::before { content: ''; position: absolute; top: 0; right: 0; width: 60px; height: 60px; border-radius: 50%; background: rgba(255,255,255,0.08); transform: translate(20px, -20px); }
.card-value { font-size: 1.5rem; font-weight: 700; color: #fff; }
.card-label { font-size: 0.75rem; color: rgba(255,255,255,0.7); margin-top: 6px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 500; }
.card:nth-child(1) { background: linear-gradient(135deg, #e74c6f, #c62a52); }
.card:nth-child(2) { background: linear-gradient(135deg, #2bbaa0, #1a9680); }
.card:nth-child(3) { background: linear-gradient(135deg, #7c5cbf, #6344a3); }
.card:nth-child(4) { background: linear-gradient(135deg, #e8873a, #d06b1f); }
.card:nth-child(5) { background: linear-gradient(135deg, #4a90d9, #3572b0); }
.card:nth-child(6) { background: linear-gradient(135deg, #d94a8e, #b83574); }
.cost-value { color: #fff !important; }

/* Charts */
.charts-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
@media (max-width: 800px) { .charts-row { grid-template-columns: 1fr; } }
.chart-box { background: var(--bg2); border: 1px solid var(--border); border-radius: 12px; padding: 20px; overflow: hidden; min-width: 0; }
.chart-box h3 { font-size: 0.9rem; margin-bottom: 14px; color: var(--text2); text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; }
.chart-scroll { max-height: 200px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--bg3) transparent; }

.stacked-bar { display: flex; height: 28px; border-radius: 6px; overflow: hidden; margin-bottom: 10px; }
.stacked-seg { min-width: 2px; transition: width 0.3s; }
.stacked-seg:hover { opacity: 0.8; }
.legend { display: flex; flex-wrap: wrap; gap: 12px; font-size: 0.8rem; color: var(--text2); }
.legend-item { display: flex; align-items: center; gap: 4px; }
.legend-dot { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }

.bar-row { display: flex; align-items: center; margin-bottom: 8px; min-width: 0; }
.bar-label { width: 120px; min-width: 120px; font-size: 0.8rem; color: var(--text2); text-align: right; padding-right: 12px; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar-track { flex: 1; min-width: 0; background: var(--bg3); border-radius: 4px; height: 18px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 4px; transition: width 0.3s; }
.bar-value { min-width: 60px; width: 60px; font-size: 0.8rem; color: var(--text2); text-align: right; padding-left: 8px; flex-shrink: 0; white-space: nowrap; }

/* Tables */
.tasks-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; margin-top: 12px; background: var(--bg2); border-radius: 12px; overflow: hidden; }
.tasks-table th { text-align: left; padding: 10px 12px; border-bottom: 2px solid var(--border); color: var(--text2); font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; }
.tasks-table td { padding: 8px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
.tasks-table tr:last-child td { border-bottom: none; }
.tasks-table tr:hover td { background: rgba(255,255,255,0.02); }
.desc-cell { max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tools-cell { font-size: 0.75rem; color: var(--text2); max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.75rem; font-weight: 600; color: #fff; white-space: nowrap; }
.muted { color: var(--text2); font-size: 0.85rem; }

/* Timeline controls */
.tl-controls { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; width: 100%; }
.tl-filters { display: flex; gap: 4px; }
.filter-btn { background: var(--bg3); border: 1px solid var(--border); color: var(--text2); padding: 4px 14px; border-radius: 16px; cursor: pointer; font-size: 0.8rem; transition: all 0.15s; }
.filter-btn:hover { color: var(--text); border-color: var(--text2); }
.filter-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); }
.tl-search { background: var(--bg3); border: 1px solid var(--border); color: var(--text); padding: 6px 12px; border-radius: 6px; font-size: 0.85rem; width: 250px; outline: none; }
.tl-search:focus { border-color: var(--accent); }
.tl-toggle { font-size: 0.8rem; color: var(--text2); cursor: pointer; display: flex; align-items: center; gap: 4px; }
.tl-toggle input { cursor: pointer; }
.tl-count { font-size: 0.8rem; color: var(--text2); margin-left: auto; }

/* Timeline chat layout */
.tl-list { padding: 12px 16px; display: flex; flex-direction: column; gap: 4px; width: 100%; min-height: 200px; }
.tl-row { display: flex; width: 100%; align-items: flex-start; gap: 8px; content-visibility: auto; contain-intrinsic-size: auto 44px; }
.tl-row.hidden { display: none; }

/* Alignment: user right, everything else left */
.tl-row.bubble-user { flex-direction: row-reverse; }

/* Avatar circle */
.tl-avatar { width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 0.65rem; font-weight: 700; color: #fff; flex-shrink: 0; margin-top: 2px; }
.bubble-user .tl-avatar { background: var(--accent); }
.bubble-claude .tl-avatar { background: var(--assistant-color); }
.bubble-tool .tl-avatar { background: var(--tool-color); }
.bubble-thinking .tl-avatar { background: var(--thinking-color); }
.bubble-system .tl-avatar { background: var(--system-color); }

/* Bubble */
.tl-bubble-wrap { max-width: 78%; min-width: 0; }
.tl-bubble { border-radius: 12px; padding: 8px 12px; cursor: pointer; transition: filter 0.1s; user-select: none; }
.tl-bubble:hover { filter: brightness(1.15); }
.tl-row.expanded .tl-bubble { border-bottom-left-radius: 4px; border-bottom-right-radius: 4px; }

/* Bubble colors */
.bubble-user .tl-bubble { background: var(--accent); color: #fff; border-bottom-right-radius: 4px; }
.bubble-claude .tl-bubble { background: var(--bg3); color: var(--text); border-bottom-left-radius: 4px; }
.bubble-tool .tl-bubble { background: #1c2028; border: 1px solid var(--border); color: var(--text); border-bottom-left-radius: 4px; }
.bubble-thinking .tl-bubble { background: rgba(210,168,255,0.06); border: 1px solid rgba(210,168,255,0.15); color: var(--text2); font-style: italic; border-bottom-left-radius: 4px; }
.bubble-system .tl-bubble { background: rgba(249,117,131,0.06); border: 1px solid rgba(249,117,131,0.15); color: var(--text2); border-bottom-left-radius: 4px; }

/* Bubble header (time + chevron) */
.tl-bubble-header { display: flex; align-items: center; gap: 6px; margin-bottom: 2px; }
.tl-bubble-label { display: none; }
.tl-time { font-size: 0.6rem; color: var(--text2); opacity: 0.6; font-family: monospace; }
.bubble-user .tl-time { color: rgba(255,255,255,0.5); }
.tl-agent-badge { font-size: 0.6rem; background: rgba(210,168,255,0.15); color: var(--thinking-color); padding: 1px 6px; border-radius: 8px; }
.tl-chevron { font-size: 0.55rem; opacity: 0.35; margin-left: auto; transition: transform 0.15s; }
.tl-row.expanded .tl-chevron { transform: rotate(90deg); }

/* Summary text */
.tl-summary { font-size: 0.82rem; line-height: 1.4; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.tl-summary code { font-size: 0.8em; }

/* Subagent: indented */
.tl-row.subagent { padding-left: 36px; }
.tl-row.subagent .tl-bubble-wrap { max-width: 72%; }

/* Expanded content inside bubble */
.tl-expanded { margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.08); overflow-x: auto; }
.bubble-user .tl-expanded { border-top-color: rgba(255,255,255,0.15); }

.tl-expanded pre { background: rgba(0,0,0,0.25); border-radius: 6px; padding: 12px; font-size: 0.8rem; line-height: 1.5; overflow-x: auto; white-space: pre-wrap; word-break: break-word; max-height: 500px; overflow-y: auto; }
.tl-expanded .user-content { background: rgba(0,0,0,0.2); border-left: none; color: #fff; }
.tl-expanded .assistant-content { font-size: 0.85rem; line-height: 1.6; }
.tl-expanded .assistant-content pre { margin: 8px 0; }
.tl-expanded .assistant-content code { font-size: 0.85em; }
.tl-expanded .assistant-content h3, .tl-expanded .assistant-content h4, .tl-expanded .assistant-content h5 { margin: 12px 0 6px; color: var(--accent); }
.tl-expanded .assistant-content ul, .tl-expanded .assistant-content ol { margin: 6px 0; padding-left: 20px; }
.tl-expanded .assistant-content p { margin: 6px 0; }
.tl-expanded .thinking-content { background: rgba(0,0,0,0.15); border-left: 3px solid var(--thinking-color); border-radius: 6px; padding: 12px; font-size: 0.8rem; font-style: italic; color: var(--text2); max-height: 400px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; }
.tl-expanded .tool-detail { display: flex; flex-direction: column; gap: 8px; }
.tl-expanded .tool-badge { display: inline-block; background: var(--tool-color); color: #fff; padding: 2px 10px; border-radius: 10px; font-size: 0.75rem; font-weight: 600; }
.tl-expanded .tool-params { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; font-size: 0.8rem; }
.tl-expanded .tool-params dt { color: var(--text2); font-weight: 600; }
.tl-expanded .tool-params dd { word-break: break-all; }
.tl-expanded .result-content { border-left: 3px solid var(--result-color); background: rgba(0,0,0,0.25); }
.tl-expanded .error-content { border-left: 3px solid var(--cost); color: var(--cost); background: rgba(0,0,0,0.25); }
.show-all-btn { background: var(--bg3); border: 1px solid var(--border); color: var(--accent); padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 0.8rem; margin-top: 8px; }
.show-all-btn:hover { background: var(--accent); color: #fff; }

.load-more-btn { display: block; width: 100%; background: var(--bg2); border: 1px solid var(--border); color: var(--accent); padding: 12px; border-radius: 8px; cursor: pointer; font-size: 0.9rem; margin-top: 12px; transition: background 0.15s; }
.load-more-btn:hover { background: var(--bg3); }

/* View toggle buttons */
.tl-view-toggle { display: flex; gap: 2px; background: var(--bg3); border-radius: 6px; padding: 2px; }
.view-btn { background: none; border: none; color: var(--text2); padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 0.9rem; transition: all 0.15s; line-height: 1; }
.view-btn:hover { color: var(--text); }
.view-btn.active { background: var(--accent); color: #fff; }

/* ── Table view overrides ── */
.tl-list.view-table { padding: 0; display: block; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--bg2); }
.tl-list.view-table .tl-row { display: flex; flex-direction: row !important; align-items: center; gap: 0; padding-left: 0; border-bottom: 1px solid var(--border); contain-intrinsic-size: auto 42px; }
.tl-list.view-table .tl-row:last-child { border-bottom: none; }
.tl-list.view-table .tl-row.subagent { padding-left: 0; }
.tl-list.view-table .tl-avatar { display: none; }
.tl-list.view-table .tl-bubble-wrap { max-width: 100%; flex: 1; min-width: 0; }
.tl-list.view-table .tl-bubble-label { display: inline; min-width: 52px; text-align: right; }

.tl-list.view-table .tl-bubble { border-radius: 0; padding: 8px 12px; border: none; background: none !important; display: flex; align-items: center; gap: 8px; }
.tl-list.view-table .tl-bubble:hover { filter: none; background: var(--bg3) !important; }
.tl-list.view-table .tl-row.expanded .tl-bubble { border-radius: 0; }
.tl-list.view-table .bubble-user .tl-bubble { color: var(--text); }

.tl-list.view-table .tl-bubble-header { margin-bottom: 0; flex-shrink: 0; gap: 6px; }
.tl-list.view-table .tl-summary { display: inline; -webkit-line-clamp: unset; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
.tl-list.view-table .tl-chevron { margin-left: 0; }

/* Table: row type indicators via left border */
.tl-list.view-table .bubble-user { border-left: 3px solid var(--user-color); }
.tl-list.view-table .bubble-claude { border-left: 3px solid var(--assistant-color); }
.tl-list.view-table .bubble-tool { border-left: 3px solid var(--tool-color); }
.tl-list.view-table .bubble-thinking { border-left: 3px solid var(--thinking-color); background: rgba(210,168,255,0.04); }
.tl-list.view-table .bubble-thinking .tl-summary { font-style: italic; color: var(--text2); }
.tl-list.view-table .bubble-system { border-left: 3px solid var(--system-color); }

/* Table: subagent indent */
.tl-list.view-table .tl-row.subagent .tl-bubble { padding-left: 36px; }

/* Table: expanded content */
.tl-list.view-table .tl-expanded { border-top: 1px solid var(--border); margin-top: 0; padding: 12px 16px 16px 38px; background: var(--bg); border-radius: 0; }
.tl-list.view-table .bubble-user .tl-expanded { border-top-color: var(--border); }
.tl-list.view-table .tl-expanded pre { background: var(--bg3); }
.tl-list.view-table .tl-expanded .user-content { background: var(--bg3); color: var(--text); border-left: 3px solid var(--user-color); }

.generated { text-align: center; color: var(--text2); font-size: 0.8rem; padding: 24px; }
`;

// ─── Embedded JavaScript ────────────────────────────────────────────────────

const TIMELINE_JS = `
// ── Helpers ──

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatTime(ts) {
  if (!ts) return '--:--:--';
  try { var d = new Date(ts); return d.toTimeString().slice(0,8); }
  catch(e) { return '--:--:--'; }
}

var BUBBLE_CLASS = {
  'user': 'bubble-user',
  'assistant-text': 'bubble-claude',
  'tool-use': 'bubble-tool',
  'tool-result': 'bubble-tool',
  'thinking': 'bubble-thinking',
  'system': 'bubble-system'
};

var BUBBLE_LABEL = {
  'user': 'You',
  'assistant-text': 'Claude',
  'tool-use': 'Tool',
  'tool-result': 'Result',
  'thinking': 'Thinking',
  'system': 'System'
};

var AVATAR_LETTER = {
  'user': 'U',
  'assistant-text': 'C',
  'tool-use': 'T',
  'tool-result': 'R',
  'thinking': '?',
  'system': '!'
};

// ── Tab switching ──

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(function(t) { t.classList.toggle('active', t.dataset.tab === name); });
  document.querySelectorAll('.tab-content').forEach(function(c) {
    var isActive = c.id === 'tab-' + name;
    c.style.display = isActive ? 'block' : 'none';
    c.classList.toggle('active', isActive);
  });
  if (name === 'timeline' && !window._timelineRendered) { renderTimeline(); window._timelineRendered = true; }
}

// ── Lightweight markdown ──

function renderMd(text) {
  var lines = text.split('\\n');
  var html = [];
  var inCode = false;
  var codeLang = '';

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!inCode && /^\`\`\`/.test(line)) {
      inCode = true;
      codeLang = line.slice(3).trim();
      html.push('<pre><code' + (codeLang ? ' class="lang-'+escHtml(codeLang)+'"' : '') + '>');
      continue;
    }
    if (inCode && /^\`\`\`/.test(line)) {
      inCode = false;
      html.push('</code></pre>');
      continue;
    }
    if (inCode) {
      html.push(escHtml(line) + '\\n');
      continue;
    }
    // Headers
    if (/^### /.test(line)) { html.push('<h5>' + inlineMd(line.slice(4)) + '</h5>'); continue; }
    if (/^## /.test(line)) { html.push('<h4>' + inlineMd(line.slice(3)) + '</h4>'); continue; }
    if (/^# /.test(line)) { html.push('<h3>' + inlineMd(line.slice(2)) + '</h3>'); continue; }
    // List items
    if (/^[\\-\\*] /.test(line.trim())) { html.push('<li>' + inlineMd(line.replace(/^\\s*[\\-\\*] /, '')) + '</li>'); continue; }
    if (/^\\d+\\. /.test(line.trim())) { html.push('<li>' + inlineMd(line.replace(/^\\s*\\d+\\. /, '')) + '</li>'); continue; }
    // Empty line
    if (!line.trim()) { html.push('<br/>'); continue; }
    // Normal paragraph line
    html.push('<p>' + inlineMd(line) + '</p>');
  }
  if (inCode) html.push('</code></pre>');
  return html.join('\\n');
}

function inlineMd(s) {
  s = escHtml(s);
  s = s.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
  s = s.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
  return s;
}

// ── Render tool use detail ──

function renderToolUse(content) {
  var params = content.input || {};
  var important = {};
  var rest = {};
  // Highlight important params first
  var importantKeys = ['file_path','command','pattern','query','url','description','notebook_path','content','old_string','new_string','prompt','subagent_type'];
  for (var k in params) {
    if (importantKeys.indexOf(k) >= 0) important[k] = params[k];
    else rest[k] = params[k];
  }
  var all = Object.assign({}, important, rest);
  var html = '<div class="tool-detail"><span class="tool-badge">' + escHtml(content.toolName) + '</span>';
  html += '<dl class="tool-params">';
  for (var k in all) {
    var v = all[k];
    var vs = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
    if (vs && vs.length > 500) vs = vs.slice(0, 500) + '...';
    // Show commands and long text in code blocks
    if (k === 'command' || k === 'old_string' || k === 'new_string') {
      html += '<dt>' + escHtml(k) + '</dt><dd><pre style="margin:0;padding:4px 8px;font-size:0.8rem">' + escHtml(vs) + '</pre></dd>';
    } else {
      html += '<dt>' + escHtml(k) + '</dt><dd>' + escHtml(vs) + '</dd>';
    }
  }
  html += '</dl></div>';
  return html;
}

// ── Expanded content rendering ──

function renderExpanded(event) {
  var c = event.content;
  switch(c.kind) {
    case 'user-text':
      return '<pre class="user-content">' + escHtml(c.text) + '</pre>';
    case 'assistant-text':
      return '<div class="assistant-content">' + renderMd(c.text) + '</div>';
    case 'tool-use':
      return renderToolUse(c);
    case 'tool-result': {
      var cls = c.isError ? 'error-content' : 'result-content';
      var html = '<pre class="' + cls + '">' + escHtml(c.output) + '</pre>';
      if (c.truncated) {
        html += '<button class="show-all-btn" onclick="showFullResult(this, \\'' + escHtml(event.id) + '\\')">' +
                'Show all ' + c.fullLength + ' lines</button>';
      }
      return html;
    }
    case 'thinking':
      return '<div class="thinking-content">' + escHtml(c.text) + '</div>';
    case 'system':
      return '<pre>' + escHtml(c.text) + '</pre>';
    default:
      return '<pre>' + escHtml(JSON.stringify(c, null, 2)) + '</pre>';
  }
}

function showFullResult(btn, eventId) {
  var full = DATA.fullResults[eventId];
  if (!full) return;
  var pre = btn.previousElementSibling;
  if (pre) pre.textContent = full;
  btn.style.display = 'none';
}

// ── Filtering ──

function matchesFilter(event) {
  if (currentFilter === 'all') return true;
  if (currentFilter === 'user') return event.eventType === 'user';
  if (currentFilter === 'claude') return event.eventType === 'assistant-text' || event.eventType === 'thinking';
  if (currentFilter === 'tools') return event.eventType === 'tool-use' || event.eventType === 'tool-result';
  return true;
}

function matchesSearch(event) {
  if (!searchText) return true;
  return event.summary.toLowerCase().indexOf(searchText.toLowerCase()) >= 0;
}

function shouldShow(event) {
  if (event.eventType === 'thinking' && !showThinking) return false;
  if (!matchesFilter(event)) return false;
  if (!matchesSearch(event)) return false;
  return true;
}

function setFilter(f) {
  currentFilter = f;
  document.querySelectorAll('.filter-btn').forEach(function(b) { b.classList.toggle('active', b.dataset.filter === f); });
  applyVisibility();
}

function onSearch(val) {
  searchText = val;
  applyVisibility();
}

function toggleThinking(checked) {
  showThinking = checked;
  applyVisibility();
}

function setView(view) {
  currentView = view;
  document.querySelectorAll('.view-btn').forEach(function(b) { b.classList.toggle('active', b.dataset.view === view); });
  var list = document.getElementById('timeline-list');
  list.classList.toggle('view-chat', view === 'chat');
  list.classList.toggle('view-table', view === 'table');
}

// Build filtered index: indices into DATA.timeline that match current filters
function getFilteredIndices() {
  var indices = [];
  for (var i = 0; i < DATA.timeline.length; i++) {
    if (shouldShow(DATA.timeline[i])) indices.push(i);
  }
  return indices;
}

var filteredIndices = [];
var renderedCount = 0;

function applyVisibility() {
  filteredIndices = getFilteredIndices();
  renderedCount = 0;
  var list = document.getElementById('timeline-list');
  list.innerHTML = '';
  renderBatch();
  document.getElementById('tl-count').textContent = filteredIndices.length + ' of ' + DATA.timeline.length + ' events';
}

function renderBatch() {
  var list = document.getElementById('timeline-list');
  var end = Math.min(renderedCount + 100, filteredIndices.length);
  for (var i = renderedCount; i < end; i++) {
    var idx = filteredIndices[i];
    list.appendChild(createRow(DATA.timeline[idx], idx));
  }
  renderedCount = end;
  updateLoadMore();
}

// ── Toggle expand ──

function toggleRow(idx) {
  var row = document.querySelector('.tl-row[data-idx="' + idx + '"]');
  if (!row) return;
  var bubble = row.querySelector('.tl-bubble');
  if (!bubble) return;
  var wasExpanded = row.classList.contains('expanded');
  if (wasExpanded) {
    row.classList.remove('expanded');
    var exp = bubble.querySelector('.tl-expanded');
    if (exp) exp.remove();
    delete expandedSet[idx];
  } else {
    row.classList.add('expanded');
    var event = DATA.timeline[idx];
    var div = document.createElement('div');
    div.className = 'tl-expanded';
    div.innerHTML = renderExpanded(event);
    bubble.appendChild(div);
    expandedSet[idx] = true;
  }
}

// ── Render timeline rows ──

function createRow(event, idx) {
  var isSubagent = !!event.agentId;
  var bubbleCls = BUBBLE_CLASS[event.eventType] || 'bubble-system';
  var label = BUBBLE_LABEL[event.eventType] || event.eventType;
  var letter = AVATAR_LETTER[event.eventType] || '?';
  var cls = 'tl-row ' + bubbleCls + (isSubagent ? ' subagent' : '');
  var agentBadge = event.agentType ? '<span class="tl-agent-badge">' + escHtml(event.agentType) + '</span>' : '';

  var div = document.createElement('div');
  div.className = cls;
  div.dataset.idx = idx;
  div.innerHTML =
    '<div class="tl-avatar">' + letter + '</div>' +
    '<div class="tl-bubble-wrap">' +
      '<div class="tl-bubble" onclick="toggleRow(' + idx + ')">' +
        '<div class="tl-bubble-header">' +
          '<span class="tl-bubble-label">' + label + '</span>' +
          '<span class="tl-time">' + formatTime(event.timestamp) + '</span>' +
          agentBadge +
          '<span class="tl-chevron">&#9654;</span>' +
        '</div>' +
        '<div class="tl-summary">' + escHtml(event.summary) + '</div>' +
      '</div>' +
    '</div>';
  return div;
}

function renderTimeline() {
  applyVisibility();
}

function loadMore() {
  renderBatch();
}

function updateLoadMore() {
  var btn = document.getElementById('load-more-btn');
  var remaining = filteredIndices.length - renderedCount;
  if (remaining > 0) {
    btn.style.display = 'block';
    btn.textContent = 'Load more (' + remaining + ' remaining)';
  } else {
    btn.style.display = 'none';
  }
}

// ── Init ──
switchTab('metrics');
`;

// ─── Browser App (session browser with sidebar) ─────────────────────────────

export function generateBrowserApp(sessions: SessionListEntry[]): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Session Browser</title>
<style>
${CSS}
${BROWSER_CSS}
</style>
</head>
<body>

<nav class="top-nav">
  <div class="nav-left">
    <h1>Claude Session Browser</h1>
    <span class="nav-meta" id="global-stats">${sessions.length} sessions</span>
  </div>
  <div class="nav-right">
    <button class="refresh-btn" onclick="refreshSessions()" title="Refresh session list">&#8635; Refresh</button>
  </div>
</nav>

<div class="app-layout">
  <!-- Left sidebar -->
  <aside class="sidebar" id="sidebar">
    <div class="sidebar-search-wrap">
      <input type="text" class="sidebar-search" placeholder="Search sessions..." oninput="filterSidebar(this.value)" />
    </div>
    <div class="sidebar-list" id="sidebar-list"></div>
  </aside>

  <!-- Main panel -->
  <main class="main-panel" id="main-panel">
    <div id="empty-state" class="empty-state">
      <div class="empty-icon">&#9776;</div>
      <h2>Select a session</h2>
      <p>Choose a session from the sidebar to view its analysis</p>
    </div>

    <div id="session-content" style="display:none">
      <div id="session-header" class="session-top-bar">
        <div class="nav-left">
          <h1 id="session-title"></h1>
          <span class="nav-meta" id="session-branch"></span>
          <span class="nav-meta" id="session-date"></span>
          <span class="nav-meta" id="session-id-display"></span>
        </div>
        <div class="nav-right">
          <span class="nav-meta" id="session-stats"></span>
        </div>
      </div>

      <div class="tab-bar" id="session-tab-bar">
        <button class="tab active" data-tab="metrics" onclick="switchTab('metrics')">Metrics</button>
        <button class="tab" data-tab="timeline" onclick="switchTab('timeline')">Timeline</button>
      </div>

      <div class="container">
        <div id="tab-metrics" class="tab-content active"></div>
        <div id="tab-timeline" class="tab-content" style="display:none">
          <div class="tl-controls">
            <div class="tl-filters">
              <button class="filter-btn active" data-filter="all" onclick="setFilter('all')">All</button>
              <button class="filter-btn" data-filter="user" onclick="setFilter('user')">User</button>
              <button class="filter-btn" data-filter="claude" onclick="setFilter('claude')">Claude</button>
              <button class="filter-btn" data-filter="tools" onclick="setFilter('tools')">Tools</button>
            </div>
            <div class="tl-view-toggle">
              <button class="view-btn active" data-view="chat" onclick="setView('chat')" title="Chat view">&#9776;</button>
              <button class="view-btn" data-view="table" onclick="setView('table')" title="Table view">&#9866;</button>
            </div>
            <input type="text" class="tl-search" placeholder="Search timeline..." oninput="onSearch(this.value)" />
            <label class="tl-toggle"><input type="checkbox" id="show-thinking" onchange="toggleThinking(this.checked)" /> Show thinking</label>
            <span class="tl-count" id="tl-count"></span>
          </div>
          <div id="timeline-list" class="tl-list view-chat"></div>
          <button id="load-more-btn" class="load-more-btn" onclick="loadMore()" style="display:none">Load more</button>
        </div>
      </div>
    </div>
  </main>
</div>

<script>
// ── Session list data ──
var SESSIONS = ${JSON.stringify(sessions)};
var DATA = null;  // current session analysis
var currentSessionId = null;
var sidebarFilter = '';

// ── State ──
var visibleCount = 100;
var currentFilter = 'all';
var searchText = '';
var showThinking = false;
var expandedSet = {};
var currentView = 'chat';

${BROWSER_JS}
${TIMELINE_JS_BROWSER}
</script>
</body>
</html>`;
}

const BROWSER_CSS = `
/* App layout */
.app-layout { display: flex; height: calc(100vh - 49px); overflow: hidden; }

/* Sidebar */
.sidebar { width: 320px; min-width: 320px; background: var(--bg2); border-right: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden; }
.sidebar-search-wrap { padding: 12px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.sidebar-search { width: 100%; background: var(--bg3); border: 1px solid var(--border); color: var(--text); padding: 8px 12px; border-radius: 6px; font-size: 0.85rem; outline: none; }
.sidebar-search:focus { border-color: var(--accent); }
.sidebar-list { flex: 1; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--bg3) transparent; }

.sb-item { padding: 10px 14px; border-bottom: 1px solid var(--border); cursor: pointer; transition: background 0.1s; }
.sb-item:hover { background: var(--bg3); }
.sb-item.active { background: var(--accent); background: rgba(88,166,255,0.12); border-left: 3px solid var(--accent); }
.sb-item.loading { opacity: 0.7; }
.sb-item-title { font-size: 0.85rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; gap: 6px; }
.sb-item-title .spinner { display: none; width: 14px; height: 14px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.6s linear infinite; flex-shrink: 0; }
.sb-item.loading .spinner { display: inline-block; }
@keyframes spin { to { transform: rotate(360deg); } }
.sb-item-meta { font-size: 0.75rem; color: var(--text2); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sb-item-prompt { font-size: 0.75rem; color: var(--text2); margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; white-space: normal; line-height: 1.3; }
.sb-item.hidden { display: none; }

/* Empty state */
.empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: var(--text2); gap: 12px; }
.empty-icon { font-size: 3rem; opacity: 0.3; }
.empty-state h2 { font-size: 1.2rem; font-weight: 600; color: var(--text); }
.empty-state p { font-size: 0.9rem; }

/* Main panel */
.main-panel { flex: 1; overflow-y: scroll; display: flex; flex-direction: column; min-width: 0; }

/* Session top bar (inside main panel, not sticky to window) */
.session-top-bar { background: var(--bg2); border-bottom: 1px solid var(--border); padding: 12px 24px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; flex-shrink: 0; }
.session-top-bar .nav-left { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.session-top-bar h1 { font-size: 1.1rem; font-weight: 600; }

/* Override: tab-bar inside browser is not window-sticky */
#session-tab-bar { position: sticky; top: 0; z-index: 10; }

/* Override: container inside main panel uses full width */
.main-panel .container { max-width: 100%; flex: 1; }

/* Refresh button */
.refresh-btn { background: var(--bg3); border: 1px solid var(--border); color: var(--text2); padding: 4px 12px; border-radius: 6px; cursor: pointer; font-size: 0.85rem; transition: all 0.15s; }
.refresh-btn:hover { background: var(--accent); color: #fff; border-color: var(--accent); }

@media (max-width: 900px) {
  .sidebar { width: 260px; min-width: 260px; }
}
`;

const BROWSER_JS = `
// ── Sidebar rendering ──

function renderSidebar() {
  var list = document.getElementById('sidebar-list');
  list.innerHTML = '';
  var filterLower = sidebarFilter.toLowerCase();
  var shown = 0;
  for (var i = 0; i < SESSIONS.length; i++) {
    var s = SESSIONS[i];
    var title = s.customTitle || s.slug || s.sessionId.slice(0, 8);
    var searchable = (title + ' ' + s.gitBranch + ' ' + s.firstPrompt + ' ' + s.sessionId).toLowerCase();
    var hidden = filterLower && searchable.indexOf(filterLower) < 0;

    var div = document.createElement('div');
    div.className = 'sb-item' + (hidden ? ' hidden' : '') + (s.sessionId === currentSessionId ? ' active' : '');
    div.dataset.sid = s.sessionId;
    div.onclick = (function(sid) { return function() { selectSession(sid); }; })(s.sessionId);

    var dateStr = s.created ? s.created.slice(0, 10) : '—';
    var branch = s.gitBranch || '—';
    var prompt = s.firstPrompt || '';

    div.innerHTML =
      '<div class="sb-item-title"><span class="spinner"></span>' + escHtml(title) + '</div>' +
      '<div class="sb-item-meta">' + escHtml(branch) + ' &middot; ' + escHtml(dateStr) + ' &middot; ' + s.messageCount + ' msgs</div>' +
      (prompt ? '<div class="sb-item-prompt">' + escHtml(prompt.slice(0, 120)) + '</div>' : '');

    list.appendChild(div);
    if (!hidden) shown++;
  }
}

function filterSidebar(val) {
  sidebarFilter = val;
  var items = document.querySelectorAll('.sb-item');
  var filterLower = val.toLowerCase();
  items.forEach(function(item) {
    var sid = item.dataset.sid;
    var s = SESSIONS.find(function(x) { return x.sessionId === sid; });
    if (!s) return;
    var title = s.customTitle || s.slug || s.sessionId.slice(0, 8);
    var searchable = (title + ' ' + s.gitBranch + ' ' + s.firstPrompt + ' ' + s.sessionId).toLowerCase();
    item.classList.toggle('hidden', filterLower && searchable.indexOf(filterLower) < 0);
  });
}

function refreshSessions() {
  fetch('/api/sessions')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      SESSIONS = data;
      renderSidebar();
      document.getElementById('global-stats').textContent = data.length + ' sessions';
    })
    .catch(function(e) { console.error('Failed to refresh:', e); });
}

// ── Session selection ──

function selectSession(sessionId) {
  if (currentSessionId === sessionId && DATA) return;

  // Mark loading in sidebar
  currentSessionId = sessionId;
  document.querySelectorAll('.sb-item').forEach(function(item) {
    item.classList.toggle('active', item.dataset.sid === sessionId);
    item.classList.toggle('loading', item.dataset.sid === sessionId);
  });

  // Show empty loading state in main panel
  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('session-content').style.display = 'none';

  fetch('/api/session/' + encodeURIComponent(sessionId))
    .then(function(r) {
      if (!r.ok) throw new Error('Failed to load session');
      return r.json();
    })
    .then(function(analysis) {
      if (currentSessionId !== sessionId) return; // stale response
      DATA = { timeline: analysis.timeline, fullResults: analysis.fullResults };
      window._timelineRendered = false;

      // Reset state
      visibleCount = 100;
      currentFilter = 'all';
      searchText = '';
      showThinking = false;
      expandedSet = {};

      // Render header
      var title = analysis.customTitle || analysis.slug || analysis.sessionId.slice(0, 8);
      document.getElementById('session-title').textContent = title;
      document.getElementById('session-branch').innerHTML = 'Branch: <strong>' + escHtml(analysis.gitBranch || '—') + '</strong>';
      document.getElementById('session-date').textContent = analysis.created ? analysis.created.slice(0, 16).replace('T', ' ') : '—';
      document.getElementById('session-id-display').innerHTML = '<code>' + escHtml(analysis.sessionId.slice(0, 12)) + '...</code>';
      document.getElementById('session-stats').textContent =
        formatCostJs(analysis.cost) + ' | ' + formatTokensJs(sumTokens(analysis.totalTokens)) + ' tokens | ' + formatDurationJs(analysis.wallClockMs);

      // Render metrics tab
      renderMetricsTab(analysis);

      // Update timeline tab button
      var tlBtn = document.querySelector('#session-tab-bar .tab[data-tab="timeline"]');
      if (tlBtn) tlBtn.textContent = 'Timeline (' + analysis.timeline.length + ')';

      // Show content, switch to metrics
      document.getElementById('session-content').style.display = 'flex';
      document.getElementById('session-content').style.flexDirection = 'column';
      document.getElementById('session-content').style.flex = '1';
      switchTab('metrics');

      // Reset timeline search/filter UI
      var searchInput = document.querySelector('.tl-search');
      if (searchInput) searchInput.value = '';
      var thinkingCheckbox = document.getElementById('show-thinking');
      if (thinkingCheckbox) thinkingCheckbox.checked = false;
      document.querySelectorAll('.filter-btn').forEach(function(b) {
        b.classList.toggle('active', b.dataset.filter === 'all');
      });
      // Keep current view mode across sessions
      var list = document.getElementById('timeline-list');
      list.classList.toggle('view-chat', currentView === 'chat');
      list.classList.toggle('view-table', currentView === 'table');
      document.querySelectorAll('.view-btn').forEach(function(b) {
        b.classList.toggle('active', b.dataset.view === currentView);
      });

      // Remove loading state
      document.querySelectorAll('.sb-item').forEach(function(item) {
        item.classList.remove('loading');
      });
    })
    .catch(function(err) {
      console.error(err);
      document.querySelectorAll('.sb-item').forEach(function(item) {
        item.classList.remove('loading');
      });
      document.getElementById('empty-state').style.display = 'flex';
      document.getElementById('empty-state').querySelector('h2').textContent = 'Error loading session';
      document.getElementById('empty-state').querySelector('p').textContent = err.message || 'Unknown error';
    });
}

// ── Client-side formatting helpers ──

function sumTokens(t) {
  return (t.inputTokens || 0) + (t.outputTokens || 0) + (t.cacheCreationTokens || 0) + (t.cacheReadTokens || 0);
}

function formatDurationJs(ms) {
  if (ms < 0) return '0s';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  var mins = Math.floor(ms / 60000);
  var secs = Math.floor((ms % 60000) / 1000);
  if (mins < 60) return mins + 'm ' + secs + 's';
  var hours = Math.floor(mins / 60);
  var remainMins = mins % 60;
  return hours + 'h ' + remainMins + 'm';
}

function formatTokensJs(n) {
  if (n < 1000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(1) + 'k';
  return (n / 1000000).toFixed(2) + 'M';
}

function formatCostJs(usd) {
  if (usd < 0.01) return '$' + (usd * 100).toFixed(2) + 'c';
  if (usd < 1) return '$' + usd.toFixed(3);
  return '$' + usd.toFixed(2);
}

// ── Client-side metrics rendering ──

var CAT_COLORS = {
  'code-editing': '#58a6ff', 'exploration': '#3fb950', 'git-operations': '#f97583',
  'testing': '#d2a8ff', 'planning': '#f0883e', 'shell-commands': '#79c0ff',
  'conversation': '#8b949e', 'other': '#6e7681'
};

function renderMetricsTab(a) {
  var tokens = sumTokens(a.totalTokens);
  var activePercent = a.wallClockMs > 0 ? ((a.activeTimeMs / a.wallClockMs) * 100).toFixed(1) : '0';

  var html = '';

  // Overview cards
  html += '<div class="metrics-cards">';
  html += '<div class="card"><div class="card-value cost-value">' + formatCostJs(a.cost) + '</div><div class="card-label">Est. Cost</div></div>';
  html += '<div class="card"><div class="card-value">' + formatTokensJs(tokens) + '</div><div class="card-label">Total Tokens</div></div>';
  html += '<div class="card"><div class="card-value">' + formatDurationJs(a.wallClockMs) + '</div><div class="card-label">Wall Clock</div></div>';
  html += '<div class="card"><div class="card-value">' + formatDurationJs(a.activeTimeMs) + '</div><div class="card-label">Active (' + activePercent + '%)</div></div>';
  html += '<div class="card"><div class="card-value">' + a.userTurns + '</div><div class="card-label">User Turns</div></div>';
  html += '<div class="card"><div class="card-value">' + a.assistantTurns + '</div><div class="card-label">Assistant Turns</div></div>';
  html += '</div>';

  // Token breakdown
  var tParts = [
    { label: 'Input', value: a.totalTokens.inputTokens, color: '#58a6ff' },
    { label: 'Output', value: a.totalTokens.outputTokens, color: '#3fb950' },
    { label: 'Cache Create', value: a.totalTokens.cacheCreationTokens, color: '#f0883e' },
    { label: 'Cache Read', value: a.totalTokens.cacheReadTokens, color: '#d2a8ff' }
  ];
  var tTotal = tokens || 1;

  html += '<div class="charts-row"><div class="chart-box"><h3>Token Breakdown</h3><div class="stacked-bar">';
  tParts.forEach(function(p) {
    html += '<div class="stacked-seg" style="width:' + (p.value/tTotal*100) + '%;background:' + p.color + '" title="' + p.label + ': ' + formatTokensJs(p.value) + '"></div>';
  });
  html += '</div><div class="legend">';
  tParts.forEach(function(p) {
    html += '<span class="legend-item"><span class="legend-dot" style="background:' + p.color + '"></span>' + p.label + ': ' + formatTokensJs(p.value) + '</span>';
  });
  html += '</div></div>';

  // Cost by model - need to compute client-side
  var MODEL_PRICING = {
    'opus-4.5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
    'opus-4.6': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
    'sonnet-4.5': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
    'haiku-4.5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 }
  };
  function modelCost(model, tok) {
    var p = MODEL_PRICING[model] || MODEL_PRICING['sonnet-4.5'];
    return (tok.inputTokens/1e6)*p.input + (tok.outputTokens/1e6)*p.output +
           (tok.cacheCreationTokens/1e6)*p.cacheWrite + (tok.cacheReadTokens/1e6)*p.cacheRead;
  }
  var modelCosts = [];
  for (var model in a.modelTokens) {
    modelCosts.push({ model: model, cost: modelCost(model, a.modelTokens[model]) });
  }
  modelCosts.sort(function(a,b) { return b.cost - a.cost; });
  var maxMC = modelCosts.length > 0 ? modelCosts[0].cost : 1;

  html += '<div class="chart-box"><h3>Cost by Model</h3><div class="chart-scroll">';
  modelCosts.forEach(function(mc) {
    html += '<div class="bar-row"><span class="bar-label">' + escHtml(mc.model) + '</span><div class="bar-track"><div class="bar-fill" style="width:' + (mc.cost/maxMC*100) + '%;background:#f97583"></div></div><span class="bar-value">' + formatCostJs(mc.cost) + '</span></div>';
  });
  html += '</div></div></div>';

  // Tool usage bars
  var toolEntries = [];
  for (var tool in a.toolCalls) toolEntries.push([tool, a.toolCalls[tool]]);
  toolEntries.sort(function(a,b) { return b[1] - a[1]; });
  var maxTool = toolEntries.length > 0 ? toolEntries[0][1] : 1;

  html += '<div class="charts-row"><div class="chart-box"><h3>Tool Usage</h3><div class="chart-scroll">';
  toolEntries.forEach(function(te) {
    html += '<div class="bar-row"><span class="bar-label">' + escHtml(te[0]) + '</span><div class="bar-track"><div class="bar-fill" style="width:' + (te[1]/maxTool*100) + '%;background:#58a6ff"></div></div><span class="bar-value">' + te[1] + '</span></div>';
  });
  html += '</div></div>';

  // Task categories
  var catCounts = {};
  (a.tasks || []).forEach(function(t) { catCounts[t.category] = (catCounts[t.category] || 0) + 1; });
  var catEntries = [];
  for (var c in catCounts) catEntries.push([c, catCounts[c]]);
  catEntries.sort(function(a,b) { return b[1] - a[1]; });
  var maxCat = catEntries.length > 0 ? catEntries[0][1] : 1;

  html += '<div class="chart-box"><h3>Task Categories</h3><div class="chart-scroll">';
  catEntries.forEach(function(ce) {
    html += '<div class="bar-row"><span class="bar-label">' + escHtml(ce[0]) + '</span><div class="bar-track"><div class="bar-fill" style="width:' + (ce[1]/maxCat*100) + '%;background:' + (CAT_COLORS[ce[0]] || '#6e7681') + '"></div></div><span class="bar-value">' + ce[1] + '</span></div>';
  });
  html += '</div></div></div>';

  // Subagents
  if (a.subagents && a.subagents.length > 0) {
    html += '<h3 style="margin-top:24px">Subagents (' + a.subagents.length + ')</h3>';
    html += '<table class="tasks-table"><thead><tr><th>Type</th><th>Tokens</th><th>Cost</th><th>Events</th><th>Top Tools</th></tr></thead><tbody>';
    a.subagents.forEach(function(s) {
      var toolStr = [];
      var stEntries = [];
      for (var t in s.toolCalls) stEntries.push([t, s.toolCalls[t]]);
      stEntries.sort(function(a,b) { return b[1] - a[1]; });
      stEntries.slice(0,5).forEach(function(e) { toolStr.push(escHtml(e[0]) + '(' + e[1] + ')'); });
      html += '<tr><td><span class="badge" style="background:#d2a8ff">' + escHtml(s.agentType) + '</span></td>';
      html += '<td>' + formatTokensJs(sumTokens(s.tokenUsage)) + '</td>';
      html += '<td>' + formatCostJs(s.cost) + '</td>';
      html += '<td>' + s.eventCount + '</td>';
      html += '<td class="tools-cell">' + toolStr.join(', ') + '</td></tr>';
    });
    html += '</tbody></table>';
  }

  // Tasks table
  if (a.tasks && a.tasks.length > 0) {
    html += '<h3 style="margin-top:24px">Tasks (' + a.tasks.length + ')</h3>';
    html += '<table class="tasks-table"><thead><tr><th>#</th><th>Category</th><th>Duration</th><th>Tokens</th><th>Cost</th><th>Tools</th><th>Description</th><th>Tool Breakdown</th></tr></thead><tbody>';
    a.tasks.forEach(function(t) {
      var tTokens = sumTokens(t);
      var tToolCount = 0;
      var toolStr = [];
      var ttEntries = [];
      for (var k in t.toolCalls) { tToolCount += t.toolCalls[k]; ttEntries.push([k, t.toolCalls[k]]); }
      ttEntries.sort(function(a,b) { return b[1] - a[1]; });
      ttEntries.forEach(function(e) { toolStr.push(escHtml(e[0]) + '(' + e[1] + ')'); });
      var desc = t.description.replace(/<[^>]+>/g, '').replace(/\\s+/g, ' ').trim();
      var descShort = desc.length > 80 ? desc.slice(0, 77) + '...' : desc;
      html += '<tr><td>' + t.index + '</td>';
      html += '<td><span class="badge" style="background:' + (CAT_COLORS[t.category] || '#6e7681') + '">' + escHtml(t.category) + '</span></td>';
      html += '<td>' + formatDurationJs(t.wallClockMs) + '</td>';
      html += '<td>' + formatTokensJs(tTokens) + '</td>';
      html += '<td>' + formatCostJs(t.cost) + '</td>';
      html += '<td>' + tToolCount + '</td>';
      html += '<td class="desc-cell" title="' + escHtml(desc) + '">' + escHtml(descShort) + '</td>';
      html += '<td class="tools-cell">' + toolStr.join(', ') + '</td></tr>';
    });
    html += '</tbody></table>';
  }

  document.getElementById('tab-metrics').innerHTML = html;
}

// ── Init ──
renderSidebar();
`;

// Timeline JS for browser mode — same as TIMELINE_JS but with different init
const TIMELINE_JS_BROWSER = `
// ── Helpers ──

function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatTime(ts) {
  if (!ts) return '--:--:--';
  try { var d = new Date(ts); return d.toTimeString().slice(0,8); }
  catch(e) { return '--:--:--'; }
}

var BUBBLE_CLASS = {
  'user': 'bubble-user',
  'assistant-text': 'bubble-claude',
  'tool-use': 'bubble-tool',
  'tool-result': 'bubble-tool',
  'thinking': 'bubble-thinking',
  'system': 'bubble-system'
};

var BUBBLE_LABEL = {
  'user': 'You',
  'assistant-text': 'Claude',
  'tool-use': 'Tool',
  'tool-result': 'Result',
  'thinking': 'Thinking',
  'system': 'System'
};

var AVATAR_LETTER = {
  'user': 'U',
  'assistant-text': 'C',
  'tool-use': 'T',
  'tool-result': 'R',
  'thinking': '?',
  'system': '!'
};

// ── Tab switching ──

function switchTab(name) {
  document.querySelectorAll('#session-tab-bar .tab').forEach(function(t) { t.classList.toggle('active', t.dataset.tab === name); });
  document.querySelectorAll('.tab-content').forEach(function(c) {
    var isActive = c.id === 'tab-' + name;
    c.style.display = isActive ? 'block' : 'none';
    c.classList.toggle('active', isActive);
  });
  if (name === 'timeline' && DATA && !window._timelineRendered) { renderTimeline(); window._timelineRendered = true; }
}

// ── Lightweight markdown ──

function renderMd(text) {
  var lines = text.split('\\n');
  var html = [];
  var inCode = false;
  var codeLang = '';
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!inCode && /^\`\`\`/.test(line)) { inCode = true; codeLang = line.slice(3).trim(); html.push('<pre><code' + (codeLang ? ' class="lang-'+escHtml(codeLang)+'"' : '') + '>'); continue; }
    if (inCode && /^\`\`\`/.test(line)) { inCode = false; html.push('</code></pre>'); continue; }
    if (inCode) { html.push(escHtml(line) + '\\n'); continue; }
    if (/^### /.test(line)) { html.push('<h5>' + inlineMd(line.slice(4)) + '</h5>'); continue; }
    if (/^## /.test(line)) { html.push('<h4>' + inlineMd(line.slice(3)) + '</h4>'); continue; }
    if (/^# /.test(line)) { html.push('<h3>' + inlineMd(line.slice(2)) + '</h3>'); continue; }
    if (/^[\\-\\*] /.test(line.trim())) { html.push('<li>' + inlineMd(line.replace(/^\\s*[\\-\\*] /, '')) + '</li>'); continue; }
    if (/^\\d+\\. /.test(line.trim())) { html.push('<li>' + inlineMd(line.replace(/^\\s*\\d+\\. /, '')) + '</li>'); continue; }
    if (!line.trim()) { html.push('<br/>'); continue; }
    html.push('<p>' + inlineMd(line) + '</p>');
  }
  if (inCode) html.push('</code></pre>');
  return html.join('\\n');
}

function inlineMd(s) {
  s = escHtml(s);
  s = s.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
  s = s.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
  return s;
}

// ── Render tool use detail ──

function renderToolUse(content) {
  var params = content.input || {};
  var important = {};
  var rest = {};
  var importantKeys = ['file_path','command','pattern','query','url','description','notebook_path','content','old_string','new_string','prompt','subagent_type'];
  for (var k in params) {
    if (importantKeys.indexOf(k) >= 0) important[k] = params[k];
    else rest[k] = params[k];
  }
  var all = Object.assign({}, important, rest);
  var html = '<div class="tool-detail"><span class="tool-badge">' + escHtml(content.toolName) + '</span>';
  html += '<dl class="tool-params">';
  for (var k in all) {
    var v = all[k];
    var vs = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
    if (vs && vs.length > 500) vs = vs.slice(0, 500) + '...';
    if (k === 'command' || k === 'old_string' || k === 'new_string') {
      html += '<dt>' + escHtml(k) + '</dt><dd><pre style="margin:0;padding:4px 8px;font-size:0.8rem">' + escHtml(vs) + '</pre></dd>';
    } else {
      html += '<dt>' + escHtml(k) + '</dt><dd>' + escHtml(vs) + '</dd>';
    }
  }
  html += '</dl></div>';
  return html;
}

// ── Expanded content rendering ──

function renderExpanded(event) {
  var c = event.content;
  switch(c.kind) {
    case 'user-text':
      return '<pre class="user-content">' + escHtml(c.text) + '</pre>';
    case 'assistant-text':
      return '<div class="assistant-content">' + renderMd(c.text) + '</div>';
    case 'tool-use':
      return renderToolUse(c);
    case 'tool-result': {
      var cls = c.isError ? 'error-content' : 'result-content';
      var html = '<pre class="' + cls + '">' + escHtml(c.output) + '</pre>';
      if (c.truncated) {
        html += '<button class="show-all-btn" onclick="showFullResult(this, \\'' + escHtml(event.id) + '\\')">' +
                'Show all ' + c.fullLength + ' lines</button>';
      }
      return html;
    }
    case 'thinking':
      return '<div class="thinking-content">' + escHtml(c.text) + '</div>';
    case 'system':
      return '<pre>' + escHtml(c.text) + '</pre>';
    default:
      return '<pre>' + escHtml(JSON.stringify(c, null, 2)) + '</pre>';
  }
}

function showFullResult(btn, eventId) {
  if (!DATA) return;
  var full = DATA.fullResults[eventId];
  if (!full) return;
  var pre = btn.previousElementSibling;
  if (pre) pre.textContent = full;
  btn.style.display = 'none';
}

// ── Filtering ──

function matchesFilter(event) {
  if (currentFilter === 'all') return true;
  if (currentFilter === 'user') return event.eventType === 'user';
  if (currentFilter === 'claude') return event.eventType === 'assistant-text' || event.eventType === 'thinking';
  if (currentFilter === 'tools') return event.eventType === 'tool-use' || event.eventType === 'tool-result';
  return true;
}

function matchesSearch(event) {
  if (!searchText) return true;
  return event.summary.toLowerCase().indexOf(searchText.toLowerCase()) >= 0;
}

function shouldShow(event) {
  if (event.eventType === 'thinking' && !showThinking) return false;
  if (!matchesFilter(event)) return false;
  if (!matchesSearch(event)) return false;
  return true;
}

function setFilter(f) {
  currentFilter = f;
  document.querySelectorAll('.filter-btn').forEach(function(b) { b.classList.toggle('active', b.dataset.filter === f); });
  applyVisibility();
}

function onSearch(val) {
  searchText = val;
  applyVisibility();
}

function toggleThinking(checked) {
  showThinking = checked;
  applyVisibility();
}

function setView(view) {
  currentView = view;
  document.querySelectorAll('.view-btn').forEach(function(b) { b.classList.toggle('active', b.dataset.view === view); });
  var list = document.getElementById('timeline-list');
  list.classList.toggle('view-chat', view === 'chat');
  list.classList.toggle('view-table', view === 'table');
}

// Build filtered index: indices into DATA.timeline that match current filters
function getFilteredIndices() {
  if (!DATA) return [];
  var indices = [];
  for (var i = 0; i < DATA.timeline.length; i++) {
    if (shouldShow(DATA.timeline[i])) indices.push(i);
  }
  return indices;
}

var filteredIndices = [];
var renderedCount = 0;

function applyVisibility() {
  if (!DATA) return;
  filteredIndices = getFilteredIndices();
  renderedCount = 0;
  var list = document.getElementById('timeline-list');
  list.innerHTML = '';
  renderBatch();
  var countEl = document.getElementById('tl-count');
  if (countEl) countEl.textContent = filteredIndices.length + ' of ' + DATA.timeline.length + ' events';
}

function renderBatch() {
  if (!DATA) return;
  var list = document.getElementById('timeline-list');
  var end = Math.min(renderedCount + 100, filteredIndices.length);
  for (var i = renderedCount; i < end; i++) {
    var idx = filteredIndices[i];
    list.appendChild(createRow(DATA.timeline[idx], idx));
  }
  renderedCount = end;
  updateLoadMore();
}

// ── Toggle expand ──

function toggleRow(idx) {
  var row = document.querySelector('.tl-row[data-idx="' + idx + '"]');
  if (!row || !DATA) return;
  var bubble = row.querySelector('.tl-bubble');
  if (!bubble) return;
  var wasExpanded = row.classList.contains('expanded');
  if (wasExpanded) {
    row.classList.remove('expanded');
    var exp = bubble.querySelector('.tl-expanded');
    if (exp) exp.remove();
    delete expandedSet[idx];
  } else {
    row.classList.add('expanded');
    var event = DATA.timeline[idx];
    var div = document.createElement('div');
    div.className = 'tl-expanded';
    div.innerHTML = renderExpanded(event);
    bubble.appendChild(div);
    expandedSet[idx] = true;
  }
}

// ── Render timeline rows ──

function createRow(event, idx) {
  var isSubagent = !!event.agentId;
  var bubbleCls = BUBBLE_CLASS[event.eventType] || 'bubble-system';
  var label = BUBBLE_LABEL[event.eventType] || event.eventType;
  var letter = AVATAR_LETTER[event.eventType] || '?';
  var cls = 'tl-row ' + bubbleCls + (isSubagent ? ' subagent' : '');
  var agentBadge = event.agentType ? '<span class="tl-agent-badge">' + escHtml(event.agentType) + '</span>' : '';
  var div = document.createElement('div');
  div.className = cls;
  div.dataset.idx = idx;
  div.innerHTML =
    '<div class="tl-avatar">' + letter + '</div>' +
    '<div class="tl-bubble-wrap">' +
      '<div class="tl-bubble" onclick="toggleRow(' + idx + ')">' +
        '<div class="tl-bubble-header">' +
          '<span class="tl-bubble-label">' + label + '</span>' +
          '<span class="tl-time">' + formatTime(event.timestamp) + '</span>' +
          agentBadge +
          '<span class="tl-chevron">&#9654;</span>' +
        '</div>' +
        '<div class="tl-summary">' + escHtml(event.summary) + '</div>' +
      '</div>' +
    '</div>';
  return div;
}

function renderTimeline() {
  if (!DATA) return;
  applyVisibility();
}

function loadMore() {
  if (!DATA) return;
  renderBatch();
}

function updateLoadMore() {
  if (!DATA) return;
  var btn = document.getElementById('load-more-btn');
  var remaining = filteredIndices.length - renderedCount;
  if (remaining > 0) {
    btn.style.display = 'block';
    btn.textContent = 'Load more (' + remaining + ' remaining)';
  } else {
    btn.style.display = 'none';
  }
}
`;
