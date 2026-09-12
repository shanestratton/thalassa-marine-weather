import React, { useCallback, useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { OverlayPortal } from '../ui/OverlayPortal';
import { usePaneScope } from '../../context/PanePortalContext';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useKeyboardOffset } from '../../hooks/useKeyboardOffset';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
import {
    calculateAutoroutingTrial,
    getAutoroutingTrialStatus,
    type AutoroutingTrialRoute,
    type AutoroutingTrialStatus,
} from '../../services/autoroutingTrial';
import { AUTOROUTING_TRIAL_MAX_DRAFT_M, AUTOROUTING_TRIAL_MAX_SPEED_KTS } from '../../types/autorouting';
import { formatLatDegMin, formatLonDegMin } from '../../utils/formatDegMin';

export interface AutoroutingTrialWorkspaceProps {
    onClose: () => void;
    mapboxToken: string;
    /** Read-only opening snapshots, never selected endpoints or a live vessel position. */
    initialCenter?: { lat: number; lon: number };
    initialDraftM?: number;
    initialSpeedKts?: number;
}
type Endpoint = 'departure' | 'destination';
type PositionInput = { lat: string; lon: string };
const emptyPosition = (): PositionInput => ({ lat: '', lon: '' });
const point = ({ lat, lon }: PositionInput) =>
    lat.trim() &&
    lon.trim() &&
    Number.isFinite(+lat) &&
    Number.isFinite(+lon) &&
    Math.abs(+lat) <= 90 &&
    Math.abs(+lon) <= 180
        ? { lat: +lat, lon: +lon }
        : null;
const inputClass = 'w-full min-w-0 rounded-lg border border-white/15 bg-slate-900 p-2 text-sm text-white';
const buttonClass = 'min-h-11 rounded-xl border border-white/15 px-3 text-sm font-bold disabled:opacity-40';

/** Deliberately no route-store, GPS, handoff or navigation imports: this draft dies on close. */
export function AutoroutingTrialWorkspace({
    onClose,
    mapboxToken,
    initialCenter,
    initialDraftM,
    initialSpeedKts,
}: AutoroutingTrialWorkspaceProps) {
    const pane = usePaneScope();
    const keyboardHeight = useKeyboardOffset(!pane);
    const closeRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useFocusTrap<HTMLDivElement>(true, { onEscape: onClose, initialFocusRef: closeRef });
    const container = useRef<HTMLDivElement>(null);
    const mapRef = useRef<mapboxgl.Map | null>(null);
    const proposalBounds = useRef<mapboxgl.LngLatBounds | null>(null);
    const openingCenter = useRef(initialCenter ? { ...initialCenter } : undefined);
    const openingToken = useRef(mapboxToken);
    const [mapReady, setMapReady] = useState(false);
    const [mapError, setMapError] = useState('');
    const [status, setStatus] = useState<AutoroutingTrialStatus | null>(null);
    const [departure, setDeparture] = useState(emptyPosition);
    const [destination, setDestination] = useState(emptyPosition);
    const [target, setTarget] = useState<Endpoint>('departure');
    const [draft, setDraft] = useState(() =>
        initialDraftM && initialDraftM > 0 && initialDraftM <= AUTOROUTING_TRIAL_MAX_DRAFT_M
            ? String(+initialDraftM.toFixed(3))
            : '',
    );
    const [speed, setSpeed] = useState(() =>
        initialSpeedKts && initialSpeedKts > 0 && initialSpeedKts <= AUTOROUTING_TRIAL_MAX_SPEED_KTS
            ? String(initialSpeedKts)
            : '',
    );
    const [proposal, setProposal] = useState<AutoroutingTrialRoute | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const pending = useRef<AbortController | null>(null);
    const invalidate = useCallback(() => {
        pending.current?.abort();
        pending.current = null;
        setBusy(false);
        setProposal(null);
        setError('');
    }, []);
    const selectPoint = useRef((_lat: number, _lon: number) => {});
    selectPoint.current = (lat, lon) => {
        invalidate();
        (target === 'departure' ? setDeparture : setDestination)({ lat: lat.toFixed(6), lon: lon.toFixed(6) });
        setTarget('destination');
    };

    useEffect(() => {
        const controller = new AbortController();
        const scope = getAuthIdentityScope();
        const unsubscribe = subscribeAuthIdentityScope(() => {
            controller.abort();
            invalidate();
            setDeparture(emptyPosition());
            setDestination(emptyPosition());
            setDraft('');
            setSpeed('');
            setStatus(null);
            onClose();
        });
        void getAutoroutingTrialStatus(controller.signal)
            .then((next) => {
                if (!controller.signal.aborted && isAuthIdentityScopeCurrent(scope)) setStatus(next);
            })
            .catch(() => {});
        return () => {
            controller.abort();
            pending.current?.abort();
            unsubscribe();
        };
    }, [invalidate, onClose]);

    // One Mapbox instance per open workspace; edits update only its GeoJSON source.
    useEffect(() => {
        const token = openingToken.current;
        if (!container.current || !token) {
            setMapError('Chart unavailable: Mapbox is not configured.');
            return;
        }
        let map: mapboxgl.Map;
        const daylight = document.documentElement.classList.contains('display-light');
        const center = openingCenter.current;
        const validCenter =
            center &&
            Number.isFinite(center.lat) &&
            Number.isFinite(center.lon) &&
            Math.abs(center.lat) <= 90 &&
            Math.abs(center.lon) <= 180;
        try {
            map = new mapboxgl.Map({
                container: container.current,
                accessToken: token,
                style: daylight ? 'mapbox://styles/mapbox/light-v11' : 'mapbox://styles/mapbox/satellite-streets-v12',
                center: validCenter ? [center.lon, center.lat] : [0, 15],
                zoom: validCenter ? 10 : 1,
                dragRotate: false,
                attributionControl: false,
                projection: 'mercator',
                maxTileCacheSize: 20,
            });
        } catch {
            setMapError('Chart unavailable on this device.');
            return;
        }
        mapRef.current = map;
        map.touchZoomRotate.disableRotation();
        map.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-right');
        map.on('load', () => {
            if (daylight) {
                // Same lightweight Ocean raster as the main chart; no ENC engine or shared map state.
                map.addSource('trial-ocean', {
                    type: 'raster',
                    tiles: ['https://api.maptiler.com/maps/ocean/{z}/{x}/{y}.png?key=3misfI2jeOYbJqgl5a6e'],
                    tileSize: 512,
                    maxzoom: 16,
                    attribution:
                        '&copy; <a href="https://www.maptiler.com/copyright/" target="_blank" rel="noopener noreferrer">MapTiler</a> &copy; OpenStreetMap contributors',
                });
                map.addLayer(
                    { id: 'trial-ocean', type: 'raster', source: 'trial-ocean', paint: { 'raster-fade-duration': 0 } },
                    map.getStyle()?.layers?.find((layer) => layer.type === 'symbol')?.id,
                );
            }
            map.addSource('trial', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
            map.addLayer({
                id: 'trial-route',
                type: 'line',
                source: 'trial',
                filter: ['==', '$type', 'LineString'],
                paint: { 'line-color': '#2dd4bf', 'line-width': 4, 'line-dasharray': [2, 1] },
            });
            map.addLayer({
                id: 'trial-endpoints',
                type: 'circle',
                source: 'trial',
                filter: ['==', '$type', 'Point'],
                paint: {
                    'circle-radius': 8,
                    'circle-color': ['match', ['get', 'endpoint'], 'departure', '#34d399', '#c084fc'],
                    'circle-stroke-width': 2,
                    'circle-stroke-color': '#ffffff',
                },
            });
            setMapReady(true);
        });
        map.on('click', (event) => selectPoint.current(event.lngLat.lat, event.lngLat.wrap().lng));
        map.on('error', () =>
            setMapError('Some chart detail could not load. Check your connection; this is not a navigation chart.'),
        );
        const resize = new ResizeObserver(() => {
            map.resize();
            // Warnings and the keyboard can shrink the chart after a proposal
            // arrives. Keep its whole geometry visible in that new viewport.
            if (proposalBounds.current) map.fitBounds(proposalBounds.current, { padding: 40, duration: 0 });
        });
        resize.observe(container.current);
        return () => {
            resize.disconnect();
            mapRef.current = null;
            map.remove();
        };
    }, []);

    const start = point(departure);
    const end = point(destination);
    const valid =
        start &&
        end &&
        (start.lat !== end.lat || start.lon !== end.lon) &&
        +draft > 0 &&
        +draft <= AUTOROUTING_TRIAL_MAX_DRAFT_M &&
        +speed > 0 &&
        +speed <= AUTOROUTING_TRIAL_MAX_SPEED_KTS;
    useEffect(() => {
        const source = mapRef.current?.getSource('trial') as mapboxgl.GeoJSONSource | undefined;
        if (!mapReady || !source) return;
        const features: GeoJSON.Feature[] = [];
        for (const [endpoint, input] of [
            ['departure', departure],
            ['destination', destination],
        ] as const) {
            const p = point(input);
            if (p)
                features.push({
                    type: 'Feature',
                    properties: { endpoint },
                    geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
                });
        }
        if (proposal)
            features.push({
                type: 'Feature',
                properties: {},
                geometry: { type: 'LineString', coordinates: proposal.coordinates },
            });
        source.setData({ type: 'FeatureCollection', features });
        proposalBounds.current = null;
        if (proposal) {
            const bounds = new mapboxgl.LngLatBounds();
            for (const coordinate of proposal.coordinates) bounds.extend(coordinate);
            proposalBounds.current = bounds;
            mapRef.current?.fitBounds(bounds, { padding: 40, duration: 0 });
        }
    }, [mapReady, departure, destination, proposal]);

    const calculate = async () => {
        if (!valid || !start || !end || !status?.ready || busy || pending.current) return;
        invalidate();
        const controller = new AbortController();
        const scope = getAuthIdentityScope();
        pending.current = controller;
        setBusy(true);
        try {
            const route = await calculateAutoroutingTrial(
                { departure: start, destination: end, draftM: +draft, speedKts: +speed },
                controller.signal,
            );
            if (!controller.signal.aborted && isAuthIdentityScopeCurrent(scope)) setProposal(route);
        } catch (failure) {
            if (!controller.signal.aborted && isAuthIdentityScopeCurrent(scope))
                setError(failure instanceof Error ? failure.message : 'Trial calculation failed.');
        } finally {
            if (pending.current === controller) {
                pending.current = null;
                setBusy(false);
            }
        }
    };
    const clear = () => {
        invalidate();
        setDeparture(emptyPosition());
        setDestination(emptyPosition());
        setDraft('');
        setSpeed('');
        setTarget('departure');
    };
    return (
        <OverlayPortal
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Autorouting trial"
            className="flex flex-col overflow-hidden bg-slate-950 text-white"
            style={{
                paddingTop: pane ? 0 : 'env(safe-area-inset-top)',
                paddingBottom: pane ? 0 : 'env(safe-area-inset-bottom)',
                bottom: pane ? undefined : keyboardHeight,
            }}
        >
            <header className="shrink-0 border-b border-white/10 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                    <h2 className="ui-dialog-title">Autorouting · Trial</h2>
                    <button
                        ref={closeRef}
                        type="button"
                        onClick={onClose}
                        className={buttonClass}
                        aria-label="Close autorouting trial"
                    >
                        Close
                    </button>
                </div>
                <p className="text-micro font-semibold text-amber-300">Not for navigation. Unsaved proposal only.</p>
            </header>
            <div className="relative min-h-32 flex-1">
                <div
                    ref={container}
                    role="region"
                    aria-label="Trial chart — tap to set selected endpoint"
                    className="absolute inset-0"
                    // Mapbox's unlayered relative-position rule otherwise beats Tailwind's absolute utility.
                    style={{ position: 'absolute', inset: 0 }}
                />
                <div className="absolute right-2 top-2 flex flex-col gap-1">
                    <button
                        type="button"
                        aria-label="Zoom trial chart in"
                        onClick={() => mapRef.current?.zoomIn()}
                        className={`${buttonClass} bg-slate-900 text-white`}
                    >
                        +
                    </button>
                    <button
                        type="button"
                        aria-label="Zoom trial chart out"
                        onClick={() => mapRef.current?.zoomOut()}
                        className={`${buttonClass} bg-slate-900 text-white`}
                    >
                        −
                    </button>
                </div>
            </div>
            {/* Keep the scroller nested: the legacy pane sheet rule expands
                direct-child scrollers to pane-height minus 2rem, displacing this chart/header. */}
            <div className="flex min-h-0 max-h-[55%] shrink-0 flex-col">
                <div className="min-h-0 overflow-y-auto overscroll-contain border-t border-white/10 p-3 space-y-3">
                    <p className="text-micro text-gray-400">
                        Tap the chart to set {target}. Basemap is not a nautical chart.
                    </p>
                    {mapError && (
                        <p role="status" className="text-micro text-amber-300">
                            {mapError}
                        </p>
                    )}
                    <div className="grid grid-cols-2 gap-2">
                        {(['departure', 'destination'] as const).map((name) => {
                            const position = name === 'departure' ? start : end;
                            return (
                                <button
                                    type="button"
                                    key={name}
                                    aria-pressed={target === name}
                                    onClick={() => setTarget(name)}
                                    className={`${buttonClass} min-w-0 py-2 text-left ${target === name ? 'border-teal-400 bg-teal-500/10' : ''}`}
                                >
                                    <span className="block capitalize">{name}</span>
                                    <span className="block text-micro font-normal">
                                        {position ? (
                                            <>
                                                <span className="block whitespace-nowrap tabular-nums">
                                                    {formatLatDegMin(position.lat)}
                                                </span>{' '}
                                                <span className="block whitespace-nowrap tabular-nums">
                                                    {formatLonDegMin(position.lon)}
                                                </span>
                                            </>
                                        ) : (
                                            'Tap chart or enter below'
                                        )}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                    <details>
                        <summary className="min-h-11 cursor-pointer content-center text-sm">Enter coordinates</summary>
                        <div className="grid grid-cols-2 gap-2">
                            {(['departure', 'destination'] as const).map((name) => (
                                <fieldset key={name} className="min-w-0 space-y-2">
                                    <legend className="text-micro capitalize">{name}</legend>
                                    {(['lat', 'lon'] as const).map((axis) => (
                                        <label key={axis} className="block text-micro">
                                            {axis === 'lat' ? 'Latitude' : 'Longitude'}
                                            <input
                                                type="number"
                                                step="any"
                                                min={axis === 'lat' ? -90 : -180}
                                                max={axis === 'lat' ? 90 : 180}
                                                aria-label={`${name} ${axis === 'lat' ? 'latitude' : 'longitude'}`}
                                                value={(name === 'departure' ? departure : destination)[axis]}
                                                onChange={(event) => {
                                                    invalidate();
                                                    (name === 'departure' ? setDeparture : setDestination)(
                                                        (previous) => ({
                                                            ...previous,
                                                            [axis]: event.target.value,
                                                        }),
                                                    );
                                                }}
                                                className={inputClass}
                                            />
                                        </label>
                                    ))}
                                </fieldset>
                            ))}
                        </div>
                    </details>
                    <div className="grid grid-cols-2 gap-2">
                        <label className="text-micro">
                            Draft (m)
                            <input
                                aria-label="Trial vessel draft in metres"
                                type="number"
                                min="0"
                                max={AUTOROUTING_TRIAL_MAX_DRAFT_M}
                                step="any"
                                value={draft}
                                onChange={(event) => {
                                    invalidate();
                                    setDraft(event.target.value);
                                }}
                                className={inputClass}
                            />
                        </label>
                        <label className="text-micro">
                            Cruising speed (kn)
                            <input
                                aria-label="Trial cruising speed in knots"
                                type="number"
                                min="0"
                                max={AUTOROUTING_TRIAL_MAX_SPEED_KTS}
                                step="any"
                                value={speed}
                                onChange={(event) => {
                                    invalidate();
                                    setSpeed(event.target.value);
                                }}
                                className={inputClass}
                            />
                        </label>
                    </div>
                    <p className="text-micro text-amber-300">
                        Check draft and speed. Requested clearance: 0.5 m; air draft and beam are not checked.
                    </p>
                    <p className="text-micro text-gray-400">
                        Trial departure: leaving now. The scheduled departure on Planning home is not used.
                    </p>
                    {!status?.ready && (
                        <p role="status" className="text-micro text-amber-300">
                            {status?.message ||
                                (status ? 'Trial calculation is not available.' : 'Checking trial availability…')}
                        </p>
                    )}
                    {error && (
                        <p role="alert" className="text-sm text-red-300">
                            {error}
                        </p>
                    )}
                    {proposal && (
                        <section aria-label="Trial proposal" className="space-y-1 text-micro">
                            <p className="font-bold text-teal-300">SevenCs proposal · not saved or activated</p>
                            {proposal.warnings.map((warning, index) => (
                                <p key={index} className="text-amber-300">
                                    {warning}
                                </p>
                            ))}
                        </section>
                    )}
                    <div className="grid grid-cols-[1fr_auto] gap-2">
                        <button
                            type="button"
                            onClick={() => void calculate()}
                            disabled={!valid || !status?.ready || !mapReady || busy}
                            className={`${buttonClass} bg-teal-600 text-white`}
                        >
                            {busy ? 'Calculating…' : 'Calculate trial route'}
                        </button>
                        <button type="button" onClick={clear} className={buttonClass}>
                            Clear
                        </button>
                    </div>
                </div>
            </div>
        </OverlayPortal>
    );
}
