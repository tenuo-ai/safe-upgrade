/**
 * Delegation broker.
 *
 * One child session per worker invocation, created immediately before the
 * worker runs and destroyed immediately after. The broker is the only thing that
 * maps a worker identity to capabilities, and it takes that identity as an
 * argument from trusted routing code, never from a model's output.
 *
 * Every allow and every deny is recorded. A denial is a normal, expected event
 * in this system, so it is logged as evidence rather than swallowed as an error.
 */

import { AuthorizationError } from "@safe-upgrade/domain";
import type { Phase, WorkerId } from "@safe-upgrade/domain";
import type { AuditLog } from "@safe-upgrade/evidence";
import { sha256Canonical, sha256Hex } from "@safe-upgrade/evidence";
import { AuthorizationDeniedError, type ProtectedTool, type Session, type Tenuo } from "@tenuo/core";
import type { Capability } from "./capabilities.ts";
import type { WorkerProfile } from "./profiles.ts";
import { SessionRegistry } from "./session-registry.ts";

type AnyProtectedTool<A extends Record<string, unknown>, R> = ProtectedTool<{
  execute: (args: A) => Promise<R>;
}>;

export interface WorkerHandle {
  readonly worker: WorkerId;
  /** Opaque lookup key. Safe to place in graph state; resolves only in memory. */
  readonly sessionRef: string;
  readonly capabilities: readonly Capability[];
  /**
   * Call a protected tool as this worker. Authorization runs first, so a denial
   * never reaches the tool body.
   */
  invoke<A extends Record<string, unknown>, R>(
    capability: Capability,
    tool: AnyProtectedTool<A, R>,
    args: A,
  ): Promise<R>;
}

export interface DelegationBrokerOptions {
  readonly tenuo: Tenuo;
  readonly parentSession: Session;
  readonly profiles: Readonly<Record<WorkerId, WorkerProfile>>;
  readonly audit: AuditLog;
  readonly registry?: SessionRegistry;
}

/** A stable, non-secret handle for a session, derived from its warrant chain. */
function sessionDigest(session: Session): string {
  return sha256Hex(session.toWire().join(".")).slice(0, 16);
}

export class DelegationBroker {
  private readonly tenuo: Tenuo;
  private readonly parentSession: Session;
  private readonly profiles: Readonly<Record<WorkerId, WorkerProfile>>;
  private readonly audit: AuditLog;
  readonly registry: SessionRegistry;

  constructor(options: DelegationBrokerOptions) {
    this.tenuo = options.tenuo;
    this.parentSession = options.parentSession;
    this.profiles = options.profiles;
    this.audit = options.audit;
    this.registry = options.registry ?? new SessionRegistry();
  }

  /**
   * Run `body` under a freshly narrowed session for `worker`. The session is
   * destroyed before this method returns, including when the body throws.
   */
  async withWorker<T>(
    worker: WorkerId,
    phase: Phase,
    body: (handle: WorkerHandle) => Promise<T>,
  ): Promise<T> {
    const profile = this.profiles[worker];
    const capabilities = Object.keys(profile.allow) as Capability[];
    const childSession = this.tenuo.narrow(this.parentSession, profile.allow);
    const sessionRef = this.registry.register(worker, childSession, profile.ttlSeconds);

    this.audit.record({
      phase,
      worker,
      type: "session_delegated",
      payload: {
        sessionRef,
        sessionDigest: sessionDigest(childSession),
        parentDigest: sessionDigest(this.parentSession),
        capabilities,
        ttlSeconds: profile.ttlSeconds,
        rationale: profile.rationale,
      },
    });

    const handle: WorkerHandle = {
      worker,
      sessionRef,
      capabilities,
      invoke: (capability, tool, args) =>
        this.invokeAs(worker, phase, sessionRef, childSession, capability, tool, args),
    };

    try {
      return await this.tenuo.withSession(childSession, () => body(handle));
    } finally {
      this.registry.destroy(sessionRef);
      this.audit.record({
        phase,
        worker,
        type: "session_destroyed",
        payload: { sessionRef, liveSessions: this.registry.size },
      });
    }
  }

  private async invokeAs<A extends Record<string, unknown>, R>(
    worker: WorkerId,
    phase: Phase,
    sessionRef: string,
    session: Session,
    capability: Capability,
    tool: AnyProtectedTool<A, R>,
    args: A,
  ): Promise<R> {
    // Arguments are hashed rather than logged: a file write carries its whole
    // content, and a denial record should not become a copy of the payload.
    const argumentsHash = sha256Canonical(args);
    const callKey = session.dedupKey(capability, args);
    const base = {
      capability,
      sessionRef,
      sessionDigest: sessionDigest(session),
      argumentsHash,
      callKey,
    };

    try {
      const result = await tool.execute(args, { session });
      this.audit.record({ phase, worker, type: "tool_allowed", payload: base });
      return result;
    } catch (error) {
      if (error instanceof AuthorizationDeniedError) {
        this.audit.record({
          phase,
          worker,
          type: "tool_denied",
          payload: { ...base, code: error.code, field: error.field ?? null, reason: error.message },
        });
        throw new AuthorizationError(
          `${worker} is not authorized to call ${capability}`,
          { capability, worker, code: error.code, ...(error.field === undefined ? {} : { field: error.field }) },
          { cause: error },
        );
      }
      throw error;
    }
  }
}
