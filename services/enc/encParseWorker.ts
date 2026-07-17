/**
 * encParseWorker — one job: JSON.parse multi-MB cell text off the main
 * thread (closing audit: the cold-path parse blocks were indivisible —
 * a 7 MB harbour cell froze ~100-200 ms per cell during boot merges).
 * The worker pays the parse; the main thread pays only the structured
 * clone IN, which is substantially cheaper than parsing the same text.
 */
const ctx = self as unknown as {
    onmessage: ((ev: MessageEvent<{ seq: number; cellId: string; text: string }>) => void) | null;
    postMessage(msg: { seq: number; cellId: string; blob: unknown | null }): void;
};

ctx.onmessage = (ev) => {
    const { seq, cellId, text } = ev.data;
    try {
        ctx.postMessage({ seq, cellId, blob: JSON.parse(text) });
    } catch {
        ctx.postMessage({ seq, cellId, blob: null });
    }
};
