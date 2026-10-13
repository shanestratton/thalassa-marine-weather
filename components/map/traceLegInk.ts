/**
 * Planning-line ink that must read on Light's pale sea as well as the dark
 * bases (127-DESKMAP A4/C3). The tracer's legs, the harbour dashes and the
 * model-comparison lines were tuned for a dark sea and fell to 1.1-1.8:1 on a
 * pale one; they ride the route line's dark casing now, on every base.
 */
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
