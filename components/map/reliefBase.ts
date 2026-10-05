/**
 * reliefBase — the seamless sea under the Obs chart (Shane 2026-10-04: "one
 * thing that really bugs me about the satellite image is the stitching").
 *
 * Everything is drawn INSIDE the dark-v11 style, never through setStyle
 * (which would destroy every custom layer):
 *  - Relief: seafloor relief from our own DEM tiles on R2. GEBCO 2026 covers
 *    the world (z0-9; its shading fades out over z10-11, its colour with the
 *    30 m grid's) and Geoscience Australia's GBR 30 m grid covers Queensland
 *    inshore (z8-13, fading out over z13.5-14.5).
 *    The colour is a raster-color ramp over an 8-bit depth index; the shape is
 *    a hillshade. Both are water only.
 *  - Relief + Sat: the same sea, with satellite imagery on land only. The
 *    imagery sits UNDER the opaque vector water fill, so photo seams at sea
 *    can never show.
 *  - Ocean: Mapbox's own vector sea. bathymetry-v2 depth bands come from the
 *    style's composite source and are gone by z9, because overzoomed they draw
 *    false straight depth edges. terrain-v2 shades the land. There is no new
 *    source and there are no seams.
 *
 * Relief's fallback is the Ocean sea. The depth bands draw BENEATH the relief
 * layers, so relief tiles that are failing, missing (a 404 means an all-land
 * tile, which mapbox-gl treats quietly) or not configured leave the vector sea
 * showing, never a hole. Every layer starts hidden: MapHub's base pass is the
 * single owner of visibility. Not for navigation.
 */
import type mapboxgl from 'mapbox-gl';
import type { ObsChartBase } from '../../types/settings';

/**
 * The public R2 URL of the relief tiles, with its version prefix: bucket
 * thalassa-relief's r2.dev address, uploaded 2026-10-05 by tools/relief.
 * Empty would mean not configured: no relief source is added, and Relief
 * draws the vector sea alone. VITE_RELIEF_TILE_BASE overrides it for a build.
 * Before the public release: move to a custom domain (r2.dev is rate-limited).
 *
 * Tile layout under it (tools/relief/README.md; XYZ, 256 px):
 * relief-{global,au}/dem/{z}/{x}/{y}.webp is Terrarium with the exaggeration
 * baked in, and relief-{global,au}/idx/{z}/{x}/{y}.png is the depth index
 * (depthIndex below). A 404 is an all-land tile, or no GBR data in relief-au.
 */
export const RELIEF_R2_URL_PLACEHOLDER = 'https://pub-1c99456d42db4077ae4c18b6dce83a23.r2.dev/v1';
export const RELIEF_TILE_BASE = String(import.meta.env.VITE_RELIEF_TILE_BASE || RELIEF_R2_URL_PLACEHOLDER).replace(
    /\/+$/,
    '',
);

/** GA's GBR 30 m grids A-D (about 10-29°S): no AU tile is requested outside this box. */
export const RELIEF_AU_BOUNDS: [number, number, number, number] = [142, -29.5, 156.5, -9];

/**
 * Each source's licence condition: credit GEBCO and GA, say the work is
 * derived (CC BY 4.0 §3(a)(1)(B): exaggerated, smoothed, merged and
 * land-masked), credit the OSM land mask (ODbL Produced Work), imply no
 * endorsement, not for navigation.
 */
export const RELIEF_ATTRIBUTION =
    'Seafloor relief derived from <a href="https://doi.org/10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa" target="_blank" rel="noopener noreferrer">GEBCO Compilation Group (2026) GEBCO 2026 Grid</a>; GBR 30 m &copy; Commonwealth of Australia (Geoscience Australia), CC BY 4.0; coastline &copy; OpenStreetMap contributors. Not for navigation.';

export const LAND_IMAGERY_LAYER = 'satellite-land-layer';
export const SEA_BASE_LAND_SHADE = 'sea-base-land-shade';
export const SEA_BASE_BANDS = 'sea-base-depth-bands';
export const SEA_BASE_COAST = 'sea-base-coastline';
/** Relief, bottom to top: world tint and shade, then the Australian grid's. */
export const RELIEF_LAYER_IDS = ['relief-global-tint', 'relief-global-shade', 'relief-au-tint', 'relief-au-shade'];
/**
 * [set, minzoom, source maxzoom, tint fade-out start, end, shade fade-out
 * start, end]. Each layer's maxzoom is where its fade ends: mapbox-gl keeps a
 * source loading for any layer inside its zoom range, whatever its opacity.
 */
const SETS = [
    // The world's COLOUR runs to the 30 m grid's fade (review 2026-10-05): gone
    // at z11, it left the grid's overzoomed edge as a straight line at z10.5+
    // (156.09°E, 9.80°S, 140.625°E, 29.54°S). Its hillshade still goes at
    // z10-11, where overzoomed relief stops being shape.
    ['global', 0, 9, 13.5, 14.5, 10, 11],
    ['au', 8, 13, 13.5, 14.5, 13.5, 14.5],
] as const;
const BANDS_FADE = [7.5, 9] as const;

/**
 * Base-style geometry hidden on every base (useMapInit, at load): roads,
 * tunnels, aeroways and buildings only ever showed through gaps in the
 * imagery, and the vector bases want plain land.
 */
export const HIDDEN_BASE_GEOMETRY = /^(road|tunnel)-|^(aeroway|building)/;
/**
 * Man-made land KEPT on every base and painted the land colour: piers,
 * breakwaters and groynes (Streets v8 structure class 'land') and bridges.
 * Over water they read as structure, which on Relief or Ocean with ENC off is
 * a marina's only geometry and a channel's air-draft hazard; on plain land
 * they vanish into it.
 */
export const LAND_STRUCTURE = /^(land-structure|bridge)-/;

export type ReliefPalette = 'day' | 'night' | 'enc';
type Ramp = ReadonlyArray<readonly [number, string]>;

/** Depth (m, positive down) → the 8-bit index the tiles carry: 0 = land or under 0.3 m, 1..254 log-scaled water. */
export const depthIndex = (d: number): number =>
    d <= 0.3 ? 0 : 1 + 253 * Math.min(1, Math.log1p(Math.min(d, 6000) / 2) / Math.log1p(3000));

const DAY = {
    ramp: [
        [0, 'rgba(88,168,206,0)'],
        [0.6, 'rgba(88,168,206,0.9)'],
        [2, '#52a6cc'],
        [5, '#4495c1'],
        [10, '#3886b6'],
        [20, '#2b73a4'],
        [30, '#246698'],
        [40, '#1f5b8c'],
        [60, '#1a4f7e'],
        [100, '#164673'],
        [200, '#133f69'],
        [400, '#10375e'],
        [1000, '#0d2f52'],
        [2000, '#0a2746'],
        [4000, '#081f3a'],
        [6000, '#061a30'],
    ] as Ramp,
    // bathymetry-v2 bands at 0, 200, 1000, 2000 and 4000 m
    bands: ['#2a6f9e', '#1f5a85', '#16466e', '#113a5e', '#0b2b49'],
    shadow: 'rgba(2,12,24,0.85)',
    highlight: 'rgba(200,236,255,0.55)',
    coast: 'rgba(196,222,240,0.55)',
    land: '#333b45',
    water: '#1f5a85',
};
const NIGHT: typeof DAY = {
    ramp: [
        [0, 'rgba(24,44,58,0)'],
        [0.6, 'rgba(24,44,58,0.85)'],
        [2, '#182c3a'],
        [5, '#142734'],
        [25, '#0f1f2b'],
        [100, '#0b1822'],
        [400, '#08131d'],
        [2000, '#060e16'],
        [6000, '#04090f'],
    ],
    bands: ['#11222f', '#0c1822', '#09131c', '#070f17', '#060d14'],
    shadow: '#020406',
    highlight: 'rgba(120,60,60,0.22)',
    coast: 'rgba(150,60,60,0.55)',
    land: '#141518',
    water: '#0c1822',
};

/** The index ramp. Stops climb strictly, so a log-squeezed pair can never collide. */
function indexRamp(ramp: Ramp): mapboxgl.ExpressionSpecification {
    const out: unknown[] = ['interpolate', ['linear'], ['raster-value']];
    let last = -1;
    for (const [d, colour] of ramp) {
        last = d === 0 ? 0 : Math.max(depthIndex(d), last + 0.01);
        out.push(last, colour);
    }
    out.push(255, ramp[ramp.length - 1][1]);
    return out as mapboxgl.ExpressionSpecification;
}

const zoomFade = (stops: number[]) =>
    ['interpolate', ['linear'], ['zoom'], ...stops] as mapboxgl.ExpressionSpecification;
const bandColour = (p: typeof DAY) =>
    [
        'interpolate',
        ['linear'],
        ['get', 'min_depth'],
        ...[0, 200, 1000, 2000, 4000].flatMap((d, i) => [d, p.bands[i]]),
    ] as mapboxgl.ExpressionSpecification;
const tintFade = (f0: number, f1: number, damp: number) => zoomFade([f0, damp, f1, 0]);
const shadeFade = (f0: number, f1: number) => zoomFade([5, 0.4, 9, 0.7, f0, 0.7, f1, 0]);

const painted = new WeakMap<object, ReliefPalette>();

/**
 * Add the sea once per style load, right after the satellite source exists
 * (Relief + Sat borrows it rather than downloading imagery twice). Idempotent.
 */
export function addReliefBase(map: mapboxgl.Map, base: string = RELIEF_TILE_BASE): void {
    const layers = map.getStyle()?.layers ?? [];
    const waterAt = layers.findIndex((layer) => layer.id === 'water');
    if (waterAt < 0 || !map.getSource('composite')) return;
    const above = layers[waterAt + 1]?.id;
    painted.delete(map);
    const add = (layer: Record<string, unknown>, before: string | undefined) => {
        if (!map.getLayer(layer.id as string))
            map.addLayer({ ...layer, layout: { visibility: 'none' } } as mapboxgl.AnyLayer, before);
    };
    const sea = { source: 'composite', paint: {} as Record<string, unknown> };

    if (map.getSource('satellite-base'))
        add(
            {
                id: LAND_IMAGERY_LAYER,
                type: 'raster',
                source: 'satellite-base',
                paint: { 'raster-saturation': 0.15, 'raster-contrast': 0.05 },
            },
            'water',
        );
    add(
        {
            ...sea,
            id: SEA_BASE_LAND_SHADE,
            type: 'fill',
            'source-layer': 'hillshade',
            paint: {
                'fill-antialias': false,
                'fill-color': ['match', ['get', 'class'], 'shadow', 'rgba(0,0,0,0.16)', 'rgba(255,255,255,0.05)'],
            },
        },
        'water',
    );
    add(
        {
            ...sea,
            id: SEA_BASE_BANDS,
            type: 'fill',
            'source-layer': 'depth',
            maxzoom: BANDS_FADE[1],
            paint: {
                'fill-antialias': false,
                'fill-color': bandColour(DAY),
                'fill-opacity': zoomFade([BANDS_FADE[0], 1, BANDS_FADE[1], 0]),
            },
        },
        above,
    );
    if (base) {
        for (const [set, minzoom, maxzoom, t0, t1, s0, s1] of SETS) {
            for (const kind of ['idx', 'dem'] as const) {
                const id = `relief-${set}-${kind}`;
                if (!map.getSource(id))
                    map.addSource(id, {
                        type: kind === 'dem' ? 'raster-dem' : 'raster',
                        tiles: [`${base}/relief-${set}/${kind}/{z}/{x}/{y}.${kind === 'dem' ? 'webp' : 'png'}`],
                        tileSize: 256,
                        minzoom,
                        maxzoom,
                        ...(kind === 'dem' ? { encoding: 'terrarium' } : {}),
                        ...(set === 'au' ? { bounds: RELIEF_AU_BOUNDS } : {}),
                        attribution: RELIEF_ATTRIBUTION,
                    } as mapboxgl.AnySourceData);
            }
            add(
                {
                    id: `relief-${set}-tint`,
                    type: 'raster',
                    source: `relief-${set}-idx`,
                    minzoom,
                    maxzoom: t1,
                    paint: {
                        'raster-color': indexRamp(DAY.ramp),
                        // GL JS 3.19 feeds the channels as 0..1: [1,0,0,0] drew nothing.
                        'raster-color-mix': [255, 0, 0, 0],
                        'raster-color-range': [0, 255],
                        'raster-opacity': tintFade(t0, t1, 1),
                        'raster-fade-duration': 0,
                    },
                },
                above,
            );
            add(
                {
                    id: `relief-${set}-shade`,
                    type: 'hillshade',
                    source: `relief-${set}-dem`,
                    minzoom,
                    maxzoom: s1,
                    paint: {
                        'hillshade-exaggeration': shadeFade(s0, s1),
                        'hillshade-shadow-color': DAY.shadow,
                        'hillshade-highlight-color': DAY.highlight,
                        'hillshade-accent-color': 'rgba(0,0,0,0)',
                        'hillshade-illumination-direction': 315,
                    },
                },
                above,
            );
        }
    }
    add(
        {
            ...sea,
            id: SEA_BASE_COAST,
            type: 'line',
            'source-layer': 'water',
            paint: { 'line-color': DAY.coast, 'line-width': zoomFade([5, 0.5, 10, 0.9, 14, 1.3]) },
        },
        above,
    );
}

/** The sea layers a base shows, as [layer id, visible]. Satellite and Hybrid show none. */
export function seaBaseLayers(base: ObsChartBase): Array<[string, boolean]> {
    const relief = base === 'relief' || base === 'reliefSat';
    const sea = relief || base === 'ocean';
    return [
        ...RELIEF_LAYER_IDS.map((id): [string, boolean] => [id, relief]),
        [SEA_BASE_BANDS, sea],
        [SEA_BASE_LAND_SHADE, base === 'ocean'],
        [SEA_BASE_COAST, sea],
        [LAND_IMAGERY_LAYER, base === 'reliefSat'],
    ];
}

/**
 * Recolour the sea for night (a native dim palette under the app's red
 * scrim) or damp the relief tint while the ENC glaze is drawn, so two depth
 * colour codes don't fight. The ENC glaze itself is untouched. Writes only
 * when the palette changes (the styledata-loop rule, 2026-07-12) and returns
 * whether it wrote.
 */
export function setReliefPalette(map: mapboxgl.Map, mode: ReliefPalette): boolean {
    if (painted.get(map) === mode || !map.getLayer(SEA_BASE_BANDS)) return false;
    painted.set(map, mode);
    const p = mode === 'night' ? NIGHT : DAY;
    const set = (id: string, prop: string, value: unknown) => {
        if (map.getLayer(id)) map.setPaintProperty(id, prop as 'fill-color', value as string);
    };
    for (const [setName, , , t0, t1] of SETS) {
        const tint = `relief-${setName}-tint`;
        set(tint, 'raster-color', indexRamp(p.ramp));
        set(tint, 'raster-opacity', tintFade(t0, t1, mode === 'enc' ? 0.7 : 1));
        set(tint, 'raster-saturation', mode === 'enc' ? -0.5 : 0);
        set(`relief-${setName}-shade`, 'hillshade-shadow-color', p.shadow);
        set(`relief-${setName}-shade`, 'hillshade-highlight-color', p.highlight);
    }
    set(SEA_BASE_BANDS, 'fill-color', bandColour(p));
    set(SEA_BASE_COAST, 'line-color', p.coast);
    set('land', 'background-color', p.land);
    set('landuse', 'fill-color', p.land);
    set('national-park', 'fill-color', p.land);
    set('water', 'fill-color', p.water);
    set('waterway', 'line-color', p.water);
    for (const layer of map.getStyle()?.layers ?? [])
        if (LAND_STRUCTURE.test(layer.id) && (layer.type === 'line' || layer.type === 'fill'))
            set(layer.id, `${layer.type}-color`, p.land);
    return true;
}
