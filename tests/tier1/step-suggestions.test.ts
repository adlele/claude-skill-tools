import { describe, it, expect } from "vitest";
import { stepFailSuggestions } from "../../src/composer/execution.js";
import type { StepType } from "../../src/composer/config/types.js";

describe("stepFailSuggestions", () => {
  const stepTypes: StepType[] = [
    "sandbox-create",
    "sandbox-start",
    "claude-interactive",
    "ralph",
    "pr-dry-run",
    "ado-pr-create",
    "status-check",
  ];

  for (const stepType of stepTypes) {
    it(`returns suggestions for '${stepType}' that mention exit code`, () => {
      const suggestions = stepFailSuggestions(stepType, 1);
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions.some(s => s.includes("code 1"))).toBe(true);
    });
  }

  it("includes sandbox-specific suggestions for sandbox-create", () => {
    const suggestions = stepFailSuggestions("sandbox-create", 1);
    expect(suggestions.some(s => s.includes("sandbox script"))).toBe(true);
  });

  it("includes Claude-specific suggestions for claude-interactive", () => {
    const suggestions = stepFailSuggestions("claude-interactive", 1);
    expect(suggestions.some(s => s.includes("Claude API"))).toBe(true);
  });

  it("includes PR-specific suggestions for ado-pr-create", () => {
    const suggestions = stepFailSuggestions("ado-pr-create", 1);
    expect(suggestions.some(s => s.includes("commits"))).toBe(true);
  });

  it("uses the actual exit code in the message", () => {
    const suggestions = stepFailSuggestions("ralph", 42);
    expect(suggestions.some(s => s.includes("code 42"))).toBe(true);
  });
});
