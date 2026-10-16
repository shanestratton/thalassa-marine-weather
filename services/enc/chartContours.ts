/** Display preferences only. Routing, alarms and clearance never read this model. */
export interface ChartContours {
    shallowM: number;
    safetyM: number;
    deepM: number;
    reliefSafety: boolean;
}
export const MAX_CHART_CONTOUR_M = 6000;
export function parseChartContours(input: unknown): ChartContours | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const p = input as Record<string, unknown>;
    const values = [p.shallowM, p.safetyM, p.deepM];
    if (values.some((v) => typeof v !== 'number' || !Number.isFinite(v)) || typeof p.reliefSafety !== 'boolean')
        return null;
    const [shallowM, safetyM, deepM] = values as number[];
    if (shallowM < 0.1 || shallowM >= safetyM || safetyM >= deepM || deepM > MAX_CHART_CONTOUR_M) return null;
    return { shallowM, safetyM, deepM, reliefSafety: p.reliefSafety };
}
/** The chosen display contour can raise the existing keel threshold, never
 * lower it. Increasing draft also raises the deep band to keep strict order.
 * No tide height or provider capability can change this datum-based floor. */
export function effectiveChartContours(input: unknown, requiredM: number): ChartContours | null {
    const p = parseChartContours(input);
    if (!p || !Number.isFinite(requiredM) || requiredM <= 0 || requiredM >= MAX_CHART_CONTOUR_M) return null;
    const safetyM = Math.max(p.safetyM, requiredM);
    return { ...p, safetyM, deepM: Math.max(p.deepM, Math.min(MAX_CHART_CONTOUR_M, safetyM + 1)) };
}
export function suggestedChartContours(requiredM: number): ChartContours | null {
    if (!Number.isFinite(requiredM) || requiredM <= 0 || requiredM >= MAX_CHART_CONTOUR_M) return null;
    const safetyM = Math.max(0.2, requiredM);
    return {
        shallowM: Math.min(2, safetyM / 2),
        safetyM,
        deepM: Math.max(30, Math.min(MAX_CHART_CONTOUR_M, safetyM + 1)),
        reliefSafety: false,
    };
}
