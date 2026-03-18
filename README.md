# claude-skill-tools

Composer and sandbox developer tools for Claude Code workflows. Orchestrate multi-role AI agent compositions using isolated git worktrees.

## Features

- **Composer** — Orchestrate multi-step workflows (analyst, architect, developer, reviewer) with session state, auto-retry, and tmux integration
- **Sandbox** — Create isolated git worktree sandboxes with role-based system prompts and a PreToolUse guard hook
- **Ralph loop** — Automated developer/reviewer iteration cycle with comment tracking and ignore lists
- **Prompt overrides** — Override any shipped role prompt per-repo via `.claude/prompts/`
- **Config overrides** — Per-repo config at `.claude/.skill-state/config.json` merges over user-level defaults
- **PR creation** — Auto-generate Azure DevOps pull requests from sandbox artifacts
- **ADO integration** — Fetch work items as markdown context for compositions
- **Session metrics** — Track Claude CLI session IDs per composition step and generate cost/token/tool usage reports
- **Session explorer** — Deep-dive analysis of individual sessions with timeline visualization and subagent tracking

## Requirements

- Node.js >= 18
- Git
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude` command available in PATH)
- Azure CLI (`az`) for ADO/PR features (optional)

## Installation

```bash
# From npm (once published)
npm install -g claude-skill-tools

# From source
git clone <repo-url>
cd claude-skill-tools
npm install
npm run build
npm link
```

## Quick Start

```bash
# List available composition types
composer list

# Start a full workflow from an ADO work item
composer compose full --ado 12345

# Automated dev/review with inline context
composer compose ralph-only --context "Add dark mode support to the settings page"

# Single role session
composer compose role --role architect --context "Design a caching layer"

# Resume a paused session
composer resume a1b2

# Manage sandboxes directly
sandbox list
sandbox roles
sandbox start --role analyst --context "Refactor the settings service"
sandbox clean --all
```

## Roles

Each role is a markdown system prompt that defines an AI agent's behavior. Shipped roles:

| Role | Description |
|------|-------------|
| `analyst` | Requirements Analyst — produces `requirements.md` from a feature request |
| `architect` | Solution Architect — produces `spec.md` from requirements |
| `developer` | Developer (Team Lead) — breaks spec into tasks, delegates to sub-agents via TDD |
| `developer_single` | Developer (Solo) — implements tasks directly using TDD (used in headless/ralph) |
| `reviewer` | Code Reviewer — reviews changes against spec, produces `comments.md` |
| `tester` | Test Writer — writes test plans and test code |

### Prompt Overrides

You can override any shipped prompt on a per-repo basis by placing markdown files in `.claude/prompts/` at the root of your target repository:

```
my-repo/
  .claude/
    prompts/
      developer.md        # overrides the shipped developer.md
      my-custom-role.md   # adds a new role not in the package
```

Resolution order:

1. **Repo-local** (`.claude/prompts/<role>.md`) — checked first
2. **Package default** (`prompts/<role>.md` in the installed package) — fallback

Repo-local files take precedence per-file. You only need to override the prompts you want to customize — the rest are inherited from the package. Repo-local-only files (like `my-custom-role.md` above) are also included.

This is useful for adding project-specific coding standards, build commands, or framework rules to your developer/reviewer prompts without forking the package.

## Composer

The composer orchestrates multi-step workflows called **compositions**. Each composition is a sequence of steps (sandbox creation, Claude sessions, ralph loops, PR creation) that run in order with an interactive stepper UI.

### Commands

| Command | Description |
|---------|-------------|
| `composer list` | List available composition types with descriptions |
| `composer compose <type> [opts]` | Start a new composition |
| `composer resume <session-id>` | Resume a paused or in-progress session |
| `composer sessions` | Show all sessions with status, step, and branch |
| `composer clean <target>` | Remove session state (`<id>`, `--all`, `--completed`, `--stale`) |
| `composer report [session-id]` | Generate metrics report for a session |

### Composition Types

| Type | Pipeline |
|------|----------|
| `full` | sandbox → analyst → architect → ralph (dev/review loop) → PR |
| `ralph-only` | sandbox → ralph (automated dev/review) → PR |
| `manual` | sandbox → analyst → architect → developer → reviewer → PR |
| `role` | sandbox → single role session → PR |
| `headless` | sandbox → background developer → status check → PR |

### Compose Options

```
--context "..."          Inline context string
--context-file <path>    Read context from a file
--ado <work-item-id>     Fetch context from Azure DevOps
--model <model>          Model to use (default: opus)
--max-iterations <n>     Max dev/review iterations (default: 5)
--role <name>            Role (required for 'role' composition)
--name <session-name>    Custom session name (auto-deduped if taken)
--base <branch>          Base branch for sandbox worktree (default: master)
--skip-sandbox           Skip sandbox creation, run on current branch
```

### Report Options

```
[session-id]             Session to report on (interactive picker if omitted)
--html                   HTML report with charts (default, opens in browser)
--text                   Plain text report to stdout
--json                   JSON output
--out <path>             Write report to a specific file path
```

### Step Navigation

During composition execution, each step pauses with an interactive prompt:

- **n** / **Enter** — run the current step
- **s** — skip current step
- **p** — go back to previous step
- **q** — quit (session is saved and can be resumed)
- **?** / **status** — show current session status and pipeline

After the first manual prompt, subsequent steps use a 10-second countdown with auto-run. Steps marked `autoAdvance` (like sandbox creation) run immediately without prompting.

When running inside tmux, steps execute in split panes with automatic completion detection. For ralph steps, the main pane spinner shows the current phase and iteration (e.g. `dev 2/5`, `rev 2/5`) by detecting `ralph-dev-N.log` / `ralph-rev-N.log` files in the worktree. This progress indicator only works in headless mode (`ralph-only`, `headless` compositions) because headless mode creates log files at the start of each phase; interactive mode (`full`, `manual`) writes the log file only after the session exits.

## Sandbox

The sandbox creates isolated git worktree environments for AI sessions. Each sandbox gets its own branch, working directory, and a copy of all role prompts.

### Commands

| Command | Description |
|---------|-------------|
| `sandbox create [opts]` | Create a worktree sandbox without launching Claude |
| `sandbox start [opts]` | Create sandbox and launch a Claude role session |
| `sandbox ralph [opts]` | Run the automated dev/review loop |
| `sandbox distill [opts]` | Distill an improved feature request from sandbox artifacts |
| `sandbox status [opts]` | Show sandbox status (commits, diff, process state) |
| `sandbox clean [target]` | Remove sandbox (worktree, branch, state) |
| `sandbox list` | List all sandboxes with status |
| `sandbox roles` | List available role prompts |

### Create Options

```
--branch <name>          Git branch name (auto-generated if omitted)
--base <branch>          Base branch to fork from (default: master)
--setup                  Run full dependency install (instead of symlinking node_modules)
--context "..."          Seed feature-request.md with inline context
--context-file <path>    Seed feature-request.md from a file
```

### Start Options

```
--role <name>            Role to launch (e.g. analyst, architect, developer)
--idea <text>            Auto-generate a custom role from a description
--context "..."          Context string seeded as feature-request.md
--context-file <path>    Read context from a file
--branch <name>          Git branch name (auto-generated if omitted)
--base <branch>          Base branch (default: master)
--model <model>          Model to use (default: opus)
--headless               Run in background (detached process)
--ralph                  Start in ralph mode (automated dev/review loop)
--max-iterations <n>     Max ralph iterations (default: 10)
--setup                  Run full dependency install
--skip-sandbox           Reuse an existing sandbox (requires --branch)
```

### Ralph Options

```
--branch <name>          Branch of existing sandbox (required)
--max-iterations <n>     Max dev/review iterations (default: 10)
--model <model>          Model to use (default: sonnet)
--headless               Run without interactive prompts
--review                 Start with reviewer (skip first dev pass)
--no-agents              Disable sub-agent delegation (use solo developer)
--composer-session <id>  Link to a composer session for metrics tracking
```

### Status Options

```
<short-id>               Lookup by short ID (from 'sandbox list')
--branch <name>          Lookup by branch name
--id <slug>              Lookup by slug
```

If no target is given, `status` falls back to showing the sandbox list.

### Clean Options

```
<short-id>               Clean by short ID (from 'sandbox list')
--branch <name>          Clean by branch name
--all                    Clean all sandboxes
--stopped                Clean stopped sandboxes
--active                 Clean active sandboxes
--running                Clean running sandboxes
--missing                Clean sandboxes with missing worktrees
--orphans                Clean orphaned worktree directories
--keep-branch            Remove worktree but keep the git branch
--force                  Skip confirmation prompts
```

When run with no arguments in a TTY, `clean` shows an interactive picker.

### Distill Options

```
--branch <name>          Branch to distill from (required)
--model <model>          Model to use (default: sonnet)
```

## Ralph Loop

The ralph loop (`sandbox ralph`) automates developer/reviewer iterations:

1. **Developer phase** — Claude runs as the developer role (team lead with sub-agents, or solo in `--no-agents` mode). On iteration 1, it reads `feature-request.md` and implements from scratch. On subsequent iterations, it reads `comments.md` and fixes flagged issues.

2. **Reviewer phase** — Claude runs as the reviewer role. It reviews all changes against the spec and writes `comments.md` with categorized feedback (Must Fix, Should Fix, Consider).

3. **User decision** (interactive mode) — After each review, you can:
   - **c** — continue to next iteration (developer addresses comments)
   - **i** — ignore specific comments (they won't be addressed in future iterations)
   - **s** — stop the loop

4. **Exit conditions** — The loop ends when:
   - Review is clean (no Must Fix / Should Fix comments)
   - Max iterations reached
   - User stops manually

Artifacts produced: `ralph-log.md` (iteration history), `comments.md` (latest review), `ignored-comments.txt` (user-ignored items), `audit-log.md` (tool call audit summary, generated from `audit-raw.jsonl` if present).

## Distill

The `sandbox distill` command generates an improved, self-contained feature request by combining:

- `feature-request.md` — the original user request
- `requirements.md` — clarified requirements from the analyst
- `spec.md` — technical specification from the architect

The output (`improved-feature-request.md`) is detailed enough that a developer can go straight to implementation with no clarifying questions. A changes summary (`feature-request-changes-summary.md`) is also generated, listing what was added, clarified, or scoped out.

This enables a **zero-intervention loop**: run the full pipeline once, distill the result, then re-run with the improved feature request for a cleaner pass:

```bash
sandbox distill --branch users/me/first-pass
sandbox start --ralph --context-file <worktree>/improved-feature-request.md
```

## Sandbox Guard Hook

Each sandbox includes a PreToolUse guard hook (`hooks/sandbox-guard.sh`) that restricts file operations to the sandbox directory via the `SANDBOX_DIR` environment variable. This prevents the AI agent from modifying files outside its worktree.

A TypeScript equivalent (`src/sandbox/sandbox-guard.ts`, compiled to `dist/sandbox/sandbox-guard.js`) is available for Windows environments where a POSIX shell is not available.

## Project Structure

```
prompts/           Role prompt markdown files (analyst, architect, developer, reviewer, tester)
hooks/             PreToolUse guard hook (sandbox-guard.sh)
src/
  shared/          Common utilities, path resolution, config, UI helpers
  composer/        Composer orchestration engine
  sandbox/         Sandbox worktree management and ralph loop
  connectors/      External service integrations (ADO PR creation, work item fetching)
  metrics/         Session metrics tracking and batch analysis (session-metrics.ts)
  session-explorer/ Deep single-session analysis with timeline (session-explorer)
  bin/             CLI entry point shims (composer, sandbox, session-explorer)
```

## State Storage

Session and sandbox state is stored repo-locally at:

- Composer: `<repo>/.claude/.skill-state/composer/`
- Sandbox: `<repo>/.claude/.skill-state/sandbox/`

Durable metrics data is stored at the user level:

- Session maps: `~/claude-skill-tools/session-maps/`
- Parsed session cache: `~/claude-skill-tools/parsed-sessions.json`
- User-level config: `~/claude-skill-tools/config.json`
- Repo-level config (optional, overrides user-level): `<repo>/.claude/.skill-state/config.json`

Session maps survive `composer clean` so you can generate reports for deleted sessions.

Add `.claude/.skill-state/` to your `.gitignore`.

### Config Resolution

Configuration is resolved by merging repo-level overrides with user-level defaults:

1. **Repo-level** (`<repo>/.claude/.skill-state/config.json`) — checked first, per-field override
2. **User-level** (`~/claude-skill-tools/config.json`) — fallback

Repo-level fields take precedence. For nested objects like `adoFields`, sub-keys are merged (repo sub-keys override user sub-keys). You only need to specify the fields you want to override at the repo level.

Example repo-level config that overrides only the ADO org for this repo:

```json
{
  "adoOrg": "https://dev.azure.com/my-team-org"
}
```

## Session Explorer

The `session-explorer` CLI provides deep single-session analysis with an interactive timeline.

### Usage

```bash
# Launch interactive session browser (local web app)
session-explorer

# Generate HTML report for a specific session
session-explorer <sessionId>

# Output raw analysis as JSON
session-explorer <sessionId> --json

# Custom port for the browser
session-explorer --port 8080

# Save report to a specific file
session-explorer <sessionId> --out report.html
```

### Features

- **Metrics tab** — Token usage, cost breakdown by model, tool call distribution, task classification
- **Timeline tab** — Every event in order: user messages, assistant text, tool uses, tool results, thinking blocks — each with human-readable summaries
- **Subagent tracking** — Loads subagent JSONL files, merges them into the timeline, and computes per-subagent metrics
- **Browser mode** — Local HTTP server with a session sidebar for on-demand parsing

This complements `composer report` (batch metrics across sessions) by drilling into a single session in detail.

## Cross-Platform Notes

- Works on macOS, Linux, and Windows (via Node.js)
- Build script uses a cross-platform Node.js copy script instead of shell `cp`
- Path resolution uses `node:path` throughout for OS-appropriate separators
- The bash sandbox guard hook (`hooks/sandbox-guard.sh`) requires a POSIX shell; on Windows, use the TypeScript guard (`dist/sandbox/sandbox-guard.js`) instead

## Development

```bash
npm install
npm run build    # Compile TypeScript + copy assets to dist/
```

## License

ISC
