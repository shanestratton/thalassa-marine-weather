import { seaComfort, type ComfortParts } from '../../utils/seaComfort';
import { PERSONAL_COMFORT_INPUTS, type ComfortPreference } from '../../utils/comfortPreference';
export interface PrivateComfortReport {
    qualified: boolean;
    operation: string;
    voyageId: string;
    capturedAt: string;
    level: number;
    parts: ComfortParts & { secondarySwell: ComfortParts['swell'] };
    fetchedAt: string;
    validAt: string;
}
const WORDS = ['Comfortable', 'Lively', 'Uncomfortable', 'Hard going'];
const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b),
        middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
/** Each voyage gets one vote per input; a dense or repeated voyage cannot
 * dominate the preference. Call only on the exact current server cohort. */
export function qualifyComfortPreference(
    profile: ComfortPreference['profile'],
    reports: readonly PrivateComfortReport[],
): ComfortPreference {
    const result: ComfortPreference = {
        schema: 1,
        profile: { ...profile },
        adjustments: { size: 0, steepness: 0, pitching: 0, cross: 0 },
        qualified: {
            size: { reports: 0, voyages: 0 },
            steepness: { reports: 0, voyages: 0 },
            pitching: { reports: 0, voyages: 0 },
            cross: { reports: 0, voyages: 0 },
        },
    };
    if (reports.length > 120 || !Number.isSafeInteger(profile.revision) || profile.revision < 1) return result;
    const groups = new Map<string, Map<string, number[]>>(),
        operations = new Set<string>();
    for (const report of reports) {
        if (
            !report ||
            report.qualified !== true ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(report.operation) ||
            operations.has(report.operation) ||
            typeof report.voyageId !== 'string' ||
            !report.voyageId ||
            report.voyageId.length > 256 ||
            !Number.isInteger(report.level) ||
            report.level < 0 ||
            report.level > 3
        )
            continue;
        operations.add(report.operation);
        const captured = Date.parse(report.capturedAt),
            fetched = Date.parse(report.fetchedAt),
            valid = Date.parse(report.validAt);
        if (
            ![captured, fetched, valid].every(Number.isFinite) ||
            fetched < captured - 30 * 60000 ||
            fetched > captured + 10 * 60000 ||
            valid < captured - 30 * 60000 ||
            valid > captured + 10 * 60000
        )
            continue;
        if (!report.parts || !report.parts.total || !('windSea' in report.parts) || !('swell' in report.parts))
            continue;
        const baseline = seaComfort(report.parts, profile);
        if (!baseline?.word || baseline.generic || !baseline.input || baseline.input === 'wmo') continue;
        const voyages = groups.get(baseline.input) ?? new Map<string, number[]>();
        const values = voyages.get(report.voyageId) ?? [];
        values.push(report.level - WORDS.indexOf(baseline.word));
        voyages.set(report.voyageId, values);
        groups.set(baseline.input, voyages);
    }
    for (const input of PERSONAL_COMFORT_INPUTS) {
        const voyages = groups.get(input),
            counts = result.qualified[input];
        if (!voyages) continue;
        counts.voyages = voyages.size;
        counts.reports = [...voyages.values()].reduce((sum, values) => sum + values.length, 0);
        if (counts.reports >= 6 && counts.voyages >= 3)
            result.adjustments[input] = Math.max(
                -1,
                Math.min(1, Math.trunc(median([...voyages.values()].map(median)))),
            ) as -1 | 0 | 1;
    }
    return result;
}
