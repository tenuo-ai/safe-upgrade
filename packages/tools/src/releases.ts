/**
 * Release evidence retrieval.
 *
 * Release notes are the most attacker-adjacent input in the system: they are
 * remote text that we deliberately feed to a model. Two separate defenses apply.
 * This module constrains *where* we fetch from; the workers treat everything
 * retrieved as quoted data that can never carry an instruction.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ReleaseEvidenceError, ToolExecutionError } from "@safe-upgrade/domain";
import { sha256Hex } from "@safe-upgrade/evidence";
import { defineTool, type RawTool, type ToolContext } from "./context.ts";

/**
 * Hosts we will talk to. Kept as exact names rather than a wildcard because a
 * glob like `*.github.com` also matches hosts an attacker may control.
 */
export const RELEASE_HOST_ALLOWLIST: readonly string[] = [
  "registry.npmjs.org",
  "api.github.com",
  "github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
];

const MAX_REDIRECTS = 5;

export interface FetchedDocument {
  readonly sourceUrl: string;
  readonly finalUrl: string;
  readonly retrievedAt: string;
  readonly contentHash: string;
  readonly mediaType: string;
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * How a package expects to be loaded.
 *
 * Worth its own field because it is the difference that breaks a CommonJS caller
 * without any API changing: a package that becomes `"type": "module"` cannot be
 * `require()`d, and nothing about its exported names has to move for that to be
 * true.
 */
export type ModuleType = "module" | "commonjs" | "unknown";

/**
 * The part of a published manifest a worker may see.
 *
 * An allowlist, not a pass-through. The registry document is remote text, and
 * forwarding it whole would put arbitrary attacker-chosen keys into graph state
 * and from there into a prompt and a checkpoint. Everything here is either a value
 * from a closed set or a string we have bounded.
 */
export interface PublishedShape {
  readonly moduleType: ModuleType;
  readonly hasExportsField: boolean;
  /** Whether the package still offers a CommonJS entry point. */
  readonly hasCommonJsEntry: boolean;
  readonly requiredNodeRange: string | null;
  readonly deprecated: string | null;
}

export interface RegistryMetadata {
  readonly packageName: string;
  readonly version: string;
  readonly resolvedVersion: string;
  readonly repositoryUrl: string | null;
  readonly homepage: string | null;
  readonly publishedAt: string | null;
  readonly shape: PublishedShape;
  /** Peer ranges the published version declares. Empty when it declares none. */
  readonly peerDependencies: Readonly<Record<string, string>>;
  readonly contentHash: string;
  readonly retrievedAt: string;
}

export type ReadRegistryMetadataArgs = {
  readonly packageName: string;
  readonly version: string;
}

export type FetchReleaseDocumentArgs = {
  readonly url: string;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  const [a = 0, b = 0] = parts;
  if (a === 10 || a === 127 || a === 0) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true; // link-local, including the cloud metadata service
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return true; // carrier-grade NAT
  }
  if (a === 192 && b === 0) {
    return true;
  }
  if (a >= 224) {
    return true; // multicast and reserved
  }
  return false;
}

function isPrivateIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === "::" || lower === "::1") {
    return true;
  }
  if (lower.startsWith("fe80") || lower.startsWith("fc") || lower.startsWith("fd")) {
    return true; // link-local and unique-local
  }
  if (lower.startsWith("::ffff:")) {
    const mapped = lower.slice("::ffff:".length);
    return isIP(mapped) === 4 ? isPrivateIpv4(mapped) : true;
  }
  return false;
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return isPrivateIpv4(address);
  }
  if (family === 6) {
    return isPrivateIpv6(address);
  }
  return true;
}

/**
 * Validate a URL before every hop, including after a redirect.
 *
 * Resolving DNS and checking the addresses leaves a rebinding window between
 * this check and the socket connect, which Node's fetch gives us no way to pin.
 * The host allowlist is what actually holds here; the address check is a second
 * layer that catches an allowlisted name pointed at an internal address.
 */
async function assertFetchable(raw: string, allowedHosts: readonly string[]): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolExecutionError(`not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:") {
    throw new ToolExecutionError(`only https is allowed, got ${url.protocol}`);
  }
  if (!allowedHosts.includes(url.hostname)) {
    throw new ToolExecutionError(`host is not allowlisted: ${url.hostname}`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new ToolExecutionError("URL credentials are not allowed");
  }
  if (url.port.length > 0 && url.port !== "443") {
    throw new ToolExecutionError(`only port 443 is allowed, got ${url.port}`);
  }

  const addresses = await lookup(url.hostname, { all: true }).catch(() => {
    throw new ReleaseEvidenceError(`cannot resolve ${url.hostname}`);
  });
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new ToolExecutionError(`${url.hostname} resolves to a non-public address`);
    }
  }
  return url;
}

async function readBounded(response: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
  const body = response.body;
  if (body === null) {
    return { text: "", truncated: false };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value === undefined) {
      continue;
    }
    if (total + value.length > limit) {
      chunks.push(value.subarray(0, limit - total));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const merged = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return { text: merged.toString("utf8"), truncated };
}

/** Strip markup so a model sees prose, not attacker-shaped HTML structure. */
export function normalizeDocument(text: string, mediaType: string): string {
  if (!mediaType.includes("html")) {
    return text;
  }
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Bound a remote string before it can reach state, a prompt, or a checkpoint. */
function boundedString(value: unknown, limit: number): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, limit) : null;
}

function peerDependenciesOf(manifest: Record<string, unknown>): Readonly<Record<string, string>> {
  const raw = manifest.peerDependencies;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {};
  }
  const peers: Record<string, string> = {};
  for (const [name, range] of Object.entries(raw)) {
    if (typeof range === "string" && range.length > 0 && range.length < 128 && name.length < 214) {
      peers[name] = range;
    }
  }
  return peers;
}

/**
 * Read the load shape out of a published manifest.
 *
 * `exports` is inspected only for whether a `require` condition survives, because
 * that is the question a CommonJS caller is asking. Its full shape is a nested,
 * attacker-authored structure and is not something to walk into state.
 */
export function publishedShape(manifest: Record<string, unknown>): PublishedShape {
  const declaredType = manifest.type;
  const moduleType: ModuleType =
    declaredType === "module" ? "module" : declaredType === "commonjs" ? "commonjs" : "unknown";
  const exportsField = manifest.exports;
  const hasExportsField = exportsField !== undefined && exportsField !== null;
  const engines = manifest.engines;
  const requiredNodeRange =
    typeof engines === "object" && engines !== null
      ? boundedString((engines as Record<string, unknown>).node, 128)
      : null;

  return {
    moduleType,
    hasExportsField,
    hasCommonJsEntry: hasCommonJsEntry(moduleType, exportsField, manifest.main),
    requiredNodeRange,
    deprecated: boundedString(manifest.deprecated, 512),
  };
}

function hasCommonJsEntry(
  moduleType: ModuleType,
  exportsField: unknown,
  main: unknown,
): boolean {
  // An ESM-typed package can still be required if it exposes a `require`
  // condition, so the declared type alone does not settle it.
  if (exportsField !== undefined && exportsField !== null) {
    return mentionsRequireCondition(exportsField, 0) || (moduleType !== "module" && typeof main === "string");
  }
  if (moduleType === "module") {
    // `.cjs` stays CommonJS regardless of the package type.
    return typeof main === "string" && main.endsWith(".cjs");
  }
  return typeof main === "string" || moduleType === "commonjs";
}

/** Depth-limited: the structure is remote and may be deeply nested on purpose. */
function mentionsRequireCondition(node: unknown, depth: number): boolean {
  if (depth > 8 || typeof node !== "object" || node === null) {
    return false;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "require" || key === "default" && typeof value === "string" && value.endsWith(".cjs")) {
      return true;
    }
    if (mentionsRequireCondition(value, depth + 1)) {
      return true;
    }
  }
  return false;
}

async function fetchFollowing(
  raw: string,
  limits: { readonly timeoutMs: number; readonly maxBytes: number },
  allowedHosts: readonly string[],
): Promise<FetchedDocument> {
  let current = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const url = await assertFetchable(current, allowedHosts);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: "text/plain, text/markdown, application/json, text/html", "user-agent": "safe-upgrade" },
      });
    } catch (error) {
      throw new ReleaseEvidenceError(`fetch failed for ${url.hostname}`, { cause: error });
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location === null) {
        throw new ReleaseEvidenceError(`redirect without a location from ${url.hostname}`);
      }
      // Re-validate the next hop from scratch rather than trusting the first.
      current = new URL(location, url).toString();
      continue;
    }
    if (!response.ok) {
      throw new ReleaseEvidenceError(`${url.hostname} returned HTTP ${response.status}`);
    }

    const mediaType = (response.headers.get("content-type") ?? "text/plain").split(";")[0]?.trim() ?? "text/plain";
    const { text, truncated } = await readBounded(response, limits.maxBytes);
    return {
      sourceUrl: raw,
      finalUrl: url.toString(),
      retrievedAt: new Date().toISOString(),
      contentHash: sha256Hex(text),
      mediaType,
      text: normalizeDocument(text, mediaType),
      truncated,
    };
  }
  throw new ReleaseEvidenceError(`too many redirects starting at ${raw}`);
}

export function createReleaseTools(
  context: ToolContext,
  allowedHosts: readonly string[] = RELEASE_HOST_ALLOWLIST,
): {
  readonly readRegistryMetadata: RawTool<ReadRegistryMetadataArgs, RegistryMetadata>;
  readonly fetchReleaseDocument: RawTool<FetchReleaseDocumentArgs, FetchedDocument>;
} {
  const limits = { timeoutMs: context.limits.releaseTimeoutMs, maxBytes: context.limits.maxReleaseBodyBytes };

  return {
    readRegistryMetadata: defineTool<ReadRegistryMetadataArgs, RegistryMetadata>(
      context,
      "read_registry_metadata",
      "Read npm registry metadata for one package version.",
      async (args) => {
        // The package name goes into a URL path, so it is encoded rather than
        // interpolated, and the scope separator is preserved deliberately.
        const encoded = args.packageName
          .split("/")
          .map((part) => encodeURIComponent(part))
          .join("/");
        const url = `https://registry.npmjs.org/${encoded}/${encodeURIComponent(args.version)}`;
        const document = await fetchFollowing(url, limits, allowedHosts);
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(document.text) as Record<string, unknown>;
        } catch (error) {
          throw new ReleaseEvidenceError(`registry metadata for ${args.packageName} is not JSON`, { cause: error });
        }
        const resolvedVersion = typeof parsed.version === "string" ? parsed.version : "";
        if (resolvedVersion !== args.version) {
          throw new ReleaseEvidenceError(
            `registry returned version ${resolvedVersion || "<none>"} for a request for ${args.version}`,
          );
        }
        const repository = parsed.repository;
        const repositoryUrl =
          typeof repository === "object" && repository !== null && "url" in repository
            ? String((repository as { url: unknown }).url)
            : typeof repository === "string"
              ? repository
              : null;
        return {
          packageName: args.packageName,
          version: args.version,
          resolvedVersion,
          repositoryUrl,
          homepage: typeof parsed.homepage === "string" ? parsed.homepage : null,
          publishedAt: null,
          shape: publishedShape(parsed),
          peerDependencies: peerDependenciesOf(parsed),
          contentHash: document.contentHash,
          retrievedAt: document.retrievedAt,
        };
      },
    ),

    fetchReleaseDocument: defineTool<FetchReleaseDocumentArgs, FetchedDocument>(
      context,
      "fetch_release_document",
      "Fetch a release note, changelog, or migration guide over https.",
      async (args) => fetchFollowing(args.url, limits, allowedHosts),
    ),
  };
}
