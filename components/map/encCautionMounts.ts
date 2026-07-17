/**
 * encCautionMounts — the caution/info AREA layer mounts (restricted /
 * cable / pipeline / TSS / seabed / anchorage / marine-farm washes,
 * SBDARE's non-clickable fill, the TSS ORIENT arrows and the FAIRWY
 * boundary), carved out of EncVectorLayer (2026-07-17 audit: residual
 * god-module, ~2 300 lines). Pure mount code — no module state.
 */
import mapboxgl from 'mapbox-gl';
import { ENC_VEC_LAYERS, ENC_VEC_SRC } from './encLayerIds';
import { mapExpr } from './encDepthStyle';

/**
 * mountCautionAreaLayers — caution / info AREAS (RESARE/CBLARE/PIPARE/SBDARE/
 * TSSLPT) as chart furniture (2026-07-16 ENC-completeness audit). A faint
 * data-driven wash + a dashed outline: S-52 magenta for restricted / cable /
 * pipeline / TSS zones, a muted olive for seabed-nature (SBDARE, an anchoring
 * aid rather than a caution). z11+ so it never clutters a passage overview.
 * The fill is tappable (encPopup reads the restriction); the outline decorates.
 */
export function mountCautionAreaLayers(map: mapboxgl.Map, beforeIdFor: (id: string) => string | undefined): void {
    // Per-CLASS colours (audit: all four true-caution classes rendered one
    // flat magenta — S-52/Navionics differentiate cable vs restricted vs TSS):
    // restricted stays S-52 magenta, cable/pipeline go violet, TSS lanes
    // amber, seabed nature a muted olive. encPopup accents match.
    const colourExpr = [
        'match',
        ['get', '_caution'],
        'SBDARE',
        '#8a8a5a', // seabed nature — olive (anchoring aid)
        'CBLARE',
        '#7c3aed', // submarine cable — violet
        'PIPARE',
        '#5b21b6', // pipeline — deep violet
        'TSSLPT',
        '#d97706', // TSS lane — amber
        'TSEZNE',
        '#c2410c', // TSS separation zone — burnt orange, darker than the lane (audit: zone read identical to lane)
        'ACHARE',
        '#2f6fd0', // designated anchorage — marine blue
        'MARCUL',
        '#5f7a3a', // marine farm — kelp green (nets + lines, keep clear)
        'PRCARE',
        '#d97706', // precautionary area — TSS amber family
        'DWRTPT',
        '#0e7490', // deep-water route — deep teal (big-ship water)
        'TSELNE',
        '#d97706', // TSS separation line (renders on the line layer)
        'TSSBND',
        '#d97706', // TSS boundary line
        '#c0209a', // RESARE + CTNARE + default — caution magenta
    ] as unknown;
    if (!map.getLayer(ENC_VEC_LAYERS.CAUTION_AREA_FILL)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.CAUTION_AREA_FILL,
                type: 'fill',
                source: ENC_VEC_SRC.CAUTION_AREAS,
                minzoom: 11,
                // SBDARE (seabed nature) is EXCLUDED from this tappable wash —
                // it blankets whole seabed areas and, clickable + above DEPARE,
                // it stole the flagship depth/keel popup (audit). It gets its
                // own subtle, NON-clickable fill below; its NATSUR decode is
                // folded into the DEPARE popup instead (extras.seabed).
                filter: ['!=', ['get', '_caution'], 'SBDARE'],
                paint: {
                    'fill-color': colourExpr as mapboxgl.ExpressionSpecification,
                    // The separation ZONE is a keep-out, not a lane — it reads
                    // at double the wash so the two are never confusable
                    // (audit: TSEZNE was visually identical to TSSLPT).
                    'fill-opacity': mapExpr(['case', ['==', ['get', '_caution'], 'TSEZNE'], 0.22, 0.1]),
                },
            },
            beforeIdFor(ENC_VEC_LAYERS.CAUTION_AREA_FILL),
        );
    }
    if (!map.getLayer(ENC_VEC_LAYERS.SBDARE_FILL)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.SBDARE_FILL,
                type: 'fill',
                source: ENC_VEC_SRC.CAUTION_AREAS,
                // Anchoring-decision zoom — at z11 the olive wash over every
                // seabed polygon was pure clutter (audit).
                minzoom: 13,
                filter: ['==', ['get', '_caution'], 'SBDARE'],
                paint: {
                    'fill-color': '#8a8a5a',
                    'fill-opacity': 0.06,
                },
            },
            beforeIdFor(ENC_VEC_LAYERS.SBDARE_FILL),
        );
    }
    if (!map.getLayer(ENC_VEC_LAYERS.CAUTION_AREA_LINE)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.CAUTION_AREA_LINE,
                type: 'line',
                source: ENC_VEC_SRC.CAUTION_AREAS,
                minzoom: 11,
                // SBDARE outlines OFF this layer too (audit: olive dashes over
                // every seabed polygon at z11 = clutter, and taps on them fell
                // through to a depth-not-seabed answer). Its subtle fill above
                // is the visual; the DEPARE popup carries the seabed read.
                filter: ['!=', ['get', '_caution'], 'SBDARE'],
                layout: { 'line-join': 'round' },
                paint: {
                    'line-color': colourExpr as mapboxgl.ExpressionSpecification,
                    'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.8, 15, 1.6],
                    'line-dasharray': [3, 2],
                    'line-opacity': 0.85,
                },
            },
            beforeIdFor(ENC_VEC_LAYERS.CAUTION_AREA_LINE),
        );
    }
    if (!map.getLayer(ENC_VEC_LAYERS.FAIRWY_LINE)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.FAIRWY_LINE,
                type: 'line',
                source: ENC_VEC_SRC.FAIRWY,
                minzoom: 11,
                layout: { 'line-join': 'round' },
                // Fairway boundary — long-dash marine blue, deliberately
                // quieter than the caution washes (it marks where you SHOULD
                // be). LINE only: a tappable fill would blanket the channel
                // and steal the water tap (burn-down: render the
                // already-extracted FAIRWY).
                paint: {
                    'line-color': '#3b82c4',
                    'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.8, 15, 1.4],
                    'line-dasharray': [6, 3],
                    'line-opacity': 0.6,
                },
            },
            beforeIdFor(ENC_VEC_LAYERS.FAIRWY_LINE),
        );
    }
    if (!map.getLayer(ENC_VEC_LAYERS.TSSLPT_ARROW)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.TSSLPT_ARROW,
                type: 'symbol',
                source: ENC_VEC_SRC.CAUTION_AREAS,
                minzoom: 11,
                // Lane-direction arrow at the lane polygon's anchor, rotated
                // to the S-57 ORIENT bearing and MAP-aligned so it points the
                // lane's true direction at any camera rotation (audit: the
                // wash was directionless — the one thing a TSS lane must say
                // is which WAY it flows).
                filter: [
                    'all',
                    ['==', ['get', '_caution'], 'TSSLPT'],
                    ['any', ['has', 'ORIENT'], ['has', 'orient']],
                ] as unknown as mapboxgl.FilterSpecification,
                layout: {
                    'symbol-placement': 'point',
                    'text-field': '⇧',
                    'text-size': ['interpolate', ['linear'], ['zoom'], 11, 18, 15, 30],
                    'text-rotate': mapExpr(['to-number', ['coalesce', ['get', 'ORIENT'], ['get', 'orient'], 0]]),
                    'text-rotation-alignment': 'map',
                    'text-allow-overlap': true,
                },
                paint: {
                    'text-color': '#d97706',
                    'text-opacity': 0.9,
                    'text-halo-color': 'rgba(255,255,255,0.7)',
                    'text-halo-width': 1,
                },
            },
            beforeIdFor(ENC_VEC_LAYERS.TSSLPT_ARROW),
        );
    }
}
