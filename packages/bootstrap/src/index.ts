export type { Isolation, IsolationRequest } from "./isolate.ts";
export { isolateRepository } from "./isolate.ts";

export type { Detection, DetectionRequest } from "./detect.ts";
export { detectRepositoryFacts } from "./detect.ts";

export { isExactVersion, resolveInstalledVersion } from "./installed.ts";
