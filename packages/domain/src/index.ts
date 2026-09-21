export type {
  CheckOutcome,
  CheckPhase,
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
  TestFramework,
  UpgradeRequest,
  UpgradeTarget,
  CompanionFact,
  WorkerId,
} from "./types.ts";
export { currentVersionOf, requestedUpdates, upgradeTargets } from "./types.ts";

export {
  absolutePathSchema,
  checkPurposeSchema,
  checkResultSchema,
  commandSpecSchema,
  exactVersionSchema,
  fileChangeSchema,
  migrationFindingSchema,
  modelPatchProposalSchema,
  modelPatchProposalJsonSchema,
  packageManagerSchema,
  packageNameSchema,
  parseOrThrow,
  releaseEvidenceSchema,
  upgradeRequestSchema,
  upgradeTargetSchema,
} from "./schemas.ts";
export type { ModelPatchChange, ModelPatchProposal } from "./schemas.ts";

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

export type { ElevationGrant, ElevationRequest } from "./elevation.ts";
export {
  describeElevation,
  elevationId,
  elevationRequest,
  grantFor,
} from "./elevation.ts";

export type { VersionRelation } from "./version.ts";
export { relateVersions } from "./version.ts";

export { count } from "./plural.ts";
