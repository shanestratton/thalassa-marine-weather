import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type mapboxgl from 'mapbox-gl';
import { openWeatherEvidenceSession, type WeatherEvidenceSession } from '../../services/weather/evidenceSession';
import type { MeasuredBuoyDetail } from '../../services/weather/evidenceContract';
import {
    BUOY_CREDIT,
    BUOY_LAYER_POINTS,
    BUOY_LAYER_SOURCE,
    thinnedBuoyStations,
} from '../../services/weather/buoyPresentation';
import { useOwnedGeoJsonOverlay, type OwnedGeoJsonOverlayOptions } from './useOwnedGeoJsonOverlay';
import type { AtmosCredit } from './atmosPresentation';
import BuoyCard from './BuoyCard';
const LAYERS: OwnedGeoJsonOverlayOptions['layers'] = [
    {
        suffix: 'points',
        specification: {
            type: 'symbol',
            layout: { 'text-field': '●', 'text-size': 18, 'text-allow-overlap': true, 'text-ignore-placement': true },
            paint: { 'text-color': '#22d3ee', 'text-halo-color': '#0f172a', 'text-halo-width': 2 },
        },
    },
];
/** Caller opt-in only. No polling, camera motion, background receiver or navigation inputs. */
export default function MeasuredBuoysLayer({
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
    const [session, setSession] = useState<WeatherEvidenceSession | null>(null);
    const [phase, setPhase] = useState('loading');
    const [clock, setClock] = useState(() => Date.now());
    const [selected, setSelected] = useState<string | null>(null);
    const [detail, setDetail] = useState<MeasuredBuoyDetail | null>(null);
    const [message, setMessage] = useState('');
    const latestInteract = useRef(canInteract);
    latestInteract.current = canInteract;
    useEffect(() => {
        const changed = () => setForeground(document.visibilityState !== 'hidden');
        document.addEventListener('visibilitychange', changed);
        return () => document.removeEventListener('visibilitychange', changed);
    }, []);
    const eligible = active && foreground;
    useEffect(() => {
        if (!eligible || !mapReady) return;
        const abort = new AbortController();
        const opened = Date.now();
        let acquired: WeatherEvidenceSession | null = null;
        let expiry: ReturnType<typeof setTimeout> | undefined;
        setPhase('loading');
        setSelected(null);
        setDetail(null);
        void openWeatherEvidenceSession(
            'buoys',
            abort.signal,
            () => !abort.signal.aborted && document.visibilityState !== 'hidden',
        )
            .then((value) => {
                acquired = value;
                if (abort.signal.aborted || !value.isCurrent()) {
                    value.close();
                    return;
                }
                setSession(value);
                setClock(Date.now());
                setPhase('ready');
                expiry = setTimeout(
                    () => {
                        value.close();
                        setSession(null);
                        setSelected(null);
                        setDetail(null);
                        setPhase('expired; toggle off and on to check again');
                    },
                    Math.max(0, Math.min(value.index.expiresAt * 1000, opened + 15 * 60_000) - Date.now()),
                );
            })
            .catch(() => {
                if (!abort.signal.aborted) setPhase('unavailable; toggle off and on to retry');
            });
        return () => {
            abort.abort();
            acquired?.close();
            clearTimeout(expiry);
            setSession(null);
            setSelected(null);
            setDetail(null);
        };
    }, [eligible, mapReady]);
    const sourceCurrent = useCallback(
        () => eligible && document.visibilityState !== 'hidden' && session?.isCurrent() === true,
        [eligible, session],
    );
    const index = sourceCurrent() ? session!.index : null;
    useEffect(() => {
        if (!index) return;
        const next = Math.min(
            ...index.stations.filter((row) => row.expiresAt * 1000 > clock).map((row) => row.expiresAt * 1000),
        );
        if (!Number.isFinite(next)) return;
        const timer = setTimeout(() => setClock(Date.now()), Math.max(0, next - Date.now()));
        return () => clearTimeout(timer);
    }, [index, clock]);
    const createData = useCallback(
        (map: mapboxgl.Map): GeoJSON.FeatureCollection => {
            if (!index || !sourceCurrent()) return { type: 'FeatureCollection', features: [] };
            const container = map.getContainer();
            const centre = map.getCenter();
            const selected = thinnedBuoyStations(
                index.stations,
                Date.now(),
                (station) =>
                    map.project([station.lon + 360 * Math.round((centre.lng - station.lon) / 360), station.lat]),
                container.clientWidth,
                container.clientHeight,
            );
            return {
                type: 'FeatureCollection',
                features: selected.map((row) => ({
                    type: 'Feature',
                    properties: { key: row.key },
                    geometry: { type: 'Point', coordinates: [row.lon, row.lat] },
                })),
            };
        },
        [index, sourceCurrent],
    );
    const vector = useOwnedGeoJsonOverlay(mapRef, mapReady, {
        namespace: 'measured-buoys141',
        label: 'Measured seas',
        credit: BUOY_CREDIT,
        enabled: eligible,
        owner: session,
        revision: `${index?.generation ?? 'none'}:${clock}`,
        sourceCurrent,
        createData,
        layers: LAYERS,
        maxFeatures: 64,
        maxVertices: 64,
        refreshOnMoveEnd: true,
    });
    const close = useCallback(() => setSelected(null), []);
    const station = sourceCurrent()
        ? index?.stations.find((row) => row.key === selected && Date.now() < row.expiresAt * 1000)
        : null;
    useEffect(() => {
        onInteractionChange(!!station);
        return () => onInteractionChange(false);
    }, [station, onInteractionChange]);
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !eligible || !index) return;
        const click = (event: mapboxgl.MapMouseEvent) => {
            if (
                !latestInteract.current ||
                !sourceCurrent() ||
                event.originalEvent.defaultPrevented ||
                !map.getLayer(BUOY_LAYER_POINTS)
            )
                return;
            const { x, y } = event.point;
            const features = map.queryRenderedFeatures(
                [
                    [x - 22, y - 22],
                    [x + 22, y + 22],
                ],
                { layers: [BUOY_LAYER_POINTS] },
            );
            const keys = new Set(features.filter((f) => f.source === BUOY_LAYER_SOURCE).map((f) => f.properties?.key));
            const candidates = index.stations.filter((row) => keys.has(row.key) && Date.now() < row.expiresAt * 1000);
            const centre = map.getCenter();
            const distance = (row: (typeof candidates)[number]) => {
                const p = map.project([row.lon + 360 * Math.round((centre.lng - row.lon) / 360), row.lat]);
                return Math.hypot(p.x - x, p.y - y);
            };
            candidates.sort((a, b) => distance(a) - distance(b) || a.key.localeCompare(b.key));
            if (candidates[0]) {
                event.preventDefault();
                setSelected(candidates[0].key);
            }
        };
        map.on('click', click);
        return () => {
            map.off('click', click);
        };
    }, [mapRef, eligible, index, sourceCurrent]);
    const stationKey = station?.key;
    useEffect(() => {
        setDetail(null);
        if (!session || !stationKey) return;
        const abort = new AbortController();
        setMessage('Loading original 72-hour samples…');
        void session
            .readStation(stationKey, abort.signal)
            .then((value) => {
                if (
                    abort.signal.aborted ||
                    !session.isCurrent() ||
                    !('measured' in value) ||
                    value.station.key !== stationKey ||
                    Date.now() >= value.station.expiresAt * 1000
                )
                    return;
                setDetail(value);
                setMessage('');
            })
            .catch(() => {
                if (!abort.signal.aborted) setMessage('Original station history is unavailable or expired.');
            });
        return () => abort.abort();
    }, [session, stationKey]);
    const credit = useMemo<AtmosCredit | null>(
        () =>
            vector === 'stuck-visible'
                ? {
                      key: 'measured-buoys',
                      title: 'Measured seas',
                      warning: true,
                      text: `Prior buoy marks may remain visible; removal or hiding could not be verified. Do not rely on them. ${BUOY_CREDIT}`,
                  }
                : !eligible
                  ? null
                  : {
                        key: 'measured-buoys',
                        title: 'Measured seas',
                        warning: phase !== 'ready' || vector !== 'ready',
                        text: `${phase === 'ready' && vector === 'ready' ? 'Measured buoy dots; tap a dot for 72-hour samples' : phase === 'ready' ? `Map ${vector}` : phase}. Up to 64 viewport dots; zoom for stations hidden by thinning. Coverage is partial; missing dots do not mean calm seas. ${BUOY_CREDIT}`,
                    },
        [eligible, phase, vector],
    );
    useEffect(() => {
        onCredit(credit);
    }, [credit, onCredit]);
    useEffect(() => () => onCredit(null), [onCredit]);
    return station && eligible ? (
        <BuoyCard
            station={station}
            detail={detail?.station.key === station.key ? detail : null}
            message={message}
            onClose={close}
        />
    ) : null;
}
