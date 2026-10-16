import { createWakeDeliveryGuard } from './wake-delivery.ts';
/** Prepared integration only: sender must call this before EVERY APNs attempt.
 * An ordinary, silent informational family; never critical/time-sensitive. */
export function createBuddyDeliveryGuard(
    queueId: unknown,
    data: Record<string, unknown>,
    read: (id: string) => Promise<unknown>,
    now = Date.now,
) {
    const check = createWakeDeliveryGuard(queueId, read);
    return async () => {
        if (
            Object.keys(data).length !== 6 ||
            Object.keys(data).some((k) =>
                !['buddy_watch', 'watch_id', 'revision', 'receipt_id', 'event', 'observed_at'].includes(k)
            ) ||
            data.buddy_watch !== 1 || typeof data.watch_id !== 'string' ||
            !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(data.watch_id) || typeof data.revision !== 'string' ||
            !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(data.revision) || typeof data.receipt_id !== 'string' ||
            !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(data.receipt_id) ||
            !['moving', 'moored', 'underway', 'entered', 'left', 'not-seen'].includes(String(data.event)) ||
            typeof data.observed_at !== 'number' || !Number.isSafeInteger(data.observed_at) || data.observed_at <= 0 ||
            data.observed_at > now()
        ) return 'retire' as const;
        return await check();
    };
}
