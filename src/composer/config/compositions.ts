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
  return `"${PACKAGE_ROOT}/dist/pr-create/create-pr.js"`;
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
        label: "Start analyst sandbox",
        cmd: '{sandbox} start --role analyst --branch "{branch_name}" --context "{context}" --model {model}',
        type: "sandbox-start",
      },
      {
        label: "Run architect",
        cmd: 'cd {worktree} && claude --system-prompt "$(cat prompts/architect.md)" --model {model} "Begin your work. Read requirements.md for context."',
        type: "claude-interactive",
      },
      {
        label: "Run ralph (automated dev/review loop)",
        cmd: '{sandbox} ralph --branch "{branch}" --max-iterations {max_iterations} --model {model}',
        type: "ralph",
      },
      {
        label: "Preview PR (dry run)",
        cmd: "node {pr_script} --worktree {worktree} --work-items {ado_id} --dry-run",
        type: "pr-dry-run",
      },
      {
        label: "Create draft PR",
        cmd: "node {pr_script} --worktree {worktree} --target master --draft --work-items {ado_id}",
        type: "pr-create",
      },
    ],
  },

  "ralph-only": {
    description: "Direct ralph: sandbox + automated dev/review -> PR",
    steps: [
      {
        label: "Start ralph sandbox",
        cmd: '{sandbox} start --ralph --branch "{branch_name}" --context "{context}" --model {model} --max-iterations {max_iterations}',
        type: "sandbox-start-ralph",
      },
      {
        label: "Preview PR (dry run)",
        cmd: "node {pr_script} --worktree {worktree} --work-items {ado_id} --dry-run",
        type: "pr-dry-run",
      },
      {
        label: "Create draft PR",
        cmd: "node {pr_script} --worktree {worktree} --target master --draft --work-items {ado_id}",
        type: "pr-create",
      },
    ],
  },

  manual: {
    description:
      "Manual role switching: analyst -> architect -> developer -> reviewer -> PR",
    steps: [
      {
        label: "Start analyst sandbox",
        cmd: '{sandbox} start --role analyst --branch "{branch_name}" --context "{context}" --model {model}',
        type: "sandbox-start",
      },
      {
        label: "Run architect",
        cmd: 'cd {worktree} && claude --system-prompt "$(cat prompts/architect.md)" --model {model} "Begin your work. Read requirements.md for context."',
        type: "claude-interactive",
      },
      {
        label: "Run developer",
        cmd: 'cd {worktree} && claude --system-prompt "$(cat prompts/developer.md)" --model {model} "Begin your work. Read spec.md for context."',
        type: "claude-interactive",
      },
      {
        label: "Run reviewer",
        cmd: 'cd {worktree} && claude --system-prompt "$(cat prompts/reviewer.md)" --model {model} "Begin your work. Review the latest changes against spec.md."',
        type: "claude-interactive",
      },
      {
        label: "Preview PR (dry run)",
        cmd: "node {pr_script} --worktree {worktree} --work-items {ado_id} --dry-run",
        type: "pr-dry-run",
      },
      {
        label: "Create draft PR",
        cmd: "node {pr_script} --worktree {worktree} --target master --draft --work-items {ado_id}",
        type: "pr-create",
      },
    ],
  },

  role: {
    description:
      "Single role: sandbox + one interactive role session -> PR",
    steps: [
      {
        label: "Start sandbox with {role} role",
        cmd: '{sandbox} start --role {role} --branch "{branch_name}" --context "{context}" --model {model}',
        type: "sandbox-start",
      },
      {
        label: "Run {role}",
        cmd: 'cd {worktree} && claude --system-prompt "$(cat prompts/{role}.md)" --model {model} "Begin your work. Read feature-request.md for context."',
        type: "claude-interactive",
      },
      {
        label: "Preview PR (dry run)",
        cmd: "node {pr_script} --worktree {worktree} --work-items {ado_id} --dry-run",
        type: "pr-dry-run",
      },
      {
        label: "Create draft PR",
        cmd: "node {pr_script} --worktree {worktree} --target master --draft --work-items {ado_id}",
        type: "pr-create",
      },
    ],
  },

  headless: {
    description: "Background agent: headless developer -> status check -> PR",
    steps: [
      {
        label: "Start headless developer",
        cmd: '{sandbox} start --role developer --branch "{branch_name}" --context "{context}" --headless --model {model}',
        type: "sandbox-start-headless",
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
        cmd: "node {pr_script} --worktree {worktree} --target master --draft --work-items {ado_id}",
        type: "pr-create",
      },
    ],
  },
};
