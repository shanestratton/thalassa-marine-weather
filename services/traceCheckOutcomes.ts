/**
 * What the last route check that could NOT mint a verification found
 * (build 124). A check that clears a route banks an envelope on the trace; a
 * check that finds a danger leg, or cannot run (no connection, no chart, no
 * tide data), used to leave nothing behind — so the row could only ever say
 * "not checked", and the background queue would repeat the same minutes of
 * grading forever.
 *
 * Kept OUT of SavedTrace on purpose: it never syncs, never counts against the
 * 50-route cap and never disturbs sameTraceContent. A record means something
 * only while its geometryKey still matches the trace's pins (the status reads
 * check that), and it is cleared when a newer envelope is banked.
 */
import { authScopedStorageKey, getAuthIdentityScope, type AuthIdentityScope } from './authIdentityScope';

const KEY = 'thalassa_trace_check_outcomes_v1';
/** Twice the route-library cap: plenty, and bounded. */
const MAX_RECORDS = 100;
const KINDS = new Set(['finding', 'unavailable', 'tide', 'nochart']);

export interface TraceCheckOutcomeRecord {
    geometryKey: string;
    draftM: number;
    draftAssumed: boolean;
    encFingerprint: string;
    at: string;
    kind: 'finding' | 'unavailable' | 'tide' | 'nochart';
    /** Danger legs, numbered by PIN as the route report does ("leg 14→15"). */
    legs?: Array<{ from: number; to: number; message: string }>;
    reason: string;
    /** traceId|geometryKey|draftM|draftAssumed|encFingerprint of the attempt. */
    memoKey?: string;
    /** Every danger leg can be cleared by an acknowledgement (no land). */
    ackable?: boolean;
}

function valid(value: unknown): value is TraceCheckOutcomeRecord {
    if (!value || typeof value !== 'object') return false;
    const r = value as Partial<TraceCheckOutcomeRecord>;
    return (
        typeof r.geometryKey === 'string' &&
        typeof r.draftM === 'number' &&
        Number.isFinite(r.draftM) &&
        typeof r.draftAssumed === 'boolean' &&
        typeof r.encFingerprint === 'string' &&
        typeof r.at === 'string' &&
        Number.isFinite(Date.parse(r.at)) &&
        KINDS.has(r.kind as string) &&
        typeof r.reason === 'string' &&
        (r.legs === undefined ||
            (Array.isArray(r.legs) &&
                r.legs.every(
                    (leg) =>
                        leg &&
                        Number.isInteger(leg.from) &&
                        Number.isInteger(leg.to) &&
                        typeof leg.message === 'string',
                )))
    );
}

function readAll(scope: AuthIdentityScope): Record<string, TraceCheckOutcomeRecord> {
    try {
        const parsed = JSON.parse(localStorage.getItem(authScopedStorageKey(KEY, scope)) ?? '{}') as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const out: Record<string, TraceCheckOutcomeRecord> = {};
        for (const [id, record] of Object.entries(parsed)) if (valid(record)) out[id] = record;
        return out;
    } catch {
        return {};
    }
}

function writeAll(records: Record<string, TraceCheckOutcomeRecord>, scope: AuthIdentityScope): boolean {
    try {
        const kept = Object.entries(records)
            .sort(([, a], [, b]) => Date.parse(b.at) - Date.parse(a.at))
            .slice(0, MAX_RECORDS);
        localStorage.setItem(authScopedStorageKey(KEY, scope), JSON.stringify(Object.fromEntries(kept)));
        return true;
    } catch {
        return false;
    }
}

export function getTraceCheckOutcome(
    traceId: string,
    scope: AuthIdentityScope = getAuthIdentityScope(),
): TraceCheckOutcomeRecord | null {
    return readAll(scope)[traceId] ?? null;
}

export function recordTraceCheckOutcome(
    traceId: string,
    record: TraceCheckOutcomeRecord,
    scope: AuthIdentityScope = getAuthIdentityScope(),
): boolean {
    if (!valid(record)) return false;
    return writeAll({ ...readAll(scope), [traceId]: record }, scope);
}

/** Drop a trace's record — only one no newer than `notAfter`, when given, so
 *  an older proof recovered from the server cannot erase a newer finding. */
export function clearTraceCheckOutcome(
    traceId: string,
    scope: AuthIdentityScope = getAuthIdentityScope(),
    notAfter?: string,
): void {
    const all = readAll(scope);
    const record = all[traceId];
    if (!record) return;
    if (notAfter && Date.parse(record.at) > Date.parse(notAfter)) return;
    delete all[traceId];
    writeAll(all, scope);
}
