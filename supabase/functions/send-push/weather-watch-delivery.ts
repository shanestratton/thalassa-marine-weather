import { createWakeDeliveryGuard, type WakeDeliveryDecision } from './wake-delivery.ts';
import { parseWeatherWatchNotice } from '../../../utils/weatherWatch.ts';
/** Fixed weather family. Recheck CAS/opt-in/ownership/expiry before EACH APNs attempt. */
export function createWeatherWatchDeliveryGuard(
    queueId: unknown,
    data: Record<string, unknown>,
    read: (id: string) => Promise<unknown>,
    now = Date.now,
): () => Promise<WakeDeliveryDecision> {
    const current = createWakeDeliveryGuard(queueId, read);
    return async () => {
        if (!parseWeatherWatchNotice(data, now())) return 'retire';
        return await current();
    };
}
