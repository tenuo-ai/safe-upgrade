/**
 * Typed errors. The `kind` discriminant drives control flow; `retryable` states
 * whether retrying the same operation is ever sensible.
 *
 * An authorization denial is never retryable. Retrying it can only mean asking
 * for broader authority, which is the one response we refuse to automate.
 */

export type UpgradeErrorKind =
  | "authorization"
  | "input_validation"
  | "repository"
  | "package_resolution"
  | "release_evidence"
  | "decision_engine"
  | "tool_execution"
  | "verification"
  | "approval_required";

export abstract class UpgradeError extends Error {
  abstract readonly kind: UpgradeErrorKind;
  abstract readonly retryable: boolean;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class AuthorizationError extends UpgradeError {
  readonly kind = "authorization" as const;
  readonly retryable = false;

  constructor(
    message: string,
    readonly detail: {
      readonly capability: string;
      readonly worker: string;
      readonly code?: string;
      readonly field?: string;
    },
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export class InputValidationError extends UpgradeError {
  readonly kind = "input_validation" as const;
  readonly retryable = false;
}

export class RepositoryError extends UpgradeError {
  readonly kind = "repository" as const;
  readonly retryable = false;
}

export class PackageResolutionError extends UpgradeError {
  readonly kind = "package_resolution" as const;
  readonly retryable = false;
}

export class ReleaseEvidenceError extends UpgradeError {
  readonly kind = "release_evidence" as const;
  readonly retryable = true;
}

export class DecisionEngineError extends UpgradeError {
  readonly kind = "decision_engine" as const;
  readonly retryable = true;
}

export class ToolExecutionError extends UpgradeError {
  readonly kind = "tool_execution" as const;
  readonly retryable = false;
}

export class VerificationError extends UpgradeError {
  readonly kind = "verification" as const;
  readonly retryable = false;
}

export class ApprovalRequiredError extends UpgradeError {
  readonly kind = "approval_required" as const;
  readonly retryable = false;
}

export function isUpgradeError(value: unknown): value is UpgradeError {
  return value instanceof UpgradeError;
}
