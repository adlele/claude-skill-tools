import { describe, it, expect } from "vitest";
import { normalizeAdoOrg } from "../../src/shared/config.js";

describe("normalizeAdoOrg", () => {
  it("converts bare name to full URL", () => {
    expect(normalizeAdoOrg("myorg")).toBe("https://dev.azure.com/myorg");
  });

  it("passes through full https URL", () => {
    expect(normalizeAdoOrg("https://dev.azure.com/myorg")).toBe(
      "https://dev.azure.com/myorg",
    );
  });

  it("passes through http URL", () => {
    expect(normalizeAdoOrg("http://dev.azure.com/myorg")).toBe(
      "http://dev.azure.com/myorg",
    );
  });

  it("strips trailing slashes from URL", () => {
    expect(normalizeAdoOrg("https://dev.azure.com/myorg///")).toBe(
      "https://dev.azure.com/myorg",
    );
  });

  it("trims whitespace", () => {
    expect(normalizeAdoOrg("  myorg  ")).toBe("https://dev.azure.com/myorg");
  });

  it("trims whitespace from URL input", () => {
    expect(normalizeAdoOrg("  https://dev.azure.com/myorg  ")).toBe(
      "https://dev.azure.com/myorg",
    );
  });
});
