import { outboundFetch, normaliseOutboundHttpUrl } from '../outboundHttp.js';
import { AIS_FLEET_FORWARDING as LIMIT } from '../fleetFeedWire.js';
/** Process-startup operator value only. No URL from a phone, receipt or raw line. */
export function fleetWorkerEndpoint(value: unknown): string | null {
    try {
        if (typeof value !== 'string' || value.length > 512) return null;
        const url = normaliseOutboundHttpUrl(value);
        return url.protocol === 'https:' && url.pathname === LIMIT.batchPath && !url.search && !url.hash
            ? url.href
            : null;
    } catch {
        return null;
    }
}
export function fleetBatchSender(endpoint: string) {
    const fixed = fleetWorkerEndpoint(endpoint);
    if (!fixed) throw Error('Fleet endpoint unavailable');
    return async (body: string, signature: string, relayId: string, token: string, signal: AbortSignal) => {
        const response = await outboundFetch(fixed, {
            method: 'POST',
            signal,
            headers: {
                'Content-Type': 'application/json',
                'X-Thalassa-Pi-Signature': signature,
                'X-Thalassa-Relay': relayId,
                Authorization: `Bearer ${token}`,
            },
            body,
        });
        if (response.status !== 200) {
            await response.body?.cancel();
            return { status: response.status };
        }
        let text = '',
            size = 0;
        const reader = response.body?.getReader();
        if (!reader) return { status: 503 };
        try {
            const decoder = new TextDecoder();
            for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                size += chunk.value.byteLength;
                if (size > 2048) return { status: 503 };
                text += decoder.decode(chunk.value, { stream: true });
            }
            const receipt = JSON.parse(text),
                batch = JSON.parse(body);
            return {
                status:
                    receipt &&
                    receipt.deliveryConfirmed === false &&
                    receipt.consentRevision === batch.consentRevision &&
                    receipt.accepted === batch.observations.length &&
                    Number.isSafeInteger(receipt.decoded) &&
                    receipt.decoded >= 0 &&
                    receipt.decoded <= receipt.accepted
                        ? 200
                        : 503,
            };
        } catch {
            return { status: 503 };
        } finally {
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
        }
    };
}
