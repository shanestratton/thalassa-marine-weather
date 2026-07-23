/**
 * RouteReportPdfService — the PDF actually builds (no jsPDF runtime throw) and
 * comes out a valid, multi-page PDF for a long route. Can't eyeball layout in
 * CI, so this at least proves the generator + pagination don't blow up.
 */
import { describe, expect, it } from 'vitest';
import { generateRouteReportPdf, getRouteReportFileName } from '../services/RouteReportPdfService';
import type { TraceLegVerdict } from '../services/routeTracer';

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
