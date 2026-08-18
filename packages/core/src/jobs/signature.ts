import { createHmac, timingSafeEqual } from "node:crypto";

/** How far a timestamp may drift, in seconds, before the request is treated as a replay. */
const DEFAULT_TOLERANCE_SEC = 300;

/**
 * The signature a sender puts in `x-deskmate-signature`. Signing the timestamp with
 * the body is what makes an intercepted request unusable later; the scheme mirrors
 * Slack's so any sender has a reference implementation to copy.
 */
export function signHookBody(secret: string, timestamp: string, raw: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex")}`;
}

export interface VerifyHookInput {
  raw: string;
  secret: string;
  signature: string | null;
  timestamp: string | null;
  nowMs: number;
  toleranceSec?: number;
}

/** Constant-time verification. Any missing or malformed part is a rejection, never a pass. */
export function verifyHookSignature(input: VerifyHookInput): boolean {
  const { raw, secret, signature, timestamp, nowMs } = input;
  const tolerance = input.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  if (!secret || !signature || !timestamp) return false;

  // `Number(timestamp)` alone is too permissive: it accepts whitespace-only
  // strings (→ 0), hex ("0x10"), exponent notation ("1e9"), a leading "+", and
  // decimals — all currently harmless only because the replay window below
  // rejects anything far from `nowMs`. But `toleranceSec` is a caller-tunable
  // field on `VerifyHookInput`; a consumer that widens it would silently make an
  // out-of-format timestamp (e.g. epoch 0 via whitespace) reachable. Require a
  // plain, non-empty run of decimal digits before converting.
  if (!/^\d+$/.test(timestamp)) return false;
  const sentSec = Number(timestamp);
  if (!Number.isFinite(sentSec)) return false;
  if (Math.abs(nowMs / 1000 - sentSec) > tolerance) return false;

  const expected = Buffer.from(signHookBody(secret, timestamp, raw));
  const actual = Buffer.from(signature);
  // timingSafeEqual throws on a length mismatch, which itself leaks nothing useful
  // here (the expected length is fixed and public), so guard it explicitly.
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
