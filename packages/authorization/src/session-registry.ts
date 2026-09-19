/**
 * Short-lived registry of live child sessions.
 *
 * Graph state holds only an opaque reference. The session object itself stays
 * here, in memory, and is deleted when the node finishes. That is what keeps
 * warrants and holder material out of LangGraph checkpoints, which are written
 * to disk and replayed later.
 *
 * The registry refuses to serialize itself. If something ever tries to put it in
 * a checkpoint, the run fails loudly instead of persisting a live credential.
 */

import { randomBytes } from "node:crypto";
import type { WorkerId } from "@safe-upgrade/domain";
import type { Session } from "@tenuo/core";

interface Entry {
  readonly worker: WorkerId;
  readonly session: Session;
  readonly expiresAtMs: number;
}

export class SessionRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(options: { readonly now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Register a session and return an unguessable reference to it. */
  register(worker: WorkerId, session: Session, ttlSeconds: number): string {
    if (ttlSeconds <= 0) {
      throw new Error("a child session must have a positive TTL");
    }
    const ref = `session_${randomBytes(16).toString("hex")}`;
    this.entries.set(ref, {
      worker,
      session,
      expiresAtMs: this.now() + ttlSeconds * 1_000,
    });
    return ref;
  }

  resolve(ref: string): Session {
    const entry = this.entries.get(ref);
    if (entry === undefined) {
      throw new Error("session reference is unknown or has already been destroyed");
    }
    if (this.now() >= entry.expiresAtMs) {
      this.entries.delete(ref);
      throw new Error("session reference has expired");
    }
    return entry.session;
  }

  workerFor(ref: string): WorkerId | undefined {
    return this.entries.get(ref)?.worker;
  }

  destroy(ref: string): void {
    this.entries.delete(ref);
  }

  destroyAll(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  toJSON(): never {
    throw new Error("SessionRegistry must never be serialized: it holds live sessions");
  }
}
