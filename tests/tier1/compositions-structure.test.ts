import { describe, it, expect } from "vitest";
import { COMPOSITIONS } from "../../src/composer/config/compositions.js";
import type { StepType } from "../../src/composer/config/types.js";

const VALID_STEP_TYPES: StepType[] = [
  "sandbox-create",
  "sandbox-start",
  "claude-interactive",
  "ralph",
  "status-check",
  "pr-dry-run",
  "ado-pr-create",
];

describe("COMPOSITIONS structure", () => {
  const entries = Object.entries(COMPOSITIONS);

  it("has at least one composition defined", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  for (const [name, comp] of entries) {
    describe(`composition '${name}'`, () => {
      it("has a non-empty description", () => {
        expect(comp.description.length).toBeGreaterThan(0);
      });

      it("has at least one step", () => {
        expect(comp.steps.length).toBeGreaterThan(0);
      });

      for (let i = 0; i < comp.steps.length; i++) {
        const step = comp.steps[i];

        it(`step ${i} ('${step.label}') has a valid type`, () => {
          expect(VALID_STEP_TYPES).toContain(step.type);
        });

        it(`step ${i} ('${step.label}') has a non-empty label`, () => {
          expect(step.label.length).toBeGreaterThan(0);
        });

        it(`step ${i} ('${step.label}') has a non-empty cmd`, () => {
          expect(step.cmd.length).toBeGreaterThan(0);
        });
      }
    });
  }

  it("every composition starts with a sandbox-create or sandbox-start step", () => {
    for (const [, comp] of entries) {
      expect(["sandbox-create", "sandbox-start"]).toContain(comp.steps[0].type);
    }
  });

  it("every composition ends with ado-pr-create step", () => {
    for (const [, comp] of entries) {
      expect(comp.steps[comp.steps.length - 1].type).toBe("ado-pr-create");
    }
  });
});
