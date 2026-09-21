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

import { join } from "node:path";
import { AuthorizationError, ToolExecutionError, describeElevation, grantFor } from "@safe-upgrade/domain";
import type { ElevationGrant, ElevationRequest, Phase, WorkerId } from "@safe-upgrade/domain";
import type { AuditLog } from "@safe-upgrade/evidence";
import { sha256Canonical, sha256Hex } from "@safe-upgrade/evidence";
import {
  AuthorizationDeniedError,
  exact,
  type ConstraintExpr,
  type ProtectedTool,
  type SessionAllow,
  type Session,
  type SessionInfo,
  type Tenuo,
} from "@tenuo/core";
import { CAPABILITIES, type Capability, type Ceilings } from "./capabilities.ts";
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

/** A request paired with the grant that approves it. */
export interface ApprovedElevation {
  readonly request: ElevationRequest;
  readonly grant: ElevationGrant;
}

export interface WithWorkerOptions {
  /**
   * Approved calls to add to this worker's session, for this invocation only.
   * Supplied by trusted routing code from recorded approvals, never by the worker.
   */
  readonly elevations?: readonly ApprovedElevation[];
}

export interface DelegationBrokerOptions {
  readonly tenuo: Tenuo;
  readonly parentSession: Session;
  readonly profiles: Readonly<Record<WorkerId, WorkerProfile>>;
  readonly audit: AuditLog;
  /** Bound per invocation, so a worker never holds an unbound tool. */
  readonly toolset: ProtectedToolset;
  /** The run's maximum authority, consulted before any elevation is honoured. */
  readonly ceilings: Ceilings;
  /** Canonical worktree root, for expanding relative paths in an elevation request. */
  readonly worktreeRoot: string;
  readonly registry?: SessionRegistry;
}

/**
 * Arguments an elevation request states as a worktree-relative path.
 *
 * Declared per capability rather than guessed from the argument name, so adding a
 * capability with a path argument is a decision someone makes here rather than
 * something that starts happening because a field was called `path`.
 */
const ELEVATION_PATH_ARGUMENTS: Partial<Record<Capability, readonly string[]>> = {
  update_manifest_field: ["path"],
};

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
  private readonly ceilings: Ceilings;
  private readonly worktreeRoot: string;

  constructor(options: DelegationBrokerOptions) {
    this.tenuo = options.tenuo;
    this.parentSession = options.parentSession;
    this.profiles = options.profiles;
    this.audit = options.audit;
    this.toolset = options.toolset;
    this.ceilings = options.ceilings;
    this.worktreeRoot = options.worktreeRoot;
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
    options: WithWorkerOptions = {},
  ): Promise<T> {
    const profile = this.profiles[worker];
    const standing = phase === "assess_verification"
      ? readOnlyAssessment(profile.allow)
      : profile.allow;
    const rationale = phase === "assess_verification"
      ? "Assesses existing verification coverage. Holds read access only."
      : profile.rationale;
    const elevations = this.elevate(worker, phase, options.elevations ?? []);
    const { allow, granted: elevated } = this.narrowable(worker, phase, standing, elevations);
    const capabilities = Object.keys(allow) as Capability[];
    const childSession = this.tenuo.narrow(this.parentSession, allow, {
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
        rationale,
        elevatedCapabilities: elevated,
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
   * Drop an elevation that the ceiling will not accept.
   *
   * Narrowing to a value the parent never permitted is not a denial at call time:
   * Tenuo refuses to build the chain at all, which is the stronger behaviour and
   * exactly what should happen. But it surfaces as an error thrown while setting up,
   * with no record of what was attempted, and the run would end as an unexplained
   * crash rather than as a refused approval.
   *
   * So the narrow is attempted, and a failure falls back to the worker's standing
   * profile with the refusal recorded. The worker then runs with the authority it
   * always had, and the call it wanted is denied through the normal path.
   */
  private narrowable(
    worker: WorkerId,
    phase: Phase,
    standing: SessionAllow,
    elevations: { readonly allow: SessionAllow; readonly granted: readonly string[] },
  ): { readonly allow: SessionAllow; readonly granted: readonly string[] } {
    if (elevations.granted.length === 0) {
      return { allow: standing, granted: [] };
    }
    const combined = { ...standing, ...elevations.allow };
    try {
      // Built and discarded. The only question being asked is whether the ceiling
      // permits it; the session actually used is created by the caller.
      this.tenuo.narrow(this.parentSession, combined, { terminal: true, ttlSeconds: 1 });
      return { allow: combined, granted: elevations.granted };
    } catch (error) {
      this.audit.record({
        phase,
        worker,
        type: "elevation_refused",
        payload: {
          elevationIds: elevations.granted,
          reason: "the approved arguments fall outside the run's ceiling",
          detail: error instanceof Error ? error.message : String(error),
        },
      });
      return { allow: standing, granted: [] };
    }
  }

  /**
   * Turn approved requests into a single-call allow, and refuse everything else.
   *
   * The approval *is* the constraint. Each argument value from the request becomes
   * an `exact()`, so the elevated capability permits precisely the call that was
   * approved and no neighbouring one: approval to set `type` to `"module"` does
   * not authorize setting it to `"commonjs"`, and approval to edit one manifest
   * does not reach another.
   *
   * Nothing here can widen the run. `narrow` only ever intersects, so a capability
   * absent from the ceiling stays absent however many grants arrive, and an
   * `exact()` outside the ceiling's own constraint yields a capability that denies
   * every call. The ceiling remains the statement of what this run may do at most;
   * elevation only decides whether a worker is holding part of it right now.
   */
  private elevate(
    worker: WorkerId,
    phase: Phase,
    approved: readonly ApprovedElevation[],
  ): { readonly allow: SessionAllow; readonly granted: readonly string[] } {
    const allow: Record<string, Record<string, ConstraintExpr>> = {};
    const granted: string[] = [];

    for (const { request, grant } of approved) {
      const capability = request.capability as Capability;
      // An approval is for one worker. Without this, a grant recorded for the
      // implementer would be handed to whichever worker ran next and happened to
      // carry the same request forward in state.
      if (request.worker !== worker) {
        this.audit.record({
          phase,
          worker,
          type: "elevation_refused",
          payload: {
            elevationId: request.id,
            capability: request.capability,
            reason: `the approval is for ${request.worker}`,
          },
        });
        continue;
      }
      // The ceiling is consulted by name first, so a request naming something this
      // run never had is rejected here rather than becoming a session that denies
      // every call and looks like a worker bug.
      if (!(capability in this.ceilings)) {
        this.audit.record({
          phase,
          worker,
          type: "elevation_refused",
          payload: {
            elevationId: request.id,
            capability: request.capability,
            reason: "the capability is not in the run's ceiling",
          },
        });
        continue;
      }
      // The id is recomputed from the request, so a request cannot borrow the id of
      // some other approved call.
      if (grantFor(request, [grant]) === null) {
        this.audit.record({
          phase,
          worker,
          type: "elevation_refused",
          payload: {
            elevationId: request.id,
            capability: request.capability,
            reason: "the grant does not match the request it is attached to",
          },
        });
        continue;
      }

      // The ceiling's own constraints stay in place, with the approved arguments
      // pinned to `exact()` on top. So `expectedBeforeHash` keeps whatever the
      // ceiling said about it, while the field and the value are exactly what was
      // approved — and if the ceiling was narrower than the approval, the ceiling
      // still wins, because `narrow` intersects.
      allow[capability] = {
        ...(this.ceilings[capability] as Record<string, ConstraintExpr>),
        ...Object.fromEntries(
          Object.entries(request.arguments).map(([name, value]) => [
            name,
            exact(this.concreteValue(capability, name, value)),
          ]),
        ),
      };
      granted.push(request.id);
      this.audit.record({
        phase,
        worker,
        type: "elevation_granted",
        payload: {
          elevationId: request.id,
          capability: request.capability,
          request: describeElevation(request),
          reason: request.reason,
          findingIds: request.findingIds,
          approvedBy: grant.approvedBy,
          approvedAt: grant.approvedAt,
        },
      });
    }

    return { allow: allow as SessionAllow, granted };
  }

  /**
   * Expand a request's stable value into the one the tool will actually receive.
   *
   * Only paths need it, and only because a request has to name a file in a way that
   * still means something after the worktree it lived in has been deleted.
   */
  private concreteValue(capability: Capability, argument: string, value: string): string {
    const pathArguments = ELEVATION_PATH_ARGUMENTS[capability] ?? [];
    return pathArguments.includes(argument) ? join(this.worktreeRoot, value) : value;
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

/** The coverage assessment phase reads tests and source but cannot author either. */
function readOnlyAssessment(standing: SessionAllow): SessionAllow {
  return Object.fromEntries(
    ["read_file", "list_files"].flatMap((capability) => {
      const policy = standing[capability];
      return policy === undefined ? [] : [[capability, policy]];
    }),
  ) as SessionAllow;
}
