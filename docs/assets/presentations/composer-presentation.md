---
marp: true
---

## Confidently Wrong at Scale: Taming AI Code Agents

From one-shot prompts to orchestrated multi-agent workflows.

---

## Agenda

1. **AI Coding Assistants** — Levels of Complexity
1. **The Composer Tool** — Multi-Role Orchestration
1. **Composer in Practice** — Real-world usage, costs, and insights
1. **Practical Tools** — Hooks, notifications, context monitoring

---

## Part 1: AI Coding Assistants — Levels of Complexity

| Level | Approach | When to use |
|-------|----------|-------------|
| 1 | Direct Asks | Small, well-defined tasks |
| 2 | Plan Mode | Anything with ambiguity |
| 3 | Constrained Agents | Repeatable agent behaviors |
| 4 | Agent Orchestration | Full development lifecycle |

---

## Level 1: Direct Asks

- One-shot prompts: "Fix this bug", "Write a function that..."
- Works great for well-defined tasks, simple information retrieval, reading files, understanding functions, etc.
- No planning, no context management — just ask and get an answer

```
"Add input validation to the login form"
```

> This is how most people start. It works, but breaks down for anything larger than a single function or file.

---

## Level 1 Failure: The Helpful Over-Engineer

You ask: *"Add a loading spinner to the submit button."*

The AI creates a generic `LoadingButton` component, a `useLoadingState` hook, a `LoadingContext` provider, and updates 4 files. You wanted one CSS class toggle.

> Without scope constraints, the AI defaults to the "best practice" solution, not the simplest one. A 2-line fix becomes a 150-line abstraction.

---

## Level 1 Failure: The Config Clobber

You ask: *"Enable strict TypeScript checking."*

The AI sets `"strict": true` in `tsconfig.json`. This enables 8 flags at once, including `noImplicitAny`, which produces 347 new errors. The AI starts "fixing" them — adding `any` casts everywhere to make the errors go away.

> The AI doesn't stop and say "this produced 347 errors, should we reconsider?" It just starts solving them, often in the worst possible way.

---

## Level 2: Plan Mode

- Read only architect mode that produces an implementation plan before writing code.
- Use it for planning the steps of a task that requires writing code, but has ambiguity in scope, constraints, or expected behavior.
- The AI interviews you, then creates a plan you approve
- Prevents the #1 failure mode: the AI guessing wrong and spiraling

> **INSIGHT:** Use the prompt **"Ask me questions about this task before you start"**

```
"I need to refactor the auth service. Before implementing anything,
ask me questions about scope, constraints, and expected behavior."
```

---

## Level 2 Failure: The Scope Creep Plan

You use plan mode for *"Add a retry mechanism to the API client."* The AI asks great questions. The plan looks solid. You approve.

But the plan included "add exponential backoff, circuit breaker, request deduplication, and a retry dashboard." You asked for retry. You got a resilience framework.

> Plan mode surfaces assumptions — but if you approve without pushing back on scope, the AI treats the whole plan as green-lit. You needed to say "just the retry, nothing else."

> **INSIGHT:** An approved plan is a contract. Read it like one.

> **INSIGHT:** Always understand what you are asking for. Don't offload the thinking to the AI.

---

## Level 3: Constrained Agents

- Define the agent's **role, rules, and methodology**
- Reusable across sessions — encode best practices once
- Use system prompts to enforce constraints and guardrails

```bash
claude --system-prompt "$(cat prompts/analyst.md)" \
  "Begin your work. Read feature-request.md for context."
```

> **INSIGHT:** Tell Claude what to do instead of what not to do

---

## System Prompts >> User Prompts

- Claude treats system prompts as **authoritative instructions**.

> **INSIGHT:** User prompts are **requests**; system prompts are **rules**.

**Example 1 — Enforcement:**

> User: "Just skip the tests, I'll add them later."
> System prompt: "ALWAYS write tests first (TDD). No exceptions."
> **Result:** System prompt wins. Tests get written.

**Example 2 — Role boundaries:**

> User: "Just fix the bug yourself instead of commenting."
> System prompt: "NEVER modify code. Only write review comments."
> **Result:** Agent stays in its lane. Writes a comment, doesn't touch code.

---

## Level 3 Failure: The Single-Brain Problem

Your system prompt is perfectly constrained. The agent follows every rule.

But the task touches 8 files across 3 layers. By file 5, the agent is making trade-offs that contradict decisions it made in file 2. No reviewer catches it — it's one agent doing everything.

> For large cross-cutting work, you need a second set of eyes. That requires a separate role, not more rules.

---

## Level 4: Agent Orchestration

- Chain multiple system-prompt-driven agent sessions into a **workflow**
- Each step has a dedicated role with its own prompt and output artifacts
- Automated dev/review loops that iterate until clean

> This takes AI-assisted development from "one agent doing everything" to "specialized agents collaborating on a pipeline."

---

## Level 4 Failure: The Telephone Game

The analyst writes vague requirements. The architect designs based on assumptions. The developer implements the wrong thing cleanly. The reviewer approves because it matches the spec.

**Everyone did their job perfectly. The feature is still wrong.**

```
Vague requirement → Assumed design → Clean implementation of the wrong thing
```

> Multi-role orchestration amplifies quality — but also amplifies ambiguity. If the first role's output is fuzzy, every downstream role inherits the confusion. The chain is only as good as its weakest artifact.

> **INSIGHT:** The chain is only as good as its first artifact. Validate early or fail expensively.

---

## Part 2: The Composer Tool

A multi-step composition engine that orchestrates AI agent roles.

- **Entry:** `composer compose <type> --context "..." | --ado <id>`
- **State:** JSON files in `.claude/.skill-state/composer/`

```bash
composer compose full --ado 12345
composer compose role --role architect --context "Refactor auth service"
```

---

## Role Prompts: Specialized Agent Behavior

| | Role | Reads | Produces | Key Rules |
|-|------|-------|----------|-----------|
| | Analyst | `feature-request.md` | `requirements.md` | No tech choices, challenge vague reqs |
| | Architect | `requirements.md` | `spec.md` | Discuss trade-offs, no code |
|↱| Developer | `spec.md`, `tasks.md` | Committed code | TDD, sub-agents, small commits |
|↳| Reviewer | Code diff, `spec.md` | `comments.md` | Must Fix / Should Fix / Nitpicks |

**Each role is bounded. The analyst can't write code, the dev can't change the spec.**

---

## Full Composition Flow

- **Create Environment** — Git worktree + symlinks + seed `feature-request.md`
- **Analyst** — Interviews user, produces `requirements.md`
- **Architect** — Designs system, produces `spec.md`
- **Auto-Distill** — Merges all three → `improved-feature-request.md`
- **Ralph Loop** — Automated developer/reviewer iteration
- **PR** — Dry-run preview, then create ADO draft PR

---

## Auto-Distill

- Triggered automatically after architect step
- Merges `feature-request.md` + `requirements.md` + `spec.md`
- Produces `improved-feature-request.md` — zero-ambiguity document

Enables **zero-intervention** re-runs:

```bash
composer compose ralph-only \
  --context-file improved-feature-request.md
```

> This is the flywheel. The distilled version can drive fully automated dev/review without human intervention on the second pass.

---

## The Ralph Loop

```
  ┌─────────────┐     ┌─────────────┐       ┌─────────────────┐
  │  Developer  │────>│  Reviewer   │────>  │ Parse comments  │
  └─────────────┘     └─────────────┘       └───────┬─────────┘
        ▲                                           │
        │                                ┌──────────┴─────────┐
        │                                ▼                    ▼
        │                         ┌────────────┐      ┌────────────┐
        └─────────────────────────│  Re-run (r)│      │   Done ✓   │
                                  └────────────┘      └────────────┘
```

- **Developer** runs headless with `developer_single.md` prompt or `developer.md` with sub-agents for complex tasks
- **Reviewer** produces `comments.md`: Must Fix / Should Fix / Nitpicks
- User can ignore specific comments (`i 1 3` or `i 1-4`)

---

## Cost of orchestration (time + money)

This has a minimum cost floor. For tasks below that floor, you paid more for the process than the code. Not every task deserves a pipeline.

e.g Adding a new field to an API Response: A dev could've implemented this feature in 2 hours. The pipeline takes: analyst (15 min) → architect (20 min) → 3 ralph iterations (45 min each) → PR review. Total: 3+ hours, $12 in tokens, and you still reviewed every artifact.

> If the task fits in one commit and one mental context, Composer adds overhead, not value.

---

## Composer shines when

- The task spans multiple files, layers, or modules that need to stay consistent
- Requirements are ambiguous enough to benefit from analyst → architect refinement
- The work would normally take multiple sessions or PRs to complete

---

## Part 3: Practical Tools

Using hooks, notifications, custom scripts and tmux to boost productivity.

---

## [Claude hooks](https://code.claude.com/docs/en/hooks)

Hooks fire on lifecycle events. Configure in `~/.claude/settings.json`:

```json
{ "hooks": {
    "UserPromptSubmit": [{ "hooks": [
      { "type": "command", "command": "~/.claude/hooks/prevent_sleep.sh" }
    ]}],
    "Stop": [{ "hooks": [
      { "type": "command", "command": "~/.claude/hooks/notify.sh" },
      { "type": "command", "command": "~/.claude/hooks/send-context.sh" }
    ]}]
}}
```

---

## ntfy.sh: Push Notifications

- Hook into `Stop` event to get notified when an agent finishes
- Careful with sending sensitive info in the notifications

---

## Context Listener: Monitor Context Usage

- Agents use a buffer for context compaction which also uses up context.
- For smaller context window models this can be a significant chunk.

> You want to stay under 50% context usage to avoid degraded model performance

---

## Context Listener: Monitor Context Usage

Monitor context usage in real-time with a Claude Code hook:

```
Claude Code (stop event)
  → send-context.sh (extracts usage from transcript JSONL)

```

**Live output (compact mode):**

```
14:32:05 · ████████████░░░░░░░░ · 42.3% · 85k/200k · opus · Add caching
14:33:12 · ██████████████░░░░░░ · 56.1% · 112k/200k · opus · Write tests · EditorSession
```

- **Green** (< 50%) → **Yellow** (50-80%) → **Red** (> 80%)

Alternative (non-tmux only): [starship claude](https://github.com/martinemde/starship-claude?tab=readme-ov-file#my-favorite-feature-context-window-progress-bar)

---

## Hooks Setup

| Event | Hook | What it does |
|-------|------|-------------|
| `UserPromptSubmit` | `prevent_sleep.sh` | `caffeinate` keeps Mac awake while agent works |
| `Stop` | `allow_sleep.sh` | Kills caffeinate, re-enables sleep |
| `Stop` | `send-context.sh` | Posts token usage to context-listener |
| `Stop` | `notify.sh` | Push notification via ntfy.sh with session name |

---

## Session Metrics: Know What You're Spending

```bash
composer report              # interactive session picker
composer report my-session   # direct report for a session
```

- Tool call breakdown per step (Read, Write, Edit, Bash, Grep)
- Wall clock time per task
- Aggregated at composer session level instead of claude session level for better granularity

---

## Disk Usage: The Worktree Problem

Each sandbox = a full git worktree.

`5 sandboxes × 10 GB node_modules = 50 GB duplicated`

**Solution:** Symlink `node_modules` from the main repo (default):

> Cleanup: `sandbox clean --all`

---

## Key Takeaways

1. **Start with plan mode** — then read the plan like a contract before approving
2. **System prompts are rules, not suggestions** — tell Claude what to do, not what not to do
3. **Validate early artifacts** — the chain is only as good as its first output. **Stop and course-correct early** — the AI will not stop itself
4. **Always understand what you are asking for. Don't offload the thinking to the AI.**
5. **Specialized roles > one agent doing everything**

---
> AI is not a silver bullet. The way to think about it is as a **force multiplier** for your existing dev process, not a replacement. The more structure and guardrails you put around it, the more effective it becomes. AI will just make code production faster but if you write poor code, it will produce poor code faster.
