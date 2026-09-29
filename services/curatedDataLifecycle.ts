/**
 * Lifecycle of curated, time-limited routing inputs: reviewed canal exits,
 * reviewed chart-track policies, Notice to Mariners packs and bundled
 * regional obstacle data.
 *
 * Each one either is still inside its validity, or says in code what happens
 * after it lapses. That statement is one of:
 *   • a RETIREMENT on the record itself. A retired record never becomes
 *     current again, whatever the clock says (a phone with its clock set
 *     back must not revive it). Renewing means a new reviewed record.
 *   • a LAPSE ACKNOWLEDGEMENT below, for data whose runtime already fails
 *     closed on its own age and which is deliberately left in place.
 * tests/curatedDataCurrency.realClock.test.ts checks every record against the
 * REAL clock, so a new lapse turns CI red instead of hiding behind the
 * pinned test clocks. Keep this module free of the data it describes: the app
 * must not bundle a regional overlay just to read an acknowledgement.
 */

/** Written on a record the owner has taken out of service. */
export interface CuratedRetirement {
    /** YYYY-MM-DD, when the owner retired it. */
    retiredOn: string;
    /** Who decided, for the audit trail. */
    decidedBy: string;
    /** Why it is retired (developer-facing). */
    reason: string;
    /** What the app does instead (developer-facing). */
    fallback: string;
}

/** A known, tolerated lapse of one exact record revision. */
export interface CuratedLapseAcknowledgement {
    /** Exact record key: a renewed record gets a new key and a new check. */
    key: string;
    /** YYYY-MM-DD */
    acknowledgedOn: string;
    reason: string;
    fallback: string;
}

/** One time-limited record as the real-clock guard sees it. */
export interface CuratedExpiryRecord {
    key: string;
    /** Where the record lives, for the failure message. */
    source: string;
    /** Repo-relative file that holds this record's literal expiry, if it has
     * one. The guard's source-literal net accounts a past-dated literal only
     * in its owning file, never by value alone. */
    literalFile?: string;
    /** Epoch ms after which the record is no longer valid (NaN = unreadable). */
    expiresAtMs: number;
    retirement?: unknown;
}

const day = (value: unknown): boolean =>
    typeof value === 'string' &&
    /^\d{4}-\d\d-\d\d$/.test(value) &&
    new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
const words = (value: unknown): boolean => typeof value === 'string' && value.trim().length >= 12;

export function isCompleteRetirement(value: unknown): value is CuratedRetirement {
    if (typeof value !== 'object' || value === null) return false;
    const r = value as Record<string, unknown>;
    return day(r.retiredOn) && words(r.decidedBy) && words(r.reason) && words(r.fallback);
}

export const CURATED_LAPSE_ACKNOWLEDGEMENTS: readonly CuratedLapseAcknowledgement[] = Object.freeze([
    {
        key: 'ntm-pack:mooloolah-bar:364 T of 2026#r1',
        acknowledgedOn: '2026-09-29',
        reason: 'NtM 364 (T) of 2026 was surveyed 1 July 2026, so its 28-day re-curation window has passed. Renewing means transcribing the current Mooloolah bar notice into a new pack revision.',
        fallback:
            'At runtime resolvePackStatus applies the same 28-day ceiling from the notice date on the live feed and fails closed (unverified). An unverified pack is ignored by routing: the bar keeps its charted depths and the notice stays an advisory icon.',
    },
    {
        // Keyed on the REGION, not the seed's sourceAsOf: a committed seed is
        // stale by design, so committing a refreshed one must not need new
        // paperwork (and must not turn CI red again 7 days later). The
        // real-clock suite checks the fallback below still holds — the real
        // runtime refuses a lapsed seed — so this can never cover a seed the
        // app would serve.
        key: 'osm-regional:newport-v1:committed-seed',
        acknowledgedOn: '2026-09-29',
        reason: 'The committed newport-v1.json is the deploy seed. The live copy is refreshed out of band by the daily data-only job (docs/NEWPORT_REGIONAL_DATA_2026-09-13.md), which never commits.',
        fallback:
            'selectRegionalOverlay refuses covered Newport requests once its copy is 7 days old (503) and never relabels stale data fresh; the Auto canal departure then refuses with "Canal water or obstacle detail is unavailable".',
    },
]);

/**
 * Every record that has lapsed at `now` without a complete retirement or an
 * acknowledgement of its exact key, plus acknowledgements that no longer
 * match any record (stale paperwork hides the next lapse). Empty = healthy.
 */
export function curatedLapseProblems(
    records: readonly CuratedExpiryRecord[],
    acknowledgements: readonly CuratedLapseAcknowledgement[],
    now: number,
): string[] {
    const problems: string[] = [];
    const acked = new Map(acknowledgements.map((a) => [a.key, a]));
    const keys = new Set<string>();
    for (const record of records) {
        if (keys.has(record.key)) problems.push(`${record.key} (${record.source}): duplicate record key`);
        keys.add(record.key);
        if (record.retirement !== undefined) {
            if (!isCompleteRetirement(record.retirement))
                problems.push(
                    `${record.key} (${record.source}): retirement needs retiredOn, decidedBy, reason and fallback`,
                );
            continue;
        }
        if (!Number.isFinite(record.expiresAtMs)) {
            problems.push(`${record.key} (${record.source}): expiry is unreadable`);
            continue;
        }
        if (now < record.expiresAtMs) continue;
        const ack = acked.get(record.key);
        if (!ack || !day(ack.acknowledgedOn) || !words(ack.reason) || !words(ack.fallback))
            problems.push(
                `${record.key} (${record.source}) lapsed ${new Date(record.expiresAtMs).toISOString()}: renew it, retire it on the record, or acknowledge the lapse in services/curatedDataLifecycle.ts`,
            );
    }
    for (const ack of acknowledgements)
        if (!keys.has(ack.key)) problems.push(`${ack.key}: acknowledgement matches no curated record — remove it`);
    return problems;
}
