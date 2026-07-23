import { useEffect, useRef, useState } from 'react';
import type { NextLegSeed } from '../../services/routeTracer';

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

function readJson<T>(key: string): T | null {
    try {
        const raw = sessionStorage.getItem(key);
        return raw ? (JSON.parse(raw) as T) : null;
    } catch {
        return null;
    }
}

function readFramePoint(key: string): TraceFramePoint | null {
    const value = readJson<unknown>(key);
    return isTracePoint(value) && typeof (value as Partial<TraceFramePoint>).name === 'string'
        ? (value as TraceFramePoint)
        : null;
}

function readLegAnchor(): NextLegSeed | null {
    const value = readJson<unknown>(STORAGE_KEYS.legAnchor);
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

/**
 * Owns the per-tab trace draft. A trace must survive a reload/crash while not
 * leaking into another tab, so sessionStorage is deliberately the boundary.
 * Keeping the recovery and persistence contract here leaves MapHub to manage
 * map rendering, grading, and user interactions instead of storage details.
 */
export function useTraceDraft() {
    const [capturedCoords, setCapturedCoords] = useState<TracePoint[]>(() => {
        const stored = readJson<unknown>(STORAGE_KEYS.pins);
        return Array.isArray(stored) ? stored.filter(isTracePoint) : [];
    });
    const [departureMs, setDepartureMs] = useState<number | null>(() => {
        try {
            const raw = sessionStorage.getItem(STORAGE_KEYS.departureMs);
            const value = raw ? Number(raw) : Number.NaN;
            return Number.isFinite(value) && value > Date.now() - 3_600_000 ? value : null;
        } catch {
            return null;
        }
    });
    const [traceName, setTraceName] = useState(() => {
        try {
            return sessionStorage.getItem(STORAGE_KEYS.name) ?? '';
        } catch {
            return '';
        }
    });
    const lastAutoNameRef = useRef<string>(
        (() => {
            try {
                return sessionStorage.getItem(STORAGE_KEYS.autoName) ?? '';
            } catch {
                return '';
            }
        })(),
    );

    const [legAnchor, setLegAnchor] = useState<NextLegSeed | null>(readLegAnchor);
    const legAnchorRef = useRef<NextLegSeed | null>(legAnchor);
    const [traceOrigin, setTraceOrigin] = useState<TraceFramePoint | null>(() => readFramePoint(STORAGE_KEYS.origin));
    const [traceDest, setTraceDest] = useState<TraceFramePoint | null>(() => readFramePoint(STORAGE_KEYS.destination));

    useEffect(() => {
        try {
            sessionStorage.setItem(STORAGE_KEYS.pins, JSON.stringify(capturedCoords));
        } catch {
            /* quota/private-mode — the trace just doesn't survive reloads */
        }
    }, [capturedCoords]);

    useEffect(() => {
        try {
            if (departureMs === null) sessionStorage.removeItem(STORAGE_KEYS.departureMs);
            else sessionStorage.setItem(STORAGE_KEYS.departureMs, String(departureMs));
        } catch {
            /* private mode — departure just doesn't survive reloads */
        }
    }, [departureMs]);

    useEffect(() => {
        legAnchorRef.current = legAnchor;
    }, [legAnchor]);

    useEffect(() => {
        try {
            sessionStorage.setItem(STORAGE_KEYS.origin, JSON.stringify(traceOrigin));
            sessionStorage.setItem(STORAGE_KEYS.destination, JSON.stringify(traceDest));
        } catch {
            /* quota/private-mode */
        }
    }, [traceOrigin, traceDest]);

    useEffect(() => {
        try {
            sessionStorage.setItem(STORAGE_KEYS.legAnchor, JSON.stringify(legAnchor));
            sessionStorage.setItem(STORAGE_KEYS.name, traceName);
            sessionStorage.setItem(STORAGE_KEYS.autoName, lastAutoNameRef.current);
        } catch {
            /* quota/private-mode */
        }
    }, [legAnchor, traceName]);

    return {
        capturedCoords,
        setCapturedCoords,
        departureMs,
        setDepartureMs,
        traceName,
        setTraceName,
        lastAutoNameRef,
        legAnchor,
        setLegAnchor,
        legAnchorRef,
        traceOrigin,
        setTraceOrigin,
        traceDest,
        setTraceDest,
    };
}
