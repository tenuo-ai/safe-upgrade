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

import { AuthorizationError, ToolExecutionError } from "@safe-upgrade/domain";
import type { Phase, WorkerId } from "@safe-upgrade/domain";
import type { AuditLog } from "@safe-upgrade/evidence";
import { sha256Canonical, sha256Hex } from "@safe-upgrade/evidence";
import {
  AuthorizationDeniedError,
  type ProtectedTool,
  type Session,
  type SessionInfo,
  type Tenuo,
} from "@tenuo/core";
import { CAPABILITIES, type Capability } from "./capabilities.ts";
import type { ProtectedToolset } from "./protected-tools.ts";
import type { WorkerProfile } from "./profiles.ts";
import { SessionRegistry } from "./session-registry.ts";

type AnyProtectedTool<A extends Record<string, unknown>, R> = ProtectedTool<{
  execute: (args: A) => Promise<R>;
}>;

type BoundTool<T> = T extends ProtectedTool<{ execute: (args: infer A) => Promise<infer R> }>
  ? (args: A) => Promise<R>
  : never;

/**
 * Every capability, already bound to this worker's session.
 *
 * Deliberately the whole set rather than only what the profile grants. A worker
 * calling something it does not hold must be *denied*, which is an event worth
 * recording; if the method were simply missing, the same mistake would surface as
 * a TypeError with no audit trail and nothing for the tests to assert against.
 */
export type BoundToolset = {
  readonly [K in Capability]: BoundTool<NonNullable<ProtectedToolset[K]>>;
};

export interface WorkerHandle {
  readonly worker: WorkerId;
  /** Opaque lookup key. Safe to place in graph state; resolves only in memory. */
  readonly sessionRef: string;
  readonly capabilities: readonly Capability[];
  /**
   * What the session says it granted: holder, depth, terminal, expiry, tools.
   * A read-only snapshot, deliberately not the session — a worker that could
   * reach the session could narrow it or put it on the wire.
   */
  readonly grant: SessionInfo;
  /**
   * The only way a worker reaches a tool. Authorization runs first, so a denial
   * never reaches the tool body.
   *
   * Each call carries its own capability name because the name comes from the key,
   * not from an argument. The earlier signature took both a name and a tool, which
   * meant every call site restated the name and could restate it wrongly — naming
   * `read_file` while passing `write_source_file` type-checked and audited the
   * wrong capability.
   */
  readonly tools: BoundToolset;
}

export interface DelegationBrokerOptions {
  readonly tenuo: Tenuo;
  readonly parentSession: Session;
  readonly profiles: Readonly<Record<WorkerId, WorkerProfile>>;
  readonly audit: AuditLog;
  /** Bound per invocation, so a worker never holds an unbound tool. */
  readonly toolset: ProtectedToolset;
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
  private readonly toolset: ProtectedToolset;

  constructor(options: DelegationBrokerOptions) {
    this.tenuo = options.tenuo;
    this.parentSession = options.parentSession;
    this.profiles = options.profiles;
    this.audit = options.audit;
    this.toolset = options.toolset;
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
    const childSession = this.tenuo.narrow(this.parentSession, profile.allow, {
      // Every worker is a leaf. No worker spawns anything, so none of them needs
      // to delegate, and a session that cannot delegate cannot be the start of a
      // chain nobody planned.
      terminal: true,
      // Clamped to the parent's remaining lifetime, so this only ever shortens.
      ttlSeconds: profile.ttlSeconds,
    });
    const sessionRef = this.registry.register(worker, childSession, profile.ttlSeconds);
    // Read back what was actually granted rather than what we asked for, so the
    // audit trail records the session's own account of itself.
    const granted = childSession.inspect();

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
        depth: granted.depth,
        terminal: granted.terminal,
        expiresAt: granted.expiresAt,
        grantedTools: granted.tools,
      },
    });

    const handle: WorkerHandle = {
      worker,
      sessionRef,
      capabilities,
      grant: granted,
      tools: this.bind(worker, phase, sessionRef, childSession),
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

  /**
   * One bound function per capability, built from the toolset's own keys so the
   * two cannot drift apart.
   */
  private bind(worker: WorkerId, phase: Phase, sessionRef: string, session: Session): BoundToolset {
    const bound: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {};
    for (const capability of CAPABILITIES) {
      const tool = this.toolset[capability];
      if (tool === undefined) {
        // `create_draft_pr` exists only when the run has a GitHub repository and
        // token. A worker that asks for it anyway gets a clear refusal rather than
        // a TypeError from calling undefined.
        bound[capability] = async () => {
          throw new ToolExecutionError(`${capability} is not configured for this run`);
        };
        continue;
      }
      bound[capability] = (args) =>
        this.invokeAs(
          worker,
          phase,
          sessionRef,
          session,
          capability,
          tool as AnyProtectedTool<Record<string, unknown>, unknown>,
          args,
        );
    }
    return bound as unknown as BoundToolset;
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
