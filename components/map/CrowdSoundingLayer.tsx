import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type mapboxgl from 'mapbox-gl';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
import { useSettingsStore } from '../../stores/settingsStore';
import { CROWD_MAP_LABEL, readCrowdViewport } from '../../services/seabed/crowdMap';
import type { AtmosCredit } from './atmosPresentation';
import { useOwnedGeoJsonOverlay, type OwnedGeoJsonOverlayOptions } from './useOwnedGeoJsonOverlay';

type Lease = Awaited<ReturnType<typeof readCrowdViewport>>;
const layers: OwnedGeoJsonOverlayOptions['layers'] = [
    {
        suffix: 'contours',
        specification: {
            type: 'line',
            paint: { 'line-color': '#fbbf24', 'line-width': 1.25, 'line-opacity': 0.8, 'line-dasharray': [2, 2] },
        },
    },
    {
        suffix: 'depths',
        specification: {
            type: 'symbol',
            layout: {
                'symbol-placement': 'line',
                'text-field': ['concat', ['to-string', ['get', 'depthM']], ' m*'],
                'text-size': 10,
            },
            paint: { 'text-color': '#fef3c7', 'text-halo-color': '#0f172a', 'text-halo-width': 1 },
        },
    },
];
/** Optional historical reference. No geometry is published to a route/depth/watch store. */
export default function CrowdSoundingLayer({
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
    const [lease, setLease] = useState<Lease | null>(null),
        [phase, setPhase] = useState('Unavailable');
    const owned = useRef<Lease | null>(null),
        epoch = useRef(0);
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || !active) return;
        const scope = getAuthIdentityScope();
        let closed = false,
            request: AbortController | null = null;
        const retire = () => {
            ++epoch.current;
            request?.abort();
            owned.current?.release();
            owned.current = null;
            setLease(null);
        };
        const refresh = () => {
            retire();
            if (closed || document.hidden || !navigator.onLine || !isAuthIdentityScopeCurrent(scope)) return;
            const bounds = map.getBounds();
            if (!bounds || map.getZoom() < 10) {
                setPhase('Zoom in to view qualified cells');
                return;
            }
            const turn = epoch.current,
                abort = new AbortController();
            request = abort;
            setPhase('Loading');
            void readCrowdViewport(
                [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
                abort.signal,
                () => !closed && !document.hidden && epoch.current === turn && isAuthIdentityScopeCurrent(scope),
            )
                .then((result) => {
                    if (closed || epoch.current !== turn || !result.isCurrent()) {
                        result.release();
                        return;
                    }
                    owned.current = result;
                    setLease(result);
                    setPhase(result.data.features.length ? 'Qualified historical cells' : 'No qualified cells here');
                })
                .catch(() => {
                    if (!closed && epoch.current === turn) setPhase('Unavailable');
                });
        };
        const identityRetired = () => {
            retire();
            setPhase('Unavailable after account change');
        };
        const unsubscribeAuth = subscribeAuthIdentityScope(identityRetired),
            unsubscribeNetwork = useSettingsStore.subscribe((state, previous) => {
                if (state.settings.satelliteMode !== previous.settings.satelliteMode) refresh();
            });
        map.on('moveend', refresh);
        document.addEventListener('visibilitychange', refresh);
        window.addEventListener('online', refresh);
        window.addEventListener('offline', refresh);
        const timer = setInterval(() => {
            if (owned.current && !owned.current.isCurrent()) {
                retire();
                setPhase('Expired or unavailable');
            }
        }, 1000);
        refresh();
        return () => {
            closed = true;
            retire();
            clearInterval(timer);
            unsubscribeAuth();
            unsubscribeNetwork();
            map.off('moveend', refresh);
            document.removeEventListener('visibilitychange', refresh);
            window.removeEventListener('online', refresh);
            window.removeEventListener('offline', refresh);
        };
    }, [active, mapReady, mapRef]);
    const current = useCallback(() => !!lease && active && !document.hidden && lease.isCurrent(), [lease, active]);
    const createData = useCallback((): GeoJSON.FeatureCollection => {
        if (!lease || !current()) throw Error('Crowd source retired');
        return lease.data;
    }, [lease, current]);
    const status = useOwnedGeoJsonOverlay(mapRef, mapReady, {
        namespace: 'crowd-soundings',
        label: CROWD_MAP_LABEL,
        credit: 'Contributors · CC0 1.0',
        enabled: active,
        owner: lease,
        revision: lease?.index.generation ?? 'none',
        sourceCurrent: current,
        createData,
        layers,
        maxFeatures: 512,
        maxVertices: 1024,
    });
    const credit = useMemo<AtmosCredit | null>(() => {
        if (!active && status !== 'stuck-visible') return null;
        const days = lease?.index.utcDayRange
            .map((day) => new Date(day * 86400000).toISOString().slice(0, 10))
            .join(' to ');
        return {
            key: 'crowd-soundings',
            title: 'Crowd soundings',
            warning: true,
            text:
                status === 'stuck-visible'
                    ? 'A prior crowd layer may still be visible; hiding/removal could not be verified. Do not rely on it.'
                    : `${phase}. ${CROWD_MAP_LABEL}. ${days ? `Contributed UTC days ${days}. ` : ''}Dashed lines use each named datum; no match to the chart datum is implied. 0.5 m is contour spacing, not accuracy; estimated vertical uncertainty is at least 1 m and position accuracy is unverified. Missing cells stay blank. Private capture and public contribution are separate owner choices. Contributors · CC0 1.0. No routing, clearance or alarms.`,
        };
    }, [active, status, phase, lease]);
    useEffect(() => {
        onCredit(credit);
    }, [credit, onCredit]);
    useEffect(() => () => onCredit(null), [onCredit]);
    return null;
}
