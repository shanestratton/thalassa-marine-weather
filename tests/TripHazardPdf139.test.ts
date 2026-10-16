import { describe, expect, it, vi } from 'vitest';
vi.mock('../services/enc/EncCellMetadata', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/enc/EncCellMetadata')>()),
    getCell: vi.fn(),
}));
import { getCell } from '../services/enc/EncCellMetadata';
import { generateTripPdf } from '../services/TripPdfService';
import type { RouteHazardReportEntry } from '../services/enc/EncHazardReportService';
import type { EncCell } from '../services/enc/types';

const trip = { name: 'Synthetic passage', legs: [], totalDistanceNm: 10, totalDurationHours: 2, countries: [] };
const hazard = (cellId: string, description: string, sourceHO = 'US'): RouteHazardReportEntry => ({
    cellId,
    sourceHO,
    description,
    hazardType: 'rock',
    minDepthM: 0.12345,
    distanceNm: 0.012345,
    side: 'port',
    representativePoint: { lat: 12.34567, lon: 123.45678 },
});
const read = (blob: Blob) =>
    new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(blob);
    });
describe('actual trip PDF hazard licensing', () => {
    it('writes public NOAA rows and grade counts, with no protected or unknown-source details', async () => {
        vi.mocked(getCell).mockImplementation((id) =>
            id === 'US5OPEN1'
                ? ({ id, sourceHO: 'US' } as EncCell)
                : id === 'AU5CLOSE'
                  ? ({ id, sourceHO: 'AU' } as EncCell)
                  : null,
        );
        const blob = generateTripPdf(trip, {
            hazardReport: {
                cellsConsulted: 3,
                bufferNm: 1,
                requiredDepthM: 3,
                entries: [
                    hazard('AU5CLOSE', 'SECRET_LICENSED_MARKER', 'AU'),
                    hazard('US5OPEN1', 'PUBLIC_NOAA_MARKER'),
                    hazard('US5GONE1', 'SECRET_MISSING_SOURCE'),
                ],
                advisories: [{ severity: 'caution', text: 'SECRET_LICENSED_ADVISORY' }],
            },
        });
        const text = await read(blob);
        expect(text).toContain('DANGER: PUBLIC_NOAA_MARKER');
        expect(text).toContain('12.346');
        expect(text).toContain('123.457');
        expect(text).toContain('2 danger, 0 caution and 0 note');
        expect(text).not.toMatch(
            /SECRET_LICENSED_MARKER|SECRET_MISSING_SOURCE|SECRET_LICENSED_ADVISORY|AU5CLOSE|US5GONE1/,
        );
    });
    it('prints no chart positions, depths, distances or descriptions when all findings stay aboard', async () => {
        vi.mocked(getCell).mockReturnValue(null);
        const blob = generateTripPdf(trip, {
            hazardReport: {
                cellsConsulted: 1,
                bufferNm: 1,
                requiredDepthM: 3,
                entries: [hazard('AU5CLOSE', 'SECRET_LICENSED_MARKER', 'AU')],
            },
        });
        const text = await read(blob);
        expect(text).toContain('1 danger, 0 caution and 0 note');
        expect(text).not.toMatch(/SECRET_LICENSED_MARKER|AU5CLOSE/);
        // Graphics operands can coincidentally contain decimal substrings;
        // chart coordinates/depths/distances must be absent from actual PDF text.
        const visibleText = text
            .split('\n')
            .filter((line) => /\bTj$|\bTJ$/.test(line))
            .join('\n');
        expect(visibleText).not.toMatch(/12\.346|123\.457|0\.1 m|0\.01 NM/);
    });
});
