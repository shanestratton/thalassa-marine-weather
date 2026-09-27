import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { destinationBounds, publicMapDestination } from '../publicMapDestination';
import { installMusgraveImagery } from '../publicSatelliteCoverage';
import type { VoyageLogDestination } from '../voyageLogApi';
import Map, { AttributionControl, Source, Layer, Marker, Popup } from 'react-map-gl/mapbox';
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
import { nightPolygon, bearingDeg, haversineNm } from '../geo';
import { WindBarb, windBarbColor } from './WindBarb';
import { fetchWindGrid, type WindSample } from '../windField';
import { classifyNearbyVesselFreshness, formatPublicAge } from '../publicVoyageFreshness';
import { shipTypeLabel, vesselColor } from '../aisShipType';
import { publicVoyageWaypoints } from '../publicVoyageWaypoints';
import { publicTrackSegments } from '../publicTrackSegments';
import {
    labelSide,
    latestPublicTrackPoint,
    publicLastKnownLabel,
    splitWaypointName,
    type LabelSide,
} from './voyageStory';

// Wind barbs are a skipper's tool, not a viewer's — the public page is for
// following a boat, and the control was competing with the base-map switcher in
// the same corner (Shane 2026-07-19).
const PUBLIC_WIND_TOGGLE_VISIBLE = false;

interface MapContainerProps {
    destination?: VoyageLogDestination | null;
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
    /** Resolved selected track, supplying the scope omitted by older waypoint payloads. */
    waypointVoyageId?: string;
    /** Nearby AIS contacts to plot. */
    nearbyVessels: NearbyVessel[];
    /** True when the dashboard's latest public-log request failed or aged out. */
    connectionLost: boolean;
    /** A map marker was tapped. */
    onEntryClick: (entry: VoyageLogEntry) => void;
    /** Entry currently focused in the sidebar — its pin gets a pulsing
     *  mood-coloured glow so viewers can spot where the story happened.
     *  No camera move (the whole track is already framed). */
    selectedEntryId?: string;
    /** Changes only when the public voyage selector resolves to a different
     *  trip. The map refits once for that selection, never on ordinary live
     *  polling updates. */
    focusKey?: string;
    /** Bump when the layout around the map changes size (diary fold /
     *  unfold): triggers an explicit map.resize() so the canvas fills
     *  the new box even where the container ResizeObserver misses the
     *  change (Shane 2026-07-15: "when I close the side card, can the
     *  map fill the void left behind"). */
    resizeSignal?: number;
    /** Whole-yacht history: frame every shared track and positioned story. */
    allTrips?: boolean;
    /** The boat's name, flown on the own-ship flag so followers know which
     *  mark is her. A primitive, so React.memo still skips clock ticks. */
    vesselName?: string;
    /** One-line passage summary for the map key on phones, e.g.
     *  '17.2 nm · 2 h 33 m'. Built by passageKeySummary, which never reads
     *  the clock, so it stays stable across the dashboard's 30 s tick. */
    keySummary?: string | null;
}

const STYLES = {
    dark: 'mapbox://styles/mapbox/dark-v11',
    satellite: 'mapbox://styles/mapbox/satellite-streets-v12',
} as const;
type StyleMode = keyof typeof STYLES;

const hasCoords = (e: VoyageLogEntry): e is VoyageLogEntry & { latitude: number; longitude: number } =>
    e.latitude != null && e.longitude != null;

/** A box in map-container pixels: left, top, right, bottom. */
interface ScreenRect {
    x: number;
    y: number;
    r: number;
    b: number;
}

/** The map's box and zoom at the last settled camera, plus where the page's
 *  own chrome (control cluster, map notes, floating header) sits over it. */
interface LabelFrame {
    width: number;
    height: number;
    zoom: number;
    chrome: ScreenRect[];
}

/** How a marker's label hangs off it, mirroring public-voyage.css: the
 *  marker's half-size, the gap above/below and beside it, and an estimate of
 *  the label's size (it is never measured, so the estimate errs large). */
interface LabelGeometry {
    half: number;
    gapV: number;
    gapH: number;
    w: number;
    h: number;
}

/** Bottom band kept clear for the provider credits (--pv-credit-clear). */
const CREDIT_CLEAR_PX = 40;

const overlaps = (a: ScreenRect, b: ScreenRect): boolean => a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b;

function labelRect(side: LabelSide, p: { x: number; y: number }, g: LabelGeometry): ScreenRect {
    switch (side) {
        case 'above':
            return { x: p.x - g.w / 2, y: p.y - g.half - g.gapV - g.h, r: p.x + g.w / 2, b: p.y - g.half - g.gapV };
        case 'right':
            return { x: p.x + g.half + g.gapH, y: p.y - g.h / 2, r: p.x + g.half + g.gapH + g.w, b: p.y + g.h / 2 };
        case 'left':
            return { x: p.x - g.half - g.gapH - g.w, y: p.y - g.h / 2, r: p.x - g.half - g.gapH, b: p.y + g.h / 2 };
        default:
            return { x: p.x - g.w / 2, y: p.y + g.half + g.gapV, r: p.x + g.w / 2, b: p.y + g.half + g.gapV + g.h };
    }
}

/**
 * labelSide keeps a label inside the frame; this also keeps it off the page's
 * chrome. The frame padding is pinned by tests, so a mark can settle right
 * beside the control cluster, where a 'below' label would slide under Expand
 * and Satellite. labelSide's choice stands whenever it lands clear; otherwise
 * the first side that is clear of the chrome, the credits band and the frame
 * edges wins, and with no clear side at all labelSide's choice stands.
 */
function clearLabelSide(
    p: { x: number; y: number } | null,
    frame: LabelFrame | null,
    g: LabelGeometry,
    avoid: ScreenRect[] = [],
): { side: LabelSide; rect: ScreenRect | null } {
    const base = labelSide(p, frame);
    if (!p || !frame) return { side: base, rect: null };
    const obstacles = [...frame.chrome, ...avoid];
    const clear = (rect: ScreenRect): boolean =>
        rect.x >= 0 &&
        rect.y >= 0 &&
        rect.r <= frame.width &&
        rect.b <= frame.height - CREDIT_CLEAR_PX &&
        !obstacles.some((o) => overlaps(rect, o));
    for (const side of [base, ...(['above', 'left', 'right', 'below'] as LabelSide[]).filter((s) => s !== base)]) {
        const rect = labelRect(side, p, g);
        if (clear(rect)) return { side, rect };
    }
    return { side: base, rect: labelRect(base, p, g) };
}

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

function MapContainer({
    destination,
    track,
    telemetry,
    entries,
    passageLine,
    waypoints,
    waypointVoyageId,
    nearbyVessels,
    connectionLost,
    onEntryClick,
    selectedEntryId,
    focusKey,
    resizeSignal,
    allTrips = false,
    vesselName,
    keySummary,
}: MapContainerProps) {
    const [styleMode, setStyleMode] = useState<StyleMode>('satellite');
    const [destinationDetail, setDestinationDetail] = useState(false);
    const exploredFocusKey = useRef<string | null>(null);
    const destinationTarget = publicMapDestination(passageLine, destination);
    // Explicit canvas resize on layout swings (diary fold/unfold). Two
    // kicks: one right after React commits the new layout, one after any
    // CSS transition settles — cheap no-ops when the size didn't change.
    const mapRef = useRef<import('react-map-gl/mapbox').MapRef | null>(null);
    // The identity/voyage card now floats over the chart. On intentional
    // framing, leave room for it and the right-hand control column. Reading
    // the current box also honours the viewer folding that card away; normal
    // polling still never recentres their map.
    const framePadding = React.useCallback(() => {
        const container = mapRef.current?.getContainer?.();
        if (!container) return { top: 64, bottom: 72, left: 28, right: 28 };
        const bounds = container.getBoundingClientRect();
        const header = document.querySelector('[data-testid="public-voyage-header"][data-overlay="true"]');
        const headerBounds = header?.getBoundingClientRect();
        return {
            top: Math.min(
                headerBounds && headerBounds.height > 0 ? Math.max(24, headerBounds.bottom - bounds.top + 16) : 24,
                bounds.height * 0.55,
            ),
            bottom: Math.min(100, bounds.height * 0.22),
            // Keep the boat off the left edge (its flag turns inward), and the
            // track clear of the bottom-right control cluster: 2 x 44 px
            // controls + 8 px gap + 12 px edge = 108 px, plus room for the end
            // marker and its half-width (a 1024 px tablet touched at 124). The old
            // 92 px dated from the single-column rail, and the end of the
            // track landed under the basemap capsule.
            left: Math.min(48, bounds.width * 0.1),
            right: Math.min(140, bounds.width * 0.3),
        };
    }, []);
    const exploreDestination = () => {
        if (!destinationTarget) return;
        exploredFocusKey.current = focusKey ?? '';
        setDestinationDetail(true);
        setStyleMode('satellite');
        mapRef.current?.fitBounds(destinationBounds(destinationTarget.center), {
            padding: framePadding(),
            maxZoom: 15,
            duration: 1000,
        });
    };
    useEffect(() => {
        if (resizeSignal === undefined) return;
        const t1 = setTimeout(() => mapRef.current?.resize(), 60);
        const t2 = setTimeout(() => mapRef.current?.resize(), 400);
        return () => {
            clearTimeout(t1);
            clearTimeout(t2);
        };
    }, [resizeSignal]);

    // The map's box and zoom as of the last settled camera. Labels read it to
    // flip toward the middle near an edge (the frame padding is pinned, so
    // labels move instead) and to stand down when they would crowd the boat.
    // Read on load, move end and resize only, never per animation frame.
    // The chrome boxes let labels step out from under the controls.
    const railRef = useRef<HTMLDivElement | null>(null);
    const notesRef = useRef<HTMLDivElement | null>(null);
    const [labelFrame, setLabelFrame] = useState<LabelFrame | null>(null);
    const readLabelFrame = useCallback(() => {
        const map = mapRef.current;
        const box = map?.getContainer?.();
        if (!map || !box || typeof map.getZoom !== 'function') return;
        const origin = box.getBoundingClientRect();
        const header = document.querySelector('[data-testid="public-voyage-header"][data-overlay="true"]');
        const chrome: ScreenRect[] = [];
        for (const el of [railRef.current, notesRef.current, header]) {
            const b = el?.getBoundingClientRect();
            if (!b || b.width <= 0 || b.height <= 0) continue;
            chrome.push({
                x: b.left - origin.left,
                y: b.top - origin.top,
                r: b.right - origin.left,
                b: b.bottom - origin.top,
            });
        }
        setLabelFrame({ width: box.clientWidth, height: box.clientHeight, zoom: map.getZoom(), chrome });
    }, []);
    // Where a coordinate sits on screen, or null before the first settled
    // frame (and in tests, whose mock map cannot project).
    const screenPoint = (lon: number, lat: number): { x: number; y: number } | null => {
        const map = mapRef.current;
        if (!labelFrame || !map || typeof map.project !== 'function') return null;
        try {
            const { x, y } = map.project([lon, lat]);
            return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
        } catch {
            return null;
        }
    };
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

    // Simplify each voyage independently; never invent a line between trips.
    const trackSegments = useMemo(() => publicTrackSegments(track).map(simplifyTrack), [track]);

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

    /**
     * THE LINE IS THE SOURCE OF TRUTH FOR WHERE A VOYAGE STARTS.
     *
     * "Voyage Start" is a SHIP-LOG waypoint, dropped where tracking was
     * switched on — the mooring, usually, and on a passage that has not sailed
     * yet that is nowhere near where the boat will actually depart from. Drawn
     * beside a planned route it contradicts the plan's own green origin dot,
     * two claims about the same thing a few hundred metres apart (Shane
     * 2026-09-05: "that is not where the voyage will start from. the voyage
     * should always be the line claude. the source of truth").
     *
     * So when there IS a plan line, the plan owns the start and this marker
     * stands down. Without one the log marker is the only start there is, and
     * it stays. "Voyage End" is untouched either way: where a passage actually
     * finished is a fact about the voyage, not a competing claim about the plan.
     */
    const hasPlanLine = !!passageLine && passageLine.length >= 2;
    const lifecycleWaypoints = useMemo(
        () => publicVoyageWaypoints(waypoints, waypointVoyageId),
        [waypoints, waypointVoyageId],
    );
    const shownWaypoints = useMemo(
        () => (hasPlanLine ? lifecycleWaypoints.filter((w) => w.name !== 'Voyage Start') : lifecycleWaypoints),
        [lifecycleWaypoints, hasPlanLine],
    );

    const trackCoords = useMemo<[number, number][]>(() => trackSegments.flat(), [trackSegments]);
    // Shared with the page header (voyageStory), so the flag on the map and
    // the status line above it can never disagree about the boat's last fix.
    const latestTrackPoint = useMemo(() => latestPublicTrackPoint(track), [track]);

    // Major course changes along the SAILED track (owner ask 2026-08-03):
    // one dot wherever the boat altered course ≥30° with a solid leg
    // (≥150 m) on both sides — tacks, channel turns, the decisions of the
    // passage — computed on the simplified segments so GPS jitter never
    // qualifies. `course` (the new heading) is carried for the tooltip.
    const courseChangeGeojson = useMemo<FeatureCollection<Point> | null>(() => {
        const TURN_DEG = 30;
        const MIN_LEG_NM = 150 / 1852;
        const feats: Feature<Point>[] = [];
        for (const seg of trackSegments) {
            for (let i = 1; i < seg.length - 1; i++) {
                const [aLon, aLat] = seg[i - 1];
                const [bLon, bLat] = seg[i];
                const [cLon, cLat] = seg[i + 1];
                const inBrg = bearingDeg(aLat, aLon, bLat, bLon);
                const outBrg = bearingDeg(bLat, bLon, cLat, cLon);
                let turn = outBrg - inBrg;
                if (turn > 180) turn -= 360;
                if (turn < -180) turn += 360;
                if (Math.abs(turn) < TURN_DEG) continue;
                if (haversineNm(aLat, aLon, bLat, bLon) < MIN_LEG_NM) continue;
                if (haversineNm(bLat, bLon, cLat, cLon) < MIN_LEG_NM) continue;
                feats.push({
                    type: 'Feature',
                    properties: { turn: Math.round(turn), course: Math.round(outBrg) },
                    geometry: { type: 'Point', coordinates: seg[i] },
                } satisfies Feature<Point>);
            }
        }
        return feats.length > 0 ? { type: 'FeatureCollection', features: feats } : null;
    }, [trackSegments]);
    const pinnedEntries = useMemo(() => entries.filter(hasCoords), [entries]);
    const allCoords = useMemo<[number, number][]>(
        () => [
            ...trackCoords,
            ...(passageLine ?? []), // frame the followed route too, even with no live track yet
            ...pinnedEntries.map((e) => [e.longitude, e.latitude] as [number, number]),
        ],
        [trackCoords, passageLine, pinnedEntries],
    );

    // The track's end, or — with no track — wherever the boat was last seen.
    // Kept above the selector-focus effect so the latest rendered fallback is
    // available through a ref without making that effect refire on every poll.
    const telemetryFix: [number, number] | undefined =
        telemetry && Number.isFinite(telemetry.lat) && Number.isFinite(telemetry.lon)
            ? [telemetry.lon, telemetry.lat]
            : undefined;

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

    // `initialViewState` only applies at mount. A historical trip selector
    // needs one intentional refocus after its data arrives, but re-fitting on
    // every background refresh would fight a viewer who is exploring the map.
    // Store the ever-changing geometry in a ref and key the effect solely to
    // the resolved trip id supplied by the dashboard.
    /**
     * Frame the whole voyage — the complete route, the sailed track and the
     * boat's last known fix — using as much of the map as the shape allows
     * (Shane 2026-09-02). Padding is only what the page chrome needs: the
     * basemap toggle at the top, the attribution strip and this button at the
     * bottom. maxZoom 14 lets a short day-sail fill the screen instead of
     * stopping at the auto-frame's cautious 12.
     */
    const frameWholeVoyage = React.useCallback((): void => {
        setDestinationDetail(false);
        exploredFocusKey.current = null;
        const map = mapRef.current;
        if (!map) return;
        const { allCoords: coords, telemetryFix: fix } = focusTargetRef.current;
        const points = [...coords, ...(fix ? [fix] : [])];
        if (points.length === 0) return;
        if (points.length === 1) {
            map.flyTo({ center: points[0], zoom: 12, duration: 900, essential: true });
            return;
        }
        let minLon = Infinity;
        let minLat = Infinity;
        let maxLon = -Infinity;
        let maxLat = -Infinity;
        for (const [lon, lat] of points) {
            minLon = Math.min(minLon, lon);
            minLat = Math.min(minLat, lat);
            maxLon = Math.max(maxLon, lon);
            maxLat = Math.max(maxLat, lat);
        }
        // A voyage that has barely moved collapses to a point; fitBounds on a
        // zero-span box lands at max zoom staring at pixels.
        if (maxLon - minLon < 1e-4 && maxLat - minLat < 1e-4) {
            map.flyTo({ center: [minLon, minLat], zoom: 12, duration: 900, essential: true });
            return;
        }
        map.fitBounds(
            [
                [minLon, minLat],
                [maxLon, maxLat],
            ],
            {
                padding: framePadding(),
                duration: 900,
                maxZoom: 14,
                essential: true,
            },
        );
    }, [framePadding]);

    const focusTargetRef = useRef({ allCoords, telemetryFix });
    focusTargetRef.current = { allCoords, telemetryFix };
    const lastFocusKey = useRef<string | undefined>(undefined);
    /**
     * A FRAME COMPUTED BEFORE THE ROUTE ARRIVES IS NOT A FRAME.
     *
     * focusKey resolves from the trip selector, which lands well before the
     * passage line does — they are separate fetches. This effect used to mark
     * the key done regardless, so the run that found `coords` empty fell to the
     * telemetry fallback (flyTo the boat at z12) and then NEVER RAN AGAIN when
     * the route turned up. The result was a passage framed on its first
     * hundred metres, with the plan line running off the top of the screen.
     *
     * Shane 2026-09-05, on a Newport → Lady Musgrave passage: "we are going to
     * lady musgrave, but it does not show up on the current map on the public
     * page. is this possible. or is it going to cost too much moula????" It
     * costs nothing — the imagery was already there and already paid for. The
     * camera was pointed at the wrong place.
     *
     * So the fallback is PROVISIONAL: it moves the camera but does not claim
     * the key, and `framable` in the deps brings the effect back the moment
     * there is real geometry to fit.
     */
    const framable = allCoords.length > 1;
    useEffect(() => {
        if (
            !MAPBOX_TOKEN ||
            focusKey === undefined ||
            lastFocusKey.current === focusKey ||
            exploredFocusKey.current === focusKey
        )
            return;

        let cancelled = false;
        let mapRefRetries = 0;
        let retryTimer: ReturnType<typeof setTimeout> | undefined;
        const applyFocus = (): void => {
            if (cancelled || exploredFocusKey.current === focusKey) return;
            const map = mapRef.current;
            if (!map) {
                // A selector can resolve on the same commit as map creation,
                // and react-map-gl attaches its ref only once mapbox-gl has
                // loaded. On a cold cache or a busy phone that is well past one
                // short retry, and a missed frame here is never retried: the
                // camera would stay on the mount-time view, which knows
                // nothing of the floating header and leaves the boat under
                // it. So keep asking, every 100 ms for up to 10 s. Nothing
                // can be explored before the map exists, so this never
                // overrides a viewer.
                if (mapRefRetries < 100) {
                    mapRefRetries += 1;
                    retryTimer = setTimeout(applyFocus, 100);
                }
                return;
            }
            const { allCoords: coords, telemetryFix: fallback } = focusTargetRef.current;
            if (coords.length >= 1) lastFocusKey.current = focusKey;
            if (coords.length === 1) {
                map.flyTo({ center: coords[0], zoom: 10, duration: 700, essential: true });
                return;
            }
            if (coords.length > 1) {
                let minLon = Infinity;
                let minLat = Infinity;
                let maxLon = -Infinity;
                let maxLat = -Infinity;
                for (const [lon, lat] of coords) {
                    minLon = Math.min(minLon, lon);
                    minLat = Math.min(minLat, lat);
                    maxLon = Math.max(maxLon, lon);
                    maxLat = Math.max(maxLat, lat);
                }
                const bounds: [[number, number], [number, number]] = [
                    [minLon, minLat],
                    [maxLon, maxLat],
                ];
                map.fitBounds(bounds, { padding: framePadding(), duration: 700, maxZoom: 12, essential: true });
                return;
            }
            // Provisional only — the key stays unclaimed above, so this is
            // replaced by a real fit as soon as the route or track lands.
            if (fallback) map.flyTo({ center: fallback, zoom: 12, duration: 700, essential: true });
        };

        const frame = requestAnimationFrame(applyFocus);
        return () => {
            cancelled = true;
            cancelAnimationFrame(frame);
            if (retryTimer !== undefined) clearTimeout(retryTimer);
        };
    }, [focusKey, framable, framePadding]);

    // Selecting an entry deliberately does NOT move the camera — the whole
    // track is already framed, and viewers want to keep the overview.

    const nowMs = now.getTime();
    const lastFix = latestTrackPoint ? [latestTrackPoint.lon, latestTrackPoint.lat] : telemetryFix;
    // Keep the point for spatial context, but remove current/live styling as
    // soon as transport or timestamp freshness fails. This is deliberately
    // independent of the frozen `is_last_known` bit in the last payload.
    // publicLastKnownLabel reads only the position fields (lat, lon,
    // updated_at, is_last_known), which is all this prop carries.
    const lastKnownAgeLabel = publicLastKnownLabel({
        latest: latestTrackPoint,
        telemetry,
        connectionLost,
        nowMs,
    });
    const positionIsLive = lastFix !== undefined && lastKnownAgeLabel === null;
    const boatPoint = lastFix ? screenPoint(lastFix[0], lastFix[1]) : null;
    // The boat's flag: 22 px ring, 8 px / 10 px off it (pv-ownship, pv-flag).
    const hasFlag = !!(vesselName || lastKnownAgeLabel);
    const boatFlag = clearLabelSide(boatPoint, labelFrame, {
        half: 11,
        gapV: 8,
        gapH: 10,
        w: Math.min(200, Math.max((vesselName?.length ?? 0) * 8.5, (lastKnownAgeLabel?.length ?? 0) * 6.5) + 22),
        h: 12 + (vesselName ? 18 : 0) + (lastKnownAgeLabel ? 16 : 0) + (vesselName && lastKnownAgeLabel ? 1 : 0),
    });

    // Lifecycle waypoint labels: place on line one, the server's qualifier
    // quiet on line two. A label within 40 px of the boat stands down so it
    // never overprints her flag, and the whole-journey view hides them all
    // until the viewer zooms in past 9. The rest keep clear of the chrome
    // and of the flag. Until the camera first settles there is no frame to
    // measure against (and the opening flight moves every mark), so the
    // labels wait for it rather than flash over the flag.
    const waypointLabels = shownWaypoints.map((w) => {
        const { place, role } = splitWaypointName(w.name);
        const p = screenPoint(w.lon, w.lat);
        const nearBoat = !!p && !!boatPoint && Math.hypot(p.x - boatPoint.x, p.y - boatPoint.y) < 40;
        const quiet = labelFrame === null || nearBoat || (allTrips && labelFrame.zoom < 9);
        // 12 px diamond box, 6 px / 8 px off it (pv-wp, pv-wp__label).
        const { side } = clearLabelSide(
            p,
            labelFrame,
            { half: 6, gapV: 6, gapH: 8, w: Math.max(place.length, role?.length ?? 0) * 7 + 18, h: role ? 40 : 24 },
            hasFlag && boatFlag.rect ? [boatFlag.rect] : [],
        );
        return { place, role, side, quiet };
    });

    // Automatically display contacts authorized by the skipper and scoped to
    // the boat by the API. Old browser declutter preferences no longer hide them.
    const nearbyVesselDisplays = useMemo(
        () =>
            nearbyVessels
                .map((vessel) => ({
                    vessel,
                    freshness: classifyNearbyVesselFreshness(vessel.updated_at, nowMs, connectionLost),
                    ageLabel: formatPublicAge(vessel.updated_at, nowMs),
                }))
                .filter((item) => item.freshness !== 'expired'),
        [connectionLost, nearbyVessels, nowMs],
    );
    const selectedVesselDisplay = selectedVessel
        ? (nearbyVesselDisplays.find((item) => item.vessel.mmsi === selectedVessel.mmsi) ?? null)
        : null;
    const popupVessel = selectedVesselDisplay?.vessel ?? null;

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
            <div className="pv-map-empty flex h-full w-full items-center justify-center px-6 text-center">
                Map unavailable — Mapbox token not configured for this build.
            </div>
        );
    }

    return (
        <div
            className={`public-voyage-map pv-map relative h-full w-full ${styleMode === 'satellite' ? 'voyage-log-sat-bright' : ''}`}
        >
            <Map
                ref={mapRef}
                mapboxAccessToken={MAPBOX_TOKEN}
                initialViewState={initialViewState}
                mapStyle={STYLES[styleMode]}
                onStyleData={() => {
                    const map = mapRef.current?.getMap();
                    if (map) installMusgraveImagery(map);
                }}
                onLoad={readLabelFrame}
                onMoveEnd={readLabelFrame}
                onResize={readLabelFrame}
                /* Flat, by request (Shane 2026-09-02: "i prefer flat earth
                   claude, you know like it really is"). The globe was tried
                   here for one afternoon; a chart is a chart. Its atmosphere
                   went with it — with no curve to wrap, fog only added haze
                   to imagery we had just finished de-hazing. */
                projection="mercator"
                maxZoom={20}
                attributionControl={false}
            >
                {/* The default strip, plus the AIS credit. AISHub gave written
                    permission for public display on 2026-09-02 ("we will
                    appreciate it if you credit AISHub but that's not mandatory")
                    — so this is a courtesy we chose, and it stays. Compact so
                    it folds to an (i) on a phone rather than eating the map. */}
                <AttributionControl customAttribution="AIS data: AISHub" compact position="bottom-right" />

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
                    attribution="© MapTiler © OpenStreetMap contributors"
                >
                    <Layer
                        id="bathy-ocean-layer"
                        type="raster"
                        layout={{ visibility: styleMode === 'satellite' && !destinationDetail ? 'visible' : 'none' }}
                        paint={{
                            // The MapTiler Ocean raster is a FULL basemap — it
                            // paints land as well as sea — so a flat tint at
                            // any strength greys out the satellite imagery
                            // underneath and the page looks like a chart with
                            // a photo hiding behind it.
                            //
                            // So it now fades with zoom, which is also how a
                            // sailor actually uses it: offshore and zoomed out
                            // the depth structure IS the story, and there is
                            // nothing to see in the imagery but blue; zoomed
                            // into an anchorage the imagery is the story —
                            // reefs, sand, the colour of the water you are
                            // about to drop the pick into — so the tint gets
                            // out of the way almost entirely.
                            'raster-opacity': ['interpolate', ['linear'], ['zoom'], 3, 0.32, 6, 0.26, 9, 0.12, 12, 0],
                            // Kept DELIBERATELY faint at every zoom and gone
                            // entirely by 12. This raster has no transparency
                            // over land, so any strength at all veils the
                            // continents — which is precisely the "milky
                            // layer" Shane saw (2026-09-02). It now reads as a
                            // hint of depth structure on open water, where the
                            // imagery is featureless blue anyway, and hands
                            // the coast back to the photography, which already
                            // shows the reef shallows better than a tint can.
                            // Warmed toward teal for what little of it shows.
                            'raster-saturation': 0.3,
                            'raster-hue-rotate': -14,
                            'raster-fade-duration': 0,
                        }}
                    />
                </Source>

                {/* Day/night terminator — translucent shadow over the night side */}
                <Source id="night-side" type="geojson" data={nightGeojson}>
                    <Layer
                        id="night-fill"
                        type="fill"
                        paint={{
                            'fill-color': '#000814',
                            'fill-opacity': destinationDetail
                                ? 0
                                : ['interpolate', ['linear'], ['zoom'], 6, 0.32, 10, 0.08, 12, 0],
                        }}
                    />
                </Source>

                {/* The followed route — the one route the boat is currently
                    following (Shane 2026-07-17). Drawn UNDER the live track so
                    the boat's actual path reads on top.

                    Glow + solid core instead of the old dashed hairline (Shane
                    2026-07-23: "change the route from a dashed line to something
                    more hip"), matching the in-app tracer line so the public
                    page reads as the same product. Violet keeps it distinct
                    from the teal sailed track. */}
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
                        /* The sailed track is the hero line, so it carries
                           the brightest colour on the page: a luminous teal
                           that sits against the warmer water tint instead of
                           disappearing into it (the old sky-blue was the same
                           family as the sea). */
                        paint={{ 'line-color': '#2dd4bf', 'line-width': 13, 'line-blur': 8, 'line-opacity': 0.38 }}
                    />
                    <Layer
                        id="track-line"
                        type="line"
                        layout={{ 'line-cap': 'round', 'line-join': 'round' }}
                        paint={{ 'line-color': '#5eead4', 'line-width': 2.8, 'line-opacity': 0.97 }}
                    />
                </Source>

                {/* Course-change marks — a dot at each major alteration
                    (≥30°) on the sailed line, so the story of the passage
                    reads at a glance: where the tacks and turns happened.
                    Ink-filled with a teal rim, so the turns read as part of
                    the track itself (the map key draws the same dot on the
                    track swatch). */}
                {courseChangeGeojson && (
                    <Source id="course-changes" type="geojson" data={courseChangeGeojson}>
                        <Layer
                            id="course-change-dots"
                            type="circle"
                            paint={{
                                'circle-radius': 3.5,
                                'circle-color': '#0b1220',
                                'circle-stroke-color': '#5eead4',
                                'circle-stroke-width': 2,
                                'circle-opacity': 0.95,
                            }}
                        />
                    </Source>
                )}

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

                {/* ...and the plan's origin gets the words, so the answer to
                    "where does this voyage start?" is on the line rather than
                    beside it. Emerald to match the start dot it sits on. */}
                {hasPlanLine && passageLine && (
                    <Marker longitude={passageLine[0][0]} latitude={passageLine[0][1]} anchor="top">
                        <div className="pv-plan-start">Voyage Start</div>
                    </Marker>
                )}

                {destinationTarget && (
                    <Marker
                        longitude={destinationTarget.center[0]}
                        latitude={destinationTarget.center[1]}
                        anchor="bottom"
                    >
                        <button
                            type="button"
                            onClick={exploreDestination}
                            aria-label={'Explore destination ' + destinationTarget.name + ' in satellite detail'}
                            className="pv-dest pv-glass mb-2 flex h-11 min-h-[44px] w-11 min-w-[44px] items-center justify-center lg:h-auto lg:w-auto lg:max-w-56 lg:flex-col lg:items-start lg:px-3 lg:py-2 lg:text-left"
                        >
                            <svg
                                aria-hidden="true"
                                className="h-5 w-5 lg:hidden"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.8"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <path d="M5 21V3m0 1c5-4 9 4 14 0v10c-5 4-9-4-14 0" />
                            </svg>
                            <span className="pv-dest__name hidden max-w-full truncate lg:block">
                                {destinationTarget.name}
                            </span>
                            <span className="pv-dest__sub hidden lg:block">Explore coast &amp; reef ↗</span>
                        </button>
                    </Marker>
                )}

                {/* Named waypoints — the marks the skipper dropped under way.
                    A small diamond with the name label; the auto breadcrumb
                    dots are intentionally gone (owner ask 2026-07-04). The
                    label is positioned off the diamond, so the diamond sits
                    exactly on the coordinate and the label flips inward near
                    the map's edges. */}
                {shownWaypoints.map((w, i) => (
                    <Marker key={`wp-${i}`} longitude={w.lon} latitude={w.lat} anchor="center">
                        <div
                            className="pv-wp"
                            data-side={waypointLabels[i].side}
                            data-quiet={waypointLabels[i].quiet ? 'true' : undefined}
                        >
                            <span className="pv-wp__diamond" aria-hidden="true" />
                            <span className="pv-wp__label">
                                <span className="pv-wp__place">{waypointLabels[i].place}</span>
                                {waypointLabels[i].role && (
                                    <span className="pv-wp__role">{waypointLabels[i].role}</span>
                                )}
                            </span>
                        </div>
                    </Marker>
                ))}

                {/* Diary entry pins — camera badge if it carries photos.
                    When the entry is the one selected in the sidebar, the
                    pin gets a pulsing halo and a lit rim (camera badge
                    variant) or an intensified drop-shadow-sm (emoji variant)
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
                                className={`pv-pin-btn relative flex min-h-[44px] min-w-[44px] items-center justify-center cursor-pointer leading-none -translate-y-0.5 transition-transform hover:scale-110 active:scale-95 ${
                                    isSelected ? 'scale-125' : ''
                                }`}
                            >
                                {/* Halo — only renders for the selected pin. Sits
                                    behind the badge/emoji and pulses to draw the
                                    eye. */}
                                {isSelected && <span aria-hidden="true" className="pv-pin-halo" />}
                                {hasPhotos ? (
                                    <span
                                        className="pv-pin relative flex items-center justify-center"
                                        data-selected={isSelected ? 'true' : undefined}
                                        style={{ '--pv-pin-ring': moodHex } as React.CSSProperties}
                                    >
                                        <svg
                                            aria-hidden="true"
                                            width="16"
                                            height="16"
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="1.8"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                        >
                                            <path d="M4 8h3l1.6-2.4h6.8L17 8h3v11H4z" />
                                            <circle cx="12" cy="13.5" r="3.3" />
                                        </svg>
                                    </span>
                                ) : (
                                    <span
                                        className="pv-pin-emoji relative"
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
                {nearbyVesselDisplays.map(({ vessel: v, freshness, ageLabel }) => {
                    const bearing = v.cog ?? v.heading ?? 0;
                    const isLastKnown = freshness === 'last-known';
                    const fill = isLastKnown ? '#64748b' : vesselColor(v.ship_type);
                    const contactName = v.name || v.mmsi;
                    return (
                        <Marker key={v.mmsi} longitude={v.lon} latitude={v.lat} anchor="center" rotation={bearing}>
                            <button
                                type="button"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedVessel(v);
                                }}
                                aria-label={
                                    isLastKnown
                                        ? `AIS contact ${contactName}, last known ${ageLabel}`
                                        : `AIS contact ${contactName}, updated ${ageLabel}`
                                }
                                className={`cursor-pointer transition-transform hover:scale-125 ${
                                    isLastKnown ? 'opacity-45' : ''
                                }`}
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

                {/* Latest known position — pulses only while independently fresh.
                    Rendered after every other marker, and lifted, so the boat
                    always sits on top. Live: a teal ring that pings. Last
                    known: a still grey ring, captioned with its age, because a
                    stale fix should not animate like a boat under way. */}
                {lastFix && (
                    <Marker longitude={lastFix[0]} latitude={lastFix[1]} anchor="center" style={{ zIndex: 1 }}>
                        <div
                            className="pv-ownship"
                            data-state={positionIsLive ? 'live' : 'last-known'}
                            data-side={boatFlag.side}
                        >
                            <span className="pv-ownship__ring" aria-hidden="true" />
                            {(vesselName || lastKnownAgeLabel) && (
                                <span className="pv-flag pv-glass">
                                    {vesselName && <span className="pv-flag__name">{vesselName}</span>}
                                    {lastKnownAgeLabel && (
                                        <span className="pv-flag__age pv-num">{lastKnownAgeLabel}</span>
                                    )}
                                </span>
                            )}
                        </div>
                    </Marker>
                )}

                {/* AIS detail popup */}
                {popupVessel && selectedVesselDisplay && (
                    <Popup
                        longitude={popupVessel.lon}
                        latitude={popupVessel.lat}
                        anchor="bottom"
                        offset={14}
                        closeButton={false}
                        closeOnClick
                        onClose={() => setSelectedVessel(null)}
                        className="voyage-log-ais-popup"
                    >
                        <div className="pv-popup">
                            <div className="mb-1.5 flex items-center gap-2">
                                {popupVessel.thumbnail_url ? (
                                    <img
                                        src={popupVessel.thumbnail_url}
                                        alt=""
                                        className="h-8 w-8 shrink-0 rounded-sm border border-white/10 object-cover"
                                    />
                                ) : (
                                    <span
                                        className="h-2 w-2 shrink-0 rounded-full"
                                        style={{ backgroundColor: vesselColor(popupVessel.ship_type) }}
                                    />
                                )}
                                <p className="pv-popup__name truncate">
                                    {popupVessel.flag_emoji ? `${popupVessel.flag_emoji} ` : ''}
                                    {popupVessel.name || `MMSI ${popupVessel.mmsi}`}
                                </p>
                            </div>
                            <p
                                className="pv-popup__fresh mb-1.5"
                                data-fresh={selectedVesselDisplay.freshness === 'fresh' ? 'true' : undefined}
                            >
                                {selectedVesselDisplay.freshness === 'fresh' ? 'Updated' : 'Last known'} ·{' '}
                                {selectedVesselDisplay.ageLabel}
                            </p>
                            {(shipTypeLabel(popupVessel.ship_type) || popupVessel.loa || popupVessel.flag_country) && (
                                <p className="pv-popup__type mb-1.5 truncate">
                                    {[
                                        /* A word, never the raw AIS code — "36" tells a punter nothing. */
                                        shipTypeLabel(popupVessel.ship_type),
                                        popupVessel.loa ? `${Math.round(popupVessel.loa)} m` : null,
                                        popupVessel.flag_country,
                                    ]
                                        .filter(Boolean)
                                        .join(' · ')}
                                </p>
                            )}
                            <dl className="pv-popup__grid grid grid-cols-2 gap-x-3 gap-y-0.5">
                                {popupVessel.sog != null && (
                                    <>
                                        <dt>SOG</dt>
                                        <dd>{popupVessel.sog.toFixed(1)} kt</dd>
                                    </>
                                )}
                                {popupVessel.cog != null && (
                                    <>
                                        <dt>COG</dt>
                                        <dd>{Math.round(popupVessel.cog)}°</dd>
                                    </>
                                )}
                                {popupVessel.destination && (
                                    <>
                                        <dt>To</dt>
                                        <dd className="truncate">{popupVessel.destination}</dd>
                                    </>
                                )}
                                {popupVessel.call_sign && (
                                    <>
                                        <dt>Call</dt>
                                        <dd>{popupVessel.call_sign}</dd>
                                    </>
                                )}
                            </dl>
                        </div>
                    </Popup>
                )}
            </Map>

            {/* Bottom-left notes: the destination close-up and the map key.
                Both sit above the reserved credits band and step up with the
                rest of the chrome when the (i) credits are opened. */}
            {(destinationTarget || trackCoords.length >= 2 || passageGeojson) && (
                <div ref={notesRef} className="pv-map-notes absolute flex">
                    {destinationTarget && (
                        <button
                            type="button"
                            onClick={exploreDestination}
                            aria-label={'Satellite close-up of ' + destinationTarget.name}
                            className="pv-pill pv-glass flex min-h-12 max-w-full items-center gap-2"
                        >
                            <span aria-hidden="true">⌕</span>
                            <span className="truncate">Explore {destinationTarget.name}</span>
                        </button>
                    )}
                    {/* Map key — what the lines mean (owner ask 2026-08-03).
                        Rows render only for layers actually on the map. The
                        course-change dot is drawn into the track swatch, and
                        on phones the track row carries the passage summary
                        (the desktop hero shows it as tiles instead). */}
                    {(passageGeojson || trackCoords.length >= 2) && (
                        <div className="pv-key pv-glass" role="group" aria-label="Map key">
                            {passageGeojson && (
                                <div className="pv-key__row">
                                    <span className="pv-swatch pv-swatch--route" aria-hidden="true" />
                                    <span>Planned route</span>
                                </div>
                            )}
                            {trackCoords.length >= 2 && (
                                <div className="pv-key__row">
                                    <span className="pv-swatch pv-swatch--track" aria-hidden="true" />
                                    <span>{allTrips ? 'Trips sailed' : 'Track sailed'}</span>
                                    {keySummary && (
                                        <span className="pv-key__stats pv-num lg:hidden">
                                            <span className="pv-key__sep">· </span>
                                            {keySummary}
                                        </span>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* Map controls — one smoked-glass cluster, bottom-right, above the
                reserved credits band so the Mapbox attribution strip is never
                covered: [Map|Sat] and [+|−] on top, then [Expand][Locate].
                Expand/Restore belongs to ThalassaDashboard and takes the empty
                lower-left cell. Custom zoom buttons replace Mapbox's white
                NavigationControl so every control shares one mould. */}
            <div ref={railRef} className="pv-rail absolute grid" role="group" aria-label="Map controls">
                <div
                    className="pv-capsule pv-capsule--basemap pv-glass flex flex-col"
                    role="group"
                    aria-label="Basemap"
                >
                    {(['dark', 'satellite'] as StyleMode[]).map((m) => (
                        <button
                            key={m}
                            type="button"
                            onClick={() => setStyleMode(m)}
                            aria-label={`${m === 'dark' ? 'Map' : 'Satellite'} basemap`}
                            aria-pressed={styleMode === m}
                            title={m === 'dark' ? 'Map' : 'Satellite'}
                            className="pv-ctrl flex flex-col items-center justify-center gap-0.5"
                        >
                            {m === 'dark' ? (
                                <svg
                                    aria-hidden="true"
                                    width="16"
                                    height="16"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.8"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                >
                                    <path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2V5Z" />
                                    <path d="M9 3v16M15 5v16" />
                                </svg>
                            ) : (
                                <svg
                                    aria-hidden="true"
                                    width="16"
                                    height="16"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.8"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                >
                                    <circle cx="12" cy="12" r="8" />
                                    <ellipse cx="12" cy="12" rx="11" ry="4" transform="rotate(-25 12 12)" />
                                </svg>
                            )}
                            <span className="pv-ctrl__label">{m === 'dark' ? 'Map' : 'Sat'}</span>
                        </button>
                    ))}
                </div>
                <div className="pv-capsule pv-capsule--zoom pv-glass flex flex-col" role="group" aria-label="Zoom">
                    <button
                        type="button"
                        onClick={() => mapRef.current?.zoomIn({ duration: 250 })}
                        aria-label="Zoom in"
                        title="Zoom in"
                        className="pv-ctrl flex items-center justify-center"
                    >
                        <svg
                            aria-hidden="true"
                            width="20"
                            height="20"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                        >
                            <path d="M12 5v14M5 12h14" />
                        </svg>
                    </button>
                    <button
                        type="button"
                        onClick={() => mapRef.current?.zoomOut({ duration: 250 })}
                        aria-label="Zoom out"
                        title="Zoom out"
                        className="pv-ctrl flex items-center justify-center"
                    >
                        <svg
                            aria-hidden="true"
                            width="20"
                            height="20"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                        >
                            <path d="M5 12h14" />
                        </svg>
                    </button>
                </div>
                {/* Locate — one tap frames the whole voyage: the complete
                    route, the track sailed so far, and the boat's last known
                    position. */}
                {(allCoords.length > 0 || telemetryFix) && (
                    <button
                        type="button"
                        onClick={frameWholeVoyage}
                        aria-label={
                            allTrips
                                ? 'Show all trips and diary locations'
                                : "Show the whole voyage — centre on the boat's last known position with the full route in view"
                        }
                        title={allTrips ? 'Show all trips and diary locations' : 'Show the whole voyage'}
                        className="pv-ctrl pv-ctrl--solo pv-glass pv-locate flex items-center justify-center"
                    >
                        <svg
                            className="h-6 w-6"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={1.8}
                            aria-hidden="true"
                        >
                            <circle cx="12" cy="12" r="3.2" />
                            <circle cx="12" cy="12" r="7.2" opacity="0.45" />
                            <path strokeLinecap="round" d="M12 2.2v2.6M12 19.2v2.6M2.2 12h2.6M19.2 12h2.6" />
                        </svg>
                    </button>
                )}
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
        </div>
    );
}

// Memoised: the public dashboard re-renders on a 30 s clock and this owns the
// whole Mapbox tree — with stable props it must not re-reconcile on every tick.
export default React.memo(MapContainer);
