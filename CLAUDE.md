# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development

```bash
npm install
npm run build          # tsc + copy-assets (prompts/, hooks/ -> dist/)
npm test               # vitest run (single run)
npm run test:watch     # vitest in watch mode
npm run test:coverage  # vitest with v8 coverage report
```

No linter is configured. TypeScript strict mode is on.

## Testing

Tests use **Vitest** and live in `tests/`. Two tiers:

- **`tests/tier1/`** — Pure function tests (no I/O, no mocking). Highest ROI.
- **`tests/tier2/`** — Filesystem tests using temp dirs. Each test creates a temp dir with `.git/`, `chdir`s into it, and calls `_resetRepoRootCache()` in `beforeEach`. Restores cwd in `afterAll`.
- **`tests/helpers/fixtures.ts`** — Shared utilities (`createTempDir`, `removeTempDir`, `writeJson`, `writeFile`).

Run a specific file or directory:
```bash
npx vitest run tests/tier1/slugify.test.ts   # single file
npx vitest run tests/tier1                   # all tier 1
npx vitest run -t "slugifyContext"           # by test name
```

Import paths in tests use `.js` extensions (same as source) — Vitest resolves them to `.ts`. For `process.exit` interception: `vi.spyOn(process, "exit").mockImplementation(...)`. Suppress console noise with `vi.spyOn(console, "log").mockImplementation(() => {})`.

The project is an ESM package (`"type": "module"`) targeting Node.js >= 18. All internal imports use `.js` extensions (NodeNext module resolution).

## Architecture

A collection of AI development tools, primarily built with Claude Code CLI in mind. Currently includes three CLI tools (`composer`, `sandbox`, `session-explorer`).

### Entry Points

- `src/bin/composer.ts` / `src/bin/sandbox.ts` / `src/bin/session-explorer.ts` — Thin shims that re-export the main modules
- `src/composer/composer.ts` — Composer CLI: arg parsing, command dispatch, signal handlers
- `src/sandbox/sandbox.ts` — Sandbox CLI: worktree management, ralph loop, role sessions
- `src/session-explorer/index.ts` — Session Explorer CLI: single-session HTML reports or local browser server for Claude session analysis

### Composer (Orchestration Engine)

The composer runs multi-step **compositions** (defined in `src/composer/config/compositions.ts`). Each composition is a sequence of `Step` objects with a type (`sandbox-create`, `claude-interactive`, `ralph`, `sandbox-start`, `status-check`, `pr-dry-run`, `ado-pr-create`) and a shell command template.

Key flow:
1. `commands.ts:cmdCompose()` parses args, creates `SessionState`, calls `runComposition()`
2. `execution.ts:runComposition()` loops through steps with an interactive prompt (n=next, s=skip, p=prev, q=quit)
3. Step commands use `{placeholder}` template vars resolved at runtime via `resolveTemplate()`
4. After sandbox-create steps, branch/worktree info is captured from sandbox state files
5. Session state is persisted as JSON in `.claude/.skill-state/composer/`

Additional composer commands:
- `cmdDistill()` — Distills improved feature requests from sandbox artifacts (requirements.md + spec.md) or from implementation diffs. Uses Claude headless (`claude -p`) to synthesize.
- `cmdReport()` — Generates HTML/text/JSON metrics reports by parsing Claude `.jsonl` session logs.

Tmux integration (`tmux.ts`): When running inside tmux, steps execute in split panes with a poll loop watching for completion.

### Sandbox (Worktree Management)

Creates isolated git worktree sandboxes for each AI session. Key modules:

- **Ralph loop** (`sandbox ralph`) — Automates developer/reviewer iteration:
  - Runs developer agent (headless via `claude -p`) -> commits changes
  - Runs reviewer agent -> writes `comments.md`
  - User can ignore comments or re-iterate
  - Tracks iterations in `ralph-log.md`

- **`ralph-helpers.ts`** — Agent execution utilities: `runAgentWithTimer()` (real-time progress display with stop capability), `runInteractiveAgentWithLog()` (interactive sessions with transcript copying), `generateReadableLog()` (converts streaming `.jsonl` logs to human-readable format), and comment parsing utilities (`parseComments`, `filterIgnored`, `expandRanges`).

- **`distill.ts`** — Generates improved feature requests by sending sandbox artifacts (feature-request.md, requirements.md, spec.md) or code diffs to Claude headless. Used by both `sandbox distill` and `composer distill`.

- **`audit.ts`** — Generates `audit-log.md` summaries from `audit-raw.jsonl` tool call logs.

- **Sandbox guard hook** (`hooks/sandbox-guard.sh`) — PreToolUse hook that restricts file operations to the sandbox directory via `SANDBOX_DIR` env var. TypeScript equivalent at `src/sandbox/sandbox-guard.ts`.

### Session Explorer

- `src/session-explorer/` — Parses Claude `.jsonl` session files for deep analysis. Two modes: generate a single-session HTML report, or launch a local HTTP server for browsing sessions interactively.

### Connectors

- `src/connectors/ado-pull-request/create.ts` — Pushes branch, builds PR description from sandbox artifacts (feature-request.md, spec.md, tasks.md, ralph-log.md, comments.md), creates Azure DevOps PR via `az repos pr create`
- `src/connectors/ado-work-item/fetch.ts` — Fetches ADO work items as markdown context via `az boards work-item show`

### Metrics

- `src/metrics/session-map.ts` — Maps composer sessions to Claude CLI session IDs (stored in `~/claude-skill-tools/session-maps/`)
- `src/metrics/session-metrics.ts` — Parses Claude `.jsonl` session logs for token usage, cost, tool call breakdowns; generates HTML/text/JSON reports
- `src/metrics/uuid.ts` — Deterministic session ID generation

### Shared Layer

- `src/shared/paths.ts` — `PACKAGE_ROOT`, `resolveRepoRoot()`, state directory helpers. All state dirs are under `<repo>/.claude/.skill-state/`
- `src/shared/ui.ts` — ANSI formatting (colors, banners, error blocks, `die()`). Respects `NO_COLOR`.
- `src/shared/config.ts` — Config with repo-level override at `<repo>/.claude/.skill-state/config.json`, falling back to user-level `~/claude-skill-tools/config.json` (ADO org, field mappings)
- `src/shared/utils.ts` — `promptUser()`, `nowISO()`, `copyDirIfExists()`

## Key Conventions

- CLI arg parsing is manual (no libraries) — switch/case blocks in `main()` or command functions
- State is JSON files on disk (no database). Composer state: `<repo>/.claude/.skill-state/composer/<sessionId>.json`. Sandbox state: `<repo>/.claude/.skill-state/sandbox/<slug>.json`
- User-level durable data (session maps, config) lives in `~/claude-skill-tools/`
- Repo-level config override: `<repo>/.claude/.skill-state/config.json` (merged over user-level, per-field)
- Role prompts are markdown files in `prompts/` (analyst, architect, developer, developer_single, reviewer, tester)
- External deps: only `@types/node` and `typescript` (zero runtime deps)
- All shell commands spawned via `spawnSync`/`spawn` from `node:child_process`
- The `die()` function (in `shared/ui.ts`) prints an error with optional suggestions and calls `process.exit(1)`
