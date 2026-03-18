import { describe, it, expect } from "vitest";
import { deterministicSessionId } from "../../src/metrics/uuid.js";

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("deterministicSessionId", () => {
  it("produces same output for same inputs (deterministic)", () => {
    const a = deterministicSessionId("session-1", 0);
    const b = deterministicSessionId("session-1", 0);
    expect(a).toBe(b);
  });

  it("produces different output for different session IDs", () => {
    const a = deterministicSessionId("session-1", 0);
    const b = deterministicSessionId("session-2", 0);
    expect(a).not.toBe(b);
  });

  it("produces different output for different step indices", () => {
    const a = deterministicSessionId("session-1", 0);
    const b = deterministicSessionId("session-1", 1);
    expect(a).not.toBe(b);
  });

  it("matches UUID v4 format", () => {
    const id = deterministicSessionId("test", 0);
    expect(id).toMatch(UUID_V4_REGEX);
  });

  it("produces different output with suffix parameter", () => {
    const a = deterministicSessionId("session-1", 0);
    const b = deterministicSessionId("session-1", 0, "iter-2");
    expect(a).not.toBe(b);
  });

  it("is deterministic with suffix", () => {
    const a = deterministicSessionId("session-1", 0, "iter-2");
    const b = deterministicSessionId("session-1", 0, "iter-2");
    expect(a).toBe(b);
  });

  it("matches UUID v4 format with suffix", () => {
    const id = deterministicSessionId("test", 3, "my-suffix");
    expect(id).toMatch(UUID_V4_REGEX);
  });
});
