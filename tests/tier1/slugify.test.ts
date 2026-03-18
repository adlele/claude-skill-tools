import { describe, it, expect } from "vitest";
import { slugifyContext } from "../../src/composer/commands.js";

describe("slugifyContext", () => {
  it("lowercases and converts spaces to dashes", () => {
    expect(slugifyContext("Add Pin Feature")).toBe("add-pin-feature");
  });

  it("strips markdown heading prefix", () => {
    expect(slugifyContext("# My Feature")).toBe("my-feature");
  });

  it("strips non-alphanumeric characters", () => {
    expect(slugifyContext("Hello!!! World???")).toBe("hello-world");
  });

  it("collapses multiple spaces and dashes", () => {
    expect(slugifyContext("too   many   spaces")).toBe("too-many-spaces");
    expect(slugifyContext("too---many---dashes")).toBe("too-many-dashes");
  });

  it("caps at 40 characters and trims trailing dash", () => {
    const long = "a ".repeat(30).trim(); // "a a a a ..." — 59 chars
    const result = slugifyContext(long);
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result).not.toMatch(/-$/);
  });

  it("returns empty string for empty input", () => {
    expect(slugifyContext("")).toBe("");
  });

  it("returns empty string when all chars are special", () => {
    expect(slugifyContext("!@#$%^&*()")).toBe("");
  });
});
