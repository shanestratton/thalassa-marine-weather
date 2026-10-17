/** Small fixed-origin display responses only; bytes are capped before accumulating. */
export async function readCabinJson(response: Response, limit: number, signal: AbortSignal): Promise<unknown> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 16_384) throw Error('Cabin response limit unavailable');
    if (!response.body || Number(response.headers.get('content-length')) > limit)
        throw Error('Cabin response unavailable');
    const reader = response.body.getReader(),
        parts: Uint8Array[] = [];
    let total = 0,
        chunks = 0;
    try {
        while (true) {
            if (signal.aborted) throw Error('Cabin response retired');
            const chunk = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
                const abort = () => {
                    cleanup();
                    reject(Error('Cabin response retired'));
                };
                const cleanup = () => signal.removeEventListener('abort', abort);
                signal.addEventListener('abort', abort, { once: true });
                if (signal.aborted) return abort();
                reader.read().then(
                    (value) => {
                        cleanup();
                        resolve(value);
                    },
                    (error) => {
                        cleanup();
                        reject(error);
                    },
                );
            });
            if (chunk.done) break;
            if (++chunks > 256 || chunk.value.byteLength === 0) throw Error('Cabin response chunk limit');
            total += chunk.value.byteLength;
            if (total > limit) throw Error('Cabin response exceeds limit');
            parts.push(chunk.value.slice());
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const part of parts) {
            bytes.set(part, offset);
            offset += part.byteLength;
        }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } finally {
        void reader.cancel().catch(() => undefined);
    }
}
