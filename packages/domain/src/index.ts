export type {
  CheckOutcome,
  CheckPurpose,
  CheckResult,
  CiAssessment,
  CommandSpec,
  EvidenceLink,
  FileChange,
  FinalResult,
  MigrationFinding,
  PackageManager,
  Phase,
  ReleaseEvidence,
  ReleaseSourceType,
  RepositoryFacts,
  RoutableAction,
  RouteDecision,
  RouteSource,
  RunStatus,
  TestAssessment,
  UpgradeRequest,
  WorkerId,
} from "./types.ts";

export {
  absolutePathSchema,
  checkPurposeSchema,
  checkResultSchema,
  commandSpecSchema,
  exactVersionSchema,
  fileChangeSchema,
  migrationFindingSchema,
  packageManagerSchema,
  packageNameSchema,
  parseOrThrow,
  releaseEvidenceSchema,
  upgradeRequestSchema,
} from "./schemas.ts";

export type { ClassificationInput } from "./result.ts";
export { classifyRun, isSafeToPresentAsVerified } from "./result.ts";

export type { UpgradeErrorKind } from "./errors.ts";
export {
  ApprovalRequiredError,
  AuthorizationError,
  DecisionEngineError,
  InputValidationError,
  PackageResolutionError,
  ReleaseEvidenceError,
  RepositoryError,
  ToolExecutionError,
  UpgradeError,
  VerificationError,
  isUpgradeError,
} from "./errors.ts";
