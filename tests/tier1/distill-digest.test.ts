import { describe, it, expect } from "vitest";
import { extractPromptDigest } from "../../src/sandbox/distill.js";

describe("extractPromptDigest", () => {
  it("extracts ## headings promoted to ###", () => {
    const lines = extractPromptDigest("dev.md", "## Coding Standards\n## Git Workflow");
    expect(lines).toEqual([
      "## dev.md",
      "### Coding Standards",
      "### Git Workflow",
    ]);
  });

  it("preserves ### headings as-is", () => {
    const lines = extractPromptDigest("dev.md", "### Sub Section\n- A point");
    expect(lines).toEqual([
      "## dev.md",
      "### Sub Section",
      "- A point",
    ]);
  });

  it("extracts top-level bullets only", () => {
    const lines = extractPromptDigest("dev.md", [
      "## Rules",
      "- Top-level bullet",
      "  - Nested bullet",
      "    - Deep nested",
      "- Another top-level",
    ].join("\n"));

    expect(lines).toContain("- Top-level bullet");
    expect(lines).toContain("- Another top-level");
    expect(lines).not.toContain("  - Nested bullet");
    expect(lines).not.toContain("    - Deep nested");
  });

  it("skips paragraph text and # title headings", () => {
    const lines = extractPromptDigest("role.md", [
      "# Main Title",
      "",
      "Some intro paragraph that should be skipped.",
      "",
      "## Section",
      "A paragraph inside a section.",
      "- A bullet",
    ].join("\n"));

    expect(lines).not.toContain("# Main Title");
    expect(lines).not.toContain("Some intro paragraph that should be skipped.");
    expect(lines).not.toContain("A paragraph inside a section.");
    expect(lines).toContain("### Section");
    expect(lines).toContain("- A bullet");
  });

  it("returns empty array when no headings or bullets found", () => {
    const lines = extractPromptDigest("empty.md", "Just a paragraph.\nAnother line.");
    expect(lines).toEqual([]);
  });

  it("returns empty array for empty content", () => {
    const lines = extractPromptDigest("empty.md", "");
    expect(lines).toEqual([]);
  });

  it("handles mixed ## and ### headings with bullets", () => {
    const content = [
      "# Developer",
      "",
      "## Process",
      "- Read context",
      "- Create team",
      "",
      "### Agent Rules",
      "- No any types",
      "- Follow existing patterns",
      "",
      "## Coding Standards",
      "- Small commits",
      "- Meaningful names",
    ].join("\n");

    const lines = extractPromptDigest("developer.md", content);
    expect(lines).toEqual([
      "## developer.md",
      "### Process",
      "- Read context",
      "- Create team",
      "### Agent Rules",
      "- No any types",
      "- Follow existing patterns",
      "### Coding Standards",
      "- Small commits",
      "- Meaningful names",
    ]);
  });

  it("skips blockquote lines and numbered lists", () => {
    const lines = extractPromptDigest("role.md", [
      "## Section",
      "> A blockquote line",
      "1. A numbered item",
      "- A bullet",
    ].join("\n"));

    expect(lines).toContain("- A bullet");
    expect(lines).not.toContain("> A blockquote line");
    expect(lines).not.toContain("1. A numbered item");
  });

  it("does not extract #### or deeper headings", () => {
    const lines = extractPromptDigest("role.md", [
      "## Section",
      "#### Deep heading",
      "- A bullet",
    ].join("\n"));

    expect(lines).toContain("### Section");
    expect(lines).toContain("- A bullet");
    expect(lines).not.toContain("#### Deep heading");
  });
});
