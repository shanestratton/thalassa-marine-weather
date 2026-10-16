/** Informational latest-state AIS watches. No navigation, collision or rescue authority. */
export const BUDDY_LIMIT = 10;
export const BUDDY_FRESH_MS = 15 * 60_000;
export const BUDDY_HOLD_MS = 2 * 60_000;
export type BuddyEvent = 'moving' | 'moored' | 'underway' | 'entered' | 'left' | 'not-seen';
export type BuddyMode = 'moving' | 'moored' | 'stopped' | 'unknown';
export interface BuddyArea {
    lat: number;
    lon: number;
    radiusNm: number;
    label: string;
}
export interface BuddyConfiguration {
    mmsi: number;
    label: string;
    enabled: boolean;
    area: BuddyArea | null;
}
export interface BuddyFacts {
    at: number;
    sog: number | null;
    navStatus: number | null;
    distanceNm: number | null;
}
export interface BuddyState {
    observedAt: number | null;
    mode: BuddyMode;
    area: 'inside' | 'outside' | 'unknown';
    candidate: BuddyMode;
    candidateSince: number | null;
    areaCandidate: 'inside' | 'outside' | 'unknown';
    areaSince: number | null;
    notSeen: boolean;
}
export interface BuddyResult {
    state: BuddyState;
    event: BuddyEvent | null;
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: readonly string[]) =>
    Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const finite = (v: unknown, min: number, max: number): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const text = (v: unknown, max: number): v is string =>
    typeof v === 'string' &&
    v.trim() === v &&
    v.length > 0 &&
    v.length <= max &&
    ![...v].some((c) => c.charCodeAt(0) < 32 || (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159));
export function parseBuddyConfiguration(v: unknown): BuddyConfiguration | null {
    if (
        !record(v) ||
        !exact(v, ['mmsi', 'label', 'enabled', 'area']) ||
        !Number.isInteger(v.mmsi) ||
        !finite(v.mmsi, 100_000_000, 799_999_999) ||
        !text(v.label, 60) ||
        typeof v.enabled !== 'boolean'
    )
        return null;
    if (
        v.area !== null &&
        (!record(v.area) ||
            !exact(v.area, ['lat', 'lon', 'radiusNm', 'label']) ||
            !finite(v.area.lat, -90, 90) ||
            !finite(v.area.lon, -180, 180) ||
            !finite(v.area.radiusNm, 0.2, 50) ||
            !text(v.area.label, 60))
    )
        return null;
    return v as unknown as BuddyConfiguration;
}
export const emptyBuddyState = (): BuddyState => ({
    observedAt: null,
    mode: 'unknown',
    area: 'unknown',
    candidate: 'unknown',
    candidateSince: null,
    areaCandidate: 'unknown',
    areaSince: null,
    notSeen: false,
});
const modes: readonly string[] = ['unknown', 'stopped', 'moving', 'moored'];
const areas: readonly string[] = ['unknown', 'inside', 'outside'];
export function parseBuddyState(v: unknown): BuddyState | null {
    if (
        !record(v) ||
        !exact(v, [
            'observedAt',
            'mode',
            'area',
            'candidate',
            'candidateSince',
            'areaCandidate',
            'areaSince',
            'notSeen',
        ]) ||
        !modes.includes(String(v.mode)) ||
        !modes.includes(String(v.candidate)) ||
        !areas.includes(String(v.area)) ||
        !areas.includes(String(v.areaCandidate)) ||
        typeof v.notSeen !== 'boolean'
    )
        return null;
    for (const k of ['observedAt', 'candidateSince', 'areaSince'])
        if (v[k] !== null && (!Number.isSafeInteger(v[k]) || !finite(v[k], 1, Number.MAX_SAFE_INTEGER))) return null;
    if (
        v.observedAt === null &&
        (v.candidateSince !== null || v.areaSince !== null || v.mode !== 'unknown' || v.area !== 'unknown' || v.notSeen)
    )
        return null;
    if (
        typeof v.observedAt === 'number' &&
        ((typeof v.candidateSince === 'number' && v.candidateSince > v.observedAt) ||
            (typeof v.areaSince === 'number' && v.areaSince > v.observedAt))
    )
        return null;
    return v as unknown as BuddyState;
}
export function parseBuddyFacts(v: unknown): BuddyFacts | null {
    if (
        !record(v) ||
        !exact(v, ['at', 'sog', 'navStatus', 'distanceNm']) ||
        !Number.isSafeInteger(v.at) ||
        !finite(v.at, 1, Number.MAX_SAFE_INTEGER) ||
        (v.sog !== null && !finite(v.sog, 0, 102.3)) ||
        (v.navStatus !== null && (!Number.isInteger(v.navStatus) || !finite(v.navStatus, 0, 15))) ||
        (v.distanceNm !== null && !finite(v.distanceNm, 0, 10810))
    )
        return null;
    return v as unknown as BuddyFacts;
}
/** Repeated, stale, future or missing reports cannot confirm arrival/movement.
 * Silence means absent from this incomplete cache, never a vessel in distress. */
export function evaluateBuddy(
    previous: BuddyState,
    facts: BuddyFacts | null,
    area: BuddyArea | null,
    now: number,
): BuddyResult {
    const state = { ...previous };
    if (!Number.isSafeInteger(now) || now <= 0 || !parseBuddyState(previous))
        return { state: emptyBuddyState(), event: null };
    if (!facts || !parseBuddyFacts(facts) || facts.at > now || now - facts.at > BUDDY_FRESH_MS) {
        const missing = state.observedAt !== null && now - state.observedAt > BUDDY_FRESH_MS;
        const event = missing && !state.notSeen ? 'not-seen' : null;
        return {
            state: {
                ...state,
                candidate: 'unknown',
                candidateSince: null,
                areaCandidate: 'unknown',
                areaSince: null,
                notSeen: missing || state.notSeen,
            },
            event,
        };
    }
    if (state.observedAt !== null && facts.at <= state.observedAt) return { state, event: null };
    const gap = state.observedAt === null || facts.at - state.observedAt > BUDDY_FRESH_MS || state.notSeen;
    const measured: BuddyMode =
        facts.sog === null
            ? 'unknown'
            : facts.sog <= 0.5
              ? [1, 5].includes(facts.navStatus ?? -1)
                  ? 'moored'
                  : 'stopped'
              : facts.sog >= 2 && ![1, 5].includes(facts.navStatus ?? -1)
                ? 'moving'
                : 'unknown';
    const where =
        area && facts.distanceNm !== null
            ? facts.distanceNm < area.radiusNm * 0.9
                ? 'inside'
                : facts.distanceNm > area.radiusNm * 1.1
                  ? 'outside'
                  : 'unknown'
            : 'unknown';
    let event: BuddyEvent | null = null;
    if (gap) {
        state.mode = measured;
        state.area = where;
        state.candidate = measured;
        state.candidateSince = measured === 'unknown' ? null : facts.at;
        state.areaCandidate = where;
        state.areaSince = where === 'unknown' ? null : facts.at;
    } else {
        if (measured === 'unknown') {
            state.candidate = 'unknown';
            state.candidateSince = null;
        } else if (measured !== state.candidate) {
            state.candidate = measured;
            state.candidateSince = facts.at;
        } else if (
            state.candidateSince !== null &&
            facts.at - state.candidateSince >= BUDDY_HOLD_MS &&
            measured !== state.mode
        ) {
            event =
                measured === 'moored'
                    ? 'moored'
                    : measured === 'moving'
                      ? state.mode === 'moored'
                          ? 'underway'
                          : 'moving'
                      : null;
            state.mode = measured;
        }
        if (where === 'unknown') {
            state.areaCandidate = 'unknown';
            state.areaSince = null;
        } else if (where !== state.areaCandidate) {
            state.areaCandidate = where;
            state.areaSince = facts.at;
        } else if (state.areaSince !== null && facts.at - state.areaSince >= BUDDY_HOLD_MS && where !== state.area) {
            if (state.area !== 'unknown') event = where === 'inside' ? 'entered' : 'left';
            state.area = where;
        }
    }
    state.observedAt = facts.at;
    state.notSeen = false;
    return { state, event };
}
export function buddyEventWords(event: BuddyEvent): string {
    return {
        moving: 'AIS reports moving',
        moored: 'AIS reports anchored or moored',
        underway: 'AIS reports under way',
        entered: 'Entered your chosen area in available AIS reports',
        left: 'Left your chosen area in available AIS reports',
        'not-seen': 'Not seen in available AIS coverage; position unknown',
    }[event];
}
