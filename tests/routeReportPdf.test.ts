/**
 * RouteReportPdfService — the PDF actually builds (no jsPDF runtime throw) and
 * comes out a valid, multi-page PDF for a long route. Can't eyeball layout in
 * CI, so this at least proves the generator + pagination don't blow up.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { generateRouteReportPdf, getRouteReportFileName } from '../services/RouteReportPdfService';
import type { TraceLegVerdict } from '../services/routeTracer';
import { clearAllCellMetadata, putCell } from '../services/enc/EncCellMetadata';
import type { EncCell } from '../services/enc/types';

const leg = (
    grade: 'clear' | 'caution' | 'danger',
    message: string | null,
    minDepthM: number | null,
): TraceLegVerdict =>
    ({
        grade,
        issues: message ? [{ severity: grade === 'clear' ? 'info' : grade, message }] : [],
        minDepthM,
        minAt: null,
        needsTide: false,
    }) as TraceLegVerdict;

describe('RouteReportPdfService', () => {
    it('builds a valid multi-page PDF from a long route with emoji-laden labels', async () => {
        const pins = Array.from({ length: 30 }, (_, i) => ({ lat: -27.1 - i * 0.01, lon: 153.1 + i * 0.01 }));
        const verdicts = Array.from({ length: 29 }, (_, i) =>
            i % 6 === 0
                ? leg('caution', 'Red port-hand mark to your port — correct side heading in (IALA-A)', 5)
                : i % 11 === 0
                  ? leg('danger', 'crosses charted land', -1)
                  : leg('clear', null, 5),
        );
        const weather = pins.map((_, i) => ({
            index: i,
            etaMs: 1_700_000_000_000 + i * 3_600_000,
            hoursFromDep: i,
            distanceNM: i * 6,
            windKts: i > 25 ? null : 12 + i,
            windDeg: (i * 20) % 360,
            gustKts: i > 25 ? null : 18 + i,
            beyondForecast: i > 25,
        }));
        const blob = generateRouteReportPdf({
            routeName: 'Bribie - Newport',
            pins,
            verdicts,
            tideLabels: { 0: '🌊 clears NOW until 13:17 today (approx)' },
            departureLabel: '🌊 leave 09:10–13:30 and every tide gate clears',
            vesselName: 'Serene Summer',
            draftM: 2.4,
            weather,
            cruisingSpeedKts: 6,
            nowMs: 1_700_000_000_000,
        });
        expect(blob.type).toBe('application/pdf');
        // A 30-waypoint / 29-leg route spills to a second page — a non-trivial
        // size proves the generator + pagination + emoji-safe text all ran.
        expect(blob.size).toBeGreaterThan(2000);
    });

    it('handles an empty/short route and a nameless route without throwing', async () => {
        const blob = generateRouteReportPdf({
            routeName: '',
            pins: [{ lat: -27.1, lon: 153.1 }],
            verdicts: [],
            tideLabels: {},
            departureLabel: null,
            nowMs: 1_700_000_000_000,
        });
        expect(blob.type).toBe('application/pdf');
    });

    it('sanitises the filename', () => {
        expect(getRouteReportFileName('Bribie - Newport')).toBe('Route_Bribie_-_Newport.pdf');
        expect(getRouteReportFileName('')).toBe('Route_Route.pdf');
        expect(getRouteReportFileName('Lady Musgrave → Newport')).toBe('Route_Lady_Musgrave___Newport.pdf');
    });
});

/**
 * A Route report PDF is a file she shares (127-C-b, C10 store 6). Over
 * licensed charts it prints each leg's grade, "needs tide" and the times, not
 * charted depths, mark names or reasons, and says so in the footer; NOAA legs
 * are printed exactly as before. Fictional cells: OC-99-ZZTEST off Nouméa
 * (protected), US5XX01M in the Chesapeake (open).
 */
describe('RouteReportPdfService — licensed chart figures stay aboard', () => {
    const cell = (id: string, sourceHO: string, bbox: EncCell['bbox']): EncCell => ({
        id,
        sourceHO,
        edition: 1,
        issued: '2026-08-01',
        importedAt: '2026-09-01T00:00:00.000Z',
        bbox,
        geojsonPath: `enc/${id}.json`,
        hazardCount: 1,
        usage: 'navigation',
    });
    beforeEach(() => {
        localStorage.clear();
        clearAllCellMetadata();
        putCell(cell('OC-99-ZZTEST', 'FR', [166.3, -22.4, 166.5, -22.2]));
        putCell(cell('US5XX01M', 'US', [-76.5, 38.9, -76.3, 39.1]));
    });
    const legs = (): TraceLegVerdict[] => [
        {
            grade: 'caution',
            issues: [{ severity: 'caution', message: 'thin water - 1.37 m charted at Passe Fictive' }],
            minDepthM: 1.37,
            minAt: null,
            needsTide: true,
            nudge: null,
            nudgeTo: null,
        },
        leg('clear', null, 4.71),
    ];
    const readBlob = (blob: Blob) =>
        new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsText(blob);
        });
    const pdfText = async (pins: Array<{ lat: number; lon: number }>): Promise<string> =>
        readBlob(
            generateRouteReportPdf({
                routeName: 'Lagoon run',
                pins,
                verdicts: legs(),
                tideLabels: { 0: 'needs +0.43 m - no tide window in 24 h', 1: 'clears 09:10-13:30 today' },
                departureLabel: null,
                nowMs: 1_700_000_000_000,
            }),
        );

    it('prints grades, needs-tide and times over licensed charts, and the footer', async () => {
        const text = await pdfText([
            { lat: -22.27, lon: 166.41 },
            { lat: -22.31, lon: 166.43 },
            { lat: -22.33, lon: 166.45 },
        ]);
        // Figures as printed (a PDF's own operators are full of numbers).
        for (const figure of ['1.37 m', '1.4 m', '4.7 m', '0.43 m', 'm least', 'thin water', 'Passe Fictive'])
            expect(text, figure).not.toContain(figure);
        expect(text).toContain('needs tide');
        expect(text).toContain('09:10-13:30');
        expect(text).toContain('licensed chart figures aren');
    });

    it('prints NOAA legs exactly as before', async () => {
        const text = await pdfText([
            { lat: 38.95, lon: -76.45 },
            { lat: 38.97, lon: -76.42 },
            { lat: 38.99, lon: -76.4 },
        ]);
        expect(text).toContain('thin water - 1.37 m charted at Passe Fictive');
        expect(text).toContain('clear - 4.7 m least');
        expect(text).toContain('needs +0.43 m');
        expect(text).not.toContain('licensed chart figures aren');
    });
});
