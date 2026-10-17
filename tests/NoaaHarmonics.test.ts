import { describe, it, expect } from 'vitest';
import reference from './fixtures/noaaHarmonicReference.json';
import { predictNoaaHarmonic, noaaHarmonicDay, NOAA_HARMONIC_STATION } from '../services/tides/noaaHarmonics';
describe('bounded NOAA astronomical station reconstruction', () => {
    it.each(reference)('compares every saved NOAA reference sample from $start without calibration', (fixture) => {
        const errors = fixture.valuesM.map((height, i) => {
            const predicted = predictNoaaHarmonic('9414290', Date.parse(fixture.start) + i * 3600000);
            expect(predicted).not.toBeNull();
            return predicted! - height;
        });
        expect(Math.max(...errors.map(Math.abs))).toBeLessThan(0.043);
        expect(errors.reduce((sum, e) => sum + Math.abs(e), 0) / errors.length).toBeLessThan(0.014);
    });
    it('refuses unknown stations, unsupported dates and invalid date normalisation', () => {
        expect(predictNoaaHarmonic('worldtides:9414290', Date.parse('2026-10-16Z'))).toBeNull();
        expect(predictNoaaHarmonic('9414290', NaN)).toBeNull();
        expect(predictNoaaHarmonic('9414290', Date.parse('2030-01-01Z'))).toBeNull();
        expect(noaaHarmonicDay('9414290', '2026-02-30')).toEqual([]);
        expect(noaaHarmonicDay('9414290', '2026-10-16')).toHaveLength(24);
        expect(NOAA_HARMONIC_STATION.datum).toBe('MLLW');
    });
    it('retains genuine below-datum tides and cannot be shifted by device timezone or a route point', () => {
        const rows = noaaHarmonicDay('9414290', '2026-10-16');
        expect(rows[0].timeMs).toBe(Date.parse('2026-10-16T00:00:00Z'));
        expect(predictNoaaHarmonic('9414290', rows[0].timeMs)).toBe(rows[0].heightM);
        const lows = reference.flatMap((f) =>
            f.valuesM.map((_, i) => predictNoaaHarmonic('9414290', Date.parse(f.start) + i * 3600000)!),
        );
        expect(Math.min(...lows)).toBeLessThan(0);
    });
});
