import type { RouteHazardReport, RouteHazardReportEntry } from './EncHazardReportService';
import { isOpenChartCell, type ChartLicenceInput } from './chartLicence';

export type RouteHazardGrade = 'danger' | 'caution' | 'note';
export interface GradedRouteHazard extends RouteHazardReportEntry {
    grade: RouteHazardGrade;
}
const rank: Record<RouteHazardGrade, number> = { danger: 2, caution: 1, note: 0 };
const distance = (entry: RouteHazardReportEntry): number =>
    Number.isFinite(entry.distanceNm) && entry.distanceNm >= 0 ? entry.distanceNm : Infinity;

/** Proximity briefing only: this never promotes a route to verified or changes depth admission. */
export function gradeRouteHazard(entry: RouteHazardReportEntry, requiredDepthM?: number): RouteHazardGrade {
    const nm = distance(entry);
    if (!Number.isFinite(nm)) return 'caution';
    if (entry.hazardType === 'coast') return nm <= 0.3 ? 'caution' : 'note';
    const knownDepth = entry.minDepthM != null && Number.isFinite(entry.minDepthM);
    const floorKnown = requiredDepthM != null && Number.isFinite(requiredDepthM) && requiredDepthM > 0;
    const depthConcern = !knownDepth || !floorKnown || entry.minDepthM! < requiredDepthM!;
    if (nm <= 0.05 && depthConcern) return 'danger';
    return nm <= 0.3 || !knownDepth ? 'caution' : 'note';
}

/** The same worst-first order is used before caps, aboard and at the file boundary. */
export function gradedRouteHazards(report: Pick<RouteHazardReport, 'entries' | 'requiredDepthM'>): GradedRouteHazard[] {
    return report.entries
        .map((entry) => ({ ...entry, grade: gradeRouteHazard(entry, report.requiredDepthM) }))
        .sort((a, b) => rank[b.grade] - rank[a.grade] || distance(a) - distance(b));
}

/** A file gets original chart facts only for a still-registered, explicitly open source.
 * Protected/unknown details never cross this boundary, including names, positions and distances.
 * Plain grade counts may be printed for facts that stay aboard. No advisory prose is copied.
 */
export function routeHazardsForFile(
    report: RouteHazardReport,
    resolveCell: (id: string) => ChartLicenceInput | null | undefined,
): { entries: GradedRouteHazard[]; withheld: Record<RouteHazardGrade, number> } {
    const entries: GradedRouteHazard[] = [],
        withheld = { danger: 0, caution: 0, note: 0 };
    for (const entry of gradedRouteHazards(report)) {
        const cell = resolveCell(entry.cellId);
        if (
            cell &&
            cell.id.trim().toUpperCase() === entry.cellId.trim().toUpperCase() &&
            isOpenChartCell(cell) &&
            isOpenChartCell({ id: entry.cellId, sourceHO: entry.sourceHO })
        )
            entries.push(entry);
        else withheld[entry.grade]++;
    }
    return { entries, withheld };
}
