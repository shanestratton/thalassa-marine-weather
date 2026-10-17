import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type mapboxgl from 'mapbox-gl';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
import { useSettingsStore } from '../../stores/settingsStore';
import {
    OPTICAL_LIMITS,
    OPTICAL_WARNING,
    type OpticalFlash,
} from '../../services/weather/api/opticalLightningContract';
import { openOpticalSession, type OpticalSession } from '../../services/weather/api/opticalLightningSession';
import { useOwnedGeoJsonOverlay, type OwnedGeoJsonOverlayOptions } from './useOwnedGeoJsonOverlay';
import type { AtmosCredit } from './atmosPresentation';
const LAYERS: OwnedGeoJsonOverlayOptions['layers'] = [
    {
        suffix: 'centroids',
        specification: {
            type: 'symbol',
            layout: { 'text-field': '◇', 'text-size': 14, 'text-allow-overlap': true },
            paint: { 'text-color': '#c4b5fd', 'text-halo-color': '#0f172a', 'text-halo-width': 1 },
        },
    },
];
export default function OpticalLightningLayer({
    mapRef,
    mapReady,
    active,
    onCredit,
}: {
    mapRef: MutableRefObject<mapboxgl.Map | null>;
    mapReady: boolean;
    active: boolean;
    onCredit: (credit: AtmosCredit | null) => void;
}) {
    const [snapshot, setSnapshot] = useState<{
        session: OpticalSession;
        rows: OpticalFlash[];
        revision: number;
        truncated: boolean;
    } | null>(null);
    const [phase, setPhase] = useState('Unavailable'),
        [clock, setClock] = useState(Date.now);
    const owner = useRef<OpticalSession | null>(null);
    useEffect(() => {
        const map = mapRef.current;
        if (!active || !mapReady || !map || document.visibilityState === 'hidden' || !navigator.onLine) return;
        const scope = getAuthIdentityScope(),
            abort = new AbortController();
        let acquired: OpticalSession | null = null,
            epoch = 0,
            expiry: ReturnType<typeof setTimeout> | undefined;
        const retire = () => {
            abort.abort();
            acquired?.close();
            owner.current = null;
            setSnapshot(null);
            setPhase('Unavailable; toggle off and on to check again');
        };
        const foreground = () => {
            if (document.visibilityState === 'hidden' || !navigator.onLine) retire();
        };
        const off = subscribeAuthIdentityScope(retire),
            settings = useSettingsStore.subscribe(retire);
        document.addEventListener('visibilitychange', foreground);
        window.addEventListener('offline', foreground);
        const refresh = () => {
            const bounds = map.getBounds(),
                revision = ++epoch;
            setSnapshot(null);
            if (!acquired?.isCurrent() || !bounds) return;
            if (map.getZoom() < 4) {
                setPhase('Zoom in for optical flashes');
                return;
            }
            setPhase('Loading');
            void acquired
                .readViewport([bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()])
                .then((value) => {
                    if (abort.signal.aborted || revision !== epoch || !acquired?.isCurrent()) return;
                    setSnapshot({ session: acquired, ...value });
                    setClock(Date.now());
                    setPhase(value.rows.length ? 'Ready' : 'No qualified observations here; gaps are unknown');
                })
                .catch(() => {
                    if (!abort.signal.aborted && revision === epoch) {
                        setSnapshot(null);
                        setPhase('Unavailable or zoom in; gaps are unknown');
                    }
                });
        };
        setPhase('Loading');
        void openOpticalSession(
            abort.signal,
            () =>
                !abort.signal.aborted &&
                isAuthIdentityScopeCurrent(scope) &&
                document.visibilityState !== 'hidden' &&
                navigator.onLine,
        )
            .then((session) => {
                acquired = session;
                if (abort.signal.aborted || !session.isCurrent()) {
                    session.close();
                    return;
                }
                owner.current = session;
                expiry = setTimeout(retire, Math.max(0, session.index.expiresAt - Date.now()));
                refresh();
                map.on('moveend', refresh);
            })
            .catch(() => {
                if (!abort.signal.aborted) setPhase('Unavailable; original source admission is pending');
            });
        return () => {
            epoch++;
            abort.abort();
            off();
            settings();
            clearTimeout(expiry);
            map.off('moveend', refresh);
            document.removeEventListener('visibilitychange', foreground);
            window.removeEventListener('offline', foreground);
            acquired?.close();
            owner.current = null;
            setSnapshot(null);
        };
    }, [active, mapReady, mapRef]);
    const current = useCallback(
        () =>
            active &&
            document.visibilityState !== 'hidden' &&
            navigator.onLine &&
            !!snapshot &&
            snapshot.session === owner.current &&
            snapshot.session.isCurrent(),
        [active, snapshot],
    );
    useEffect(() => {
        if (!snapshot) return;
        const times = snapshot.rows.map((r) => r[2] + OPTICAL_LIMITS.age).filter((t) => t > clock);
        const next = Math.min(...times);
        if (!Number.isFinite(next)) return;
        const timer = setTimeout(() => setClock(Date.now()), Math.max(0, next - Date.now()));
        return () => clearTimeout(timer);
    }, [snapshot, clock]);
    const createData = useCallback(
        (): GeoJSON.FeatureCollection => ({
            type: 'FeatureCollection',
            features: current()
                ? snapshot!.rows
                      .filter((r) => r[2] + OPTICAL_LIMITS.age > Date.now() && Math.abs(r[1]) <= 85.05112878)
                      .map((r) => ({
                          type: 'Feature',
                          geometry: { type: 'Point', coordinates: [r[0], r[1]] },
                          properties: { kind: 'optical-flash', originalAt: r[2] },
                      }))
                : [],
        }),
        [current, snapshot],
    );
    const status = useOwnedGeoJsonOverlay(mapRef, mapReady, {
        namespace: 'optical-lightning142',
        label: 'Satellite optical flashes',
        credit: 'NOAA GLM / EUMETSAT LI',
        enabled: active,
        owner: snapshot,
        revision: `${snapshot?.revision ?? 0}:${clock}`,
        sourceCurrent: current,
        createData,
        layers: LAYERS,
        maxFeatures: 600,
        maxVertices: 600,
    });
    const credit = useMemo<AtmosCredit | null>(() => {
        if (!active && status !== 'stuck-visible') return null;
        const source = snapshot?.session.isCurrent() ? snapshot.session.index.sources : [];
        const names = [
            ...new Set(source.map((s) => `${s.provider === 'noaa-glm' ? 'NOAA GLM' : 'EUMETSAT LI'} ${s.platform}`)),
        ].join('; ');
        const end = source.length
            ? new Date(Math.max(...source.map((s) => s.observedEnd))).toISOString().slice(11, 19)
            : null;
        const count = snapshot?.rows.filter((row) => row[2] + OPTICAL_LIMITS.age > clock).length ?? 0;
        return {
            key: 'optical-lightning',
            title: 'Satellite optical flashes',
            warning: true,
            text: `${status === 'stuck-visible' ? 'Prior optical layer removal could not be verified' : phase === 'Ready' ? `${count} displayed optical centroids` : phase}. ${names}${end ? `; original window ends ${end} UTC` : ''}. ${snapshot?.truncated ? 'Display capped; additional flashes omitted. ' : ''}${OPTICAL_WARNING} Coverage is limited to original regional products; Australia has no assumed coverage. Overlapping instruments can show the same physical flash twice. Provider QC reduces false detections without guaranteeing accuracy.`,
        };
    }, [active, status, snapshot, phase, clock]);
    useEffect(() => onCredit(credit), [credit, onCredit]);
    useEffect(() => () => onCredit(null), [onCredit]);
    return null;
}
