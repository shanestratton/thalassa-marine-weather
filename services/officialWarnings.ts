/**
 * The official warnings in force at a position (129-06), from
 * official_alerts_at(lat, lon) (129-05, held migration 20261014150000).
 *
 * null means "not answered": the function is not deployed yet, the caller is
 * signed out (only signed-in callers may call it), offline, or the answer is
 * malformed. The Warnings page, the Glass count and nothing else then show
 * nothing official, and the page keeps its position-aware link: an answer
 * that cannot be read is never taken as "no warnings".
 *
 * The text is the issuer's, as stored: nothing here edits it. Answers are kept
 * for 4 minutes per account and position (rounded to 0.001°, about 100 m, the
 * outlines' own simplification), and a "not answered" for 10, so the Glass and
 * the page share one call.
 *
 * A refresh that fails after an answer never takes a warning away: the last
 * answer for that account and position is given again, marked stale (since
 * when it was last answered), and asked again after a minute. A known gale
 * warning stays on the Glass and the page through a dropout offshore, and
 * the page says it could not check rather than "No official warnings".
 * null only when nothing has ever answered there.
 */
import { supabase } from './supabase';
import { getAuthIdentityScope } from './authIdentityScope';

export type OfficialCoverage = 'live' | 'partial' | 'unavailable' | 'off' | 'none';

export interface OfficialInfo {
    language: string;
    event: string;
    severity: string;
    headline: string | null;
    description: string | null;
    instruction: string | null;
    web: string | null;
    senderName: string | null;
    onset: string | null;
    expires: string | null;
    category: string[];
    parameters: Array<{ valueName: string; value: string }>;
    eventCodes: Array<{ valueName: string; value: string }>;
}

export interface OfficialAlert {
    provider: string;
    issuer: string;
    identifier: string;
    /**
     * How it reached the point: its own polygon, a zone holding the point, or
     * 'nearby', a marine warning within 3 NM (NWS's marine zones end at the
     * water, so a berth is just outside them). null from an older answer.
     */
    matchedBy: 'polygon' | 'zone' | 'nearby' | null;
    sent: string;
    onset: string | null;
    expires: string | null;
    infos: OfficialInfo[];
    attribution: string;
    attributionUrl: string | null;
}

export interface OfficialProvider {
    id: string;
    issuer: string;
    state: 'live' | 'unavailable' | 'off';
    since: string | null;
    lastSuccessAt: string | null;
    attribution: string;
    attributionUrl: string | null;
    unplaced: number;
    unplacedNewest: { event: string | null; areas: string[] } | null;
}

export interface OfficialAnswer {
    at: string;
    coverage: OfficialCoverage;
    providers: OfficialProvider[];
    alerts: OfficialAlert[];
    /**
     * Set when this is the last answer given again because a refresh failed:
     * when it was answered (ISO). Its warnings still stand; its "none in
     * force" does not.
     */
    staleSince?: string;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);
const pairs = (v: unknown) =>
    (Array.isArray(v) ? v : [])
        .map(rec)
        .filter((p): p is Rec => !!p && typeof p.valueName === 'string' && typeof p.value === 'string')
        .map((p) => ({ valueName: p.valueName as string, value: p.value as string }));
const COVERAGE: readonly OfficialCoverage[] = ['live', 'partial', 'unavailable', 'off', 'none'];
const STATES = ['live', 'unavailable', 'off'] as const;

function parseInfo(v: unknown): OfficialInfo | null {
    const i = rec(v);
    const event = str(i?.event);
    if (!i || !event) return null;
    return {
        language: str(i.language) ?? '',
        event,
        severity: str(i.severity) ?? 'Unknown',
        headline: str(i.headline),
        description: str(i.description),
        instruction: str(i.instruction),
        web: str(i.web),
        senderName: str(i.senderName),
        onset: str(i.onset),
        expires: str(i.expires),
        category: strs(i.category),
        parameters: pairs(i.parameters),
        eventCodes: pairs(i.eventCodes),
    };
}

/** The RPC's answer, or null when it is not one: a malformed answer is never read as "no warnings". */
export function parseOfficialAnswer(raw: unknown): OfficialAnswer | null {
    const a = rec(raw);
    const coverage = a?.coverage as OfficialCoverage;
    if (!a || !COVERAGE.includes(coverage) || !Array.isArray(a.providers) || !Array.isArray(a.alerts)) return null;
    const providers: OfficialProvider[] = [];
    for (const v of a.providers) {
        const p = rec(v);
        const state = p?.state as OfficialProvider['state'];
        if (!p || !str(p.id) || !str(p.issuer) || !STATES.includes(state)) return null;
        const newest = rec(p.unplaced_newest);
        providers.push({
            id: p.id as string,
            issuer: p.issuer as string,
            state,
            since: str(p.since),
            lastSuccessAt: str(p.last_success_at),
            attribution: str(p.attribution) ?? '',
            attributionUrl: str(p.attribution_url),
            unplaced: typeof p.unplaced === 'number' ? p.unplaced : 0,
            unplacedNewest: newest ? { event: str(newest.event), areas: strs(newest.areas) } : null,
        });
    }
    const alerts: OfficialAlert[] = [];
    for (const v of a.alerts) {
        const r = rec(v);
        const infos = (Array.isArray(r?.infos) ? (r!.infos as unknown[]) : []).map(parseInfo);
        // One unreadable warning makes the whole answer unreadable: never a silent drop.
        if (!r || !str(r.provider) || !str(r.identifier) || infos.length === 0 || infos.some((i) => !i)) return null;
        const matched = r.matched_by;
        alerts.push({
            provider: r.provider as string,
            issuer: str(r.issuer) ?? (r.provider as string),
            identifier: r.identifier as string,
            matchedBy: matched === 'polygon' || matched === 'zone' || matched === 'nearby' ? matched : null,
            sent: str(r.sent) ?? '',
            onset: str(r.onset),
            expires: str(r.expires),
            infos: infos as OfficialInfo[],
            attribution: str(r.attribution) ?? '',
            attributionUrl: str(r.attribution_url),
        });
    }
    return { at: str(a.at) ?? new Date().toISOString(), coverage, providers, alerts };
}

/** Warnings still in force at `nowMs`: one whose expiry has passed since the answer is dropped. */
export function officialInForce(answer: OfficialAnswer, nowMs: number): OfficialAlert[] {
    return answer.alerts.filter((a) => {
        const end = a.expires ? Date.parse(a.expires) : NaN;
        return !Number.isFinite(end) || end > nowMs;
    });
}

const ANSWER_MS = 4 * 60_000;
const UNANSWERED_MS = 10 * 60_000;
/** A failed refresh after an answer is asked again this soon, so the stale mark clears quickly. */
const STALE_RETRY_MS = 60_000;
const cache = new Map<string, { at: number; ttl: number; value: Promise<OfficialAnswer | null> }>();
/** The last good answer per account and position, never overwritten by a failure. */
const lastGood = new Map<string, OfficialAnswer>();

export function clearOfficialWarningsCache(): void {
    cache.clear();
    lastGood.clear();
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function fetchOfficialWarnings(lat: number, lon: number): Promise<OfficialAnswer | null> {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return Promise.resolve(null);
    }
    const p_lat = round3(lat);
    const p_lon = round3(lon);
    const key = `${getAuthIdentityScope().key}|${p_lat}|${p_lon}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
    const entry: { at: number; ttl: number; value: Promise<OfficialAnswer | null> } = {
        at: Date.now(),
        ttl: UNANSWERED_MS,
        value: Promise.resolve(null),
    };
    entry.value = (async () => {
        let answer: OfficialAnswer | null = null;
        try {
            const { data, error } = (await supabase?.rpc('official_alerts_at', { p_lat, p_lon })) ?? {};
            answer = error ? null : parseOfficialAnswer(data);
        } catch {
            answer = null;
        }
        if (answer) {
            entry.ttl = ANSWER_MS;
            lastGood.set(key, answer);
            return answer;
        }
        // Not answered: the last answer here, if there was one, stands, marked stale.
        const prev = lastGood.get(key);
        if (!prev) return null;
        entry.ttl = STALE_RETRY_MS;
        return { ...prev, staleSince: prev.staleSince ?? prev.at };
    })();
    cache.set(key, entry);
    return entry.value;
}
