/**
 * Workers that do not exist yet.
 *
 * A registry entry is required for every worker id, and the honest entry for one
 * that has not been written is a blocking condition. The alternative — returning
 * an empty update — would let the graph route onward and finish, and the run
 * would report a status derived from work nobody did.
 *
 * `blocked` is the correct classification: not `human_required`, which means a
 * person must decide something, and not `indeterminate`, which means the evidence
 * was inconclusive. The evidence is absent because the code is absent.
 */

import type { WorkerId } from "@safe-upgrade/domain";
import type { WorkerFn, WorkerInput } from "@safe-upgrade/graph";
import type { UpgradeStateUpdate } from "@safe-upgrade/graph";

export function unimplementedWorker(worker: WorkerId, responsibility: string): WorkerFn {
  return async (input: WorkerInput): Promise<UpgradeStateUpdate> => {
    input.audit.record({
      phase: input.state.phase,
      worker,
      type: "worker_unimplemented",
      payload: { worker, responsibility },
    });
    return {
      blockingConditions: [`the ${worker} worker is not implemented: ${responsibility}`],
    };
  };
}
