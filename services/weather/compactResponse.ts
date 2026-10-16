/** Limit compact JSON before parsing, including a dishonest Content-Length.
 * Native HTTP/Pi bridges may already have buffered bytes; this still bounds
 * the subsequent text/JSON copies. Browser streams are cancelled on overflow. */
export const MAX_COMPACT_RESPONSE_BYTES = 65_536;

export function parseCompactText(text: string): unknown {
    if (
        text.length > MAX_COMPACT_RESPONSE_BYTES ||
        new TextEncoder().encode(text).byteLength > MAX_COMPACT_RESPONSE_BYTES
    ) {
        throw new Error('Compact forecast exceeds 64 KiB');
    }
    return JSON.parse(text);
}

export async function readCompactResponse(response: Response): Promise<unknown> {
    const declared = Number(response.headers.get('content-length') || 0);
    if (Number.isFinite(declared) && declared > MAX_COMPACT_RESPONSE_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error('Compact forecast exceeds 64 KiB');
    }
    if (!response.body) return parseCompactText(await response.text());
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let total = 0;
    let text = '';
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > MAX_COMPACT_RESPONSE_BYTES) {
                await reader.cancel().catch(() => undefined);
                throw new Error('Compact forecast exceeds 64 KiB');
            }
            text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
    } finally {
        reader.releaseLock();
    }
    return JSON.parse(text);
}
