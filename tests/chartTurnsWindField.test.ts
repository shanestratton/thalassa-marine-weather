/**
 * The live wind field stays true when the chart turns (127-11a, audit A1/A3).
 *
 * Shane 2026-10-10: "oh, um add in the course up and north up etc. that is
 * cool to see as well". The live wind is leaflet-velocity on a headless,
 * always-north-up Leaflet map in a div over the chart. Before 11a the div was
 * only translated and scaled, so on a turned chart the whole field slid off
 * the water and flowed the wrong way everywhere but the centre.
 *
 * velocityOverlayTransform is the div's CSS transform about its centre:
 * translate(T) rotate(-B) scale(s). This checks it the way a browser applies
 * it: a north-up Leaflet point, through the parsed transform, must land where
 * a rotation-faithful Mapbox projection draws the same place, within 1 px.
 * Every place is fictional; the views are high-latitude (a Tromsø-like
 * fjord), mid-latitude (a Brittany-like coast) and across 180°.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('leaflet', () => ({ default: {} }));

import { sameSeenAt, velocityOverlayTransform } from '../components/map/MapboxVelocityOverlay';

type Pt = { x: number; y: number };

const W = 390;
const H = 844;

/** Web Mercator in world pixels at a zoom (Mapbox's 512 px tiles; Leaflet's 256 at zoom + 1). */
function mercator(lng: number, lat: number, zoom: number): Pt {
    const world = 512 * Math.pow(2, zoom);
    const y = 0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI);
    return { x: ((lng + 180) / 360) * world, y: y * world };
}

/** Screen-space rotation, CSS sense (clockwise for a positive angle, y down). */
function rotate(p: Pt, deg: number): Pt {
    const a = (deg * Math.PI) / 180;
    return { x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) };
}

/** Mapbox's project() for a camera at `centre`, `zoom`, `bearing` (no pitch, no padding). */
function project(lng: number, lat: number, cam: { lng: number; lat: number; zoom: number; bearing: number }): Pt {
    const p = mercator(lng, lat, cam.zoom);
    const c = mercator(cam.lng, cam.lat, cam.zoom);
    // The chart turned to bearing B draws north-up offsets turned by -B.
    const d = rotate({ x: p.x - c.x, y: p.y - c.y }, -cam.bearing);
    return { x: W / 2 + d.x, y: H / 2 + d.y };
}

/** Apply a CSS transform list (translate/rotate/scale only) about `origin`, as a browser does. */
function applyCss(transform: string, origin: Pt, p: Pt): Pt {
    const ops = [...transform.matchAll(/(translate|rotate|scale)\(([^)]*)\)/g)].map(([, op, args]) => ({
        op,
        args: args.split(',').map((a) => parseFloat(a)),
    }));
    // Each function maps the point in turn, the LAST first (CSS composes left to right).
    let q = { x: p.x - origin.x, y: p.y - origin.y };
    for (const { op, args } of [...ops].reverse()) {
        if (op === 'scale') q = { x: q.x * args[0], y: q.y * (args[1] ?? args[0]) };
        else if (op === 'rotate') q = rotate(q, args[0]);
        else q = { x: q.x + args[0], y: q.y + (args[1] ?? 0) };
    }
    return { x: q.x + origin.x, y: q.y + origin.y };
}

/**
 * The overlay as MapboxVelocityOverlay drives it. At the last settle (`sync`)
 * Leaflet was set to that centre and zoom in a div of `div` size centred on
 * the chart, and drew the centre `residual` px off its own middle (the
 * sub-pixel error syncFull measures). The camera has since moved to `now`.
 */
function landing(
    probe: { lng: number; lat: number },
    sync: { lng: number; lat: number; zoom: number },
    now: { lng: number; lat: number; zoom: number; bearing: number },
    div: { w: number; h: number },
    residual: Pt,
): { css: Pt; mapbox: Pt; transform: string } {
    const local = { x: div.w / 2, y: div.h / 2 };
    // Where north-up Leaflet draws the probe inside its div (it projects at the synced view).
    const p = mercator(probe.lng, probe.lat, sync.zoom);
    const c = mercator(sync.lng, sync.lat, sync.zoom);
    const leafletLocal = { x: local.x + (p.x - c.x) + residual.x, y: local.y + (p.y - c.y) + residual.y };
    const s = Math.pow(2, now.zoom - sync.zoom);
    const transform = velocityOverlayTransform({
        anchor: project(sync.lng, sync.lat, now),
        origin: project(now.lng, now.lat, now),
        r: residual,
        s,
        bearing: now.bearing,
    });
    // The div sits centred on the chart, so its local middle is the chart's.
    const offset = { x: (W - div.w) / 2, y: (H - div.h) / 2 };
    const screen = applyCss(
        transform,
        { x: W / 2, y: H / 2 },
        {
            x: leafletLocal.x + offset.x,
            y: leafletLocal.y + offset.y,
        },
    );
    return { css: screen, mapbox: project(probe.lng, probe.lat, now), transform };
}

const SQUARE = Math.ceil(Math.hypot(W, H));

/** Nine probes spread over the view (corners, edge midpoints, centre), as geo points under `cam`. */
function probes(cam: { lng: number; lat: number; zoom: number }): Array<{ lng: number; lat: number }> {
    const out: Array<{ lng: number; lat: number }> = [];
    const c = mercator(cam.lng, cam.lat, cam.zoom);
    const world = 512 * Math.pow(2, cam.zoom);
    for (const fx of [-0.45, 0, 0.45]) {
        for (const fy of [-0.45, 0, 0.45]) {
            const x = c.x + fx * W;
            const y = c.y + fy * H;
            const lng = (x / world) * 360 - 180;
            const lat = (360 / Math.PI) * Math.atan(Math.exp((0.5 - y / world) * 2 * Math.PI)) - 90;
            out.push({ lng, lat });
        }
    }
    return out;
}

const PLACES = [
    { name: 'a Tromsø-like fjord (70°N)', lng: 18.96, lat: 69.65, zoom: 9 },
    { name: 'a Brittany-like coast', lng: -4.49, lat: 48.38, zoom: 11 },
    { name: 'a Fiji-like reef on 180°', lng: 179.9, lat: -16.8, zoom: 10 },
];

describe('velocityOverlayTransform: Leaflet’s north-up field lands on the turned chart', () => {
    for (const place of PLACES) {
        for (const bearing of [0, 37, 90, 180, 270]) {
            for (const s of [1, 1.6]) {
                it(`${place.name}, bearing ${bearing}°, scale ${s}: nine probes within 1 px`, () => {
                    const sync = { lng: place.lng, lat: place.lat, zoom: place.zoom };
                    // The camera has panned a little and pinched by `s` since the settle.
                    const shift = mercator(place.lng, place.lat, place.zoom);
                    const world = 512 * Math.pow(2, place.zoom);
                    const nowLng = ((shift.x + 23) / world) * 360 - 180;
                    const now = {
                        lng: nowLng,
                        lat: place.lat - 0.004,
                        zoom: place.zoom + Math.log2(s),
                        bearing,
                    };
                    for (const div of [
                        { w: SQUARE, h: SQUARE },
                        { w: W, h: H },
                    ]) {
                        for (const probe of probes(now)) {
                            const { css, mapbox } = landing(probe, sync, now, div, { x: 0.3, y: -0.4 });
                            expect(Math.abs(css.x - mapbox.x)).toBeLessThan(1);
                            expect(Math.abs(css.y - mapbox.y)).toBeLessThan(1);
                        }
                    }
                });
            }
        }
    }

    it('turns the field with the chart: a southerly’s streaks go up the screen at 0° and down it at 180°', () => {
        // A streak heading north from the centre, in Leaflet's north-up div.
        for (const [bearing, upward] of [
            [0, true],
            [180, false],
        ] as const) {
            const t = velocityOverlayTransform({
                anchor: { x: W / 2, y: H / 2 },
                origin: { x: W / 2, y: H / 2 },
                r: { x: 0, y: 0 },
                s: 1,
                bearing,
            });
            const tail = applyCss(t, { x: W / 2, y: H / 2 }, { x: W / 2, y: H / 2 });
            const head = applyCss(t, { x: W / 2, y: H / 2 }, { x: W / 2, y: H / 2 - 10 });
            expect(head.y < tail.y).toBe(upward);
        }
    });

    it('at bearing 0 it is exactly the string the overlay wrote before (pixel-identical north up)', () => {
        const anchor = { x: 251.25, y: 301.5 };
        const origin = { x: 195, y: 422 };
        const r = { x: 0.3, y: -0.4 };
        expect(velocityOverlayTransform({ anchor, origin, r, s: 1, bearing: 0 })).toBe(
            `translate(${anchor.x - origin.x - 1 * r.x}px, ${anchor.y - origin.y - 1 * r.y}px)`,
        );
        const s = 1.6;
        expect(velocityOverlayTransform({ anchor, origin, r, s, bearing: 0 })).toBe(
            `translate(${anchor.x - origin.x - s * r.x}px, ${anchor.y - origin.y - s * r.y}px) scale(${s})`,
        );
    });
});

describe('sameSeenAt: “is she on screen” is re-measured after a turn (A3)', () => {
    const at = { lat: -16.8, lon: 179.9, centre: { lat: -16.8, lng: 179.9 }, zoom: 14, bearing: 0 };
    it('the same spot under the same camera is the same', () => {
        expect(sameSeenAt(at, { ...at })).toBe(true);
    });
    it('a camera that only turned is a different camera', () => {
        expect(sameSeenAt(at, { ...at, bearing: 90 })).toBe(false);
    });
});
