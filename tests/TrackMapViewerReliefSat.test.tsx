/**
 * The big Log track map on Relief + Sat (125-13b). Shane 2026-10-09: "on the
 * log page, can we replace the little and the big map with our relief + sat
 * ?? remove the old satellite map".
 *
 * TrackMapViewer keeps its dialog (header, Wind/Track toggle, HUD, legends,
 * sparkline, scrubber, focus trap) and draws its map in Mapbox GL through the
 * Log-map helper (components/map/logMap.ts, 125-13a), loaded with import() so
 * the Log page's own chunk does not carry it. Pinned here without WebGL (the
 * browser spec, browser-tests/track-map-viewer-layout.spec.ts, renders it):
 *
 *  - the base is reliefBase's Relief + Sat; the old satellite tiles are never
 *    asked for, and Leaflet is not imported;
 *  - every overlay the Leaflet viewer drew (scratch parity table): the
 *    followed route under the track, the track by wind or water/land,
 *    planned routes in violet, one line per voyage, turn dots, start/end,
 *    GPS dots, the playback boat;
 *  - its interactions: tap for conditions (and tap again to close), a tap on
 *    a turn dot, play, scrub, the Wind/Track toggle without a rebuild, the
 *    one-time fit and its refits;
 *  - built on open and removed on close, never registered as THE chart;
 *  - tiles on Obs's Pi rule (dormant while PI_TILE_PROXY_USABLE is false);
 *  - no WebGL or no token: an honest plain box, the rest of the viewer works;
 *  - a passage across the antimeridian (Fiji) draws and frames as one line.
 */
import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAttributionControl, FakeMapboxMap, FakePopup } from './helpers/fakeMapboxGl';
import type { ShipLogEntry } from '../types';

const pi = vi.hoisted(() => ({ display: false }));

vi.mock('../services/PiCacheService', () => ({
    piCache: {
        canDisplayProxiedTiles: () => pi.display,
        passthroughTileUrl: (url: string) =>
            `https://pi.fixture.test/api/passthrough-tile?url=${encodeURIComponent(url)}`,
    },
}));

vi.mock('mapbox-gl', async () => {
    const { fakeMapboxGl } = await import('./helpers/fakeMapboxGl');
    return { default: fakeMapboxGl };
});

// Leaflet is the old map. Importing it at all is the regression.
vi.mock('leaflet', () => {
    throw new Error('TrackMapViewer must not import Leaflet');
});

import { TrackMapViewer } from '../components/TrackMapViewer';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { chartMapBeside } from '../components/map/chartMapRegistry';
import { logMapTransformRequest } from '../components/map/logMap';
import {
    BOAT_DOT,
    END_DOT,
    FOLLOWED_ROUTE_CORE,
    FOLLOWED_ROUTE_GLOW,
    START_DOT,
} from '../components/map/logMapColours';
import { LAND_IMAGERY_LAYER, seaBaseLayers } from '../components/map/reliefBase';
import { deriveTurnMarkers } from '../services/shiplog/turnMarkers';
import { windBucket } from '../services/shiplog/trackViz';

const OLD_SATELLITE = /satellite-streets|arcgisonline|World_Imagery/;

const at = (minute: number) => new Date(Date.UTC(2026, 9, 9, 6, minute)).toISOString();

const fix = (
    id: string,
    latitude: number,
    longitude: number,
    minute: number,
    over: Partial<ShipLogEntry> = {},
): ShipLogEntry =>
    ({
        id,
        userId: 'fixture-skipper',
        voyageId: 'fixture-voyage',
        latitude,
        longitude,
        timestamp: at(minute),
        positionFormatted: '',
        entryType: 'auto',
        source: 'device',
        isOnWater: true,
        ...over,
    }) as ShipLogEntry;

/**
 * Out of Cowes, west down the Solent, then a right-angle turn south (a
 * fictional boat). Winds 4, 4, 8, 8, 14, 14, 19, 19 kt: four wind buckets.
 */
const WINDS = [4, 4, 8, 8, 14, 14, 19, 19];
const SOLENT = [
    [50.77, -1.3],
    [50.77, -1.32],
    [50.77, -1.34],
    [50.77, -1.36],
    [50.77, -1.38],
    [50.755, -1.38],
    [50.74, -1.38],
    [50.725, -1.38],
].map(([lat, lon], i) =>
    fix(`s${i}`, lat, lon, i * 5, {
        windSpeed: WINDS[i],
        windDirection: 'SW',
        speedKts: 5 + i * 0.1,
        courseDeg: i < 4 ? 270 : 180,
        cumulativeDistanceNM: i * 0.75,
        waveHeight: 1,
        isOnWater: i !== 6,
    }),
);

/** Savusavu Bay east across the antimeridian into the Lau Group (fictional). */
const FIJI = [179.6, 179.75, 179.9, -179.95, -179.8, -179.65].map((lon, i) =>
    fix(`f${i}`, -16.8 - i * 0.02, lon, i * 30, { windSpeed: 12 }),
);

const ROUTE = [
    { lat: 50.772, lon: -1.296 },
    { lat: 50.775, lon: -1.36 },
    { lat: 50.73, lon: -1.385 },
];

const lastMap = () => FakeMapboxMap.instances[FakeMapboxMap.instances.length - 1];
const mapBuilt = async (count = 1) => {
    await waitFor(() => expect(FakeMapboxMap.instances).toHaveLength(count));
    return lastMap();
};
/** A drawn feature, read back: its coordinates beside its properties. */
type Drawn<C> = { coordinates: C; [property: string]: unknown };
const dataOf = (map: FakeMapboxMap, id: string) =>
    map.getSource(id)?.data as GeoJSON.FeatureCollection<GeoJSON.Geometry, Record<string, string>>;
const lines = (map: FakeMapboxMap, id = 'track-line'): Drawn<number[][]>[] =>
    dataOf(map, id).features.map((f) => ({
        ...f.properties,
        coordinates: (f.geometry as GeoJSON.LineString).coordinates,
    }));
const points = (map: FakeMapboxMap, id: string): Drawn<number[]>[] =>
    dataOf(map, id).features.map((f) => ({
        ...f.properties,
        coordinates: (f.geometry as GeoJSON.Point).coordinates,
    }));
const layerIndex = (map: FakeMapboxMap, id: string) => map.layers.findIndex((layer) => layer.id === id);
const paintOf = (map: FakeMapboxMap, id: string) => map.getLayer(id)?.paint ?? {};
const lonLat = (e: ShipLogEntry) => [e.longitude, e.latitude];

const sized = (width: number, height: number) => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(height);
};

function Harness({ entries = SOLENT, route }: { entries?: ShipLogEntry[]; route?: typeof ROUTE }) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <button onClick={() => setOpen(true)}>Open voyage track</button>
            <TrackMapViewer
                isOpen={open}
                onClose={() => setOpen(false)}
                entries={entries}
                followedRouteCoords={route}
            />
        </>
    );
}

beforeEach(() => {
    FakeMapboxMap.instances.length = 0;
    FakeMapboxMap.attempts = 0;
    FakeMapboxMap.failWebGL = false;
    FakePopup.instances.length = 0;
    pi.display = false;
    vi.stubEnv('VITE_MAPBOX_ACCESS_TOKEN', 'pk.fixture');
    sized(390, 844);
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('The big Log track map on Relief + Sat', () => {
    it('draws reliefBase’s Relief + Sat layers, visible exactly as seaBaseLayers says', async () => {
        render(<TrackMapViewer isOpen onClose={() => {}} entries={SOLENT} />);
        const map = await mapBuilt();
        expect(map.options.style).toBe('mapbox://styles/mapbox/dark-v11');
        map.loadStyle();
        for (const [id, visible] of seaBaseLayers('reliefSat')) {
            expect(map.visibility(id), id).toBe(visible ? 'visible' : 'none');
        }
        expect(map.visibility(LAND_IMAGERY_LAYER)).toBe('visible');
    });

    it('never asks for the old satellite tiles, carries no Leaflet, and loads its map lazily', async () => {
        render(<TrackMapViewer isOpen onClose={() => {}} entries={SOLENT} />);
        const map = await mapBuilt();
        map.loadStyle();
        expect(map.tileUrls().length).toBeGreaterThan(3);
        for (const url of map.tileUrls()) expect(url).not.toMatch(OLD_SATELLITE);
        const viewer = readFileSync('components/TrackMapViewer.tsx', 'utf8');
        const gl = readFileSync('components/TrackMapViewerGL.tsx', 'utf8');
        const features = readFileSync('components/map/trackMapFeatures.ts', 'utf8');
        for (const [path, source] of Object.entries({ viewer, gl, features }))
            expect(source, path).not.toMatch(/from 'leaflet'|leaflet\/dist|logMapTiles|satellite-streets|arcgisonline/);
        // The dialog's own chunk (part of the Log page's) carries no map engine:
        // the map arrives with import(), beside the mapbox-gl chunk Obs loads.
        expect(viewer).toContain("import('./TrackMapViewerGL')");
        expect(viewer).not.toMatch(/^import (?!type )[^;]*from '(mapbox-gl|\.\/map\/logMap|\.\/TrackMapViewerGL)'/m);
        expect(gl).toContain('createLogMap(');
    });

    it('pans, pinches, double-taps and takes the keyboard; never rotates; credits a compact ⓘ above the home bar', async () => {
        render(<TrackMapViewer isOpen onClose={() => {}} entries={SOLENT} />);
        const map = await mapBuilt();
        expect(map.options).toMatchObject({
            interactive: true,
            dragPan: true,
            scrollZoom: true,
            touchZoomRotate: true,
            doubleClickZoom: true,
            keyboard: true,
            dragRotate: false,
            maxTileCacheSize: 20,
            transformRequest: logMapTransformRequest,
        });
        expect(map.options.preserveDrawingBuffer).toBeFalsy();
        expect(map.touchZoomRotate?.disableRotation).toHaveBeenCalled();
        const credits = map.controls.find((c) => c.control instanceof FakeAttributionControl);
        expect(credits?.position).toBe('bottom-right');
        expect((credits?.control as FakeAttributionControl).options).toEqual({ compact: true });
        const box = map.getContainer();
        expect(box.classList.contains('thalassa-log-gl-map')).toBe(true);
        expect(box.classList.contains('is-free')).toBe(true);
    });

    it('frames its first view from the track in hand (never a fixed home harbour), and the world with nothing', async () => {
        const { unmount } = render(<TrackMapViewer isOpen onClose={() => {}} entries={SOLENT} />);
        const map = await mapBuilt();
        const bounds = map.options.bounds as [[number, number], [number, number]];
        expect(bounds[0][0]).toBeCloseTo(-1.38, 5);
        expect(bounds[1][0]).toBeCloseTo(-1.3, 5);
        expect(bounds[0][1]).toBeCloseTo(50.725, 5);
        expect(bounds[1][1]).toBeCloseTo(50.77, 5);
        expect(map.options.fitBoundsOptions).toMatchObject({ padding: 40, maxZoom: 15, retainPadding: false });
        unmount();

        render(<TrackMapViewer isOpen onClose={() => {}} entries={[]} />);
        const empty = await mapBuilt(2);
        expect(empty.options.center).toEqual([0, 20]);
        expect(empty.options.zoom).toBe(1);
        expect(empty.options.bounds).toBeUndefined();
    });

    it('is built on open and removed on close, once per opening, and never registered as the chart', async () => {
        render(<Harness />);
        expect(FakeMapboxMap.attempts).toBe(0);
        fireEvent.click(screen.getByRole('button', { name: 'Open voyage track' }));
        const first = await mapBuilt();
        first.loadStyle();
        const close = screen.getByRole('button', { name: 'Close track map viewer' });
        expect(chartMapBeside(close)).toBeNull();
        expect(readFileSync('components/TrackMapViewerGL.tsx', 'utf8')).not.toContain('registerChartMap');

        fireEvent.click(close);
        expect(first.remove).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('dialog', { name: 'Voyage track viewer' })).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Open voyage track' }));
        const second = await mapBuilt(2);
        expect(second).not.toBe(first);
        expect(FakeMapboxMap.attempts).toBe(2);
        fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
        expect(second.remove).toHaveBeenCalledTimes(1);
    });

    it('closing stops playback: nothing plays on in the closed viewer, and it reopens still at the start', async () => {
        // LogPage and PassageSummaryCard keep the viewer mounted and only close
        // it, so its own unmount never runs on close. Real timers: a playback
        // tick is 50 ms, and the Solent track is ~2 s of frames.
        const ticks = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', { name: 'Open voyage track' }));
        const first = await mapBuilt();
        first.loadStyle();
        await waitFor(() => expect(first.getSource('track-vessel')).toBeDefined());
        fireEvent.click(screen.getByRole('button', { name: 'Play track' }));
        fireEvent.click(screen.getByRole('button', { name: 'Close track map viewer' }));
        await ticks(400);

        fireEvent.click(screen.getByRole('button', { name: 'Open voyage track' }));
        const second = await mapBuilt(2);
        second.loadStyle();
        await waitFor(() => expect(second.getSource('track-vessel')).toBeDefined());
        const slider = () => screen.getByRole('slider', { name: 'Track playback position' }) as HTMLInputElement;
        await ticks(400);
        expect(slider().value).toBe('0');
        expect(points(second, 'track-vessel')).toEqual([]);
        expect(screen.getByRole('button', { name: 'Play track' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Hide voyage details' })).not.toBeInTheDocument();

        // Play then Pause leaves nothing running that Pause cannot reach.
        fireEvent.click(screen.getByRole('button', { name: 'Play track' }));
        fireEvent.click(screen.getByRole('button', { name: 'Pause playback' }));
        const paused = points(second, 'track-vessel').map((p) => p.coordinates);
        await ticks(400);
        expect(slider().value).toBe('0');
        expect(points(second, 'track-vessel').map((p) => p.coordinates)).toEqual(paused);
        expect(screen.getByRole('button', { name: 'Play track' })).toBeInTheDocument();
    });

    it('one playback loop at a time: under StrictMode (as index.tsx renders the app) Pause stops the boat', async () => {
        // StrictMode calls a state updater twice in development; Play starts its
        // loop inside one, so the second call must replace the first, not orphan it.
        const ticks = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
        render(
            <React.StrictMode>
                <TrackMapViewer isOpen onClose={() => {}} entries={SOLENT} />
            </React.StrictMode>,
        );
        const map = await waitFor(() => {
            const built = FakeMapboxMap.instances.filter((m) => !m.remove.mock.calls.length);
            expect(built).toHaveLength(1);
            return built[0];
        });
        map.loadStyle();
        await waitFor(() => expect(map.getSource('track-vessel')).toBeDefined());
        // Wind/Track and Play in one batch: with an update already queued, React
        // runs Play's updater during render, where StrictMode calls it twice.
        act(() => {
            fireEvent.click(screen.getByRole('button', { name: 'Track' }));
            fireEvent.click(screen.getByRole('button', { name: 'Play track' }));
        });
        fireEvent.click(screen.getByRole('button', { name: 'Pause playback' }));
        const slider = screen.getByRole('slider', { name: 'Track playback position' }) as HTMLInputElement;
        const paused = points(map, 'track-vessel').map((p) => p.coordinates);
        await ticks(400);
        expect(slider.value).toBe('0');
        expect(points(map, 'track-vessel').map((p) => p.coordinates)).toEqual(paused);
        expect(screen.getByRole('button', { name: 'Play track' })).toBeInTheDocument();
    });

    it('paints the track by forecast wind, in one line per wind bucket that share their boundary fix', async () => {
        render(<TrackMapViewer isOpen onClose={() => {}} entries={SOLENT} />);
        const map = await mapBuilt();
        map.loadStyle();
        await waitFor(() => expect(map.getSource('track-line')).toBeDefined());
        const track = lines(map);
        expect(track.map((l) => l.core)).toEqual([4, 8, 14, 19].map((kt) => windBucket(kt).color));
        expect(track.map((l) => l.glow)).toEqual(track.map((l) => l.core));
        expect(track.map((l) => l.coordinates.length)).toEqual([3, 3, 3, 2]);
        expect(track[0].coordinates[2]).toEqual(track[1].coordinates[0]);
        expect(paintOf(map, 'track-line-glow')).toMatchObject({ 'line-width': 11, 'line-opacity': 0.26 });
        expect(paintOf(map, 'track-line-core')).toMatchObject({ 'line-width': 3.5 });
    });

    it('Wind/Track recolours the same map by water and land, never rebuilding it', async () => {
        render(<TrackMapViewer isOpen onClose={() => {}} entries={SOLENT} />);
        const map = await mapBuilt();
        map.loadStyle();
        await waitFor(() => expect(map.getSource('track-line')).toBeDefined());
        fireEvent.click(screen.getByRole('button', { name: 'Track' }));
        // Water to s6 (ashore), then land; the lone water fix after it is no line.
        await waitFor(() => expect(lines(map).map((l) => l.core)).toEqual(['#38bdf8', '#34d399']));
        expect(FakeMapboxMap.instances).toHaveLength(1);
        expect(map.remove).not.toHaveBeenCalled();
    });

    it('draws a planned route in violet and every voyage as its own line, never one joining them', async () => {
        const plan = [
            [50.8, -1.2],
            [50.79, -1.25],
            [50.785, -1.28],
        ].map(([lat, lon], i) =>
            fix(`p${i}`, lat, lon, 100 + i, { source: 'planned_route', voyageId: 'fixture-plan', windSpeed: 30 }),
        );
        render(<TrackMapViewer isOpen onClose={() => {}} entries={[...SOLENT, ...plan]} />);
        const map = await mapBuilt();
        map.loadStyle();
        await waitFor(() => expect(map.getSource('track-line')).toBeDefined());
        const track = lines(map);
        const planned = track.filter((l) => l.glow === '#7c3aed');
        expect(planned).toHaveLength(1);
        expect(planned[0].core).toBe('#c4b5fd');
        expect(planned[0].coordinates).toEqual(plan.map(lonLat));
        // No line has a fix from both voyages in it.
        const planKeys = new Set(plan.map((e) => lonLat(e).join()));
        for (const line of track.filter((l) => l.glow !== '#7c3aed'))
            for (const c of line.coordinates) expect(planKeys.has(c.join())).toBe(false);
    });

    it('draws the followed route beneath the track, then dots, turns, ends and the boat above', async () => {
        render(<TrackMapViewer isOpen onClose={() => {}} entries={SOLENT} followedRouteCoords={ROUTE} />);
        const map = await mapBuilt();
        map.loadStyle();
        await waitFor(() => expect(map.getSource('track-route')).toBeDefined());
        expect(lines(map, 'track-route')[0].coordinates).toEqual(ROUTE.map((c) => [c.lon, c.lat]));
        expect(paintOf(map, 'track-route-glow')).toMatchObject({
            'line-color': FOLLOWED_ROUTE_GLOW,
            'line-width': 10,
            'line-opacity': 0.28,
        });
        expect(paintOf(map, 'track-route-core')).toMatchObject({ 'line-color': FOLLOWED_ROUTE_CORE, 'line-width': 3 });
        const order = [
            'track-route-glow',
            'track-route-core',
            'track-line-glow',
            'track-line-core',
            'track-fixes',
            'track-turns',
            'track-ends-halo',
            'track-ends',
            'track-vessel-halo',
            'track-vessel',
        ].map((id) => layerIndex(map, id));
        expect(order.every((index) => index >= 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        // Above everything the base draws (its place names included).
        expect(order[0]).toBeGreaterThan(layerIndex(map, 'settlement-major-label'));
    });

    it('marks the start, the end, each GPS fix and each derived turn as the Leaflet viewer did', async () => {
        // A named waypoint is a vertex of the line but never a GPS dot.
        const waypoint = fix('w', 50.77, -1.33, 7, { entryType: 'waypoint', waypointName: 'Lunch stop' });
        const entries = [...SOLENT, waypoint];
        render(<TrackMapViewer isOpen onClose={() => {}} entries={entries} />);
        const map = await mapBuilt();
        map.loadStyle();
        await waitFor(() => expect(map.getSource('track-ends')).toBeDefined());
        expect(points(map, 'track-ends')).toEqual([
            expect.objectContaining({ coordinates: lonLat(SOLENT[0]), role: 'start', core: START_DOT }),
            expect.objectContaining({ coordinates: lonLat(SOLENT[7]), role: 'end', core: END_DOT }),
        ]);
        // GPS dots: every line fix but the waypoint, water blue or land green.
        const fixes = points(map, 'track-fixes');
        expect(fixes.map((f) => f.coordinates)).toEqual(SOLENT.map(lonLat));
        expect(fixes.map((f) => f.fill)).toEqual(SOLENT.map((e) => (e.isOnWater ? '#0284c7' : '#059669')));
        expect(paintOf(map, 'track-fixes')).toMatchObject({ 'circle-radius': 2 });
        // Turns: derived from the track, never stored.
        const expected = deriveTurnMarkers(entries);
        expect(expected.length).toBeGreaterThan(0);
        const turns = points(map, 'track-turns');
        expect(turns.map((t) => t.coordinates)).toEqual(expected.map((m) => [m.lon, m.lat]));
        expect(turns[0]).toMatchObject({ from: expected[0].fromCardinal, to: expected[0].toCardinal });
        expect(paintOf(map, 'track-turns')).toMatchObject({ 'circle-radius': 4, 'circle-color': '#f59e0b' });
        // No boat until playback asks for one.
        expect(points(map, 'track-vessel')).toEqual([]);
    });

    it('frames the route and the track once, and refits for a new route but never for a live fix', async () => {
        const { rerender } = render(
            <TrackMapViewer isOpen onClose={() => {}} entries={SOLENT.slice(0, 6)} followedRouteCoords={ROUTE} />,
        );
        const map = await mapBuilt();
        // The first frame takes in both, as the map is made.
        const [[west, south], [east, north]] = map.options.bounds as [[number, number], [number, number]];
        expect([west, south, east, north]).toEqual([-1.385, 50.73, -1.296, 50.775]);
        map.loadStyle();
        await waitFor(() => expect(map.getSource('track-line')).toBeDefined());
        rerender(<TrackMapViewer isOpen onClose={() => {}} entries={SOLENT} followedRouteCoords={ROUTE} />);
        await waitFor(() => expect(lines(map).flatMap((l) => l.coordinates)).toContainEqual(lonLat(SOLENT[7])));
        expect(map.fitBounds).not.toHaveBeenCalled();
        // A new route to follow earns a new frame: padded, unanimated, padding not kept.
        rerender(<TrackMapViewer isOpen onClose={() => {}} entries={SOLENT} followedRouteCoords={ROUTE.slice(0, 2)} />);
        await waitFor(() => expect(map.fitBounds).toHaveBeenCalledTimes(1));
        expect(map.fitBounds).toHaveBeenLastCalledWith(
            expect.anything(),
            expect.objectContaining({ padding: 40, maxZoom: 15, animate: false, retainPadding: false }),
        );
    });

    it('opened before its track arrives (as PassageSummaryCard opens it), it frames the track when it lands', async () => {
        const { rerender } = render(<TrackMapViewer isOpen onClose={() => {}} entries={[]} />);
        const map = await mapBuilt();
        map.loadStyle();
        expect(map.fitBounds).not.toHaveBeenCalled();
        rerender(<TrackMapViewer isOpen onClose={() => {}} entries={SOLENT} />);
        await waitFor(() => expect(map.fitBounds).toHaveBeenCalledTimes(1));
        const [bounds] = map.fitBounds.mock.calls[0];
        expect(bounds).toEqual([
            [-1.38, 50.725],
            [-1.3, 50.77],
        ]);
        expect(screen.queryByText('Loading track…')).not.toBeInTheDocument();
    });

    it('frames a lone point at a harbour zoom, not a world view', async () => {
        render(
            <TrackMapViewer isOpen onClose={() => {}} entries={[]} followedRouteCoords={[{ lat: 50.77, lon: -1.3 }]} />,
        );
        const map = await mapBuilt();
        expect(map.options).toMatchObject({ center: [-1.3, 50.77], zoom: 13 });
    });

    it('a tap shows the conditions at the nearest fix, as text, and a second tap closes it', async () => {
        const hostile = SOLENT.map((e, i) => (i === 3 ? { ...e, windDirection: '<img src=x onerror=alert(1)>' } : e));
        render(<TrackMapViewer isOpen onClose={() => {}} entries={hostile} />);
        const map = await mapBuilt();
        map.loadStyle();
        await waitFor(() => expect(map.getSource('track-line')).toBeDefined());
        act(() => map.fire('click', { lngLat: { lng: -1.3601, lat: 50.7702 }, point: { x: 200, y: 300 } }));
        expect(FakePopup.instances).toHaveLength(1);
        const popup = FakePopup.instances[0];
        expect(popup.options).toMatchObject({ closeButton: true, closeOnClick: false, className: 'track-cond-popup' });
        expect(popup.lngLat).toEqual([-1.36, 50.77]);
        const text = popup.element.textContent ?? '';
        expect(text).toContain('8 kt');
        expect(text).toContain('<img src=x onerror=alert(1)>');
        expect(popup.element.querySelector('img')).toBeNull();
        expect(text).toContain('5.3 kt SOG');
        expect(text).toContain('1.0 m');
        expect(popup.isOpen()).toBe(true);

        act(() => map.fire('click', { lngLat: { lng: -1.3, lat: 50.77 }, point: { x: 10, y: 10 } }));
        expect(popup.isOpen()).toBe(false);
        expect(FakePopup.instances).toHaveLength(1);
        // Tapping the bubble itself closes it too.
        act(() => map.fire('click', { lngLat: { lng: -1.3, lat: 50.77 }, point: { x: 10, y: 10 } }));
        const next = FakePopup.instances[1];
        act(() => next.element.click());
        expect(next.isOpen()).toBe(false);
    });

    it('a tap on a turn dot shows the turn, not the conditions', async () => {
        render(<TrackMapViewer isOpen onClose={() => {}} entries={SOLENT} />);
        const map = await mapBuilt();
        map.loadStyle();
        await waitFor(() => expect(map.getSource('track-turns')).toBeDefined());
        const turn = points(map, 'track-turns')[0];
        map.rendered = [
            {
                layer: { id: 'track-turns' },
                properties: { from: turn.from, to: turn.to, time: turn.time },
                geometry: { type: 'Point', coordinates: turn.coordinates },
            },
        ];
        act(() =>
            map.fire('click', {
                lngLat: { lng: turn.coordinates[0], lat: turn.coordinates[1] },
                point: { x: 1, y: 1 },
            }),
        );
        const popup = FakePopup.instances[0];
        expect(popup.element.textContent).toContain(`${turn.from} → ${turn.to}`);
        expect(popup.element.textContent).not.toContain('SOG');
        expect(popup.lngLat).toEqual(turn.coordinates);
    });

    it('play puts the boat on the track and the scrubber moves her, with the boat on top in cyan', async () => {
        render(<TrackMapViewer isOpen onClose={() => {}} entries={SOLENT} />);
        const map = await mapBuilt();
        map.loadStyle();
        await waitFor(() => expect(map.getSource('track-vessel')).toBeDefined());
        fireEvent.click(screen.getByRole('button', { name: 'Play track' }));
        expect(points(map, 'track-vessel').map((p) => p.coordinates)).toEqual([lonLat(SOLENT[0])]);
        fireEvent.click(screen.getByRole('button', { name: 'Pause playback' }));
        fireEvent.change(screen.getByRole('slider', { name: 'Track playback position' }), { target: { value: '5' } });
        expect(points(map, 'track-vessel').map((p) => p.coordinates)).toEqual([lonLat(SOLENT[5])]);
        expect(paintOf(map, 'track-vessel')).toMatchObject({ 'circle-color': BOAT_DOT });
    });

    it('a boat placed before the style arrives is drawn as soon as it does', async () => {
        render(<TrackMapViewer isOpen onClose={() => {}} entries={SOLENT} />);
        const map = await mapBuilt();
        fireEvent.change(screen.getByRole('slider', { name: 'Track playback position' }), { target: { value: '2' } });
        map.loadStyle();
        await waitFor(() => expect(points(map, 'track-vessel').map((p) => p.coordinates)).toEqual([lonLat(SOLENT[2])]));
    });

    it('draws and frames a passage across the antimeridian (Fiji) as one short line', async () => {
        render(<TrackMapViewer isOpen onClose={() => {}} entries={FIJI} />);
        const map = await mapBuilt();
        const [[west], [east]] = map.options.bounds as [[number, number], [number, number]];
        expect(east - west).toBeLessThan(1);
        map.loadStyle();
        await waitFor(() => expect(map.getSource('track-line')).toBeDefined());
        const coords = lines(map).flatMap((l) => l.coordinates);
        for (let i = 1; i < coords.length; i += 1)
            expect(Math.abs(coords[i][0] - coords[i - 1][0]), `step ${i}`).toBeLessThan(1);
        const ends = points(map, 'track-ends').map((p) => p.coordinates[0]);
        expect(Math.abs(ends[1] - ends[0])).toBeLessThan(1);

        // A tap on the far side of the line finds the fix across the antimeridian.
        act(() => map.fire('click', { lngLat: { lng: 180.06, lat: -16.86 }, point: { x: 5, y: 5 } }));
        const popup = FakePopup.instances[0];
        expect((popup.lngLat as number[])[0]).toBeCloseTo(180.05, 5);

        // The playback boat sails the short way too.
        fireEvent.click(screen.getByRole('button', { name: 'Play track' }));
        fireEvent.click(screen.getByRole('button', { name: 'Pause playback' }));
        fireEvent.change(screen.getByRole('slider', { name: 'Track playback position' }), { target: { value: '4' } });
        const [boat] = points(map, 'track-vessel');
        expect(boat.coordinates[0]).toBeCloseTo(180.2, 5);
    });

    it('tiles follow Obs’s Pi rule: through the boat’s Pi only once a map engine may use it', async () => {
        render(<TrackMapViewer isOpen onClose={() => {}} entries={SOLENT} />);
        const map = await mapBuilt();
        const transform = map.options.transformRequest as typeof logMapTransformRequest;
        const relief = 'https://tiles.thalassatiles.com/v1/relief-global/idx/9/251/169.png';
        expect(transform(relief, 'Tile').url).toBe(relief);
        pi.display = true;
        expect(transform(relief, 'Tile').url).toContain('pi.fixture.test/api/passthrough-tile');
        const imagery = 'https://api.mapbox.com/v4/mapbox.satellite/9/251/169@2x.jpg90?access_token=pk.fixture';
        expect(transform(imagery, 'Tile').url).toBe(imagery);
    });

    it('no WebGL: an honest plain box, and the rest of the viewer still works inside the Log page', async () => {
        FakeMapboxMap.failWebGL = true;
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        render(
            <ErrorBoundary boundaryName="LogPage">
                <TrackMapViewer isOpen onClose={() => {}} entries={SOLENT} />
            </ErrorBoundary>,
        );
        expect(await screen.findByText(/can.t draw the map/i)).toBeInTheDocument();
        expect(FakeMapboxMap.attempts).toBe(1);
        expect(screen.getByRole('dialog', { name: 'Voyage track viewer' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Track' }));
        fireEvent.click(screen.getByRole('button', { name: 'Play track' }));
        expect(screen.getByRole('button', { name: 'Pause playback' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Hide voyage details' })).toBeInTheDocument();
        // Re-renders never ask Mapbox again this opening.
        expect(FakeMapboxMap.attempts).toBe(1);
    });

    it('its credits ride above the dock and its bubbles are the Log maps’ glass, white in daylight', () => {
        const css = readFileSync('index.css', 'utf8');
        const daylight = readFileSync('styles/daylight.css', 'utf8');
        // Positional containers only (MapAttributionContract): the corner moves, the credit is Mapbox's.
        expect(css).toMatch(
            /\.track-map-gl \{\s*--track-credits-bottom: calc\(4rem \+ env\(safe-area-inset-bottom\) \+ 14px \+ var\(--track-dock-h, 0px\)\);/,
        );
        expect(css).toMatch(
            /\.track-map-gl\.is-free \.mapboxgl-ctrl-bottom-right \{\s*bottom: var\(--track-credits-bottom\);/,
        );
        expect(css).toMatch(/\.track-map-gl \.mapboxgl-popup-content \{[^}]*background: rgba\(15, 23, 42, 0\.92\)/);
        expect(daylight).toMatch(
            /:root\.display-light \.track-map-gl \.mapboxgl-popup-content \{[^}]*background: #ffffff;[^}]*color: #0f172a;/,
        );
        // The Leaflet viewer's dead deep-water filter went with it.
        expect(css).not.toContain('.tmv-deepwater');
    });

    it('no Mapbox token: the same plain box, and no map is attempted', async () => {
        vi.stubEnv('VITE_MAPBOX_ACCESS_TOKEN', '');
        render(<TrackMapViewer isOpen onClose={() => {}} entries={SOLENT} />);
        expect(await screen.findByText(/can.t draw the map/i)).toBeInTheDocument();
        expect(FakeMapboxMap.attempts).toBe(0);
        expect(screen.getByRole('slider', { name: 'Track playback position' })).toBeInTheDocument();
    });
});
