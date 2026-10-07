/**
 * Hazard marks and their names, placed by the real Mapbox engine (build 123,
 * package HM). FICTIONAL marks, nowhere real (the repo is public), set out by
 * screen pixels in open North Atlantic water at z14 (or the zoom ?z= names)
 * and mounted by the real chart layer (mountEncVectorLayer) with the collision
 * settings every chart map uses (crossSourceCollisions off, no fade; the main
 * chart and the auto-route trial map, tests/enc/encMapsCollideBySource.test.ts):
 *
 *   W1  "Fictional Shoal Wreck", 6 m, with R1 (an unnamed 4 m rock) where
 *       its name would print;
 *   W2  "Fictional Open Wreck", 7 m, alone: its name has room;
 *   R2/R3  two unnamed rocks on top of each other, 2 m and 9 m, the deeper
 *       one listed first in the source;
 *   R4  "Fictional Reef Rock", 1 m, with O1 (an unnamed 10 m obstruction)
 *       where its name would print;
 *   R5/R6  "Fictional Deep Rock", 9 m and listed first, with R6 (an unnamed
 *       2 m rock) on top of it, a few pixels into where its name would print:
 *       the deep rock loses the declutter and its name must not take the
 *       shallow one with it (before HM, neither drew).
 *
 * window.__encHazards.read() waits for the map to settle and returns which
 * marks and which names Mapbox placed (queryRenderedFeatures). Placement runs
 * whether or not the canvas paints, so it holds on CI. probe(tag) reads the
 * pixel at a mark, which Mapbox only paints for an authenticated map (the dev
 * server's own VITE_MAPBOX_ACCESS_TOKEN). With a token the names use the
 * app's own Mapbox fonts; without one there are no font files to fetch, so
 * the glyphs are drawn locally (localFontFamily) and the names still place.
 */
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import type { Feature, FeatureCollection } from 'geojson';
import { mountEncVectorLayer } from '../../components/map/EncVectorLayer';
import { ENC_VEC_LAYERS, ENC_VEC_SRC } from '../../components/map/encLayerIds';
import { registerSeamarkIcons } from '../../components/map/seamarkIcons';
import type { EncMergedVectorData } from '../../services/enc/EncHazardService';

const token = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_MAPBOX_ACCESS_TOKEN;
if (token) mapboxgl.accessToken = token;

const map = new mapboxgl.Map({
    container: document.getElementById('map')!,
    style: {
        version: 8,
        glyphs: token
            ? 'mapbox://fonts/mapbox/{fontstack}/{range}.pbf'
            : `${location.origin}/e2e/fixtures/glyphs/{fontstack}/{range}.pbf`,
        sources: {},
        layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#f4f8fb' } }],
    },
    ...(token ? {} : { localFontFamily: 'sans-serif' }),
    center: [-40.0, 30.0],
    // ?z= sets the zoom; the marks keep their pixel layout at any zoom.
    zoom: Number(new URLSearchParams(location.search).get('z') ?? 14),
    // Every chart map's placement settings (components/map/useMapInit.ts and
    // components/autorouting/AutoroutingTrialWorkspace.tsx).
    crossSourceCollisions: false,
    fadeDuration: 0,
    attributionControl: false,
    preserveDrawingBuffer: true,
    testMode: true,
} as mapboxgl.MapOptions);

/** Screen offsets (CSS px from the map centre) of every mark. */
const MARKS = {
    W1: { kind: 'WRECKS', dx: 0, dy: -160, props: { OBJNAM: 'Fictional Shoal Wreck', VALSOU: 6, CATWRK: 2 } },
    R1: { kind: 'UWTROC', dx: 36, dy: -134, props: { VALSOU: 4, WATLEV: 3 } },
    W2: { kind: 'WRECKS', dx: 0, dy: 170, props: { OBJNAM: 'Fictional Open Wreck', VALSOU: 7, CATWRK: 2 } },
    R3: { kind: 'UWTROC', dx: -62, dy: 4, props: { VALSOU: 9, WATLEV: 3 } },
    R2: { kind: 'UWTROC', dx: -70, dy: 0, props: { VALSOU: 2, WATLEV: 3 } },
    R4: { kind: 'UWTROC', dx: 60, dy: 40, props: { OBJNAM: 'Fictional Reef Rock', VALSOU: 1, WATLEV: 3 } },
    O1: { kind: 'OBSTRN', dx: 96, dy: 66, props: { VALSOU: 10 } },
    R5: { kind: 'UWTROC', dx: -110, dy: -250, props: { OBJNAM: 'Fictional Deep Rock', VALSOU: 9, WATLEV: 3 } },
    R6: { kind: 'UWTROC', dx: -104, dy: -244, props: { VALSOU: 2, WATLEV: 3 } },
} as const;
type Tag = keyof typeof MARKS;

const HAZARD_LAYERS = [ENC_VEC_LAYERS.OBSTRN, ENC_VEC_LAYERS.WRECKS, ENC_VEC_LAYERS.UWTROC];
const GLYPHS = ['sm-hazard-rock', 'sm-hazard-wreck-dangerous', 'sm-hazard-obstruction'];

interface HazardPlacement {
    marks: string[];
    names: string[];
    painted: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const idle = () =>
    new Promise<void>((r) => {
        map.once('idle', () => r());
        map.triggerRepaint();
    });

function screenOf(at: Tag | { dx: number; dy: number }): { x: number; y: number } {
    const c = map.project(map.getCenter());
    const { dx, dy } = typeof at === 'string' ? MARKS[at] : at;
    return { x: c.x + dx, y: c.y + dy };
}

/** The rendered pixel at a mark, or at a screen offset from the centre. */
function probe(at: Tag | { dx: number; dy: number }): [number, number, number, number] {
    const p = screenOf(at);
    const dpr = window.devicePixelRatio || 1;
    const src = map.getCanvas();
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(src, 0, 0);
    const d = ctx.getImageData(Math.round(p.x * dpr), Math.round(p.y * dpr), 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
}

function placed(): HazardPlacement {
    const tags = (layers: string[]) =>
        [
            ...new Set(
                map
                    .queryRenderedFeatures(undefined as unknown as mapboxgl.PointLike, { layers })
                    .map((f) => String(f.properties?.tag)),
            ),
        ].sort();
    // Open water clear of every mark: the background, if the canvas painted.
    const sea = probe({ dx: -150, dy: -300 });
    return {
        marks: tags(HAZARD_LAYERS),
        names: tags([ENC_VEC_LAYERS.POINTS_LABEL]),
        painted: sea[3] > 0,
    };
}

let loaded = false;

/** Wait for the icons, the data and two identical settled placements. */
async function read(): Promise<HazardPlacement> {
    for (let i = 0; i < 100; i++) {
        if (!loaded || !GLYPHS.every((id) => map.hasImage(id))) {
            await sleep(100);
            continue;
        }
        await idle();
        const inSource = new Set(map.querySourceFeatures(ENC_VEC_SRC.POINTS).map((f) => f.properties?.tag));
        if (inSource.size < Object.keys(MARKS).length) {
            await sleep(100);
            continue;
        }
        const first = placed();
        await sleep(150);
        await idle();
        const second = placed();
        if (JSON.stringify(first) === JSON.stringify(second)) return second;
    }
    throw new Error('the hazard fixture never settled');
}

const fixture = { map, marks: MARKS, read, probe, ready: false };
(window as unknown as { __encHazards: typeof fixture }).__encHazards = fixture;

map.on('load', async () => {
    // The glyphs first, so no tile is ever laid out without them (the mount
    // registers them too, fire-and-forget; that call then finds them all).
    await registerSeamarkIcons(map);
    const at = (dx: number, dy: number) => {
        const c = map.project(map.getCenter());
        const ll = map.unproject([c.x + dx, c.y + dy]);
        return { type: 'Point' as const, coordinates: [ll.lng, ll.lat] };
    };
    const byKind = (kind: string): FeatureCollection => ({
        type: 'FeatureCollection',
        features: (Object.keys(MARKS) as Tag[])
            .filter((tag) => MARKS[tag].kind === kind)
            .map(
                (tag): Feature => ({
                    type: 'Feature',
                    geometry: at(MARKS[tag].dx, MARKS[tag].dy),
                    properties: { tag, ...MARKS[tag].props },
                }),
            ),
    });
    const empty: FeatureCollection = { type: 'FeatureCollection', features: [] };
    const data = new Proxy(
        { cellCount: 1, OBSTRN: byKind('OBSTRN'), WRECKS: byKind('WRECKS'), UWTROC: byKind('UWTROC') } as Record<
            string,
            unknown
        >,
        { get: (t, k: string) => (k in t ? t[k] : empty) },
    ) as unknown as EncMergedVectorData;
    mountEncVectorLayer(map, data, { minZoom: 7 });
    loaded = true;
    fixture.ready = true;
});
