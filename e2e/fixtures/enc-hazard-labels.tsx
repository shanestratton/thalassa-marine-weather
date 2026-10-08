/**
 * Hazard marks and their names, placed by the real Mapbox engine (build 123,
 * package HM; build 125, 125-04). FICTIONAL marks, nowhere real (the repo is
 * public), set out by screen pixels at the zoom ?z= names (z14 by default)
 * and mounted by the real chart layer (mountEncVectorLayer) with the
 * collision settings every chart map uses (crossSourceCollisions off, no
 * fade; the main chart and the auto-route trial map,
 * tests/enc/encMapsCollideBySource.test.ts). Two layouts:
 *
 * ?layout=names (the default), in open North Atlantic water:
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
 * ?layout=cross, the shallowest danger across CLASSES (125-04), in open water
 * on a fictional approach to Brittany (the Iroise, 48.2 N 5.4 W; no real mark
 * is reproduced). Each pair touches at every zoom the chart draws, and the
 * deeper mark is the one Mapbox used to place first (rocks, then wrecks,
 * then obstructions, when they were three layers):
 *   A1/A2  a 15 m rock (A1) and a 0.5 m dangerous wreck (A2) on it;
 *   B1/B2  a 9 m wreck (B1) and a 2 m obstruction (B2) on it;
 *   C1/C2  a 1 m rock (C1) and an obstruction of unknown depth (C2) on it,
 *       which the fail-safe sorts as 0, the most dangerous;
 *   L1, L2, L3  lone controls, one per class with its own glyph: foul ground,
 *       a wreck showing her mast, a rock awash at chart datum.
 * and the 125-04 review pairs, where the mark that must LOSE is listed first
 * in the merged source (obstructions, then wrecks, then rocks) and the old
 * three layers drew the danger only by layer order:
 *   D1/D2  foul ground with no depth (D1) on a 0.5 m dangerous wreck (D2);
 *   E1/E2  a non-dangerous wreck with no depth (E1) on a 1 m rock (E2);
 *   F1/F2  a 20 m obstruction (F1) on a 0.5 m dangerous wreck (F2), both
 *       with LOWER-CASE attribute names, as an ogr2ogr cell can carry them;
 *   G1/G2  an obstruction of unknown depth (G1) on a rock that covers and
 *       uncovers, no depth (G2);
 *   H1/H2  an obstruction of unknown depth (H1) on a rock awash with VALSOU 0
 *       (H2): equal depths, so the class order (rock first) decides;
 *   I1/I2  foul ground with no depth (I1) on a rock awash at chart datum with
 *       no depth (I2).
 *
 * window.__encHazards.read() waits for the map to settle and returns which
 * marks and which names Mapbox placed (queryRenderedFeatures), with the glyph
 * each placed mark drew. The marks are read from EVERY symbol layer on the
 * hazard points source (one layer since 125-04; three before), so the same
 * fixture measures both. Placement runs whether or not the canvas paints, so
 * it holds on CI. probe(tag) reads the pixel at a mark, which Mapbox only
 * paints for an authenticated map (the dev server's own
 * VITE_MAPBOX_ACCESS_TOKEN). With a token the names use the app's own Mapbox
 * fonts; without one there are no font files to fetch, so the glyphs are
 * drawn locally (localFontFamily) and the names still place.
 *
 * setPalette(name) switches the chart's own states without a remount: 'day'
 * (the paper chart), 'night' (the S-52 night dim), 'imagery' (the satellite
 * base: land and coast hidden, the glaze carries the bands) and 'bare' (the
 * declutter slider at its last notch). Placement must not move between them.
 */
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import type { Feature, FeatureCollection } from 'geojson';
import { applyEncVisibility, mountEncVectorLayer, setEncNightDim } from '../../components/map/EncVectorLayer';
import { applyChartDetailLevel, DETAIL_SCRUB_MAX } from '../../components/map/encDetailScrubber';
import { setEncMapBase } from '../../components/map/encDepthStyleState';
import { ENC_VEC_LAYERS, ENC_VEC_SRC } from '../../components/map/encLayerIds';
import { registerSeamarkIcons } from '../../components/map/seamarkIcons';
import type { EncMergedVectorData } from '../../services/enc/EncHazardService';

const token = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_MAPBOX_ACCESS_TOKEN;
if (token) mapboxgl.accessToken = token;

const params = new URLSearchParams(location.search);
const LAYOUT = params.get('layout') === 'cross' ? 'cross' : 'names';

interface MarkDef {
    kind: 'OBSTRN' | 'WRECKS' | 'UWTROC';
    dx: number;
    dy: number;
    props: Record<string, unknown>;
}

/** Screen offsets (CSS px from the map centre) of every mark: names layout. */
const NAME_MARKS: Record<string, MarkDef> = {
    W1: { kind: 'WRECKS', dx: 0, dy: -160, props: { OBJNAM: 'Fictional Shoal Wreck', VALSOU: 6, CATWRK: 2 } },
    R1: { kind: 'UWTROC', dx: 36, dy: -134, props: { VALSOU: 4, WATLEV: 3 } },
    W2: { kind: 'WRECKS', dx: 0, dy: 170, props: { OBJNAM: 'Fictional Open Wreck', VALSOU: 7, CATWRK: 2 } },
    R3: { kind: 'UWTROC', dx: -62, dy: 4, props: { VALSOU: 9, WATLEV: 3 } },
    R2: { kind: 'UWTROC', dx: -70, dy: 0, props: { VALSOU: 2, WATLEV: 3 } },
    R4: { kind: 'UWTROC', dx: 60, dy: 40, props: { OBJNAM: 'Fictional Reef Rock', VALSOU: 1, WATLEV: 3 } },
    O1: { kind: 'OBSTRN', dx: 96, dy: 66, props: { VALSOU: 10 } },
    R5: { kind: 'UWTROC', dx: -110, dy: -250, props: { OBJNAM: 'Fictional Deep Rock', VALSOU: 9, WATLEV: 3 } },
    R6: { kind: 'UWTROC', dx: -104, dy: -244, props: { VALSOU: 2, WATLEV: 3 } },
};

/** Cross-class layout: each pair 3 px apart, so they touch even at z7 (icon box ~16 px). */
const CROSS_MARKS: Record<string, MarkDef> = {
    D1: { kind: 'OBSTRN', dx: -90, dy: -250, props: { CATOBS: 7 } },
    D2: { kind: 'WRECKS', dx: -87, dy: -248, props: { VALSOU: 0.5, CATWRK: 2 } },
    I1: { kind: 'OBSTRN', dx: 0, dy: -250, props: { CATOBS: 7 } },
    I2: { kind: 'UWTROC', dx: 3, dy: -248, props: { WATLEV: 5 } },
    E1: { kind: 'WRECKS', dx: 90, dy: -250, props: { CATWRK: 1, WATLEV: 3 } },
    E2: { kind: 'UWTROC', dx: 93, dy: -248, props: { VALSOU: 1, WATLEV: 3 } },
    A1: { kind: 'UWTROC', dx: -90, dy: -130, props: { VALSOU: 15, WATLEV: 3 } },
    A2: { kind: 'WRECKS', dx: -87, dy: -128, props: { VALSOU: 0.5, CATWRK: 2 } },
    B1: { kind: 'WRECKS', dx: 90, dy: -130, props: { VALSOU: 9, CATWRK: 2 } },
    B2: { kind: 'OBSTRN', dx: 93, dy: -128, props: { VALSOU: 2 } },
    F1: { kind: 'OBSTRN', dx: -90, dy: -10, props: { valsou: 20 } },
    F2: { kind: 'WRECKS', dx: -87, dy: -8, props: { valsou: 0.5, catwrk: 2 } },
    L2: { kind: 'WRECKS', dx: 0, dy: -10, props: { VALSOU: 4, CATWRK: 4 } },
    G1: { kind: 'OBSTRN', dx: 90, dy: -10, props: {} },
    G2: { kind: 'UWTROC', dx: 93, dy: -8, props: { WATLEV: 4 } },
    C1: { kind: 'UWTROC', dx: -90, dy: 110, props: { VALSOU: 1, WATLEV: 3 } },
    C2: { kind: 'OBSTRN', dx: -87, dy: 112, props: {} },
    H1: { kind: 'OBSTRN', dx: 0, dy: 110, props: {} },
    H2: { kind: 'UWTROC', dx: 3, dy: 112, props: { VALSOU: 0, WATLEV: 5 } },
    L1: { kind: 'OBSTRN', dx: 90, dy: 110, props: { VALSOU: 12, CATOBS: 7 } },
    L3: { kind: 'UWTROC', dx: 0, dy: 220, props: { VALSOU: 0, WATLEV: 5 } },
};

const MARKS = LAYOUT === 'cross' ? CROSS_MARKS : NAME_MARKS;
type Tag = string;

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
    center: LAYOUT === 'cross' ? [-5.4, 48.2] : [-40.0, 30.0],
    // ?z= sets the zoom; the marks keep their pixel layout at any zoom.
    zoom: Number(params.get('z') ?? 14),
    // Every chart map's placement settings (components/map/useMapInit.ts and
    // components/autorouting/AutoroutingTrialWorkspace.tsx).
    crossSourceCollisions: false,
    fadeDuration: 0,
    attributionControl: false,
    preserveDrawingBuffer: true,
    testMode: true,
} as mapboxgl.MapOptions);

const GLYPHS = Array.from(
    new Set([
        'sm-hazard-rock',
        'sm-hazard-wreck-dangerous',
        'sm-hazard-obstruction',
        // Every glyph the layout draws, losers included: a mark whose image is
        // missing is never placed, so it could not lose a collision honestly.
        ...(LAYOUT === 'cross'
            ? [
                  'sm-hazard-foul',
                  'sm-hazard-wreck',
                  'sm-hazard-wreck-mast',
                  'sm-hazard-rock-drying',
                  'sm-hazard-rock-awash-cd',
              ]
            : []),
    ]),
);

interface HazardPlacement {
    marks: string[];
    names: string[];
    /** The glyph each placed mark drew, by tag. */
    glyphs: Record<string, string>;
    /** The symbol layers that draw marks off the hazard points source. */
    markLayers: string[];
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

/** Every symbol layer that draws a MARK from the hazard points (the names excluded). */
function hazardMarkLayers(): string[] {
    return (map.getStyle()?.layers ?? [])
        .filter(
            (l) =>
                l.type === 'symbol' &&
                (l as { source?: unknown }).source === ENC_VEC_SRC.POINTS &&
                l.id !== ENC_VEC_LAYERS.POINTS_LABEL,
        )
        .map((l) => l.id);
}

/** An evaluated icon-image, as a plain id (Mapbox hands back a ResolvedImage). */
function imageId(v: unknown): string {
    if (typeof v === 'string') return v;
    const o = v as { name?: unknown; namePrimary?: unknown; id?: { name?: unknown } } | null;
    const name = o?.namePrimary ?? o?.name ?? o?.id?.name;
    return typeof name === 'string' ? name : String(v);
}

function placed(): HazardPlacement {
    const query = (layers: string[]) =>
        layers.length === 0
            ? []
            : map.queryRenderedFeatures(undefined as unknown as mapboxgl.PointLike, {
                  layers: layers.filter((id) => map.getLayer(id)),
              });
    const tags = (feats: mapboxgl.GeoJSONFeature[]) => [...new Set(feats.map((f) => String(f.properties?.tag)))].sort();
    const markLayers = hazardMarkLayers();
    const markFeats = query(markLayers);
    const glyphs: Record<string, string> = {};
    for (const f of markFeats) {
        glyphs[String(f.properties?.tag)] = imageId(
            (f.layer as { layout?: Record<string, unknown> } | undefined)?.layout?.['icon-image'],
        );
    }
    // Open water clear of every mark: the background, if the canvas painted.
    const sea = probe({ dx: -150, dy: -300 });
    return {
        marks: tags(markFeats),
        names: tags(query([ENC_VEC_LAYERS.POINTS_LABEL])),
        glyphs,
        markLayers,
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

type Palette = 'day' | 'night' | 'imagery' | 'bare';

/** Switch the chart's own display state in place (no remount). */
function setPalette(name: Palette): void {
    setEncNightDim(map, name === 'night');
    setEncMapBase(map, name === 'imagery');
    applyChartDetailLevel(map, name === 'bare' ? DETAIL_SCRUB_MAX : 0);
    applyEncVisibility(map);
}

const fixture = { map, marks: MARKS, layout: LAYOUT, read, probe, setPalette, ready: false };
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
        features: Object.keys(MARKS)
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
    setPalette('day');
    loaded = true;
    fixture.ready = true;
});
