import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type mapboxgl from 'mapbox-gl';
import type { OffshoreComparisonRow, OffshoreComparisonModel } from '../../services/routing/offshoreModelComparison';
import type { OffshoreJob, OffshoreCandidate } from '../../services/routing/offshoreProtocol';
import type { IsochroneEnvironment } from '../../services/routing/isochroneEnvironment';
import type { VerifiedOffshoreCandidate } from '../../services/routing/offshoreSelection';
import type { WindGrid } from '../../services/weather/windGridEncoding';

export interface OffshoreComparisonInputs {
    base: Omit<OffshoreJob, 'wind' | 'deadlineMs'>;
    bounds: { north: number; south: number; east: number; west: number };
    environment: IsochroneEnvironment;
}
export interface OffshoreComparisonContext {
    isCurrent: () => boolean;
    disabledReason?: string;
    load: () => Promise<OffshoreComparisonInputs>;
    verify: (
        candidate: OffshoreCandidate,
        job: OffshoreJob,
        environment: IsochroneEnvironment,
        isCurrent: () => boolean,
    ) => Promise<VerifiedOffshoreCandidate>;
    commit: (candidate: VerifiedOffshoreCandidate, model: OffshoreComparisonModel) => void;
}
export interface OffshoreComparisonView {
    ready: boolean;
    disabledReason?: string;
    open: boolean;
    busy: boolean;
    checking: string | null;
    selected: string | null;
    message: string | null;
    rows: OffshoreComparisonRow[];
    verified: Partial<Record<string, VerifiedOffshoreCandidate>>;
    start: () => Promise<void>;
    close: () => void;
    select: (id: string) => Promise<void>;
}
const SOURCE = 'offshore-model-comparison';
const LAYER = 'offshore-model-comparison-lines';
const EMPTY = { type: 'FeatureCollection' as const, features: [] };

function removeOverlay(map: mapboxgl.Map | null): void {
    try {
        if (map?.getLayer(LAYER)) map.removeLayer(LAYER);
        if (map?.getSource(SOURCE)) map.removeSource(SOURCE);
    } catch {
        /* A disposed map already removed its layers. */
    }
}

/** Owns disposable comparison inputs only; the existing passage owns every accepted route. */
export function useOffshoreComparison(mapRef: MutableRefObject<mapboxgl.Map | null>) {
    const context = useRef<OffshoreComparisonContext | null>(null);
    const epoch = useRef(0);
    const abort = useRef<AbortController | null>(null);
    const rowsRef = useRef<OffshoreComparisonRow[]>([]);
    const inputs = useRef<OffshoreComparisonInputs | null>(null);
    const grids = useRef(new Map<string, { grid: WindGrid; at: number }>());
    const [state, setState] = useState<Omit<OffshoreComparisonView, 'start' | 'close' | 'select'>>({
        ready: false,
        open: false,
        busy: false,
        checking: null,
        selected: null,
        message: null,
        rows: [],
        verified: {},
    });
    const reset = useCallback(() => {
        epoch.current++;
        abort.current?.abort();
        abort.current = null;
        context.current = null;
        rowsRef.current = [];
        inputs.current = null;
        grids.current.clear();
        removeOverlay(mapRef.current);
        setState({
            ready: false,
            open: false,
            busy: false,
            checking: null,
            selected: null,
            message: null,
            rows: [],
            verified: {},
        });
    }, [mapRef]);
    useEffect(
        () => () => {
            epoch.current++;
            abort.current?.abort();
            grids.current.clear();
            inputs.current = null;
            context.current = null;
            removeOverlay(mapRef.current);
        },
        [mapRef],
    );
    const prepare = useCallback((next: OffshoreComparisonContext) => {
        context.current = next;
        setState((old) => ({ ...old, ready: true, disabledReason: next.disabledReason }));
    }, []);
    useEffect(() => {
        if (!state.ready) return;
        const timer = setInterval(() => {
            if (context.current && !context.current.isCurrent()) reset();
        }, 250);
        return () => clearInterval(timer);
    }, [state.ready, reset]);
    const start = useCallback(async () => {
        const ctx = context.current;
        if (!ctx || !ctx.isCurrent() || ctx.disabledReason) return;
        abort.current?.abort();
        const controller = new AbortController();
        abort.current = controller;
        const token = ++epoch.current;
        const deadlineMs = Date.now() + 60_000;
        const owns = () => epoch.current === token && !controller.signal.aborted && ctx.isCurrent();
        const live = () => owns() && Date.now() < deadlineMs;
        grids.current.clear();
        inputs.current = null;
        rowsRef.current = [];
        removeOverlay(mapRef.current);
        setState((old) => ({
            ...old,
            open: true,
            busy: true,
            checking: null,
            selected: null,
            rows: [],
            verified: {},
            message: null,
        }));
        let timer: ReturnType<typeof setTimeout> | undefined;
        let stale: ReturnType<typeof setInterval> | undefined;
        try {
            const api = await import('../../services/routing/offshoreModelComparison');
            if (!live()) return;
            rowsRef.current = api.OFFSHORE_COMPARISON_MODELS.map((model) => ({ model, status: 'loading' }));
            setState((old) => ({ ...old, rows: rowsRef.current }));
            const loaded = await Promise.race([
                ctx.load(),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(
                        () => reject(new Error('Comparison preparation exceeded its 60-second budget.')),
                        Math.max(1, deadlineMs - Date.now()),
                    );
                    stale = setInterval(() => {
                        if (!live()) reject(new Error('Comparison was cancelled.'));
                    }, 100);
                }),
            ]).finally(() => {
                clearTimeout(timer);
                clearInterval(stale);
            });
            if (!live()) return;
            inputs.current = loaded;
            const update = (row: OffshoreComparisonRow) => {
                if (!live()) return;
                rowsRef.current = rowsRef.current.map((old) => (old.model.id === row.model.id ? row : old));
                setState((old) => ({ ...old, rows: rowsRef.current }));
                const map = mapRef.current;
                if (!map) return;
                const data: GeoJSON.FeatureCollection<GeoJSON.LineString> = {
                    type: 'FeatureCollection',
                    features: rowsRef.current.flatMap((r) => {
                        const line = api.offshoreComparisonLine(r);
                        return line ? [line] : [];
                    }),
                };
                try {
                    if (!map.getSource(SOURCE)) map.addSource(SOURCE, { type: 'geojson', data: EMPTY });
                    if (!map.getLayer(LAYER))
                        map.addLayer(
                            {
                                id: LAYER,
                                type: 'line',
                                source: SOURCE,
                                paint: {
                                    'line-color': ['get', 'colour'],
                                    'line-width': 2,
                                    'line-opacity': 0.7,
                                    'line-dasharray': [3, 3],
                                },
                            },
                            map.getLayer('route-line-layer') ? 'route-line-layer' : undefined,
                        );
                    (map.getSource(SOURCE) as mapboxgl.GeoJSONSource).setData(data);
                } catch {
                    /* The reference overlay cannot affect route verification. */
                }
            };
            const rows = await api.compareOffshoreModels({
                ...loaded,
                commercialEnabled: true,
                deadlineMs,
                signal: controller.signal,
                isCurrent: live,
                onRow: update,
                onGrid: (model, grid) => {
                    if (live()) grids.current.set(model.id, { grid, at: Date.now() });
                },
            });
            if (owns()) {
                rowsRef.current = rows;
                setState((old) => ({ ...old, rows, busy: false }));
            }
        } catch (error) {
            if (owns())
                setState((old) => ({
                    ...old,
                    busy: false,
                    message: error instanceof Error ? error.message : 'Comparison unavailable.',
                    rows: old.rows.map((row) => ({ ...row, status: 'unavailable' })),
                }));
        } finally {
            clearTimeout(timer);
            clearInterval(stale);
            if (owns()) setState((old) => ({ ...old, busy: false }));
        }
    }, [mapRef]);
    const close = useCallback(() => {
        epoch.current++;
        abort.current?.abort();
        removeOverlay(mapRef.current);
        setState((old) => ({ ...old, open: false, busy: false, checking: null }));
    }, [mapRef]);
    const select = useCallback(async (id: string) => {
        const ctx = context.current,
            loaded = inputs.current;
        const row = rowsRef.current.find((value) => value.model.id === id);
        const grid = grids.current.get(id);
        if (
            !ctx ||
            !loaded ||
            row?.status !== 'candidate' ||
            !row.candidate ||
            !grid ||
            Date.now() - grid.at > 30 * 60_000 ||
            !ctx.isCurrent()
        ) {
            setState((old) => ({
                ...old,
                message: 'Comparison expired. Compare again with the current passage settings.',
            }));
            return;
        }
        const token = ++epoch.current;
        abort.current?.abort();
        const deadlineMs = Date.now() + 15_000;
        const live = () => epoch.current === token && ctx.isCurrent() && Date.now() < deadlineMs;
        setState((old) => ({ ...old, checking: id, message: null }));
        try {
            const verified = await ctx.verify(
                row.candidate,
                { ...loaded.base, wind: grid.grid, deadlineMs },
                loaded.environment,
                live,
            );
            if (!live()) return;
            ctx.commit(verified, row.model);
            setState((old) => ({
                ...old,
                selected: id,
                verified: { ...old.verified, [id]: verified },
                message: `${row.model.label} selected after final chart, land and environment checks.`,
            }));
        } catch (error) {
            if (epoch.current === token && ctx.isCurrent())
                setState((old) => ({
                    ...old,
                    message: error instanceof Error ? error.message : 'Candidate verification failed.',
                }));
        } finally {
            if (epoch.current === token) setState((old) => ({ ...old, checking: null }));
        }
    }, []);
    return { prepare, reset, view: { ...state, start, close, select } satisfies OffshoreComparisonView };
}
