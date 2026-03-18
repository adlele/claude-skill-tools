import * as crypto from "node:crypto";

/**
 * Generate a deterministic UUID from a composite key.
 * Uses SHA-256, takes the first 16 bytes, formats as UUID v4 layout.
 */
export function deterministicSessionId(
  composerSessionId: string,
  stepIndex: number,
  suffix?: string,
): string {
  const input = `${composerSessionId}:${stepIndex}${suffix ? `:${suffix}` : ""}`;
  const hash = crypto.createHash("sha256").update(input).digest();
  const bytes = new Uint8Array(hash.buffer, 0, 16);
  // Set version (4) and variant (8-b) bits
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
