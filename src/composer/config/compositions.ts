import type { Composition } from "./types.js";
import { PACKAGE_ROOT, resolveRepoRoot, getComposerStateDir, getSandboxStateDir } from "../../shared/paths.js";

// ============================================================
// PATH RESOLUTION
// ============================================================

export { getComposerStateDir as COMPOSER_STATE_DIR_FN };

// Lazily resolved — only called when a command actually runs
export function getRepoRoot(): string {
  return resolveRepoRoot();
}

// Sibling script paths — resolved from compiled package location
export function getSandboxScript(): string {
  return `node "${PACKAGE_ROOT}/dist/bin/sandbox.js"`;
}

export function getPrScript(): string {
  return `"${PACKAGE_ROOT}/dist/connectors/ado-pull-request/create.js"`;
}

export function getSandboxStateDirPath(): string {
  return getSandboxStateDir();
}

// ============================================================
// COMPOSITION DEFINITIONS
// ============================================================

export const COMPOSITIONS: Record<string, Composition> = {
  full: {
    description:
      "Full workflow: analyst -> architect -> ralph dev/review -> PR",
    steps: [
      {
        label: "Create sandbox",
        cmd: '{sandbox} create --branch "{branch_name}" --context "{context}" --base "{base_branch}"',
        type: "sandbox-create",
        autoAdvance: true,
      },
      {
        label: "Run analyst",
        cmd: 'cd {worktree} && claude --session-id {claude_session_id} --system-prompt "$(cat prompts/analyst.md)" --model {model} "Begin your work. Read feature-request.md for context."',
        type: "claude-interactive",
      },
      {
        label: "Run architect",
        cmd: 'cd {worktree} && claude --session-id {claude_session_id} --system-prompt "$(cat prompts/architect.md)" --model {model} "Begin your work. Read requirements.md for context."',
        type: "claude-interactive",
      },
      {
        label: "Run ralph (dev/review loop, agents enabled)",
        cmd: '{sandbox} ralph --branch "{branch}" --max-iterations {max_iterations} --model {model} --composer-session {session_id}',
        type: "ralph",
      },
      {
        label: "Preview PR (dry run)",
        cmd: "node {pr_script} --worktree {worktree} --work-items {ado_id} --dry-run",
        type: "pr-dry-run",
      },
      {
        label: "Create draft PR",
        cmd: "node {pr_script} --worktree {worktree} --target {base_branch} --draft --work-items {ado_id}",
        type: "ado-pr-create",
      },
    ],
  },

  "ralph-only": {
    description: "Direct ralph: sandbox + automated dev/review -> PR",
    steps: [
      {
        label: "Create sandbox",
        cmd: '{sandbox} create --branch "{branch_name}" --context "{context}" --base "{base_branch}"',
        type: "sandbox-create",
        autoAdvance: true,
      },
      {
        label: "Run ralph (automated dev/review loop)",
        cmd: '{sandbox} ralph --branch "{branch}" --max-iterations {max_iterations} --model {model} --no-agents --composer-session {session_id}',
        type: "ralph",
      },
      {
        label: "Preview PR (dry run)",
        cmd: "node {pr_script} --worktree {worktree} --work-items {ado_id} --dry-run",
        type: "pr-dry-run",
      },
      {
        label: "Create draft PR",
        cmd: "node {pr_script} --worktree {worktree} --target {base_branch} --draft --work-items {ado_id}",
        type: "ado-pr-create",
      },
    ],
  },

  manual: {
    description:
      "Manual role switching: analyst -> architect -> developer -> reviewer -> PR",
    steps: [
      {
        label: "Create sandbox",
        cmd: '{sandbox} create --branch "{branch_name}" --context "{context}" --base "{base_branch}"',
        type: "sandbox-create",
        autoAdvance: true,
      },
      {
        label: "Run analyst",
        cmd: 'cd {worktree} && claude --session-id {claude_session_id} --system-prompt "$(cat prompts/analyst.md)" --model {model} "Begin your work. Read feature-request.md for context."',
        type: "claude-interactive",
      },
      {
        label: "Run architect",
        cmd: 'cd {worktree} && claude --session-id {claude_session_id} --system-prompt "$(cat prompts/architect.md)" --model {model} "Begin your work. Read requirements.md for context."',
        type: "claude-interactive",
      },
      {
        label: "Run developer",
        cmd: 'cd {worktree} && claude --session-id {claude_session_id} --system-prompt "$(cat prompts/developer.md)" --model {model} "Begin your work. Read spec.md for context."',
        type: "claude-interactive",
      },
      {
        label: "Run reviewer",
        cmd: 'cd {worktree} && claude --session-id {claude_session_id} --system-prompt "$(cat prompts/reviewer.md)" --model {model} "Begin your work. Review the latest changes against spec.md."',
        type: "claude-interactive",
      },
      {
        label: "Preview PR (dry run)",
        cmd: "node {pr_script} --worktree {worktree} --work-items {ado_id} --dry-run",
        type: "pr-dry-run",
      },
      {
        label: "Create draft PR",
        cmd: "node {pr_script} --worktree {worktree} --target {base_branch} --draft --work-items {ado_id}",
        type: "ado-pr-create",
      },
    ],
  },

  role: {
    description:
      "Single role: sandbox + one interactive role session -> PR",
    steps: [
      {
        label: "Create sandbox",
        cmd: '{sandbox} create --branch "{branch_name}" --context "{context}" --base "{base_branch}"',
        type: "sandbox-create",
        autoAdvance: true,
      },
      {
        label: "Run {role}",
        cmd: 'cd {worktree} && claude --session-id {claude_session_id} --system-prompt "$(cat prompts/{role}.md)" --model {model} "Begin your work. Read feature-request.md for context."',
        type: "claude-interactive",
      },
      {
        label: "Preview PR (dry run)",
        cmd: "node {pr_script} --worktree {worktree} --work-items {ado_id} --dry-run",
        type: "pr-dry-run",
      },
      {
        label: "Create draft PR",
        cmd: "node {pr_script} --worktree {worktree} --target {base_branch} --draft --work-items {ado_id}",
        type: "ado-pr-create",
      },
    ],
  },

  headless: {
    description: "Background agent: headless developer -> status check -> PR",
    steps: [
      {
        label: "Create sandbox",
        cmd: '{sandbox} create --branch "{branch_name}" --context "{context}" --base "{base_branch}"',
        type: "sandbox-create",
        autoAdvance: true,
      },
      {
        label: "Launch headless developer",
        cmd: '{sandbox} start --role developer --headless --skip-sandbox --branch "{branch}" --model {model}',
        type: "sandbox-start",
      },
      {
        label: "Check status",
        cmd: '{sandbox} status --branch "{branch}"',
        type: "status-check",
      },
      {
        label: "Preview PR (dry run)",
        cmd: "node {pr_script} --worktree {worktree} --work-items {ado_id} --dry-run",
        type: "pr-dry-run",
      },
      {
        label: "Create draft PR",
        cmd: "node {pr_script} --worktree {worktree} --target {base_branch} --draft --work-items {ado_id}",
        type: "ado-pr-create",
      },
    ],
  },
};
