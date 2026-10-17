import { createWakeDeliveryGuard, type WakeDeliveryDecision } from './wake-delivery.ts';
import { isCurrentLightningNotice } from '../../../utils/licensedLightningPush.ts';
/** Check original event expiry and current owner/opt-in/location before every actual send. */
export function createLightningDeliveryGuard(
    queueId: unknown,
    data: Record<string, unknown>,
    read: (id: string) => Promise<unknown>,
    now = Date.now,
): () => Promise<WakeDeliveryDecision> {
    const current = createWakeDeliveryGuard(queueId, read);
    return async () => isCurrentLightningNotice(data, now()) ? await current() : 'retire';
}
