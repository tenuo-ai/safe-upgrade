/**
 * Structured edits to a package manifest.
 *
 * Not a text write. `package.json` is where a repository declares what runs on
 * install and what runs as a check, so a worker able to write it as text is a
 * worker able to give itself a `postinstall` script and a `test` script that
 * always passes. That is why `write_source_file` refuses manifests, and why the
 * answer is not to relax it.
 *
 * So this edits named fields from a closed set, and only to values from a closed
 * set. The field and the value are ordinary arguments, which means the capability
 * constrains them: a session can be narrowed to `field: "type"` and
 * `value: "module"` and nothing else that reaches this tool will do anything else.
 *
 * Field order and formatting are preserved. A diff that reorders a manifest hides
 * the one line that changed inside a hundred that did not, and this change is
 * meant to be reviewed.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { InputValidationError, ToolExecutionError } from "@safe-upgrade/domain";
import { sha256Hex } from "@safe-upgrade/evidence";
import { defineTool, type RawTool, type ToolContext } from "./context.ts";
import { resolveInsideRoot } from "./paths.ts";

/**
 * Editable fields, and what each may be set to.
 *
 * Top-level scalars only. `scripts` and the dependency blocks are deliberately
 * absent: scripts are the escalation path this tool exists to avoid, and
 * dependencies move through the package manager so the lockfile moves with them.
 */
const EDITABLE: Readonly<Record<string, readonly string[]>> = {
  type: ["module", "commonjs"],
};

export const EDITABLE_MANIFEST_FIELDS: readonly string[] = Object.keys(EDITABLE);

export function allowedManifestValues(field: string): readonly string[] {
  return EDITABLE[field] ?? [];
}

export type UpdateManifestFieldArgs = {
  readonly path: string;
  readonly field: string;
  readonly value: string;
  /** Hash of the file as the worker last read it. */
  readonly expectedBeforeHash: string;
}

export interface UpdateManifestFieldResult {
  readonly path: string;
  readonly field: string;
  readonly previousValue: string | null;
  readonly value: string;
  readonly hashBefore: string;
  readonly hashAfter: string;
  readonly changed: boolean;
}

export function createManifestTools(context: ToolContext): {
  readonly updateManifestField: RawTool<UpdateManifestFieldArgs, UpdateManifestFieldResult>;
} {
  return {
    updateManifestField: defineTool<UpdateManifestFieldArgs, UpdateManifestFieldResult>(
      context,
      "update_manifest_field",
      "Set one allowlisted top-level field in a package manifest to one allowlisted value.",
      async (args) => {
        const resolved = resolveInsideRoot(context.paths, args.path);
        if (resolved.fileClass !== "manifest") {
          throw new ToolExecutionError(
            `${resolved.relative} is classified as ${resolved.fileClass}, not a manifest`,
          );
        }

        const permitted = EDITABLE[args.field];
        if (permitted === undefined) {
          throw new ToolExecutionError(
            `${args.field} is not an editable manifest field; editable fields are ${EDITABLE_MANIFEST_FIELDS.join(", ")}`,
          );
        }
        if (!permitted.includes(args.value)) {
          throw new ToolExecutionError(
            `${args.field} may not be set to ${args.value}; permitted values are ${permitted.join(", ")}`,
          );
        }

        const before = readFileSync(resolved.absolute, "utf8");
        const hashBefore = sha256Hex(before);
        if (args.expectedBeforeHash !== hashBefore) {
          throw new ToolExecutionError(
            `${resolved.relative} changed since it was read; expected ${args.expectedBeforeHash}`,
          );
        }

        const parsed = parseManifest(before, resolved.relative);
        const previous = parsed[args.field];
        if (previous !== undefined && typeof previous !== "string") {
          throw new ToolExecutionError(
            `${resolved.relative} has a non-string ${args.field}, which this tool will not overwrite`,
          );
        }

        const after = setTopLevelField(before, args.field, args.value);
        // Re-parse rather than trust the edit. A textual edit that produced invalid
        // JSON would leave the repository unable to install, and the point of
        // editing this file structurally is that it cannot happen quietly.
        const reparsed = parseManifest(after, resolved.relative);
        if (reparsed[args.field] !== args.value) {
          throw new ToolExecutionError(`failed to set ${args.field} in ${resolved.relative}`);
        }
        assertOnlyFieldChanged(parsed, reparsed, args.field, resolved.relative);

        writeFileSync(resolved.absolute, after, "utf8");
        return {
          path: resolved.relative,
          field: args.field,
          previousValue: previous ?? null,
          value: args.value,
          hashBefore,
          hashAfter: sha256Hex(after),
          changed: before !== after,
        };
      },
    ),
  };
}

function parseManifest(text: string, relativePath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new InputValidationError(`${relativePath} is not valid JSON`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InputValidationError(`${relativePath} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Nothing but the named field may differ.
 *
 * Compared structurally, so the check does not depend on the textual edit having
 * been careful. A manifest that lost its `scripts` block to a bad edit would
 * otherwise be written out and only noticed when a check stopped running.
 */
function assertOnlyFieldChanged(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  field: string,
  relativePath: string,
): void {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (key === field) {
      continue;
    }
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      throw new ToolExecutionError(`editing ${field} would also change ${key} in ${relativePath}`);
    }
  }
}

/**
 * Set or insert a top-level string field, leaving the rest of the text alone.
 *
 * `JSON.parse` then `JSON.stringify` would be shorter and would reformat the whole
 * file. Indentation is copied from a sibling line so the inserted line matches
 * whatever the repository already does.
 */
export function setTopLevelField(text: string, field: string, value: string): string {
  const encodedKey = JSON.stringify(field);
  const encodedValue = JSON.stringify(value);

  // Only a top-level key: one indent level in, on its own line.
  const existing = new RegExp(String.raw`^(\s*)${escapeForRegExp(encodedKey)}(\s*):(\s*)("(?:[^"\\]|\\.)*")`, "m");
  const found = existing.exec(text);
  if (found !== null && indentDepth(found[1] ?? "") === 1) {
    return `${text.slice(0, found.index)}${found[1] ?? ""}${encodedKey}${found[2] ?? ""}:${found[3] ?? " "}${encodedValue}${text.slice(found.index + found[0].length)}`;
  }

  const opening = text.indexOf("{");
  if (opening === -1) {
    throw new ToolExecutionError("manifest has no object to edit");
  }
  const firstKey = /\n(\s*)"/.exec(text.slice(opening));
  const indent = firstKey?.[1] ?? "  ";
  const rest = text.slice(opening + 1);
  const empty = rest.trim().startsWith("}");
  return `${text.slice(0, opening + 1)}\n${indent}${encodedKey}: ${encodedValue}${empty ? "" : ","}${rest}`;
}

/** Nesting level of a line's leading whitespace, tabs counted as one level each. */
function indentDepth(indent: string): number {
  const withoutNewlines = indent.replace(/\n/g, "");
  if (withoutNewlines.includes("\t")) {
    return withoutNewlines.replace(/[^\t]/g, "").length;
  }
  return Math.round(withoutNewlines.length / 2);
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
