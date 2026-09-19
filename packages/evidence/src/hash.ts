/**
 * Hashing and redaction.
 *
 * Large payloads are referenced by digest rather than embedded, and anything
 * that looks like a credential is replaced before it can reach a log, a report,
 * a prompt, or a checkpoint.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/** Stable digest of a structured value, independent of key insertion order. */
export function sha256Canonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return Object.fromEntries(entries.map(([key, inner]) => [key, sortValue(inner)]));
  }
  return value;
}

export const REDACTED = "[redacted]";

const SECRET_KEY = /(secret|token|password|passwd|api[_-]?key|authorization|cookie|holder[_-]?key|private[_-]?key|credential|bearer)/i;

/**
 * Value-shaped secrets we can recognize without knowing the key name: GitHub
 * tokens, PEM blocks, and Authorization header contents.
 */
const SECRET_VALUE = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g,
  /\bsk-[A-Za-z0-9-_]{16,}\b/g,
];

export function redactString(value: string): string {
  let out = value;
  for (const rule of SECRET_VALUE) {
    out = out.replace(rule, REDACTED);
  }
  return out;
}

/**
 * Deep-redact a value for persistence. Keys whose names suggest a credential
 * are dropped entirely; remaining strings are scrubbed for secret-shaped
 * substrings. Byte arrays are reduced to a digest, never emitted raw.
 */
export function redact(value: unknown, extraSecretKeys: readonly string[] = []): unknown {
  const extra = new Set(extraSecretKeys.map((key) => key.toLowerCase()));
  const walk = (input: unknown, depth: number): unknown => {
    if (depth > 12) {
      return "[truncated]";
    }
    if (typeof input === "string") {
      return redactString(input);
    }
    if (input instanceof Uint8Array) {
      return `sha256:${sha256Hex(input)}`;
    }
    if (Array.isArray(input)) {
      return input.map((item) => walk(item, depth + 1));
    }
    if (input !== null && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(input as Record<string, unknown>)) {
        if (SECRET_KEY.test(key) || extra.has(key.toLowerCase())) {
          out[key] = REDACTED;
          continue;
        }
        out[key] = walk(inner, depth + 1);
      }
      return out;
    }
    if (typeof input === "bigint") {
      return input.toString();
    }
    if (typeof input === "function" || typeof input === "symbol") {
      return "[unserializable]";
    }
    return input;
  };
  return walk(value, 0);
}
