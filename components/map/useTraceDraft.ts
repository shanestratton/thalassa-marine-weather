import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
    type Dispatch,
    type SetStateAction,
} from 'react';
import type { NextLegSeed, SavedTrace } from '../../services/routeTracer';
import { reversedLegName, stripRouteBadges } from '../../services/routeNameParts';
import {
    activeReversalNote,
    parseReturnPlan,
    parseReversalMark,
    reversedLegForSlot,
    type ReturnPlan,
    type ReversalMark,
} from '../../services/tripReverse';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../../services/authIdentityScope';

export interface TracePoint {
    lat: number;
    lon: number;
}

export interface TraceFramePoint extends TracePoint {
    name: string;
}

const STORAGE_KEYS = {
    pins: 'thalassa_trace_wip_pins',
    departureMs: 'thalassa_trace_departure_ms',
    name: 'thalassa_trace_wip_name',
    autoName: 'thalassa_trace_wip_auto_name',
    legAnchor: 'thalassa_trace_wip_leg_anchor',
    origin: 'thalassa_trace_wip_origin',
    destination: 'thalassa_trace_wip_dest',
    /** "Plan the return trip" cursor (services/tripReverse.ts ReturnPlan). */
    returnPlan: 'thalassa_trace_wip_return_plan',
    /** Where a reversed draft came from — its "check this direction" note. */
    reversedFrom: 'thalassa_trace_wip_reversed_from',
} as const;

const subscribeIdentity = (notify: () => void): (() => void) => subscribeAuthIdentityScope(() => notify());

function sameScope(left: AuthIdentityScope, right: AuthIdentityScope): boolean {
    return left.key === right.key && left.generation === right.generation;
}

function scopedStorageKey(key: string, scope: AuthIdentityScope): string {
    return authScopedStorageKey(key, scope);
}

function readRaw(key: string, scope: AuthIdentityScope): string | null {
    try {
        const scoped = sessionStorage.getItem(scopedStorageKey(key, scope));
        if (scoped !== null) return scoped;
        // The old draft carried no owner metadata. Preserve it only in the
        // deliberately separate anonymous scope; never guess it onto a login.
        return scope.userId ? null : sessionStorage.getItem(key);
    } catch {
        return null;
    }
}

function isTracePoint(value: unknown): value is TracePoint {
    if (!value || typeof value !== 'object') return false;
    const point = value as Partial<TracePoint>;
    return (
        Number.isFinite(point.lat) &&
        Number.isFinite(point.lon) &&
        Math.abs(point.lat!) <= 90 &&
        Math.abs(point.lon!) <= 180
    );
}

function readJson<T>(key: string, scope: AuthIdentityScope): T | null {
    try {
        const raw = readRaw(key, scope);
        return raw ? (JSON.parse(raw) as T) : null;
    } catch {
        return null;
    }
}

function readFramePoint(key: string, scope: AuthIdentityScope): TraceFramePoint | null {
    const value = readJson<unknown>(key, scope);
    return isTracePoint(value) && typeof (value as Partial<TraceFramePoint>).name === 'string'
        ? (value as TraceFramePoint)
        : null;
}

function readLegAnchor(scope: AuthIdentityScope): NextLegSeed | null {
    const value = readJson<unknown>(STORAGE_KEYS.legAnchor, scope);
    if (!value || typeof value !== 'object') return null;
    const seed = value as Partial<NextLegSeed>;
    const ordinal = seed.ordinal;
    return typeof seed.tripId === 'string' &&
        typeof ordinal === 'number' &&
        Number.isInteger(ordinal) &&
        ordinal > 0 &&
        typeof seed.fromName === 'string' &&
        isTracePoint(seed.anchor)
        ? (seed as NextLegSeed)
        : null;
}

interface TraceDraftData {
    capturedCoords: TracePoint[];
    departureMs: number | null;
    traceName: string;
    autoName: string;
    legAnchor: NextLegSeed | null;
    traceOrigin: TraceFramePoint | null;
    traceDest: TraceFramePoint | null;
    returnPlan: ReturnPlan | null;
    reversedFrom: ReversalMark | null;
}

interface ScopedTraceDraft {
    scope: AuthIdentityScope;
    data: TraceDraftData;
}

function readDraft(scope: AuthIdentityScope): TraceDraftData {
    const storedCoords = readJson<unknown>(STORAGE_KEYS.pins, scope);
    const rawDeparture = readRaw(STORAGE_KEYS.departureMs, scope);
    const departure = rawDeparture ? Number(rawDeparture) : Number.NaN;
    return {
        capturedCoords: Array.isArray(storedCoords) ? storedCoords.filter(isTracePoint) : [],
        departureMs: Number.isFinite(departure) && departure > Date.now() - 3_600_000 ? departure : null,
        traceName: readRaw(STORAGE_KEYS.name, scope) ?? '',
        autoName: readRaw(STORAGE_KEYS.autoName, scope) ?? '',
        legAnchor: readLegAnchor(scope),
        traceOrigin: readFramePoint(STORAGE_KEYS.origin, scope),
        traceDest: readFramePoint(STORAGE_KEYS.destination, scope),
        returnPlan: parseReturnPlan(readJson<unknown>(STORAGE_KEYS.returnPlan, scope)),
        reversedFrom: parseReversalMark(readJson<unknown>(STORAGE_KEYS.reversedFrom, scope)),
    };
}

/** One draft replaced wholesale by a reversed leg (return-trip flow). */
export interface ReversedLegDraft {
    points: TracePoint[];
    name: string;
    /** Name the auto-namer may keep rewriting; '' leaves the name as given. */
    autoName?: string;
    legAnchor: NextLegSeed | null;
    reversedFrom: ReversalMark | null;
    returnPlan: ReturnPlan | null;
}

function resolveAction<T>(action: SetStateAction<T>, current: T): T {
    return typeof action === 'function' ? (action as (previous: T) => T)(current) : action;
}

/**
 * Owns the per-tab trace draft. A trace must survive a reload/crash while not
 * leaking into another tab, so sessionStorage is deliberately the boundary.
 * Keeping the recovery and persistence contract here leaves MapHub to manage
 * map rendering, grading, and user interactions instead of storage details.
 */
export function useTraceDraft() {
    const identityScope = useSyncExternalStore(subscribeIdentity, getAuthIdentityScope, getAuthIdentityScope);
    const hydratedDraft = useMemo(() => readDraft(identityScope), [identityScope]);
    const [storedDraft, setStoredDraft] = useState<ScopedTraceDraft>(() => ({
        scope: identityScope,
        data: hydratedDraft,
    }));
    // A render caused by an identity transition must never expose the previous
    // account while the layout effect hydrates the new account's draft.
    const draft = sameScope(storedDraft.scope, identityScope) ? storedDraft.data : hydratedDraft;

    const lastAutoNameRef = useRef(draft.autoName);
    const legAnchorRef = useRef<NextLegSeed | null>(draft.legAnchor);
    const refsScope = useRef(identityScope);
    if (!sameScope(refsScope.current, identityScope)) {
        refsScope.current = identityScope;
        lastAutoNameRef.current = draft.autoName;
    }
    legAnchorRef.current = draft.legAnchor;

    useLayoutEffect(() => {
        setStoredDraft((current) =>
            sameScope(current.scope, identityScope) ? current : { scope: identityScope, data: hydratedDraft },
        );
    }, [hydratedDraft, identityScope]);

    const updateDraft = useCallback(
        (update: (current: TraceDraftData) => TraceDraftData): void => {
            const scope = identityScope;
            if (!isAuthIdentityScopeCurrent(scope)) return;
            setStoredDraft((current) => {
                if (!isAuthIdentityScopeCurrent(scope)) return current;
                const base = sameScope(current.scope, scope) ? current.data : readDraft(scope);
                return { scope, data: update(base) };
            });
        },
        [identityScope],
    );

    const setCapturedCoords = useCallback<Dispatch<SetStateAction<TracePoint[]>>>(
        (action) =>
            updateDraft((current) => ({ ...current, capturedCoords: resolveAction(action, current.capturedCoords) })),
        [updateDraft],
    );
    const setDepartureMs = useCallback<Dispatch<SetStateAction<number | null>>>(
        (action) => updateDraft((current) => ({ ...current, departureMs: resolveAction(action, current.departureMs) })),
        [updateDraft],
    );
    const setTraceName = useCallback<Dispatch<SetStateAction<string>>>(
        (action) => updateDraft((current) => ({ ...current, traceName: resolveAction(action, current.traceName) })),
        [updateDraft],
    );
    // Every door that opens another route (a saved route, a passage, a pasted
    // or logged track, "Plot the next leg", Clear-abandon) declares the draft's
    // chain identity through here. A return-trip cursor and a reversal note
    // describe the draft being replaced, so they end with it — one rule here
    // rather than a reset at each of those doors.
    const setLegAnchor = useCallback<Dispatch<SetStateAction<NextLegSeed | null>>>(
        (action) =>
            updateDraft((current) => ({
                ...current,
                legAnchor: resolveAction(action, current.legAnchor),
                returnPlan: null,
                reversedFrom: null,
            })),
        [updateDraft],
    );
    const setReturnPlan = useCallback<Dispatch<SetStateAction<ReturnPlan | null>>>(
        (action) => updateDraft((current) => ({ ...current, returnPlan: resolveAction(action, current.returnPlan) })),
        [updateDraft],
    );
    const clearReturnContext = useCallback(
        () => updateDraft((current) => ({ ...current, returnPlan: null, reversedFrom: null })),
        [updateDraft],
    );
    const setTraceOrigin = useCallback<Dispatch<SetStateAction<TraceFramePoint | null>>>(
        (action) => updateDraft((current) => ({ ...current, traceOrigin: resolveAction(action, current.traceOrigin) })),
        [updateDraft],
    );
    const setTraceDest = useCallback<Dispatch<SetStateAction<TraceFramePoint | null>>>(
        (action) => updateDraft((current) => ({ ...current, traceDest: resolveAction(action, current.traceDest) })),
        [updateDraft],
    );
    /**
     * ⇄ on an unlocked draft. Geometry and its labels are one edit (only
     * pins/title used to reverse, leaving the departure/destination frame
     * pointing outbound). The name loses its trip badges: a reversed "(2nd
     * Leg)" is a new route, and the stale badge seeded Cast Off as leg 2 and
     * offered "Plot the 3rd leg" (2026-10-07). `sourceLabel` names what was
     * reversed for the "check this direction" note; reversing a reversal is
     * the original direction again, so its note goes. Any return-trip cursor
     * ends: the draft is no longer that return leg.
     *
     * `detach` is for a chained leg that has been SAVED and still shows its
     * locked start (Save keeps the anchor). Its reversal is a copy too, so
     * the lock goes in the same edit; without it a locked draft is refused.
     */
    const reverseDirection = useCallback(
        (sourceLabel?: string | null, options: { detach?: boolean } = {}) => {
            if (!isAuthIdentityScopeCurrent(identityScope)) return;
            if (draft.capturedCoords.length < 2 || (draft.legAnchor && !options.detach)) return;
            const autoName = reversedLegName(lastAutoNameRef.current);
            lastAutoNameRef.current = autoName;
            updateDraft((current) => {
                const reversed = [...current.capturedCoords].reverse();
                const end = reversed[reversed.length - 1];
                const backToOriginal = activeReversalNote(current.capturedCoords, current.reversedFrom) !== null;
                const label = sourceLabel?.trim() || stripRouteBadges(current.traceName) || 'the outbound line';
                return {
                    ...current,
                    capturedCoords: reversed,
                    traceName: reversedLegName(current.traceName),
                    autoName,
                    legAnchor: options.detach ? null : current.legAnchor,
                    traceOrigin: current.traceDest,
                    traceDest: current.traceOrigin,
                    reversedFrom: backToOriginal || !end ? null : { label, end: { lat: end.lat, lon: end.lon } },
                    returnPlan: null,
                };
            });
        },
        [draft.capturedCoords.length, draft.legAnchor, identityScope, updateDraft],
    );

    /**
     * ⇄ on a locked-start ("Plot the next leg") draft: drop a saved leg that
     * arrives at the locked pin in reversed, pin 0 on the exact anchor. False
     * when there is no locked start or the leg does not reach it. The flipped
     * name is the skipper's own words, so the auto-namer stands down.
     */
    const fillSlotWithReversed = useCallback(
        (source: SavedTrace): boolean => {
            if (!isAuthIdentityScopeCurrent(identityScope)) return false;
            const anchor = draft.legAnchor;
            if (!anchor) return false;
            const slot = reversedLegForSlot(source, anchor.anchor);
            if (!slot) return false;
            lastAutoNameRef.current = '';
            updateDraft((current) =>
                current.legAnchor
                    ? {
                          ...current,
                          capturedCoords: slot.points,
                          traceName: slot.name,
                          autoName: '',
                          traceOrigin: null,
                          traceDest: null,
                          reversedFrom: { label: slot.sourceLabel, end: { ...slot.points[slot.points.length - 1] } },
                      }
                    : current,
            );
            return true;
        },
        [draft.legAnchor, identityScope, updateDraft],
    );

    /** Replace the draft with one return leg in a single edit (the return-trip
     *  flow's open/next steps). The departure goes too: one set while the
     *  outbound trip was on screen would grade this leg's tide gates and be
     *  stamped on its Passage Planning row. A return leg falls back to now
     *  until the skipper sets its own. */
    const openReversedLeg = useCallback(
        (next: ReversedLegDraft): boolean => {
            if (!isAuthIdentityScopeCurrent(identityScope)) return false;
            const autoName = next.autoName ?? '';
            lastAutoNameRef.current = autoName;
            updateDraft((current) => ({
                ...current,
                capturedCoords: next.points.map((point) => ({ lat: point.lat, lon: point.lon })),
                departureMs: null,
                traceName: next.name,
                autoName,
                legAnchor: next.legAnchor,
                traceOrigin: null,
                traceDest: null,
                reversedFrom: next.reversedFrom,
                returnPlan: next.returnPlan,
            }));
            return true;
        },
        [identityScope, updateDraft],
    );

    useEffect(() => {
        const scope = identityScope;
        if (!isAuthIdentityScopeCurrent(scope)) return;
        try {
            sessionStorage.setItem(scopedStorageKey(STORAGE_KEYS.pins, scope), JSON.stringify(draft.capturedCoords));
            if (draft.departureMs === null) {
                sessionStorage.removeItem(scopedStorageKey(STORAGE_KEYS.departureMs, scope));
            } else {
                sessionStorage.setItem(scopedStorageKey(STORAGE_KEYS.departureMs, scope), String(draft.departureMs));
            }
            sessionStorage.setItem(scopedStorageKey(STORAGE_KEYS.origin, scope), JSON.stringify(draft.traceOrigin));
            sessionStorage.setItem(scopedStorageKey(STORAGE_KEYS.destination, scope), JSON.stringify(draft.traceDest));
            sessionStorage.setItem(scopedStorageKey(STORAGE_KEYS.legAnchor, scope), JSON.stringify(draft.legAnchor));
            sessionStorage.setItem(scopedStorageKey(STORAGE_KEYS.name, scope), draft.traceName);
            sessionStorage.setItem(scopedStorageKey(STORAGE_KEYS.autoName, scope), lastAutoNameRef.current);
            sessionStorage.setItem(scopedStorageKey(STORAGE_KEYS.returnPlan, scope), JSON.stringify(draft.returnPlan));
            sessionStorage.setItem(
                scopedStorageKey(STORAGE_KEYS.reversedFrom, scope),
                JSON.stringify(draft.reversedFrom),
            );
        } catch {
            /* quota/private-mode — the draft just doesn't survive reloads */
        }
    }, [draft, identityScope]);

    return {
        capturedCoords: draft.capturedCoords,
        setCapturedCoords,
        departureMs: draft.departureMs,
        setDepartureMs,
        traceName: draft.traceName,
        setTraceName,
        lastAutoNameRef,
        legAnchor: draft.legAnchor,
        setLegAnchor,
        legAnchorRef,
        traceOrigin: draft.traceOrigin,
        setTraceOrigin,
        traceDest: draft.traceDest,
        setTraceDest,
        reverseDirection,
        returnPlan: draft.returnPlan,
        setReturnPlan,
        reversedFrom: draft.reversedFrom,
        clearReturnContext,
        fillSlotWithReversed,
        openReversedLeg,
    };
}
