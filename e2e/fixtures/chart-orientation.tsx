// The chart turned (127-11a, "the chart can turn"): what is drawn on it stays
// right at a fixed bearing. Real Mapbox projection; the real
// MapboxVelocityOverlay on a synthetic uniform wind grid; the production
// own-ship marker (its DOM, its painters and its options); the production AIS
// target layers. Fictional places, no tiles, no GPS, no credentials.
//
// Mapbox paints nothing without its session check (no token here), but it
// projects, places markers and places symbols, which is what these read. The
// wind field is a Leaflet canvas in a DOM div, so it renders for real.
//
// Query: scene=wind|marker|sart|arrow|run, bearing=<deg> (the camera at load,
// as a mode would turn it), mode=turning|north (whether a turning mode is on;
// default: turning when the bearing is not 0), state=underway|stopped (marker).
//
// 127-11b ("the modes"): scene=arrow mounts the production north arrow beside
// the chart in Heading up, her compass reading heading=<deg> on her bus;
// scene=run is a simulated two-minute Track-up run (the production controller,
// marker and wind field together at the fjord), driven by run().
// scene=interrupt&kind=jump|fit: a camera move lands while the controller's
// turn is still easing, in real motion (interrupted()). scene=snap&snap=<deg>:
// a chart turned to 5°, built with that bearingSnap, for a mouse pan.
//
// Places, worldwide: the wind over a Tromsø-like fjord (70°N), the boat in a
// Chesapeake-like bay, the beacon on the antimeridian by a Taveuni-like reef.
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { mapboxWindField } from '../../components/map/MapboxWindField';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MapboxVelocityOverlay } from '../../components/map/MapboxVelocityOverlay';
import {
    chartFitBearing,
    isOrientationEvent,
    orientChart,
    setChartOrientation,
} from '../../components/map/chartOrientation';
import { ChartOrientationArrow } from '../../components/map/ChartOrientationControl';
import { registerChartMap } from '../../components/map/chartMapRegistry';
import { publishOwnshipMotion } from '../../components/map/ownshipMotion';
import {
    createVesselElement,
    OWNSHIP_MARKER_OPTIONS,
    presentOwnshipDirection,
    presentOwnshipStatus,
    presentOwnshipWind,
    turnOwnshipArrows,
} from '../../components/map/useVesselTracker';
import { boatWindChipFor } from '../../components/map/boatWindReadout';
import {
    AIS_DISTRESS_GEOMETRY,
    AIS_DISTRESS_ICON_PX,
    AIS_SART_LAYER,
    AIS_TARGET_ICON_LAYERS,
    registerAisDistressSymbol,
} from '../../components/map/aisDistressSymbol';
import { targetPresentation } from '../../components/map/useAisStreamLayer';
import type { WindGrid } from '../../services/weather/windGridEncoding';

const params = new URLSearchParams(location.search);
const scene = params.get('scene') ?? 'wind';
const bearing = Number(params.get('bearing') ?? 0) || 0;
const turning = (params.get('mode') ?? (bearing ? 'turning' : 'north')) === 'turning';
const state = params.get('state') ?? 'underway';

const FJORD: [number, number] = [18.96, 69.65];
const BAY: [number, number] = [-76.4, 38.6];
const REEF: [number, number] = [179.95, -16.8];
/** A made-up Brittany-like headland, and a broad Atlantic view that holds it. */
const HEADLAND: [number, number] = [-4.77, 48.38];
const ATLANTIC: [number, number] = [-20, 45];
/** Her in the fjord, on screen at its opening camera. */
const FJORD_HER: [number, number] = [19.0, 69.66];
const kind = params.get('kind') ?? 'jump';
/** Where her marker is drawn: the bay, or the fjord for the run (under the wind field). */
const HOME: [number, number] = scene === 'run' ? FJORD : BAY;

// As 127-11b's controller will: the mode first, then the camera.
setChartOrientation({ turning, target: turning ? bearing : null });

const centre =
    scene === 'wind' || scene === 'run'
        ? FJORD
        : scene === 'sart'
          ? REEF
          : scene === 'interrupt'
            ? kind === 'jump'
                ? ATLANTIC
                : FJORD
            : BAY;
const map = new mapboxgl.Map({
    container: 'map',
    center: centre,
    zoom: scene === 'wind' || scene === 'run' ? 7 : scene === 'interrupt' ? (kind === 'jump' ? 3.2 : 9) : 14,
    bearing: scene === 'snap' ? 5 : bearing,
    ...(scene === 'snap' && { bearingSnap: Number(params.get('snap') ?? 7) }),
    attributionControl: false,
    testMode: true,
    fadeDuration: 0,
    style: {
        version: 8,
        sources: {},
        layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#0b1220' } }],
    },
} as mapboxgl.MapOptions);

const settle = () =>
    new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

/** A southerly (from 180°, so the air goes north) at 12 m/s over a 0.5° grid round the fjord. */
function southerly(): WindGrid {
    const n = 21;
    const lats = Array.from({ length: n }, (_, i) => FJORD[1] - 5 + i * 0.5);
    const lons = Array.from({ length: n }, (_, i) => FJORD[0] - 5 + i * 0.5);
    const frame = () => ({
        u: new Float32Array(n * n).fill(0),
        v: new Float32Array(n * n).fill(12),
        speed: new Float32Array(n * n).fill(12),
    });
    const a = frame();
    const b = frame();
    return {
        u: [a.u, b.u],
        v: [a.v, b.v],
        speed: [a.speed, b.speed],
        width: n,
        height: n,
        lats,
        lons,
        north: lats[n - 1],
        south: lats[0],
        west: lons[0],
        east: lons[n - 1],
        totalHours: 2,
        refTime: 'fixture',
    };
}

/** The wind field's div: the overlay's Leaflet container over the chart. */
const fieldDiv = () =>
    [...map.getContainer().children].find(
        (el) => (el as HTMLElement).style.zIndex === '400' && !(el as HTMLElement).dataset.closeInWind,
    ) as HTMLDivElement | undefined;

/**
 * Where five places land: Mapbox's projection, and where the wind field's
 * north-up Leaflet map draws them on screen (a probe element at Leaflet's own
 * container point, measured after the browser applies the div's transform).
 */
async function windProbes() {
    for (let i = 0; i < 100 && !(fieldDiv()?.style.opacity === '1' && mapboxWindField(map)); i++) {
        await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 400));
    await settle();
    const div = fieldDiv()!;
    const field = mapboxWindField(map)!;
    const canvas = field.canvas;
    const box = map.getContainer().getBoundingClientRect();
    const c = map.getCenter();
    const out = [];
    for (const [dLng, dLat] of [
        [0, 0],
        [0.6, 0.3],
        [-0.6, 0.3],
        [0.5, -0.4],
        [-0.4, -0.35],
    ]) {
        const geo = { lng: c.lng + dLng, lat: c.lat + dLat };
        const at = field.framePoint([geo.lng, geo.lat]);
        const probe = document.createElement('div');
        probe.style.cssText = `position:absolute;left:${at.x - 1}px;top:${at.y - 1}px;width:2px;height:2px;`;
        const surface = document.createElement('div');
        surface.style.cssText = canvas.style.cssText;
        surface.appendChild(probe);
        div.appendChild(surface);
        const r = probe.getBoundingClientRect();
        surface.remove();
        const p = map.project([geo.lng, geo.lat]);
        out.push({
            geo,
            mapbox: { x: box.left + p.x, y: box.top + p.y },
            css: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
        });
    }
    return {
        probes: out,
        div: {
            inset: div.style.inset,
            width: canvas.style.width,
            height: canvas.style.height,
            transform: canvas.style.transform,
        },
        view: { width: box.width, height: box.height },
    };
}

/** Turn the chart as a mode would: an ease with the orientation mark, then the settle. */
async function turn(to: number) {
    await new Promise<void>((resolve) => {
        map.once('moveend', () => resolve());
        map.easeTo({ bearing: to, duration: 0 }, { thalassaOrientation: true });
    });
}

// ── The boat: the production marker, painted by the production painters ──
function boat() {
    const el = createVesselElement();
    const now = Date.now();
    const underway = state === 'underway';
    presentOwnshipStatus(
        el,
        { label: underway ? '6.2 kts' : 'Stopped', anchorTone: null, anchorNote: null },
        { kind: 'live', at: now, ageMs: 0 },
    );
    presentOwnshipDirection(
        el,
        underway ? { degrees: 135, source: 'course' } : { degrees: null, source: 'unknown' },
        map.getBearing(),
    );
    presentOwnshipWind(
        el,
        boatWindChipFor(
            { wind: { kt: 14, fromDeg: 200, stale: false }, boat: { crewOwnerId: null }, fieldShowsHers: false },
            { kind: 'boat', crewOwnerId: null },
            'kts',
        ),
        map.getBearing(),
    );
    new mapboxgl.Marker({ element: el, ...OWNSHIP_MARKER_OPTIONS }).setLngLat(HOME).addTo(map);
    // As useVesselTracker does: her arrows stay true while the chart turns.
    map.on('rotate', () => turnOwnshipArrows(el, map.getBearing()));
}

function measureBoat() {
    const root = document.querySelector('.vessel-tracker-marker')!;
    const rect = (sel: string) => {
        const b = root.querySelector(sel)!.getBoundingClientRect();
        return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height };
    };
    const fixBox = root.getBoundingClientRect();
    const fix = { x: fixBox.left + fixBox.width / 2, y: fixBox.top + fixBox.height / 2 };
    // Where her course (135°T) runs on this screen, by the chart's own projection.
    const ahead = map.project([
        HOME[0] + (0.001 * Math.sin((135 * Math.PI) / 180)) / Math.cos((HOME[1] * Math.PI) / 180),
        HOME[1] + 0.001 * Math.cos((135 * Math.PI) / 180),
    ]);
    const here = map.project(HOME);
    const screenCourse = ((Math.atan2(ahead.x - here.x, -(ahead.y - here.y)) * 180) / Math.PI + 360) % 360;
    // The hull's own on-screen turn (the root is upright, so the arrow's is the whole of it).
    const m = new DOMMatrix(getComputedStyle(root.querySelector('.vessel-arrow')!).transform);
    const hullDeg = ((Math.atan2(m.b, m.a) * 180) / Math.PI + 360) % 360;
    const w = new DOMMatrix(getComputedStyle(root.querySelector('.vessel-wind-arrow')!).transform);
    const windDeg = ((Math.atan2(w.b, w.a) * 180) / Math.PI + 360) % 360;
    // Her wind blows to 020°T: where that runs on screen.
    const down = map.project([
        HOME[0] + (0.001 * Math.sin((20 * Math.PI) / 180)) / Math.cos((HOME[1] * Math.PI) / 180),
        HOME[1] + 0.001 * Math.cos((20 * Math.PI) / 180),
    ]);
    const screenWind = ((Math.atan2(down.x - here.x, -(down.y - here.y)) * 180) / Math.PI + 360) % 360;
    return {
        fix,
        badge: rect('.vessel-sog-badge'),
        chip: rect('.vessel-wind-chip'),
        arrow: rect('.vessel-arrow'),
        text: root.querySelector('.vessel-sog-badge')!.textContent,
        hullDeg,
        screenCourse,
        windDeg,
        screenWind,
    };
}

// ── A distress beacon and a boat, in the production AIS layers ──
function ais() {
    registerAisDistressSymbol(map);
    // A plain boat image for the boat layer (the chart registers its own).
    const boatPx = 48;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = boatPx;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(boatPx / 2, 4);
    ctx.lineTo(boatPx - 12, boatPx - 6);
    ctx.lineTo(12, boatPx - 6);
    ctx.closePath();
    ctx.fill();
    for (const id of ['ais-boat', 'ais-stopped']) {
        map.addImage(id, ctx.getImageData(0, 0, boatPx, boatPx), { sdf: true });
    }
    const now = Date.now();
    const c = map.project(map.getCenter());
    const at = (dx: number) => {
        const ll = map.unproject([c.x + dx, c.y]);
        return [ll.lng, ll.lat];
    };
    const target = (mmsi: number, dx: number, props: Record<string, unknown>) => {
        const properties: Record<string, unknown> = {
            mmsi,
            ...props,
            source: 'local',
            lastUpdated: now - 5_000,
            safetyTextAt: now - 4_000,
            staleMinutes: 0.1,
        };
        Object.assign(properties, targetPresentation(properties));
        return { type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: at(dx) }, properties };
    };
    map.addSource('ais-targets', {
        type: 'geojson',
        data: {
            type: 'FeatureCollection',
            features: [
                target(970_000_701, 0, { navStatus: 14, safetyText: 'SART ACTIVE' }),
                target(228_000_702, 120, { sog: 6, cog: 70, heading: 72, shipType: 36 }),
            ],
        },
    });
    for (const layer of AIS_TARGET_ICON_LAYERS) map.addLayer(layer as unknown as mapboxgl.AnyLayer);
}

async function readAis() {
    await new Promise<void>((resolve) => {
        map.once('idle', () => resolve());
        map.triggerRepaint();
    });
    const placed = (layer: string) =>
        map
            .queryRenderedFeatures(undefined as unknown as mapboxgl.PointLike, { layers: [layer] })
            .map((f) => ({ mmsi: Number(f.properties?.mmsi), iconKind: String(f.properties?.iconKind) }));
    // The ⊗'s arms on screen: diagonal, as IEC 62288 draws it, whatever the bearing.
    const px = 0.8 * AIS_DISTRESS_ICON_PX;
    const g = AIS_DISTRESS_GEOMETRY;
    const probe = (dx: number, dy: number) => {
        const dpr = window.devicePixelRatio || 1;
        const src = map.getCanvas();
        const copy = document.createElement('canvas');
        copy.width = src.width;
        copy.height = src.height;
        const cx = copy.getContext('2d')!;
        cx.drawImage(src, 0, 0);
        const c = map.project(map.getCenter());
        const d = cx.getImageData(Math.round((c.x + dx) * dpr), Math.round((c.y + dy) * dpr), 1, 1).data;
        return [d[0], d[1], d[2], d[3]];
    };
    const background = probe(0, -200);
    return {
        boats: placed('ais-targets-circle'),
        beacons: placed(AIS_SART_LAYER),
        painted: background[3] > 0,
        armNe: probe(g.armReach * px * 0.6, -g.armReach * px * 0.6),
        straightUp: probe(0, -g.ringRadius * px * 0.5),
    };
}

// ── 127-11b: the north arrow, and a simulated Track-up run ──
const KN = 1.9438444924;
/** Her bus, as the own-ship marker publishes it: a fresh true heading, stopped. */
function busHeading(heading: number, [lon, lat]: [number, number] = HOME) {
    const now = Date.now();
    const metric = (value: number) => ({ value, lastUpdated: now, freshness: 'live' });
    publishOwnshipMotion({
        lane: 'bus',
        lat,
        lon,
        at: now,
        heading: null,
        speed: null,
        instruments: { headingTrue: metric(heading), sog: metric(0) },
        maxAgeMs: 13_000,
    });
}

/** The production arrow beside the chart, in Heading up, her compass on `heading`. */
function arrow() {
    localStorage.setItem('thalassa_chart_orientation_obs_v1', params.get('orient') ?? 'heading');
    registerChartMap(map.getContainer(), map);
    const rail = document.createElement('div');
    rail.style.cssText = 'position:fixed;right:16px;bottom:242px;z-index:500';
    document.body.appendChild(rail);
    createRoot(rail).render(<ChartOrientationArrow active />);
    const heading = Number(params.get('heading') ?? 0);
    busHeading(heading);
    setInterval(() => busHeading(heading), 500);
}

/** Where the arrow's needle points on screen: degrees clockwise from up. */
function needle() {
    const g = document.querySelector<SVGGElement>('button[aria-label^="Chart orientation"] svg g')!;
    const m = g.getScreenCTM()!;
    const at = (x: number, y: number) => new DOMPoint(x, y).matrixTransform(m);
    const tip = at(12, 2);
    const mid = at(12, 12);
    return ((Math.atan2(tip.x - mid.x, -(tip.y - mid.y)) * 180) / Math.PI + 360) % 360;
}

/**
 * Two simulated minutes of Track up from the phone alone: four legs of 30 s
 * (020°, 110°, 200°, 290°: three turns after the first), one fix a second.
 * The clock is the page's, moved a second per fix; the eases are instant
 * (the spec asks for reduced motion). After every ease the wind field is
 * probed, and her badge is measured after every fix.
 */
async function run() {
    const turns: number[] = [];
    map.on('rotatestart', (e: unknown) => {
        if (isOrientationEvent(e)) turns.push(Date.now());
    });
    localStorage.setItem('thalassa_chart_orientation_obs_v1', 'track');
    const ctl = orientChart(map, 'obs', () => ({}));
    const real = Date.now.bind(Date);
    let skew = 0;
    Date.now = () => real() + skew;
    let upright = true;
    let worstProbe = 0;
    for (let s = 0; s < 120; s++) {
        skew += 1000;
        const before = turns.length;
        publishOwnshipMotion({
            lane: 'phone',
            lat: HOME[1],
            lon: HOME[0],
            at: Date.now(),
            heading: [20, 110, 200, 290][Math.floor(s / 30)],
            speed: 6 / KN,
            instruments: {},
            maxAgeMs: 30_000,
        });
        await settle();
        const m = measureBoat();
        if (!(m.badge.width > m.badge.height * 2 && m.badge.left > m.fix.x + 10)) upright = false;
        if (turns.length > before) {
            const { probes } = await windProbes();
            for (const { mapbox, css } of probes)
                worstProbe = Math.max(worstProbe, Math.abs(css.x - mapbox.x), Math.abs(css.y - mapbox.y));
        }
    }
    Date.now = real;
    const bearing = map.getBearing();
    ctl.stop();
    return { eases: turns.length, upright, worstProbe, bearing };
}

/**
 * A camera move that lands while a turn is in flight, in real motion (no
 * reduced motion here). The production controller in Heading up eases the
 * chart to her 120°T; 10° into that ease, the Obs startup camera's jumpTo
 * to her (kind=jump), or a duration-0 whole-route fit that keeps the mode's
 * bearing, as usePassageRouteFrame's (kind=fit), moves the chart. Where the
 * camera and she are right after the move, and 2 s later.
 */
async function interrupted() {
    const her = kind === 'jump' ? HEADLAND : FJORD_HER;
    localStorage.setItem('thalassa_chart_orientation_obs_v1', 'heading');
    // Frames first: a cold software-GL first frame can swallow a whole ease.
    if (!map.loaded()) await new Promise<void>((resolve) => map.once('idle', () => resolve()));
    await settle();
    let ctl: ReturnType<typeof orientChart> | null = null;
    let feed: ReturnType<typeof setInterval> | undefined;
    let midTurn = 0;
    // Up to three tries to catch the ease in the air (10° in, still easing).
    for (let attempt = 0; attempt < 3; attempt++) {
        ctl?.stop();
        clearInterval(feed);
        await settle();
        const turned = new Promise<void>((resolve) => {
            const onRotate = () => {
                if (Math.abs(map.getBearing()) < 10) return;
                map.off('rotate', onRotate);
                resolve();
            };
            map.on('rotate', onRotate);
        });
        ctl = orientChart(map, 'obs', () => ({}));
        busHeading(120, her);
        feed = setInterval(() => busHeading(120, her), 500);
        await turned;
        midTurn = map.getBearing();
        if (map.isMoving() && midTurn < 110) break;
    }
    if (kind === 'jump') map.jumpTo({ center: her, zoom: 14 });
    else
        map.fitBounds(
            [
                [19.2, 69.7],
                [19.6, 69.9],
            ],
            { duration: 0, padding: 40, bearing: chartFitBearing(map) },
        );
    const read = () => {
        const c = map.getCenter();
        const p = map.project(her);
        return { centre: [c.lng, c.lat], zoom: map.getZoom(), her: { x: p.x, y: p.y }, bearing: map.getBearing() };
    };
    const after = read();
    await new Promise((r) => setTimeout(r, 2000));
    const later = read();
    clearInterval(feed);
    ctl?.stop();
    return { midTurn, after, later };
}

map.on('load', () => {
    if (scene === 'wind' || scene === 'run') {
        createRoot(document.createElement('div')).render(
            <MapboxVelocityOverlay mapboxMap={map} visible windGrid={southerly()} windHour={0} />,
        );
    }
    if (scene === 'marker' || scene === 'run') boat();
    else if (scene === 'arrow') arrow();
    else if (scene === 'sart') ais();
    (window as unknown as { __orient: unknown }).__orient = {
        windProbes,
        turn,
        measureBoat,
        readAis,
        needle,
        run,
        interrupted,
        bearing: () => map.getBearing(),
        centre: () => map.getCenter().toArray(),
    };
    document.body.dataset.ready = 'true';
});
