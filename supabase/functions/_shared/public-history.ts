/** Complete, deterministically ordered reads for the public voyage overview. */
export async function readCompletePublicPages<T>(
    readPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
    options: { maxRows: number; key: (row: T) => string; pageSize?: number },
): Promise<T[]> {
    const pageSize = options.pageSize ?? 1000;
    if (!Number.isInteger(pageSize) || pageSize < 1 || !Number.isInteger(options.maxRows) || options.maxRows < 1) {
        throw new Error('Invalid public history read bounds');
    }
    const rows: T[] = [];
    const keys = new Set<string>();
    for (;;) {
        // Probe past the envelope instead of pretending its truncated prefix
        // is the complete history. A lower PostgREST max_rows is harmless:
        // offsets advance by actual rows, and only an empty page ends a read.
        const { data, error } = await readPage(rows.length, rows.length + pageSize - 1);
        if (error || !Array.isArray(data)) throw new Error('Public history could not be read completely');
        if (data.length === 0) return rows;
        if (rows.length + data.length > options.maxRows) throw new Error('Public history exceeds its read envelope');
        for (const row of data) {
            const key = options.key(row);
            if (!key || keys.has(key)) throw new Error('Public history changed during pagination');
            keys.add(key);
            rows.push(row);
        }
    }
}

/** Bound concurrent geometry reads/signing work without dropping any trips or posts. */
export async function mapPublicHistory<T, R>(
    items: readonly T[],
    convert: (item: T, index: number) => Promise<R>,
    concurrency = 3,
): Promise<R[]> {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid public history concurrency');
    const results = new Array<R>(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await convert(items[index], index);
        }
    }));
    return results;
}

/**
 * Every voyage gets at least both endpoints. The usual response budget is
 * soft for a huge logbook: never silently drop an older voyage to meet it.
 */
export function publicOverviewPointBudget(voyageCount: number, totalBudget: number): number {
    if (!Number.isInteger(voyageCount) || voyageCount < 1) return 0;
    if (!Number.isInteger(totalBudget) || totalBudget < 2) throw new Error('Invalid public track budget');
    return Math.max(2, Math.floor(totalBudget / voyageCount));
}

/**
 * A retirement prevents publishing a live shadow even if its subsequent
 * purge failed. Do not apply this to durable history: restoring an archived
 * voyage may republish its recorded track without reviving its live tail.
 */
export function isRetiredPublicLiveVoyage(voyageId: unknown, retiredIds: ReadonlySet<string>): boolean {
    return typeof voyageId === 'string' && retiredIds.has(voyageId.trim());
}
