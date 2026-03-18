import { describe, it, expect } from "vitest";
import { resolveTemplate } from "../../src/composer/execution.js";
import type { TemplateVars } from "../../src/composer/config/types.js";

function makeVars(overrides: Partial<TemplateVars> = {}): TemplateVars {
  return {
    sessionId: "test-session",
    context: "some context",
    branchName: "users/dev/test-branch",
    branch: "users/dev/test-branch",
    worktree: "/tmp/worktree",
    model: "opus",
    maxIterations: 5,
    adoId: "12345",
    role: "developer",
    baseBranch: "master",
    claudeSessionId: "abc-def-123",
    ...overrides,
  };
}

describe("resolveTemplate", () => {
  it("replaces a single placeholder", () => {
    const vars = makeVars({ branch: "my-branch" });
    const { resolved } = resolveTemplate("git checkout {branch}", vars);
    expect(resolved).toBe("git checkout my-branch");
  });

  it("replaces multiple placeholders in one string", () => {
    const vars = makeVars({ model: "sonnet", maxIterations: 3 });
    const { resolved } = resolveTemplate(
      "claude --model {model} --max {max_iterations}",
      vars,
    );
    expect(resolved).toBe("claude --model sonnet --max 3");
  });

  it("replaces all known token types", () => {
    const vars = makeVars();
    const template =
      "{session_id} {branch_name} {branch} {worktree} {model} {max_iterations} {ado_id} {role} {base_branch} {claude_session_id}";
    const { resolved } = resolveTemplate(template, vars);
    expect(resolved).not.toContain("{");
    expect(resolved).toContain("test-session");
    expect(resolved).toContain("users/dev/test-branch");
    expect(resolved).toContain("/tmp/worktree");
    expect(resolved).toContain("opus");
    expect(resolved).toContain("5");
    expect(resolved).toContain("12345");
    expect(resolved).toContain("developer");
    expect(resolved).toContain("master");
    expect(resolved).toContain("abc-def-123");
  });

  it("replaces {sandbox} and {pr_script} with script paths", () => {
    const vars = makeVars();
    const { resolved } = resolveTemplate("{sandbox} create && node {pr_script}", vars);
    expect(resolved).not.toContain("{sandbox}");
    expect(resolved).not.toContain("{pr_script}");
  });

  it("handles repeated placeholders", () => {
    const vars = makeVars({ branch: "feat/x" });
    const { resolved } = resolveTemplate("{branch}/{branch}", vars);
    expect(resolved).toBe("feat/x/feat/x");
  });

  it("passes through strings with no placeholders", () => {
    const vars = makeVars();
    const { resolved } = resolveTemplate("echo hello world", vars);
    expect(resolved).toBe("echo hello world");
  });

  it("handles empty claudeSessionId", () => {
    const vars = makeVars({ claudeSessionId: undefined });
    const { resolved } = resolveTemplate("--session {claude_session_id}", vars);
    expect(resolved).toBe("--session ");
  });
});
