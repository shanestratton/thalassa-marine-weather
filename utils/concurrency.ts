/**
 * mapWithConcurrency — Promise.all with a worker cap.
 *
 * WHY (2026-07-12 audit): the ENC routing preload fired an UNCAPPED
 * Promise.all over every cell intersecting a route bbox — with the
 * 172-cell cloud library that meant dozens of simultaneous multi-MB
 * Supabase downloads saturating marina wifi, plus back-to-back
 * main-thread JSON.parses. A small pool keeps the pipe busy without
 * flooding it.
 *
 * Results keep input order. A worker that throws records `undefined`
 * for that item and keeps going — bulk loaders here always tolerate
 * per-item failure (a missing cell must never sink the whole route).
 */
export async function mapWithConcurrency<T, R>(
    items: readonly T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>,
): Promise<Array<R | undefined>> {
    const results = new Array<R | undefined>(items.length);
    if (items.length === 0) return results;
    let next = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
        for (;;) {
            const i = next++;
            if (i >= items.length) return;
            try {
                results[i] = await fn(items[i], i);
            } catch {
                results[i] = undefined;
            }
        }
    });
    await Promise.all(workers);
    return results;
}
