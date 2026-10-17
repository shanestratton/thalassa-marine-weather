import { useCallback, useEffect, useMemo, useState, type MutableRefObject } from 'react';
import type mapboxgl from 'mapbox-gl';
import { fetchWeatherFunction } from '../../services/weather/openMeteoProxy';
import {
    LIGHTNING_CREDIT,
    LIGHTNING_WINDOW_MS,
    parseLicensedLightning,
    type LicensedLightning,
} from '../../services/weather/api/licensedLightningContract';
import { assertNetworkAllowed } from '../../services/networkPolicy';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../../services/authIdentityScope';
import { useSettingsStore } from '../../stores/settingsStore';
import { useOwnedGeoJsonOverlay, type OwnedGeoJsonOverlayOptions } from './useOwnedGeoJsonOverlay';
import type { AtmosCredit } from './atmosPresentation';

const LAYERS: OwnedGeoJsonOverlayOptions['layers'] = [
    {
        suffix: 'pulses',
        specification: {
            type: 'symbol',
            layout: { 'text-field': 'ϟ', 'text-size': 22, 'text-allow-overlap': true, 'text-ignore-placement': true },
            paint: { 'text-color': '#fde047', 'text-halo-color': '#0f172a', 'text-halo-width': 2 },
        },
    },
];
type Snapshot = { data: LicensedLightning; scope: AuthIdentityScope };
/** One explicit open = one point query. No camera changes, polling, socket, background read or page furniture. */
export default function LicensedLightningLayer({
    mapRef,
    mapReady,
    active,
    onCredit,
}: {
    mapRef: MutableRefObject<mapboxgl.Map | null>;
    mapReady: boolean;
    active: boolean;
    onCredit(credit: AtmosCredit | null): void;
}) {
    const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
    const [phase, setPhase] = useState('loading');
    const [clock, setClock] = useState(Date.now);
    useEffect(() => {
        const map = mapRef.current;
        if (!active || !mapReady || !map || document.visibilityState === 'hidden') return;
        const scope = getAuthIdentityScope(),
            abort = new AbortController();
        const retire = () => {
            abort.abort();
            setSnapshot(null);
            setPhase('unavailable; toggle off and on to check again');
        };
        const visibility = () => {
            if (document.visibilityState === 'hidden') retire();
        };
        const identity = subscribeAuthIdentityScope(retire);
        const settings = useSettingsStore.subscribe(() => {
            try {
                assertNetworkAllowed('grib', 'Licensed lightning');
            } catch {
                retire();
            }
        });
        document.addEventListener('visibilitychange', visibility);
        setPhase('loading');
        setSnapshot(null);
        try {
            assertNetworkAllowed('grib', 'Licensed lightning');
            if (!scope.userId) throw new Error('Sign in required');
            const centre = map.getCenter(),
                latitude = centre.lat,
                longitude = ((((centre.lng + 180) % 360) + 360) % 360) - 180;
            void fetchWeatherFunction<unknown>('licensed-lightning', { latitude, longitude }, 12000, abort.signal)
                .then((value) => {
                    if (
                        abort.signal.aborted ||
                        !isAuthIdentityScopeCurrent(scope) ||
                        document.visibilityState === 'hidden'
                    )
                        return;
                    assertNetworkAllowed('grib', 'Licensed lightning');
                    const data = parseLicensedLightning(value, latitude, longitude, Date.now());
                    if (!data) throw new Error('Invalid licensed lightning');
                    setSnapshot({ data, scope });
                    setClock(Date.now());
                    setPhase('ready');
                })
                .catch(() => {
                    if (!abort.signal.aborted) retire();
                });
        } catch {
            retire();
        }
        return () => {
            abort.abort();
            identity();
            settings();
            document.removeEventListener('visibilitychange', visibility);
            setSnapshot(null);
        };
    }, [active, mapReady, mapRef]);
    const sourceCurrent = useCallback(() => {
        try {
            assertNetworkAllowed('grib', 'Licensed lightning');
            return (
                active &&
                !!snapshot &&
                document.visibilityState !== 'hidden' &&
                isAuthIdentityScopeCurrent(snapshot.scope) &&
                Date.now() >= snapshot.data.receivedAt &&
                Date.now() < snapshot.data.receivedAt + LIGHTNING_WINDOW_MS
            );
        } catch {
            return false;
        }
    }, [active, snapshot]);
    useEffect(() => {
        if (!snapshot) return;
        const times = [
            snapshot.data.receivedAt + LIGHTNING_WINDOW_MS,
            ...snapshot.data.pulses.map((p) => p.time + LIGHTNING_WINDOW_MS),
        ].filter((time) => time > clock);
        const next = Math.min(...times);
        if (!Number.isFinite(next)) return;
        const timer = setTimeout(() => setClock(Date.now()), Math.max(0, next - Date.now()));
        return () => clearTimeout(timer);
    }, [snapshot, clock]);
    const createData = useCallback(
        (): GeoJSON.FeatureCollection => ({
            type: 'FeatureCollection',
            features: sourceCurrent()
                ? snapshot!.data.pulses
                      .filter((p) => p.time + LIGHTNING_WINDOW_MS > Date.now() && Math.abs(p.lat) <= 85.05112878)
                      .map((p) => ({
                          type: 'Feature',
                          geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
                          properties: { originalAt: p.time, kind: p.type },
                      }))
                : [],
        }),
        [sourceCurrent, snapshot],
    );
    const status = useOwnedGeoJsonOverlay(mapRef, mapReady, {
        namespace: 'licensed-lightning142',
        label: 'Licensed lightning',
        credit: LIGHTNING_CREDIT,
        enabled: active,
        owner: snapshot,
        revision: `${snapshot?.data.receivedAt ?? 'none'}:${clock}`,
        sourceCurrent,
        createData,
        layers: LAYERS,
        maxFeatures: 1000,
        maxVertices: 1000,
    });
    const credit = useMemo<AtmosCredit | null>(() => {
        if (status === 'stuck-visible')
            return {
                key: 'licensed-lightning',
                title: 'Lightning',
                warning: true,
                text: `A prior lightning layer may remain visible; its removal could not be verified. ${LIGHTNING_CREDIT}`,
            };
        if (!active) return null;
        const data = snapshot?.data,
            ready =
                phase === 'ready' &&
                status === 'ready' &&
                !!data &&
                clock < data.receivedAt + LIGHTNING_WINDOW_MS &&
                sourceCurrent();
        return {
            key: 'licensed-lightning',
            title: 'Lightning',
            warning: !ready || data?.truncated === true,
            text:
                `${ready && data ? `Snapshot ${new Date(data.receivedAt).toISOString().slice(11, 16)} UTC` : phase === 'loading' ? 'Loading' : 'Unavailable'}. ` +
                '20 NM around the chart point selected when opened. Toggle off and on to refresh. An empty result does not mean clear conditions. ' +
                (data?.truncated ? 'Result capped at1000 pulses. ' : '') +
                LIGHTNING_CREDIT,
        };
    }, [status, active, snapshot, phase, clock, sourceCurrent]);
    useEffect(() => {
        onCredit(credit);
    }, [credit, onCredit]);
    useEffect(() => () => onCredit(null), [onCredit]);
    return null;
}
