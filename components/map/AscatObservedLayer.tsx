import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type mapboxgl from 'mapbox-gl';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
import { ASCAT_CREDIT, type AscatRow } from '../../services/weather/ascatContract';
import { openAscatSession, type AscatSession, type AscatView } from '../../services/weather/ascatSession';
import {
    ascatAge,
    ascatCompass,
    ascatOverlay,
    ASCAT_LINES,
    ASCAT_CALM,
    ASCAT_SOURCE,
} from '../../services/weather/ascatPresentation';
import { useOwnedGeoJsonOverlay, type OwnedGeoJsonOverlayOptions } from './useOwnedGeoJsonOverlay';
import type { AtmosCredit } from './atmosPresentation';
import { ModalSheet } from '../ui/ModalSheet';
const LAYERS: OwnedGeoJsonOverlayOptions['layers'] = [
    {
        suffix: 'arrows',
        specification: {
            type: 'line',
            filter: ['==', ['geometry-type'], 'LineString'],
            paint: { 'line-color': '#f9a8d4', 'line-width': 1.6, 'line-opacity': 0.9 },
        },
    },
    {
        suffix: 'calm',
        specification: {
            type: 'symbol',
            filter: ['==', ['geometry-type'], 'Point'],
            layout: { 'text-field': '○', 'text-size': 16, 'text-allow-overlap': true },
            paint: { 'text-color': '#f9a8d4', 'text-halo-color': '#0f172a', 'text-halo-width': 2 },
        },
    },
];
export default function AscatObservedLayer({
    mapRef,
    mapReady,
    active,
    canInteract,
    onCredit,
    onInteractionChange,
}: {
    mapRef: React.MutableRefObject<mapboxgl.Map | null>;
    mapReady: boolean;
    active: boolean;
    canInteract: boolean;
    onCredit: (credit: AtmosCredit | null) => void;
    onInteractionChange: (active: boolean) => void;
}) {
    const [foreground, setForeground] = useState(() => document.visibilityState !== 'hidden');
    const [online, setOnline] = useState(() => navigator.onLine);
    const [session, setSession] = useState<AscatSession | null>(null),
        [view, setView] = useState<AscatView | null>(null);
    const [phase, setPhase] = useState('off'),
        [clock, setClock] = useState(Date.now),
        [selected, setSelected] = useState<AscatRow | null>(null);
    const shown = useRef<readonly AscatRow[]>([]),
        interactive = useRef(canInteract);
    interactive.current = canInteract;
    const eligible = active && foreground && online;
    useEffect(() => {
        const visibility = () => setForeground(document.visibilityState !== 'hidden'),
            connectivity = () => setOnline(navigator.onLine);
        document.addEventListener('visibilitychange', visibility);
        window.addEventListener('online', connectivity);
        window.addEventListener('offline', connectivity);
        return () => {
            document.removeEventListener('visibilitychange', visibility);
            window.removeEventListener('online', connectivity);
            window.removeEventListener('offline', connectivity);
        };
    }, []);
    useEffect(() => {
        if (!eligible || !mapReady) return;
        const scope = getAuthIdentityScope(),
            abort = new AbortController(),
            opened = Date.now();
        let acquired: AscatSession | null = null,
            expiry: ReturnType<typeof setTimeout> | undefined;
        const retire = () => {
            abort.abort();
            acquired?.close();
            setSession(null);
            setView(null);
            setSelected(null);
            setPhase('unavailable');
        };
        const unsubscribe = subscribeAuthIdentityScope(retire);
        setPhase('loading');
        setView(null);
        setSelected(null);
        void openAscatSession(
            abort.signal,
            () =>
                !abort.signal.aborted &&
                isAuthIdentityScopeCurrent(scope) &&
                document.visibilityState !== 'hidden' &&
                navigator.onLine,
        )
            .then((value) => {
                acquired = value;
                if (abort.signal.aborted || !value.isCurrent()) {
                    value.close();
                    return;
                }
                setSession(value);
                setClock(Date.now());
                expiry = setTimeout(
                    retire,
                    Math.max(0, Math.min(value.index.expiresAt * 1000, opened + 15 * 60000) - Date.now()),
                );
            })
            .catch(() => {
                if (!abort.signal.aborted) setPhase('unavailable');
            });
        return () => {
            unsubscribe();
            abort.abort();
            acquired?.close();
            clearTimeout(expiry);
            setSession(null);
            setView(null);
            setSelected(null);
        };
    }, [eligible, mapReady]);
    const sourceCurrent = useCallback(
        () => eligible && document.visibilityState !== 'hidden' && navigator.onLine && session?.isCurrent() === true,
        [eligible, session],
    );
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !sourceCurrent() || !session) return;
        let epoch = 0,
            live = true;
        const refresh = () => {
            const revision = ++epoch,
                bounds = map.getBounds();
            setView(null);
            setSelected(null);
            setPhase('loading');
            if (!bounds) {
                setPhase('unavailable');
                return;
            }
            void session
                .readViewport([bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()])
                .then((value) => {
                    if (live && revision === epoch && sourceCurrent()) {
                        setView(value);
                        setClock(Date.now());
                        setPhase(value.rows.length ? 'ready' : 'gap');
                    }
                })
                .catch((error) => {
                    if (live && revision === epoch)
                        setPhase(
                            error instanceof Error && error.message.startsWith('Zoom in') ? 'zoom' : 'unavailable',
                        );
                });
        };
        map.on('moveend', refresh);
        refresh();
        return () => {
            live = false;
            epoch++;
            map.off('moveend', refresh);
        };
    }, [session, mapReady, mapRef, sourceCurrent]);
    useEffect(() => {
        if (!view || !sourceCurrent()) return;
        const times = view.rows.map((row) => (row[2] + 86400) * 1000).filter((time) => time > clock);
        const next = Math.min(clock + 60000, ...times);
        const timer = setTimeout(() => setClock(Date.now()), Math.max(1, next - Date.now()));
        return () => clearTimeout(timer);
    }, [view, clock, sourceCurrent]);
    const createData = useCallback(
        (map: mapboxgl.Map): GeoJSON.FeatureCollection => {
            if (!view || !sourceCurrent()) {
                shown.current = [];
                return { type: 'FeatureCollection', features: [] };
            }
            const result = ascatOverlay(map, view.rows, Date.now());
            shown.current = result.shown;
            return result.data;
        },
        [view, sourceCurrent],
    );
    const vector = useOwnedGeoJsonOverlay(mapRef, mapReady, {
        namespace: 'ascat-observed141',
        label: 'Satellite wind',
        credit: ASCAT_CREDIT,
        enabled: eligible,
        owner: session,
        revision: `${view?.generation ?? 'none'}:${view?.revision ?? 0}:${clock}`,
        sourceCurrent,
        createData,
        layers: LAYERS,
        maxFeatures: 600,
        maxVertices: 3000,
        refreshOnMoveEnd: true,
    });
    const row = selected && sourceCurrent() && selected[2] > Date.now() / 1000 - 86400 ? selected : null;
    useEffect(() => {
        onInteractionChange(!!row);
        return () => onInteractionChange(false);
    }, [row, onInteractionChange]);
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !eligible) return;
        const click = (event: mapboxgl.MapMouseEvent) => {
            if (!interactive.current || !sourceCurrent() || event.originalEvent.defaultPrevented) return;
            const layers = [ASCAT_LINES, ASCAT_CALM].filter((name) => !!map.getLayer(name));
            if (!layers.length) return;
            const { x, y } = event.point;
            const feature = map
                .queryRenderedFeatures(
                    [
                        [x - 22, y - 22],
                        [x + 22, y + 22],
                    ],
                    { layers },
                )
                .find((f) => f.source === ASCAT_SOURCE && Number.isInteger(f.properties?.row));
            const candidate = feature ? shown.current[Number(feature.properties?.row)] : null;
            if (candidate && candidate[2] > Date.now() / 1000 - 86400) {
                event.preventDefault();
                event.originalEvent.preventDefault();
                setSelected(candidate);
            }
        };
        map.on('click', click);
        return () => {
            map.off('click', click);
        };
    }, [eligible, sourceCurrent, mapRef]);
    const hasFresh = view?.rows.some((value) => value[2] > clock / 1000 - 86400) === true;
    const citation = session?.isCurrent()
        ? ASCAT_CREDIT.replace('© EUMETSAT;', `© ${session.index.copyright};`)
        : ASCAT_CREDIT;
    const credit = useMemo<AtmosCredit | null>(() => {
        if (vector === 'stuck-visible')
            return {
                key: 'ascat',
                title: 'Satellite wind',
                warning: true,
                text: `A prior satellite layer may remain visible; removal could not be verified. Do not rely on it. ${citation}`,
            };
        if (!eligible) return null;
        const status =
            phase === 'zoom'
                ? 'Zoom in: at most nine tiles per view.'
                : phase === 'gap' || (phase === 'ready' && !hasFresh)
                  ? 'No qualified pass in this view. Swath gaps stay empty.'
                  : phase === 'ready' && vector === 'ready'
                    ? 'Ready.'
                    : phase === 'loading'
                      ? 'Loading.'
                      : 'Unavailable; toggle off and on to check again.';
        return {
            key: 'ascat',
            title: 'Satellite wind',
            warning: phase !== 'ready' || !hasFresh || vector !== 'ready',
            text: `${status} Last 24 hours of original UTC observations. 12.5 km sampling, 25 km effective resolution; up to 600 actual viewport vectors. Arrows point downwind, circles are zero wind. Stress-equivalent 10 m retrievals; distinct from buoy measurements. No routing or automatic model choice. ${citation}`,
        };
    }, [eligible, phase, vector, hasFresh, citation]);
    useEffect(() => {
        onCredit(credit);
    }, [credit, onCredit]);
    useEffect(() => () => onCredit(null), [onCredit]);
    const source = row && session?.isCurrent() ? session.index.sources[row[5]] : null;
    return row && source ? (
        <ModalSheet
            isOpen
            onClose={() => setSelected(null)}
            title="Satellite wind"
            fitViewport
            maxWidth="max-w-md"
            footer={
                <button
                    className="min-h-11 w-full rounded-xl border border-white/15 py-2 text-sm text-white"
                    onClick={() => setSelected(null)}
                    aria-label="Close satellite wind"
                >
                    Close
                </button>
            }
        >
            <div className="space-y-3 break-words text-xs text-slate-300">
                <p className="font-semibold text-rose-300">
                    Satellite {(row[3] * 1.9438444924406).toFixed(0)} kt{' '}
                    {row[3] === 0 ? '· zero wind' : ascatCompass(row[4])} · {ascatAge(row[2])}
                </p>
                <p>
                    Observed {new Date(row[2] * 1000).toISOString().replace('T', ' ').slice(0, 19)} UTC · Metop-
                    {source.dataset === 'osisaf_ascat_b_coa' ? 'B' : 'C'}.
                </p>
                <p>
                    Forecast comparison unavailable: no qualified forecast captured before this observation is attached.
                </p>
                <p>
                    Stress-equivalent 10 m wind, effective resolution 25 km (12.5 km sampling). Quality-screened
                    satellite retrieval; this is not a buoy or your boat's wind measurement. Nearby coast, rain and
                    unresolved cells can differ. Gaps are not filled.
                </p>
                <p>{citation}</p>
            </div>
        </ModalSheet>
    ) : null;
}
