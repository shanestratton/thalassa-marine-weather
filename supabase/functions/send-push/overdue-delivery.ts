import { createWakeDeliveryGuard, type WakeDeliveryDecision } from './wake-delivery.ts';
import { parseOverdueNotice } from '../../../utils/overdueWatch.ts';
/** Held integration: current() is preflight; beforeHttp() runs ONLY after a real
 * target/JWT/body is ready, immediately before fetch, including each retry.
 * Never invoke beforeHttp during generic preflight/no-token handling. */
export function createOverdueDeliveryGuards(
    queueId: unknown,
    data: unknown,
    read: (id: string) => Promise<unknown>,
    attempt: (id: string) => Promise<unknown>,
    now = Date.now,
): { current: () => Promise<WakeDeliveryDecision>; beforeHttp: () => Promise<WakeDeliveryDecision> } {
    const current = createWakeDeliveryGuard(queueId, read), record = createWakeDeliveryGuard(queueId, attempt);
    const valid = () => parseOverdueNotice(data, now()) !== null;
    return {
        current: async () => valid() ? await current() : 'retire',
        beforeHttp: async () => valid() ? await record() : 'retire',
    };
}
