import { describe, expect, it, vi } from 'vitest';
import {
    extractCoords,
    isAreaCoveringPoint,
    NoticeToMarinersService,
    parseIssueDate,
} from '../services/NoticeToMarinersService';

describe('NoticeToMarinersService geographic helpers', () => {
    it('matches antimeridian-spanning warning areas in either longitude convention', () => {
        // HYDROPAC is stored as 120°E → 280°E, while GPS positions arrive
        // in the conventional -180..180 range.
        expect(isAreaCoveringPoint('P', -20, 170)).toBe(true);
        expect(isAreaCoveringPoint('P', -20, -170)).toBe(true);
        expect(isAreaCoveringPoint('P', -20, -90)).toBe(true);
        expect(isAreaCoveringPoint('P', -20, -60)).toBe(false);

        // NAVAREA XIV also crosses the date line and must include NZ/Pacific
        // positions expressed west of Greenwich.
        expect(isAreaCoveringPoint('XIV', -40, -170)).toBe(true);
        expect(isAreaCoveringPoint('XIV', -40, -100)).toBe(false);
    });

    it('handles signed bounds that cross Greenwich and all-longitude regions', () => {
        expect(isAreaCoveringPoint('I', 55, -20)).toBe(true);
        expect(isAreaCoveringPoint('I', 55, 10)).toBe(true);
        expect(isAreaCoveringPoint('I', 55, 60)).toBe(false);
        expect(isAreaCoveringPoint('A', 75, 150)).toBe(true);
        expect(isAreaCoveringPoint('A', 55, 150)).toBe(false);
    });

    it('parses valid NGA issue dates and rejects calendar-normalised invalid values', () => {
        expect(parseIssueDate('292359Z FEB 2024')?.toISOString()).toBe('2024-02-29T23:59:00.000Z');
        expect(parseIssueDate('310000Z APR 2026')).toBeNull();
        expect(parseIssueDate('012460Z JAN 2026')).toBeNull();
    });

    it('extracts signed coordinates from a broadcast body', () => {
        expect(extractCoords('AREA BOUND BY 19-23.0N 092-03.1W AND 12-00.0S 150-30.0E')).toEqual([
            { lat: 19 + 23 / 60, lon: -(92 + 3.1 / 60) },
            { lat: -12, lon: 150.5 },
        ]);
    });

    it('puts a deadline on notice-source refreshes so one source cannot hang the layer', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            json: vi.fn().mockResolvedValue({ 'broadcast-warn': [] }),
        } as unknown as Response);
        const signal = new AbortController().signal;
        const timeoutMock = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal);

        await expect(NoticeToMarinersService.refresh(true)).resolves.toEqual([]);

        expect(timeoutMock).toHaveBeenCalledWith(15_000);
        expect(fetchMock).toHaveBeenCalledWith('/api/nga-msi/broadcast-warn?output=json', {
            headers: undefined,
            signal,
        });
        fetchMock.mockRestore();
        timeoutMock.mockRestore();
    });
});
