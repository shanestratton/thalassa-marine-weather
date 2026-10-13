/**
 * official-alerts-watch's database reads (129-06), apart from the edge
 * function so a fake database can test them (tests/OfficialAlertsWatch.test.ts).
 *
 * Hosted PostgREST answers at most max_rows (1000) rows to one request and
 * cuts the rest off without an error. So:
 *   - the point match answers one row per boat (its warnings as an array), at
 *     most 500 boats a call: never near the cap, and a reply with more rows
 *     than boats is refused, not read;
 *   - the deliveries so far are read a page at a time, in a stable order,
 *     until a page comes back empty, so no account's deliveries are cut off
 *     (one cut off would look never told, and be pushed again every run).
 * Dependency-free: the edge function passes its supabase-js calls in.
 */
import { chainKeyFor, type PriorDelivery } from './watch.ts';

/** The most rows asked for in one request: hosted PostgREST's max_rows. */
export const PAGE_ROWS = 1000;
/** Boats per point-match call: one row each, so a reply stays under max_rows. */
export const MATCH_BOATS = 500;

export type Rows<T> = PromiseLike<{ data: T[] | null; error: unknown }>;
type Row = Record<string, unknown>;

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * Every row of an ordered query, a page at a time: `page(from, to)` is the
 * query with .range(from, to). Each page starts where the last one's rows
 * ended, and the read stops on an empty page, so a server cap below
 * PAGE_ROWS cannot cut it short either.
 */
export async function readAllRows<T>(page: (from: number, to: number) => Rows<T>, what: string): Promise<T[]> {
    const out: T[] = [];
    for (let from = 0;;) {
        const { data, error } = await page(from, from + PAGE_ROWS - 1);
        if (error) throw new Error(`${what} read failed`);
        const rows = data ?? [];
        if (rows.length === 0) return out;
        out.push(...rows);
        from += rows.length;
    }
}

/**
 * The warnings in force at each boat, by userId: official_alerts_watch_match
 * once per MATCH_BOATS boats, each reply one row per boat, {k, alert_ids}.
 */
export async function matchBoats(
    boats: ReadonlyArray<{ userId: string; position: { lat: number; lon: number } }>,
    match: (points: Array<{ k: number; lat: number; lon: number }>) => Rows<Row>,
): Promise<Map<string, Set<number>>> {
    const out = new Map<string, Set<number>>();
    for (let i = 0; i < boats.length; i += MATCH_BOATS) {
        const part = boats.slice(i, i + MATCH_BOATS);
        const { data, error } = await match(part.map((b, k) => ({ k, lat: b.position.lat, lon: b.position.lon })));
        if (error) throw new Error('match failed');
        const rows = Array.isArray(data) ? data : [];
        // More rows than boats is not this function's answer (an older shape, or a cut-off one).
        if (rows.length > part.length) throw new Error('match answered more rows than boats');
        for (const r of rows) {
            const boat = typeof r.k === 'number' ? part[r.k] : undefined;
            const ids = Array.isArray(r.alert_ids)
                ? r.alert_ids.filter((id): id is number => typeof id === 'number')
                : [];
            if (!boat || ids.length === 0) continue;
            const set = out.get(boat.userId) ?? new Set<number>();
            for (const id of ids) set.add(id);
            out.set(boat.userId, set);
        }
    }
    return out;
}

/**
 * The deliveries so far to these accounts, 200 accounts a query and every
 * page of each: `page(ids, from, to)` is the deliveries query for those ids,
 * ordered (user, delivered, alert) with .range(from, to).
 */
export async function readPriorDeliveries(
    userIds: readonly string[],
    page: (ids: string[], from: number, to: number) => Rows<Row>,
): Promise<PriorDelivery[]> {
    const prior: PriorDelivery[] = [];
    for (let i = 0; i < userIds.length; i += 200) {
        const ids = userIds.slice(i, i + 200);
        const rows = await readAllRows((from, to) => page(ids, from, to), 'delivery');
        for (const r of rows) {
            if (typeof r.user_id !== 'string' || typeof r.alert_id !== 'number') continue;
            const provider = str(r.provider_id) ?? '';
            const identifier = str(r.identifier) ?? '';
            prior.push({
                userId: r.user_id,
                alertId: r.alert_id,
                provider,
                identifier,
                refs: strings(r.refs),
                chainKey: str(r.chain_key) ?? chainKeyFor(provider, identifier),
                severity: str(r.severity) ?? 'Unknown',
                deliveredAt: str(r.delivered_at) ?? '',
            });
        }
    }
    return prior;
}
