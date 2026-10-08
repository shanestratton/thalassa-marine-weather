/**
 * Obs camera centring on the real Mapbox engine (build 124, package OC).
 *
 * Shane 2026-10-08: "can we look at the obs page gps again, it is still not
 * quite right ... it sometimes starts up like the 2nd image [the whole east
 * coast at z3.9] ... when i click the locate fab, it goes to the first image
 * which is not centred". Plan and Obs share one Mapbox map. Plan's route fit
 * (fitTraceBounds) padded the camera clear of its route card, Mapbox GL 3
 * kept that padding on the map, and every later Obs flight landed at the
 * padded centre: 130 px right of the canvas centre on any phone, with
 * getBounds() shrunk to the strip right of the card.
 *
 * The page is one full-screen map built as useMapInit builds the app's
 * (mercator, world copies, no rotate), with a background and one magenta
 * dot where the fix is. window.__obsCamera drives the app's own code:
 *
 *   planFit(points)  Plan's route fit, the real fitTraceBounds.
 *   locate(fix)      The locate button's real path for Current Location,
 *                    locateOnObs → locatePhone → GpsService → its flight
 *                    (obsFlyTo, the flight find-boat flies too). Only the
 *                    phone's receiver is faked: navigator.geolocation answers
 *                    `fix`, stamped now. (Playwright's WebKit emulation stamps
 *                    its positions about 1.8e15 ms in the future, which
 *                    GpsService rightly refuses.)
 *   locateBoat(fix)  Find-boat's real path for the boat's row, locateOnObs →
 *                    locateVessel → her own position chain → obsFlyTo. Only
 *                    her instrument bus is faked: NmeaGpsProvider answers
 *                    `fix`, stamped now (a fictional boat, "Sea Wren").
 *   tracerFly(fix, zoom)  A tracer flight (a pin, a leg's mark): the real
 *                    tracerFlyTo, which frames beside the route card.
 *   leave(padding)   Any surface leaving a padding on the map (setPadding).
 *   showObs()        What Obs does as it shows: clearCameraPadding.
 *   symmetricFit()   A control: a fit whose padding is the same on every
 *                    side, which never moved the centre.
 *   measure(fix)     The camera: zoom, the fix in canvas pixels, the padding,
 *                    and getBounds() in canvas pixels.
 *   probe(x, y)      The drawn pixel, which Mapbox only paints for an
 *                    authenticated map (the dev server's own token).
 *
 * Places are public harbours; nothing here is anyone's position.
 */
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { fitTraceBounds, tracerFlyTo } from '../../components/map/mapHubHelpers';
import { NmeaGpsProvider } from '../../services/NmeaGpsProvider';
import { locateOnObs } from '../../components/map/obsCentre';
import { clearCameraPadding } from '../../components/map/cameraPadding';
import { OBS_VESSEL_ZOOM } from '../../components/map/useObsStartupCamera';

type Fix = { lat: number; lon: number };
type Padding = { top: number; right: number; bottom: number; left: number };

const token = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_MAPBOX_ACCESS_TOKEN;
if (token) mapboxgl.accessToken = token;

document.body.style.cssText = 'margin:0;background:#020617;overflow:hidden;';
const container = document.getElementById('map')!;
container.style.cssText = 'position:fixed;inset:0;';

const FIX_SOURCE = 'fix';
const map = new mapboxgl.Map({
    container,
    style: {
        version: 8,
        sources: { [FIX_SOURCE]: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
        layers: [
            { id: 'background', type: 'background', paint: { 'background-color': '#0b2540' } },
            {
                id: 'fix',
                type: 'circle',
                source: FIX_SOURCE,
                paint: { 'circle-radius': 10, 'circle-color': '#ff00c8', 'circle-pitch-alignment': 'map' },
            },
        ],
    },
    center: [0, 20],
    zoom: 3,
    minZoom: 2,
    maxZoom: 22,
    renderWorldCopies: true,
    projection: 'mercator',
    dragRotate: false,
    pitchWithRotate: false,
    attributionControl: false,
    preserveDrawingBuffer: true,
    testMode: true,
} as mapboxgl.MapOptions);

/** The phone's receiver: answers where the fixture says the phone is. */
let phoneAt: Fix | null = null;
const fakeGeolocation: Pick<Geolocation, 'getCurrentPosition'> = {
    getCurrentPosition(success, failure) {
        setTimeout(() => {
            if (!phoneAt) {
                failure?.({ code: 2, message: 'no fix', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
                return;
            }
            success({
                coords: {
                    latitude: phoneAt.lat,
                    longitude: phoneAt.lon,
                    accuracy: 5,
                    altitude: null,
                    altitudeAccuracy: null,
                    heading: null,
                    speed: null,
                },
                timestamp: Date.now(),
            } as GeolocationPosition);
        }, 0);
    },
};
Object.defineProperty(navigator, 'geolocation', { value: fakeGeolocation, configurable: true });

/** Her instrument bus: answers where the fixture says she is (the rest of her chain is real). */
let boatAt: Fix | null = null;
NmeaGpsProvider.getPosition = () =>
    boatAt && {
        latitude: boatAt.lat,
        longitude: boatAt.lon,
        accuracy: 5,
        heading: null,
        speed: 0,
        timestamp: Date.now(),
        source: 'nmea',
        satellites: 9,
        hdop: 0.9,
        fixQuality: 1,
    };

const errors: string[] = [];
map.on('error', (e) => {
    const err = (e as unknown as { error?: { message?: string } }).error;
    errors.push(String(err?.message ?? e.type));
});

/** The camera has stopped and the frame after it is drawn. */
function settled(): Promise<void> {
    return new Promise((resolve) => {
        const done = () => requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        if (map.isMoving()) map.once('moveend', done);
        else done();
    });
}

/** Drawn and idle: what the pixels show. */
function idle(): Promise<void> {
    return new Promise((resolve) => {
        map.once('idle', () => resolve());
        map.triggerRepaint();
    });
}

function setFix(fix: Fix): void {
    (map.getSource(FIX_SOURCE) as mapboxgl.GeoJSONSource).setData({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Point', coordinates: [fix.lon, fix.lat] },
    });
}

function measure(fix?: Fix) {
    const canvas = map.getCanvas();
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const bounds = map.getBounds()!;
    const centre = map.getCenter();
    const px = (lon: number, lat: number) => map.project([lon, lat]);
    return {
        width,
        height,
        zoom: map.getZoom(),
        padding: map.getPadding() as Padding,
        fixPx: fix ? { x: px(fix.lon, fix.lat).x, y: px(fix.lon, fix.lat).y } : null,
        // getBounds() in canvas pixels: the whole canvas is 0..width, 0..height.
        boundsPx: {
            west: px(bounds.getWest(), centre.lat).x,
            east: px(bounds.getEast(), centre.lat).x,
            north: px(centre.lng, bounds.getNorth()).y,
            south: px(centre.lng, bounds.getSouth()).y,
        },
    };
}

const fixture = {
    ready: false,
    errors,
    painted: false,
    async planFit(points: Fix[]) {
        fitTraceBounds(map, points);
        await settled();
        return { ...measure(), endsPx: points.map((p) => ({ x: map.project([p.lon, p.lat]).x })) };
    },
    async locate(fix: Fix) {
        setFix(fix);
        phoneAt = fix;
        const outcome = await locateOnObs(map, { kind: 'phone' }, { own: null, crew: null }, OBS_VESSEL_ZOOM);
        await settled();
        await idle();
        return { outcome, ...measure(fix) };
    },
    async locateBoat(fix: Fix) {
        setFix(fix);
        boatAt = fix;
        const outcome = await locateOnObs(
            map,
            { kind: 'boat', crewOwnerId: null },
            { own: 'Sea Wren', crew: null },
            OBS_VESSEL_ZOOM,
        );
        await settled();
        await idle();
        return { outcome, ...measure(fix) };
    },
    async tracerFly(fix: Fix, zoom: number) {
        setFix(fix);
        tracerFlyTo(map, fix, zoom, 700);
        await settled();
        await idle();
        return measure(fix);
    },
    async leave(padding: Padding) {
        map.setPadding(padding);
        await settled();
        return measure();
    },
    async showObs() {
        const cleared = clearCameraPadding(map);
        await settled();
        return { cleared, ...measure() };
    },
    async symmetricFit(points: Fix[]) {
        const lons = points.map((p) => p.lon);
        const lats = points.map((p) => p.lat);
        map.fitBounds(
            [
                [Math.min(...lons), Math.min(...lats)],
                [Math.max(...lons), Math.max(...lats)],
            ],
            // The control keeps its padding on purpose: one that is the same on
            // every side never moved the centre.
            { padding: 60, duration: 900, maxZoom: 11 },
        );
        await settled();
        return measure();
    },
    measure,
    probe(x: number, y: number): number[] {
        const dpr = window.devicePixelRatio || 1;
        const src = map.getCanvas();
        const c = document.createElement('canvas');
        c.width = src.width;
        c.height = src.height;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(src, 0, 0);
        const d = ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data;
        return [d[0], d[1], d[2], d[3]];
    },
};
(window as unknown as { __obsCamera: typeof fixture }).__obsCamera = fixture;

map.on('load', async () => {
    await idle();
    // Mapbox paints only for an authenticated map: the background says whether it did.
    fixture.painted = fixture.probe(4, 4)[3] > 0;
    fixture.ready = true;
});
