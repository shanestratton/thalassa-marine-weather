/**
 * Planning-line ink that must read on Light's pale sea as well as the dark
 * bases (127-DESKMAP A4/C3). The tracer's legs, the harbour dashes and the
 * model-comparison lines were tuned for a dark sea and fell to 1.1-1.8:1 on a
 * pale one; they ride the route line's dark casing now: on every base on the
 * web, and on the phone wherever it shows Light (128-LIGHT).
 */
import type mapboxgl from 'mapbox-gl';
import { SURVEY_DASH } from './inshoreRouteState';

/** The route line's dark edge (inshoreRouteState, since 2026-10-05). */
export const TRACE_CASING = SURVEY_DASH.casing;

/**
 * A leg with no chart behind it on this device: grey dashes on the dark edge,
 * "sketch, not checked" — never green, never the needs-tide amber.
 */
export const SKETCH_LEG_DASH = { ink: '#cbd5e1', casing: TRACE_CASING, dasharray: [2, 1.5] } as const;

/**
 * The bearing hint and the proven-lane ghost stay HINT weight, uncased: today's
 * ink on the dark bases, slate on Light. [layer, paint property, value] for
 * MapHub's base pass, which writes each only where the layer differs.
 */
export function traceHintPaint(paleSea: boolean): Array<[string, 'line-color' | 'line-opacity', string | number]> {
    return [
        ['trace-dest-hint-line', 'line-color', paleSea ? '#475569' : '#38bdf8'],
        ['trace-dest-hint-line', 'line-opacity', paleSea ? 0.7 : 0.45],
        ['trace-ghost-line', 'line-color', paleSea ? '#475569' : '#94a3b8'],
    ];
}

/** The dark edges under the harbour dashes and both model-comparison lines (useMapInit). */
export const LINE_EDGE_LAYERS = ['route-harbour-casing', 'confidence-gfs-casing', 'confidence-ecmwf-casing'] as const;

/**
 * Where the lines ride their dark edge, for MapHub's base pass (128-LIGHT;
 * Shane 2026-10-13: the phone planner on the Light chart too). The web: every
 * line, every base. The phone's planner now opens on Light, where its legs
 * (1.2-1.8:1), harbour dashes and model lines would fade into the pale sea, so
 * there they ride it too; on its other bases the phone keeps 127's lines, the
 * trace edge carrying only a "sketch, not checked" leg.
 */
export function lineEdges(phone: boolean, paleSea: boolean) {
    const all = !phone || paleSea;
    return {
        visibility: all ? ('visible' as const) : ('none' as const),
        traceFilter: all ? null : (['==', ['get', 'sketch'], true] as mapboxgl.FilterSpecification),
    };
}
