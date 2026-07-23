import React, { useEffect, useMemo, useRef, useState } from 'react';
import Map, { Source, Layer, Marker, NavigationControl, Popup } from 'react-map-gl/mapbox';
import type { FeatureCollection, Feature, LineString, Point } from 'geojson';
import 'mapbox-gl/dist/mapbox-gl.css';
import {
    MAPBOX_TOKEN,
    MOOD,
    type NearbyVessel,
    type VoyageLogEntry,
    type VoyageLogTrackPoint,
    type VoyageLogWaypoint,
} from '../voyageLogApi';
import { nightPolygon } from '../geo';
import { CompassRose } from './CompassRose';
import { WindBarb, windBarbColor } from './WindBarb';
import { fetchWindGrid, type WindSample } from '../windField';

// Wind barbs are a skipper's tool, not a viewer's — the public page is for
// following a boat, and the control was competing with the base-map switcher in
// the same corner (Shane 2026-07-19).
const PUBLIC_WIND_TOGGLE_VISIBLE = false;

interface MapContainerProps {
    track: VoyageLogTrackPoint[];
    /** Latest telemetry. Carries the boat's position, and when the track is
     *  empty it is the ONLY position available — the map centres and drops the
     *  boat marker from it rather than opening on a globe view of nowhere. */
    telemetry?: { lat: number; lon: number; updated_at: string; is_last_known?: boolean } | null;
    entries: VoyageLogEntry[];
    /** The one route the boat is currently following (linked passage plan),
     *  [lon,lat] points. Drawn as a distinct dashed line; every other
     *  saved/planned route is filtered out of the track. */
    passageLine?: [number, number][] | null;
    /** Named waypoints dropped under way — labelled pins on the track. */
    waypoints: VoyageLogWaypoint[];
    /** Nearby AIS contacts to plot. */
    nearbyVessels: NearbyVessel[];
    /** A map marker was tapped. */
    onEntryClick: (entry: VoyageLogEntry) => void;
    /** Entry currently focused in the sidebar — its pin gets a pulsing
     *  mood-coloured glow so viewers can spot where the story happened.
     *  No camera move (the whole track is already framed). */
    selectedEntryId?: string;
    /** Bump when the layout around the map changes size (diary fold /
     *  unfold): triggers an explicit map.resize() so the canvas fills
     *  the new box even where the container ResizeObserver misses the
     *  change (Shane 2026-07-15: "when I close the side card, can the
     *  map fill the void left behind"). */
    resizeSignal?: number;
}

/** Hex fill for an AIS contact's triangle, by ship-type substring. */
function vesselColor(shipType: string | null | undefined): string {
    const t = (shipType ?? '').toLowerCase();
    if (t.includes('tanker')) return '#f87171'; // red
    if (t.includes('cargo')) return '#fbbf24'; // amber
    if (t.includes('passenger')) return '#38bdf8'; // sky
    if (t.includes('fishing')) return '#34d399'; // emerald
    if (t.includes('sailing') || t.includes('pleasure') || t.includes('yacht')) return '#a78bfa'; // violet
    if (t.includes('tug') || t.includes('pilot') || t.includes('sar') || t.includes('law')) return '#fb923c'; // orange
    return '#94a3b8'; // slate
}

const STYLES = {
    dark: 'mapbox://styles/mapbox/dark-v11',
    satellite: 'mapbox://styles/mapbox/satellite-streets-v12',
} as const;
type StyleMode = keyof typeof STYLES;

const hasCoords = (e: VoyageLogEntry): e is VoyageLogEntry & { latitude: number; longitude: number } =>
    e.latitude != null && e.longitude != null;

/**
 * Douglas-Peucker simplification, ~20 m tolerance. GPS capture runs at
 * seconds-cadence, so the raw line carries thousands of points and every
 * fix's jitter — the drawn track looked hairy. This keeps the real shape
 * (bends, channels, tacks) and drops the noise. Longitude is scaled by
 * cos(lat) so tolerance means the same distance in both axes.
 */
function simplifyTrack(coords: [number, number][]): [number, number][] {
    if (coords.length <= 2) return coords;
    const TOL_DEG = 0.00018; // ≈ 20 m of latitude
    const latScale = Math.cos((coords[0][1] * Math.PI) / 180);
    const keep = new Uint8Array(coords.length);
    keep[0] = 1;
    keep[coords.length - 1] = 1;
    const stack: [number, number][] = [[0, coords.length - 1]];
    while (stack.length > 0) {
        const [a, b] = stack.pop()!;
        if (b - a < 2) continue;
        const ax = coords[a][0] * latScale;
        const ay = coords[a][1];
        const bx = coords[b][0] * latScale;
        const by = coords[b][1];
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        let maxD = -1;
        let maxI = -1;
        for (let i = a + 1; i < b; i++) {
            const px = coords[i][0] * latScale;
            const py = coords[i][1];
            const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
            const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
            if (d > maxD) {
                maxD = d;
                maxI = i;
            }
        }
        if (maxD > TOL_DEG) {
            keep[maxI] = 1;
            stack.push([a, maxI], [maxI, b]);
        }
    }
    const out: [number, number][] = [];
    for (let i = 0; i < coords.length; i++) if (keep[i] === 1) out.push(coords[i]);
    return out;
}

export default function MapContainer({
    track,
    telemetry,
    entries,
    passageLine,
    waypoints,
    nearbyVessels,
    onEntryClick,
    selectedEntryId,
    resizeSignal,
}: MapContainerProps) {
    const [styleMode, setStyleMode] = useState<StyleMode>('satellite');
    // Explicit canvas resize on layout swings (diary fold/unfold). Two
    // kicks: one right after React commits the new layout, one after any
    // CSS transition settles — cheap no-ops when the size didn't change.
    const mapRef = useRef<import('react-map-gl/mapbox').MapRef | null>(null);
    useEffect(() => {
        if (resizeSignal === undefined) return;
        const t1 = setTimeout(() => mapRef.current?.resize(), 60);
        const t2 = setTimeout(() => mapRef.current?.resize(), 400);
        return () => {
            clearTimeout(t1);
            clearTimeout(t2);
        };
    }, [resizeSignal]);
    const [selectedVessel, setSelectedVessel] = useState<NearbyVessel | null>(null);
    // Wind-barb overlay — off by default; fetched from Open-Meteo around the
    // boat the first time it's switched on.
    const [windOn, setWindOn] = useState(false);
    const [windData, setWindData] = useState<WindSample[]>([]);
    const [windLoading, setWindLoading] = useState(false);

    // Tick once a minute so the day/night terminator drifts in real time.
    const [now, setNow] = useState<Date>(() => new Date());
    useEffect(() => {
        const id = setInterval(() => setNow(new Date()), 60_000);
        return () => clearInterval(id);
    }, []);
    const nightFeature = useMemo(() => nightPolygon(now), [now]);
    const nightGeojson = useMemo(
        () =>
            nightFeature
                ? { type: 'FeatureCollection' as const, features: [nightFeature] }
                : { type: 'FeatureCollection' as const, features: [] },
        [nightFeature],
    );

    // Split the track into per-voyage segments so separate passages never
    // join up: the point list is time-ordered and a voyage's fixes are
    // contiguous, so a new segment starts whenever voyage_id changes (a
    // legacy null run stays its own segment). Each segment is simplified
    // independently — no line is ever drawn across a voyage boundary.
    const trackSegments = useMemo<[number, number][][]>(() => {
        const segs: [number, number][][] = [];
        let cur: [number, number][] = [];
        let curVoyage: string | null | undefined = undefined;
        for (const p of track) {
            const vid = p.voyage_id ?? null;
            // PLANNED routes (voyage_id 'planned_…') are saved passage plans
            // that leak into the track — they used to each draw as their own
            // line, cluttering the map with every route the boat ever saved
            // (Shane 2026-07-17). The ONE route being followed is drawn from
            // `passageLine` instead, so drop every planned_ fix here.
            if (typeof vid === 'string' && vid.startsWith('planned_')) continue;
            if (vid !== curVoyage) {
                if (cur.length) segs.push(cur);
                cur = [];
                curVoyage = vid;
            }
            cur.push([p.lon, p.lat]);
        }
        if (cur.length) segs.push(cur);
        return segs.map(simplifyTrack).filter((s) => s.length >= 2);
    }, [track]);

    // The one followed route as a GeoJSON line (Shane 2026-07-17). Distinct
    // from the cyan live track — dashed violet, matching the in-app planned style.
    const passageGeojson = useMemo<FeatureCollection<LineString> | null>(() => {
        if (!passageLine || passageLine.length < 2) return null;
        return {
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    properties: {},
                    geometry: { type: 'LineString', coordinates: passageLine },
                } satisfies Feature<LineString>,
            ],
        };
    }, [passageLine]);

    // The followed route's WAYPOINTS — the vertices of the plan line, tagged
    // so start and finish can be drawn larger than the intermediate marks
    // (Shane 2026-07-23: "show the waypoints on the route"). One Point feature
    // per vertex; `role` drives the size/colour match expression in the layer.
    const passageWaypointsGeojson = useMemo<FeatureCollection<Point> | null>(() => {
        if (!passageLine || passageLine.length < 2) return null;
        const last = passageLine.length - 1;
        return {
            type: 'FeatureCollection',
            features: passageLine.map(
                (coord, i) =>
                    ({
                        type: 'Feature',
                        properties: { role: i === 0 ? 'start' : i === last ? 'finish' : 'mark' },
                        geometry: { type: 'Point', coordinates: coord },
                    }) satisfies Feature<Point>,
            ),
        };
    }, [passageLine]);

    const trackCoords = useMemo<[number, number][]>(() => trackSegments.flat(), [trackSegments]);
    const pinnedEntries = useMemo(() => entries.filter(hasCoords), [entries]);
    const allCoords = useMemo<[number, number][]>(
        () => [
            ...trackCoords,
            ...(passageLine ?? []), // frame the followed route too, even with no live track yet
            ...pinnedEntries.map((e) => [e.longitude, e.latitude] as [number, number]),
        ],
        [trackCoords, passageLine, pinnedEntries],
    );

    // One LineString feature per voyage segment.
    const trackGeojson = useMemo<FeatureCollection<LineString>>(
        () => ({
            type: 'FeatureCollection',
            features: trackSegments.map(
                (coords) =>
                    ({
                        type: 'Feature',
                        properties: {},
                        geometry: { type: 'LineString', coordinates: coords },
                    }) satisfies Feature<LineString>,
            ),
        }),
        [trackSegments],
    );

    // Initial camera — fit the whole voyage, else a globe view.
    const initialViewState = useMemo(() => {
        // No track: centre on the boat's last known position if we have one.
        // The globe view below is the genuine no-idea-where case, and it should
        // stay reachable — but it must not be what a moored boat looks like.
        if (allCoords.length === 0) {
            if (telemetry && Number.isFinite(telemetry.lat) && Number.isFinite(telemetry.lon)) {
                // z12 — settled after z10 (a whole region: "roughly Moreton Bay"
                // when the question is "which anchorage") and z13 (Shane: "the zoom
                // is a bit high"). z12 shows the anchorage with enough coast around
                // it to place it. There is no track to frame in this branch, and
                // the viewer can still pinch out.
                return { longitude: telemetry.lon, latitude: telemetry.lat, zoom: 12 };
            }
            return { longitude: 0, latitude: 20, zoom: 1.3 };
        }
        if (allCoords.length === 1) return { longitude: allCoords[0][0], latitude: allCoords[0][1], zoom: 8 };
        let minLon = Infinity;
        let minLat = Infinity;
        let maxLon = -Infinity;
        let maxLat = -Infinity;
        for (const [lon, lat] of allCoords) {
            minLon = Math.min(minLon, lon);
            minLat = Math.min(minLat, lat);
            maxLon = Math.max(maxLon, lon);
            maxLat = Math.max(maxLat, lat);
        }
        return {
            bounds: [
                [minLon, minLat],
                [maxLon, maxLat],
            ] as [[number, number], [number, number]],
            fitBoundsOptions: { padding: 90 },
        };
        // initialViewState is mount-only — the first computed value is what matters.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Selecting an entry deliberately does NOT move the camera — the whole
    // track is already framed, and viewers want to keep the overview.

    // The track's end, or — with no track — wherever the boat was last seen.
    const telemetryFix: [number, number] | undefined =
        telemetry && Number.isFinite(telemetry.lat) && Number.isFinite(telemetry.lon)
            ? [telemetry.lon, telemetry.lat]
            : undefined;
    const lastFix = trackCoords[trackCoords.length - 1] ?? telemetryFix;
    // Only label the marker when the position is the fallback: a live boat needs
    // no caption, a month-old berth fix very much does.
    const lastKnownAgeLabel =
        trackCoords.length === 0 && telemetry?.is_last_known
            ? (() => {
                  const ms = Date.now() - new Date(telemetry.updated_at).getTime();
                  if (!Number.isFinite(ms) || ms < 0) return 'Last known';
                  const days = Math.floor(ms / 86_400_000);
                  if (days >= 1) return `Last known · ${days}d ago`;
                  const hours = Math.floor(ms / 3_600_000);
                  if (hours >= 1) return `Last known · ${hours}h ago`;
                  return 'Last known · just now';
              })()
            : null;

    // Fetch the wind grid around the boat the first time the overlay is
    // switched on (and when the boat's position moves materially). Client-side
    // Open-Meteo — no server cost, no key. Rendered as barbs (below).
    const windCenter = lastFix ?? (pinnedEntries[0] ? [pinnedEntries[0].longitude, pinnedEntries[0].latitude] : null);
    const windCenterKey = windCenter ? `${windCenter[1].toFixed(1)},${windCenter[0].toFixed(1)}` : '';
    useEffect(() => {
        if (!windOn || !windCenter) return;
        let cancelled = false;
        setWindLoading(true);
        fetchWindGrid(windCenter[1], windCenter[0])
            .then((d) => {
                if (!cancelled) setWindData(d);
            })
            .catch(() => {
                /* offshore / API hiccup — leave the toggle on, retry on next center change */
            })
            .finally(() => {
                if (!cancelled) setWindLoading(false);
            });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [windOn, windCenterKey]);

    if (!MAPBOX_TOKEN) {
        return (
            <div className="w-full h-full flex items-center justify-center bg-slate-900 text-slate-500 text-sm">
                Map unavailable — Mapbox token not configured for this build.
            </div>
        );
    }

    return (
        <div
            className={`w-full h-full relative bg-slate-900 ${styleMode === 'satellite' ? 'voyage-log-sat-bright' : ''}`}
        >
            <Map
                ref={mapRef}
                mapboxAccessToken={MAPBOX_TOKEN}
                initialViewState={initialViewState}
                mapStyle={STYLES[styleMode]}
                projection="mercator"
                attributionControl={false}
            >
                <NavigationControl position="top-left" showCompass={false} />

                {/* Bathymetry tint over the satellite imagery (Shane
                    2026-07-09) — same MapTiler Ocean raster the app uses,
                    translucent so depth contours read through the water
                    while the imagery stays photographic. FIRST child so
                    the track/markers mount above it; always mounted with
                    visibility toggled (a conditional mount after the
                    track would append the raster on top of it). Chart
                    mode hides it — that style shades water itself. */}
                <Source
                    id="bathy-ocean"
                    type="raster"
                    tiles={['https://api.maptiler.com/maps/ocean/{z}/{x}/{y}.png?key=3misfI2jeOYbJqgl5a6e']}
                    tileSize={512}
                    maxzoom={16}
                >
                    <Layer
                        id="bathy-ocean-layer"
                        type="raster"
                        layout={{ visibility: styleMode === 'satellite' ? 'visible' : 'none' }}
                        paint={{ 'raster-opacity': 0.45, 'raster-fade-duration': 0 }}
                    />
                </Source>

                {/* Day/night terminator — translucent shadow over the night side */}
                <Source id="night-side" type="geojson" data={nightGeojson}>
                    <Layer id="night-fill" type="fill" paint={{ 'fill-color': '#000814', 'fill-opacity': 0.32 }} />
                </Source>

                {/* The followed route — the one route the boat is currently
                    following (Shane 2026-07-17). Drawn UNDER the live track so
                    the boat's actual path reads on top.

                    Glow + solid core instead of the old dashed hairline (Shane
                    2026-07-23: "change the route from a dashed line to something
                    more hip"), matching the in-app tracer line so the public
                    page reads as the same product. Violet keeps it distinct
                    from the sky-blue sailed track. */}
                {passageGeojson && (
                    <Source id="passage-route" type="geojson" data={passageGeojson}>
                        <Layer
                            id="passage-glow"
                            type="line"
                            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
                            paint={{ 'line-color': '#a78bfa', 'line-width': 9, 'line-blur': 6, 'line-opacity': 0.3 }}
                        />
                        <Layer
                            id="passage-line"
                            type="line"
                            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
                            paint={{ 'line-color': '#c4b5fd', 'line-width': 3, 'line-opacity': 0.95 }}
                        />
                    </Source>
                )}

                {/* Route waypoints — start (green) and finish (red) larger than
                    the violet intermediate marks. Its own Source so it mounts
                    ABOVE the route line; still below the live track and boat. */}
                {passageWaypointsGeojson && (
                    <Source id="passage-waypoints" type="geojson" data={passageWaypointsGeojson}>
                        <Layer
                            id="passage-waypoint-dots"
                            type="circle"
                            paint={{
                                'circle-radius': ['match', ['get', 'role'], 'mark', 3.5, 6],
                                'circle-color': [
                                    'match',
                                    ['get', 'role'],
                                    'start',
                                    '#34d399',
                                    'finish',
                                    '#f87171',
                                    '#c4b5fd',
                                ],
                                'circle-stroke-color': '#ffffff',
                                'circle-stroke-width': ['match', ['get', 'role'], 'mark', 1, 2],
                                'circle-opacity': 0.95,
                            }}
                        />
                    </Source>
                )}

                {/* Voyage track — glow underlay + crisp line */}
                <Source id="voyage-track" type="geojson" data={trackGeojson}>
                    <Layer
                        id="track-glow"
                        type="line"
                        layout={{ 'line-cap': 'round', 'line-join': 'round' }}
                        paint={{ 'line-color': '#38bdf8', 'line-width': 11, 'line-blur': 7, 'line-opacity': 0.3 }}
                    />
                    <Layer
                        id="track-line"
                        type="line"
                        layout={{ 'line-cap': 'round', 'line-join': 'round' }}
                        paint={{ 'line-color': '#7dd3fc', 'line-width': 2.5, 'line-opacity': 0.95 }}
                    />
                </Source>

                {/* Wind barbs — Open-Meteo grid around the boat, toggleable.
                    Standard meteorological barbs coloured by speed; the marker
                    rotates by the wind-FROM bearing. */}
                {windOn &&
                    windData.map((w, i) => (
                        <Marker
                            key={`wind-${i}`}
                            longitude={w.lon}
                            latitude={w.lat}
                            anchor="center"
                            rotation={w.dirDeg}
                        >
                            <div className="pointer-events-none opacity-90 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
                                <WindBarb speedKt={w.speedKt} color={windBarbColor(w.speedKt)} />
                            </div>
                        </Marker>
                    ))}

                {/* Named waypoints — the marks the skipper dropped under way.
                    A small diamond with the name label; the auto breadcrumb
                    dots are intentionally gone (owner ask 2026-07-04). */}
                {waypoints.map((w, i) => (
                    <Marker key={`wp-${i}`} longitude={w.lon} latitude={w.lat} anchor="center">
                        <div className="flex flex-col items-center pointer-events-none select-none">
                            <span className="w-2.5 h-2.5 rotate-45 bg-amber-300 border border-amber-100 shadow-[0_0_6px_rgba(251,191,36,0.7)]" />
                            <span className="mt-0.5 px-1 rounded bg-slate-900/80 text-amber-200 text-[9px] font-bold leading-tight whitespace-nowrap">
                                {w.name}
                            </span>
                        </div>
                    </Marker>
                ))}

                {/* Latest known position — pulsing */}
                {lastFix && (
                    <Marker longitude={lastFix[0]} latitude={lastFix[1]} anchor="center">
                        <div className="flex flex-col items-center">
                            <span className="relative flex h-4 w-4">
                                <span
                                    className={`absolute inline-flex h-full w-full rounded-full opacity-60 ${
                                        lastKnownAgeLabel ? 'bg-slate-400' : 'bg-sky-400 animate-ping'
                                    }`}
                                />
                                <span
                                    className={`relative inline-flex h-4 w-4 rounded-full border-2 border-white shadow-lg ${
                                        lastKnownAgeLabel ? 'bg-slate-400' : 'bg-sky-400'
                                    }`}
                                />
                            </span>
                            {/* Not pinging, and captioned: a stale fix should not
                                animate like a boat under way. */}
                            {lastKnownAgeLabel && (
                                <span className="mt-1 whitespace-nowrap rounded bg-slate-900/85 px-1.5 py-0.5 text-[10px] font-bold text-slate-300 shadow">
                                    {lastKnownAgeLabel}
                                </span>
                            )}
                        </div>
                    </Marker>
                )}

                {/* Diary entry pins — camera badge if it carries photos.
                    When the entry is the one selected in the sidebar, the
                    pin gets a pulsing mood-coloured halo (camera badge
                    variant) or an intensified drop-shadow (emoji variant)
                    so the viewer can quickly spot where on the route the
                    story happened. */}
                {pinnedEntries.map((entry) => {
                    const hasPhotos = entry.photos.length > 0;
                    const moodHex = MOOD[entry.mood]?.hex ?? '#38bdf8';
                    const isSelected = !!selectedEntryId && entry.id === selectedEntryId;
                    return (
                        <Marker key={entry.id} longitude={entry.longitude} latitude={entry.latitude} anchor="bottom">
                            <button
                                type="button"
                                onClick={() => onEntryClick(entry)}
                                aria-label={`Voyage log entry: ${entry.title || 'Untitled'}`}
                                className={`relative cursor-pointer leading-none -translate-y-0.5 transition-transform hover:scale-110 active:scale-95 ${
                                    isSelected ? 'scale-125' : ''
                                }`}
                            >
                                {/* Halo — only renders for the selected pin. Sits
                                    behind the badge/emoji, mood-coloured, pulses
                                    to draw the eye. */}
                                {isSelected && (
                                    <span
                                        aria-hidden="true"
                                        className="absolute inset-0 -m-2 rounded-full animate-ping"
                                        style={{ backgroundColor: `${moodHex}66` }}
                                    />
                                )}
                                {hasPhotos ? (
                                    <span
                                        className="relative flex items-center justify-center w-7 h-7 rounded-full bg-slate-900/90 border-2 text-sm shadow-lg"
                                        style={{
                                            borderColor: moodHex,
                                            boxShadow: isSelected ? `0 0 16px ${moodHex}` : undefined,
                                        }}
                                    >
                                        📷
                                    </span>
                                ) : (
                                    <span
                                        className="relative text-2xl"
                                        style={{
                                            filter: isSelected
                                                ? `drop-shadow(0 0 10px ${moodHex}) drop-shadow(0 0 6px ${moodHex})`
                                                : `drop-shadow(0 0 4px ${moodHex})`,
                                        }}
                                    >
                                        {MOOD[entry.mood]?.emoji ?? '📍'}
                                    </span>
                                )}
                            </button>
                        </Marker>
                    );
                })}

                {/* AIS — nearby ships. Triangle points along COG (or heading). */}
                {nearbyVessels.map((v) => {
                    const bearing = v.cog ?? v.heading ?? 0;
                    const fill = vesselColor(v.ship_type);
                    return (
                        <Marker key={v.mmsi} longitude={v.lon} latitude={v.lat} anchor="center" rotation={bearing}>
                            <button
                                type="button"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedVessel(v);
                                }}
                                aria-label={`AIS contact ${v.name || v.mmsi}`}
                                className="cursor-pointer transition-transform hover:scale-125"
                            >
                                <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                                    <polygon
                                        points="8,1 13,14 8,11 3,14"
                                        fill={fill}
                                        stroke="rgba(15,23,42,0.85)"
                                        strokeWidth="1"
                                        strokeLinejoin="round"
                                    />
                                </svg>
                            </button>
                        </Marker>
                    );
                })}

                {/* AIS detail popup */}
                {selectedVessel && (
                    <Popup
                        longitude={selectedVessel.lon}
                        latitude={selectedVessel.lat}
                        anchor="bottom"
                        offset={14}
                        closeButton={false}
                        closeOnClick
                        onClose={() => setSelectedVessel(null)}
                        className="voyage-log-ais-popup"
                    >
                        <div className="min-w-[190px] max-w-[240px] bg-slate-900 border border-white/10 rounded-xl px-3 py-2.5 text-slate-100 shadow-2xl">
                            <div className="flex items-center gap-2 mb-1.5">
                                {selectedVessel.thumbnail_url ? (
                                    <img
                                        src={selectedVessel.thumbnail_url}
                                        alt=""
                                        className="w-8 h-8 rounded object-cover shrink-0 border border-white/10"
                                    />
                                ) : (
                                    <span
                                        className="w-2 h-2 rounded-full shrink-0"
                                        style={{ backgroundColor: vesselColor(selectedVessel.ship_type) }}
                                    />
                                )}
                                <p className="text-sm font-bold truncate">
                                    {selectedVessel.flag_emoji ? `${selectedVessel.flag_emoji} ` : ''}
                                    {selectedVessel.name || `MMSI ${selectedVessel.mmsi}`}
                                </p>
                            </div>
                            {(selectedVessel.ship_type || selectedVessel.loa || selectedVessel.flag_country) && (
                                <p className="text-[10px] text-slate-400 uppercase tracking-wider mb-1.5 truncate">
                                    {[
                                        selectedVessel.ship_type,
                                        selectedVessel.loa ? `${Math.round(selectedVessel.loa)} m` : null,
                                        selectedVessel.flag_country,
                                    ]
                                        .filter(Boolean)
                                        .join(' · ')}
                                </p>
                            )}
                            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] font-mono">
                                {selectedVessel.sog != null && (
                                    <>
                                        <span className="text-slate-500">SOG</span>
                                        <span className="text-emerald-400 text-right">
                                            {selectedVessel.sog.toFixed(1)} kt
                                        </span>
                                    </>
                                )}
                                {selectedVessel.cog != null && (
                                    <>
                                        <span className="text-slate-500">COG</span>
                                        <span className="text-amber-400 text-right">
                                            {Math.round(selectedVessel.cog)}°
                                        </span>
                                    </>
                                )}
                                {selectedVessel.destination && (
                                    <>
                                        <span className="text-slate-500">To</span>
                                        <span className="text-slate-200 text-right truncate">
                                            {selectedVessel.destination}
                                        </span>
                                    </>
                                )}
                                {selectedVessel.call_sign && (
                                    <>
                                        <span className="text-slate-500">Call</span>
                                        <span className="text-slate-200 text-right">{selectedVessel.call_sign}</span>
                                    </>
                                )}
                            </div>
                        </div>
                    </Popup>
                )}
            </Map>

            {/* Basemap toggle */}
            <div className="absolute top-3 right-3 flex rounded-lg overflow-hidden border border-white/15 bg-slate-900/80 backdrop-blur-md shadow-lg text-[11px] font-bold uppercase tracking-wider">
                {(['dark', 'satellite'] as StyleMode[]).map((m) => (
                    <button
                        key={m}
                        onClick={() => setStyleMode(m)}
                        aria-label={`${m === 'dark' ? 'Chart' : 'Satellite'} basemap`}
                        className={`px-3 py-1.5 transition-colors ${
                            styleMode === m ? 'bg-sky-600 text-white' : 'text-slate-300 hover:bg-white/10'
                        }`}
                    >
                        {m === 'dark' ? 'Chart' : 'Satellite'}
                    </button>
                ))}
            </div>

            {/* Wind-barb toggle PARKED (Shane 2026-07-19: "can we remove the wind
                button from the public page"). The barb layer and its Open-Meteo
                fetch stay wired and cost nothing while windOn is false — flip this
                to bring the control back. */}
            {PUBLIC_WIND_TOGGLE_VISIBLE && (
                <button
                    onClick={() => setWindOn((v) => !v)}
                    aria-label="Toggle wind barbs"
                    className={`absolute top-14 right-3 flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/15 backdrop-blur-md shadow-lg text-[11px] font-bold uppercase tracking-wider transition-colors ${
                        windOn ? 'bg-sky-600 text-white' : 'bg-slate-900/80 text-slate-300 hover:bg-white/10'
                    }`}
                >
                    {windLoading ? (
                        <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    ) : (
                        <span aria-hidden>🌬️</span>
                    )}
                    Wind
                </button>
            )}

            {/* Compass rose — chart-style decoration, bottom-left */}
            <div className="absolute bottom-4 left-4 z-10">
                <CompassRose />
            </div>
        </div>
    );
}
