export const SYNOPTIC_MAX_ASSET_BYTES = 2 * 1024 * 1024;
/** Stream cap also holds when Content-Length is absent or dishonest. */
export async function readChartBytes(response: Response, mime: 'image/gif' | 'image/png'): Promise<Uint8Array> {
    const length = Number(response.headers.get('content-length') ?? 0);
    if (
        !response.ok ||
        response.headers.get('content-type')?.split(';')[0].trim() !== mime ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > SYNOPTIC_MAX_ASSET_BYTES ||
        !response.body
    ) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error('Official chart response refused');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > SYNOPTIC_MAX_ASSET_BYTES) {
                await reader.cancel();
                throw new Error('Official chart exceeds 2 MiB');
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.byteLength;
    }
    const good =
        mime === 'image/png'
            ? [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)
            : ['GIF87a', 'GIF89a'].includes(new TextDecoder().decode(bytes.slice(0, 6)));
    if (!good) throw new Error('Official chart signature refused');
    return bytes;
}
