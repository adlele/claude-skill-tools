import { describe, it, expect, beforeEach, afterAll } from "vitest";
import * as path from "node:path";
import { parseComments, filterIgnored } from "../../src/sandbox/ralph-helpers.js";
import { createTempDir, removeTempDir, writeFile } from "../helpers/fixtures.js";
import * as fs from "node:fs";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.realpathSync(createTempDir("cst-ralph-"));
});

afterAll(() => {
  if (tmpDir) removeTempDir(tmpDir);
});

describe("parseComments", () => {
  it("returns empty array for non-existent file", () => {
    expect(parseComments("/nonexistent/comments.md")).toEqual([]);
  });

  it("extracts ### comments under ## Must Fix", () => {
    const file = path.join(tmpDir, "comments.md");
    writeFile(
      file,
      [
        "## Must Fix",
        "### Missing null check in handler",
        "### SQL injection in query builder",
        "## Nice to Have",
        "### Consider adding docs",
      ].join("\n"),
    );
    const comments = parseComments(file);
    expect(comments).toEqual([
      "### Missing null check in handler",
      "### SQL injection in query builder",
    ]);
  });

  it("extracts ### comments under ## Should Fix", () => {
    const file = path.join(tmpDir, "comments.md");
    writeFile(
      file,
      [
        "## Should Fix",
        "### Add error handling",
        "## Other",
        "### Not extracted",
      ].join("\n"),
    );
    const comments = parseComments(file);
    expect(comments).toEqual(["### Add error handling"]);
  });

  it("extracts from both Must Fix and Should Fix sections", () => {
    const file = path.join(tmpDir, "comments.md");
    writeFile(
      file,
      [
        "## Must Fix",
        "### Critical bug",
        "## Should Fix",
        "### Minor issue",
        "## Praise",
        "### Great work",
      ].join("\n"),
    );
    const comments = parseComments(file);
    expect(comments).toEqual(["### Critical bug", "### Minor issue"]);
  });

  it("ignores non-### lines within sections", () => {
    const file = path.join(tmpDir, "comments.md");
    writeFile(
      file,
      [
        "## Must Fix",
        "Some body text here",
        "### Actual comment",
        "More body text",
      ].join("\n"),
    );
    const comments = parseComments(file);
    expect(comments).toEqual(["### Actual comment"]);
  });

  it("returns empty array when no matching sections", () => {
    const file = path.join(tmpDir, "comments.md");
    writeFile(file, "## Praise\n### Great job\n## Summary\nAll good.");
    expect(parseComments(file)).toEqual([]);
  });
});

describe("filterIgnored", () => {
  it("returns all comments when ignored file does not exist", () => {
    const comments = ["### Bug A", "### Bug B"];
    expect(filterIgnored(comments, "/nonexistent/ignored.txt")).toEqual(
      comments,
    );
  });

  it("filters out comments present in ignored file", () => {
    const ignoredFile = path.join(tmpDir, "ignored.txt");
    writeFile(ignoredFile, "### Bug A\n");
    const comments = ["### Bug A", "### Bug B"];
    expect(filterIgnored(comments, ignoredFile)).toEqual(["### Bug B"]);
  });

  it("returns empty when all comments are ignored", () => {
    const ignoredFile = path.join(tmpDir, "ignored.txt");
    writeFile(ignoredFile, "### Bug A\n### Bug B\n");
    const comments = ["### Bug A", "### Bug B"];
    expect(filterIgnored(comments, ignoredFile)).toEqual([]);
  });

  it("returns all when ignored file is empty", () => {
    const ignoredFile = path.join(tmpDir, "ignored.txt");
    writeFile(ignoredFile, "");
    const comments = ["### Bug A"];
    expect(filterIgnored(comments, ignoredFile)).toEqual(["### Bug A"]);
  });
});
