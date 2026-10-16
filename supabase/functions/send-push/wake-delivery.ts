/** A fixed service-only database guard, reevaluated before each APNs attempt.
 * Unknown/unavailable is retryable; a definitive false retires the queue row. */
export type WakeDeliveryDecision = 'allow' | 'retire' | 'unavailable';
export function createWakeDeliveryGuard(
    queueId: unknown,
    read: (id: string) => Promise<unknown>,
): () => Promise<WakeDeliveryDecision> {
    return async () => {
        if (
            typeof queueId !== 'string' ||
            !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(queueId)
        ) return 'retire';
        try {
            const result = await read(queueId);
            return result === true ? 'allow' : result === false ? 'retire' : 'unavailable';
        } catch {
            return 'unavailable';
        }
    };
}
