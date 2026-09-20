/**
 * Append-only audit log.
 *
 * Every authorization decision, command, file change, and route choice lands
 * here. Events are written once, never rewritten, and every payload passes
 * through redaction on the way in.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Phase, WorkerId } from "@safe-upgrade/domain";
import { redact, sha256Hex } from "./hash.ts";

export type AuditEventType =
  | "route_decision"
  | "repository_inspected"
  | "baseline_recorded"
  | "worker_unimplemented"
  | "session_delegated"
  | "session_destroyed"
  | "tool_allowed"
  | "tool_denied"
  | "file_changed"
  | "command_completed"
  | "evidence_retrieved"
  | "finding_created"
  | "verification_completed"
  | "result_classified";

export interface AuditEvent {
  readonly eventId: string;
  readonly runId: string;
  readonly timestamp: string;
  readonly phase: Phase;
  readonly worker?: WorkerId;
  readonly type: AuditEventType;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface AuditEventInput {
  readonly phase: Phase;
  readonly worker?: WorkerId;
  readonly type: AuditEventType;
  readonly payload: Readonly<Record<string, unknown>>;
}

const AUTHORIZATION_EVENTS: ReadonlySet<AuditEventType> = new Set([
  "session_delegated",
  "session_destroyed",
  "tool_allowed",
  "tool_denied",
]);

export interface AuditLogOptions {
  readonly runId: string;
  /** Omit to keep the log in memory only, which is what unit tests use. */
  readonly directory?: string;
  readonly clock?: () => Date;
}

export class AuditLog {
  readonly runId: string;
  private readonly directory: string | undefined;
  private readonly clock: () => Date;
  private readonly recorded: AuditEvent[] = [];

  constructor(options: AuditLogOptions) {
    this.runId = options.runId;
    this.directory = options.directory;
    this.clock = options.clock ?? (() => new Date());
    if (this.directory !== undefined) {
      mkdirSync(join(this.directory, "checks"), { recursive: true });
    }
  }

  get events(): readonly AuditEvent[] {
    return this.recorded;
  }

  record(input: AuditEventInput): AuditEvent {
    const event: AuditEvent = {
      eventId: randomUUID(),
      runId: this.runId,
      timestamp: this.clock().toISOString(),
      phase: input.phase,
      ...(input.worker === undefined ? {} : { worker: input.worker }),
      type: input.type,
      payload: redact(input.payload) as Readonly<Record<string, unknown>>,
    };
    this.recorded.push(event);
    this.appendToDisk(event);
    return event;
  }

  /** Events of one type, in the order they were recorded. */
  ofType(type: AuditEventType): readonly AuditEvent[] {
    return this.recorded.filter((event) => event.type === type);
  }

  /**
   * Store a large payload beside the log and return its digest plus location.
   * Callers reference the digest from events instead of embedding the body.
   */
  writeArtifact(name: string, content: string): { readonly path: string; readonly hash: string } {
    const hash = sha256Hex(content);
    if (this.directory === undefined) {
      return { path: `memory:${name}`, hash };
    }
    const path = join(this.directory, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content, { encoding: "utf8", flag: "w" });
    return { path, hash };
  }

  private appendToDisk(event: AuditEvent): void {
    if (this.directory === undefined) {
      return;
    }
    const line = `${JSON.stringify(event)}\n`;
    appendFileSync(join(this.directory, "audit.jsonl"), line, "utf8");
    if (AUTHORIZATION_EVENTS.has(event.type)) {
      appendFileSync(join(this.directory, "authorization-events.jsonl"), line, "utf8");
    }
  }
}
