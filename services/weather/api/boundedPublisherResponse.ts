/** Pure shared bounded transport; no phone runtime or provider admission. */
export class MarineDataTrustError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MarineDataTrustError';
    }
}

function requireTrust(condition: unknown, message: string): asserts condition {
    if (!condition) throw new MarineDataTrustError(message);
}

async function cancelResponseBody(response: Response, reason: string): Promise<void> {
    try {
        await response.body?.cancel(new MarineDataTrustError(reason));
    } catch {
        // A rejection from an upstream stream's cancellation hook must not
        // replace the deterministic trust error that caused the rejection.
    }
}

export async function rejectBeforeBodyRead(response: Response, message: string): Promise<never> {
    await cancelResponseBody(response, message);
    throw new MarineDataTrustError(message);
}

/**
 * Read a response body into one bounded allocation.
 *
 * Immutable asset callers pass the manifest's exact byte count as `maxBytes`,
 * so a valid 6–9 MiB frame never needs both a retained chunk list and a second
 * joined copy. Manifest callers reserve only the 256 KiB manifest ceiling.
 */
function waitForPublisherRead<T>(pending: Promise<T>, signal?: AbortSignal, onAbort?: () => void): Promise<T> {
    if (!signal) return pending;
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const abort = () => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', abort);
            reject(signal.reason ?? new DOMException('Publisher read aborted', 'AbortError'));
            onAbort?.();
        };
        signal.addEventListener('abort', abort, { once: true });
        pending.then(
            (value) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener('abort', abort);
                resolve(value);
            },
            (error: unknown) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener('abort', abort);
                reject(error);
            },
        );
        if (signal.aborted) abort();
    });
}

export async function readBoundedResponse(
    response: Response,
    maxBytes: number,
    signal?: AbortSignal,
): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        await rejectBeforeBodyRead(response, 'response byte ceiling is invalid');
    }
    const declared = response.headers.get('content-length');
    if (declared !== null) {
        if (!/^\d+$/.test(declared)) {
            await rejectBeforeBodyRead(response, 'response Content-Length is invalid');
        }
        if (Number(declared) > maxBytes) {
            await rejectBeforeBodyRead(response, 'response exceeds its byte ceiling');
        }
    }
    requireTrust(response.body !== null, 'response has no body');
    const reader = response.body.getReader();
    let cancellation: Promise<void> | null = null;
    const cancelOnce = (): Promise<void> => {
        if (!cancellation) {
            try {
                cancellation = reader.cancel().catch(() => undefined);
            } catch {
                cancellation = Promise.resolve();
            }
        }
        return cancellation;
    };
    const output = new Uint8Array(maxBytes);
    let total = 0;
    try {
        for (;;) {
            signal?.throwIfAborted();
            const { done, value } = await waitForPublisherRead(reader.read(), signal, () => {
                void cancelOnce();
            });
            if (done) break;
            if (!value) continue;
            requireTrust(total + value.byteLength <= maxBytes, 'response exceeded its byte ceiling while streaming');
            output.set(value, total);
            total += value.byteLength;
        }
    } catch (error) {
        // Ordinary validation failure still awaits cleanup. An aborted caller
        // must not be held by an upstream cancel hook that never resolves.
        if (signal?.aborted) void cancelOnce();
        else await waitForPublisherRead(cancelOnce(), signal);
        throw error;
    } finally {
        reader.releaseLock();
    }
    return total === output.byteLength ? output : output.slice(0, total);
}
