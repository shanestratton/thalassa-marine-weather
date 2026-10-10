/**
 * Which charts are licensed (127-C-b, C7): one rule for every store. 'open'
 * only for a NOAA cell (public domain); everything else, unknown included, is
 * 'protected'. A source can make a cell stricter, never more open. The Pi
 * keeps the same rule (pi-cache/src/chartLicence.ts, pinned by
 * tests/ChartLicenceParity.test.ts).
 */
import type { ChartLicence } from './types';

/** A NOAA ENC cell name, as the server's root read policy matches its file (20261009070000). */
export const OPEN_CHART_ID = /^US[0-9][A-Z0-9]{5}$/;

export interface ChartLicenceInput {
    id: string;
    sourceHO?: string;
    licence?: unknown;
}

export function chartLicenceOf(cell: ChartLicenceInput): ChartLicence {
    const ho = typeof cell.sourceHO === 'string' ? cell.sourceHO.trim().toUpperCase() : '';
    return OPEN_CHART_ID.test(
        String(cell.id ?? '')
            .trim()
            .toUpperCase(),
    ) &&
        (!ho || ho === 'US') &&
        cell.licence !== 'protected'
        ? 'open'
        : 'protected';
}

export const isProtectedChart = (cell: ChartLicenceInput): boolean => chartLicenceOf(cell) === 'protected';
export const isOpenChartCell = (cell: ChartLicenceInput): boolean => !isProtectedChart(cell);

/** True when any of these cells (ids or records) is protected; false for none. */
export const anyProtectedChart = (cells: Iterable<string | ChartLicenceInput> | null | undefined): boolean =>
    [...(cells ?? [])].some((cell) => isProtectedChart(typeof cell === 'string' ? { id: cell } : cell));
