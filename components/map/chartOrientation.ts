/**
 * The chart's orientation (127-11): one owner of the bearing.
 *
 * Shane 2026-10-10: "oh, um add in the course up and north up etc. that is
 * cool to see as well". The modes (North, Course, Track and Heading up) and
 * the controller that turns the chart are 127-11b. This is the part every
 * layer reads so that it stays right the moment the chart turns (11a):
 *   - whether a turning mode is on: the wind field's square and the ENC
 *     merge window take a shape any bearing fits inside;
 *   - the bearing a fit must keep (chartFitBearing): Mapbox's fitBounds turns
 *     the chart to 0 unless told, and the mode would turn it straight back;
 *   - the mark every orientation turn carries in its eventData, so Locate and
 *     the tracer's long press never take one for a move of their own.
 * Nothing in 11a turns the chart: with no mode set, every reader gets today's
 * north-up answer. The gesture locks all stay (Shane 2026-05-18: "prevent the
 * earth from rotating on the chart page").
 */
import type mapboxgl from 'mapbox-gl';

let turning = false;
let target: number | null = null;
const listeners = new Set<() => void>();

/** A mode that turns the chart (Course, Track or Heading up) is on, whatever it shows this moment. */
export const chartTurning = (): boolean => turning;

/** The mode's word (127-11b's controller): its target, null while it holds North up. Listeners hear only a flip. */
export function setChartOrientation(next: { turning: boolean; target: number | null }): void {
    const flip = next.turning !== turning;
    turning = next.turning;
    target = next.target !== null && Number.isFinite(next.target) ? next.target : null;
    if (flip) for (const listener of [...listeners]) listener();
}

export function subscribeChartTurning(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** The chart's bearing now; 0 for a map that cannot say (a torn-down map, a test double). */
export function chartBearing(map: Pick<mapboxgl.Map, 'getBearing'>): number {
    try {
        const bearing = map.getBearing();
        return Number.isFinite(bearing) ? bearing : 0;
    } catch {
        return 0;
    }
}

/** The bearing every fit on the chart names: the mode's target, else the chart's own (0 north up). */
export const chartFitBearing = (map: Pick<mapboxgl.Map, 'getBearing'>): number => target ?? chartBearing(map);

/** An orientation turn, by the mark in its eventData; never a gesture, Locate or a fit. */
export const isOrientationEvent = (event: unknown): boolean =>
    (event as { thalassaOrientation?: unknown } | null)?.thalassaOrientation === true;
