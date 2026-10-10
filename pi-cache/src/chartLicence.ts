/**
 * The Pi's copy of the app's licence rule (services/enc/chartLicence.ts;
 * pi-cache cannot import app services). 'open' only for a NOAA cell the Pi
 * did not decrypt itself; o-charts and S-63 cells, and everything unknown,
 * are 'protected'. tests/ChartLicenceParity.test.ts pins the two copies.
 */
export type ChartLicence = 'protected' | 'open';

export const NOAA_OPEN_CHART_ID = /^US[0-9][A-Z0-9]{5}$/;

export function piChartLicence(cell: {
    cellId: string;
    sourceHO?: string;
    source?: string;
    licence?: unknown;
}): ChartLicence {
    const ho = typeof cell.sourceHO === 'string' ? cell.sourceHO.trim().toUpperCase() : '';
    return NOAA_OPEN_CHART_ID.test(
        String(cell.cellId ?? '')
            .trim()
            .toUpperCase(),
    ) &&
        (!ho || ho === 'US') &&
        cell.source !== 'pi-decrypt' &&
        cell.source !== 's63' &&
        cell.licence !== 'protected'
        ? 'open'
        : 'protected';
}
