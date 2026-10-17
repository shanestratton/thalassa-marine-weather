import React from 'react';
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import type mapboxgl from 'mapbox-gl';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
import { useSettingsStore } from '../../stores/settingsStore';
import { NmeaStore } from '../../services/NmeaStore';
import { GpsService } from '../../services/GpsService';
import { getPairing } from '../../services/PiPairingService';
import { boatLanBaseNow } from '../../services/enc/piCellSync';
import { getVersion, subscribe as subscribeCharts } from '../../services/enc/EncCellMetadata';
import { subscribeChartFindAccess } from '../../services/enc/chartFind';
import {
    loadUserOverlays,
    readUserOverlay,
    subscribeUserOverlays,
    userOverlayGeneration,
} from '../../services/userOverlays/store';
import { overlayDisplayData, type OverlayData } from '../../services/userOverlays/model';
import {
    AreaEntryTracker,
    entryFixUsable,
    type EntryArea,
    type EntryFix,
    type EntryNotice,
} from '../../services/userOverlays/entry';
import { borrowedEntryChartAreas } from '../../services/userOverlays/chartAreas';
import { playOverlayChime, stopOverlayChime } from '../../services/userOverlays/audio';

const SOURCE = 'private-user-overlays';
const IDS = ['private-overlay-fill', 'private-overlay-line', 'private-overlay-point'];
const empty: OverlayData = { type: 'FeatureCollection', features: [] };
/** Reads existing receiver cache only; never requests GPS, a provider or a Pi. */
export function overlayFixNow(mode: 'boat' | 'phone'): EntryFix | null {
    const scope = getAuthIdentityScope(),
        boat = useSettingsStore.getState().activeVesselId ?? 'none';
    if (mode === 'phone') {
        const p = GpsService.getLastKnownPosition();
        return p
            ? {
                  lat: p.latitude,
                  lon: p.longitude,
                  at: p.timestamp,
                  accuracyM: p.accuracy,
                  identity: `${scope.key}:${scope.generation}:phone`,
                  source: 'phone GPS',
              }
            : null;
    }
    const evidence = NmeaStore.getState().instrumentEvidence,
        p = evidence?.position;
    return evidence && p && ['gateway', 'lan'].includes(evidence.via)
        ? {
              ...p,
              accuracyM: null,
              identity: `${scope.key}:${scope.generation}:${boat}:${evidence.identity}:${evidence.via}`,
              source: evidence.via === 'lan' ? 'paired Pi boat receiver' : 'boat gateway',
          }
        : null;
}
function mount(map: mapboxgl.Map, data: OverlayData) {
    const existing = map.getSource(SOURCE) as mapboxgl.GeoJSONSource | undefined;
    if (existing) existing.setData(data);
    else map.addSource(SOURCE, { type: 'geojson', data });
    if (!map.getLayer(IDS[0]))
        map.addLayer({
            id: IDS[0],
            type: 'fill',
            source: SOURCE,
            filter: ['==', ['geometry-type'], 'Polygon'],
            paint: { 'fill-color': '#d946ef', 'fill-opacity': 0.16 },
        });
    if (!map.getLayer(IDS[1]))
        map.addLayer({
            id: IDS[1],
            type: 'line',
            source: SOURCE,
            filter: ['!=', ['geometry-type'], 'Point'],
            paint: { 'line-color': '#f0abfc', 'line-width': 2 },
        });
    if (!map.getLayer(IDS[2]))
        map.addLayer({
            id: IDS[2],
            type: 'circle',
            source: SOURCE,
            filter: ['==', ['geometry-type'], 'Point'],
            paint: {
                'circle-color': '#f0abfc',
                'circle-radius': 5,
                'circle-stroke-color': '#701a75',
                'circle-stroke-width': 1,
            },
        });
}
function clear(map: mapboxgl.Map) {
    try {
        for (const id of IDS) if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(SOURCE)) map.removeSource(SOURCE);
    } catch {
        /* style already removed */
    }
}
export interface UserOverlayLayerProps {
    map: mapboxgl.Map | null;
    mapReady: boolean;
    active: boolean;
    className?: string;
}
export default function UserOverlayLayer({
    map,
    mapReady,
    active,
    className = 'absolute bottom-32 left-3 right-3 z-40',
}: UserOverlayLayerProps) {
    const [notices, setNotices] = React.useState<EntryNotice[]>([]),
        [unknown, setUnknown] = React.useState('');
    React.useEffect(() => {
        if (!map || !mapReady || !active) return;
        const ownedMap = map;
        let stopped = false,
            foreground = !Capacitor.isNativePlatform(),
            generation = 0,
            areas: EntryArea[] = [],
            display = empty,
            chartOn = false,
            mode: 'boat' | 'phone' = 'boat',
            identity = '',
            lastChartAvailable = false,
            minimumPositionAt = 0;
        const tracker = new AreaEntryTracker(),
            chartTracker = new AreaEntryTracker();
        const reset = () => {
            tracker.reset();
            chartTracker.reset();
            setNotices([]);
            stopOverlayChime();
        };
        const retire = () => {
            minimumPositionAt = Date.now();
            generation++;
            areas = [];
            display = empty;
            chartOn = false;
            reset();
            clear(map);
        };
        async function load() {
            const seq = ++generation,
                scope = getAuthIdentityScope(),
                epoch = userOverlayGeneration();
            const current = () =>
                !stopped &&
                seq === generation &&
                isAuthIdentityScopeCurrent(scope) &&
                epoch === userOverlayGeneration();
            try {
                if (!scope.userId) {
                    retire();
                    setUnknown('');
                    return;
                }
                const library = await loadUserOverlays(scope);
                if (!current()) return;
                const next: EntryArea[] = [],
                    features: OverlayData['features'] = [];
                for (const row of library.overlays) {
                    if (!row.visible && !row.alerts) continue;
                    const data = await readUserOverlay(row, scope);
                    if (!current()) return;
                    if (row.visible)
                        for (const f of overlayDisplayData(data).features)
                            features.push({ ...f, id: `${row.id}:${f.id}` });
                    if (row.alerts)
                        for (const f of data.features)
                            if (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon')
                                next.push({
                                    key: `user:${row.id}:${f.id}`,
                                    label: `${row.label}: ${f.properties.label}`,
                                    source: 'user overlay',
                                    geometry: f.geometry,
                                });
                }
                if (!current()) return;
                areas = next;
                display = { type: 'FeatureCollection', features };
                chartOn = library.charts;
                mode = library.position;
                reset();
                setUnknown('');
                mount(ownedMap, display);
            } catch {
                if (current()) {
                    retire();
                    setUnknown('Private overlays unavailable. Entry checks unknown.');
                }
            }
        }
        const changed = () => {
            retire();
            void load();
        };
        const auth = subscribeAuthIdentityScope(changed),
            library = subscribeUserOverlays(changed),
            chart = subscribeCharts(reset),
            access = subscribeChartFindAccess(reset),
            settings = useSettingsStore.subscribe((s, p) => {
                if (s.activeVesselId !== p.activeVesselId) {
                    minimumPositionAt = Date.now();
                    reset();
                }
            });
        const tick = () => {
            if (stopped) return;
            if (!foreground || document.visibilityState !== 'visible') {
                reset();
                return;
            }
            const pairing = getPairing(),
                base = boatLanBaseNow(),
                nextIdentity = `${pairing?.deviceId ?? ''}:${pairing?.fingerprint ?? ''}:${base ?? ''}:${getVersion()}`;
            if (identity !== nextIdentity) {
                if (identity) minimumPositionAt = Date.now();
                identity = nextIdentity;
                reset();
            }
            const now = Date.now(),
                candidate = overlayFixNow(mode),
                fix = candidate && candidate.at > minimumPositionAt ? candidate : null,
                chartAreas =
                    chartOn && mode === 'boat' && fix?.source === 'paired Pi boat receiver'
                        ? borrowedEntryChartAreas(map)
                        : null;
            const chartAvailable = !!chartAreas;
            if (chartOn && chartAvailable !== lastChartAvailable) {
                lastChartAvailable = chartAvailable;
                chartTracker.reset();
                setNotices((n) => n.filter((row) => row.source === 'user overlay'));
                stopOverlayChime();
            }
            const events = [...tracker.update(areas, fix, now), ...chartTracker.update(chartAreas, fix, now)].slice(
                0,
                5,
            );
            if (events.length) {
                setNotices(events);
                playOverlayChime();
            }
            if (areas.length || chartOn)
                setUnknown(
                    tracker.limited || chartTracker.limited
                        ? 'Entry checks unknown: area identity capacity reached. Review or restart these foreground checks.'
                        : !entryFixUsable(fix, now)
                          ? 'Entry checks unknown: selected original position is unavailable, stale or inaccurate.'
                          : chartOn && !chartAreas
                            ? 'Chart entry checks unavailable: open the charts aboard on paired boat Wi-Fi.'
                            : '',
                );
        };
        const style = () => {
            if (!stopped && ownedMap.isStyleLoaded() && !ownedMap.getSource(SOURCE))
                try {
                    mount(ownedMap, display);
                } catch {
                    /* wait for style */
                }
        };
        const visibility = () => {
            minimumPositionAt = Date.now();
            reset();
        };
        let appListener: { remove: () => Promise<void> } | null = null;
        if (Capacitor.isNativePlatform()) {
            void App.getState()
                .then((state) => {
                    if (!stopped) {
                        foreground = state.isActive;
                        reset();
                    }
                })
                .catch(() => {
                    foreground = false;
                });
            void App.addListener('appStateChange', (state) => {
                if (stopped) return;
                foreground = state.isActive;
                minimumPositionAt = Date.now();
                reset();
            })
                .then((handle) => {
                    if (stopped) void handle.remove();
                    else appListener = handle;
                })
                .catch(() => {
                    if (!stopped) {
                        foreground = false;
                        reset();
                    }
                });
        }
        map.on('style.load', style);
        map.on('styledata', style);
        document.addEventListener('visibilitychange', visibility);
        void load();
        const timer = setInterval(tick, 1000);
        return () => {
            stopped = true;
            generation++;
            clearInterval(timer);
            auth();
            library();
            chart();
            access();
            settings();
            map.off('style.load', style);
            map.off('styledata', style);
            document.removeEventListener('visibilitychange', visibility);
            void appListener?.remove();
            areas = [];
            display = empty;
            reset();
            clear(map);
        };
    }, [map, mapReady, active]);
    return active && mapReady && map && (notices.length || unknown) ? (
        <aside
            aria-label="Area entry notice"
            className={`${className} break-words rounded-xl border border-fuchsia-300/30 bg-slate-950/95 p-3 text-sm text-slate-100`}
        >
            {notices.map((n) => (
                <p key={n.key}>
                    Entered {n.label} ({n.source}); {n.fixSource}, {new Date(n.at).toISOString()}. Check the area's
                    original information.
                </p>
            ))}
            {unknown && <p>{unknown}</p>}
            <p className="text-xs text-slate-300">
                Foreground advisory only. Absence of a notice does not mean clear water.
            </p>
            <button
                type="button"
                className="min-h-11 px-3 rounded bg-white/10"
                onClick={() => {
                    setNotices([]);
                    setUnknown('');
                }}
            >
                Dismiss area notice
            </button>
        </aside>
    ) : null;
}
