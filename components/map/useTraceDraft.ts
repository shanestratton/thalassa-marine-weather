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
import type { NextLegSeed } from '../../services/routeTracer';
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
    };
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
    const setLegAnchor = useCallback<Dispatch<SetStateAction<NextLegSeed | null>>>(
        (action) => updateDraft((current) => ({ ...current, legAnchor: resolveAction(action, current.legAnchor) })),
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
    };
}
