import { describe, expect, it } from 'vitest';
import { PressureFallWatch } from '../utils/pressureFallWatch';
import { observedTendency, type TendencyReading } from '../utils/barometerTendency';
const MIN = 60_000;
const NOW = 1_800_000_000_000;
const fall = observedTendency(
    Array.from({ length: 37 }, (_, i) => ({ t: NOW - (36 - i) * 5 * MIN, hpa: 1018 - i / 6 })),
    NOW,
)!;
const flat: TendencyReading = { ...fall, delta3h: 0, rawDelta3h: 0 };
describe('pressure fall episode watch', () => {
    it('requires two live minutes and delivers once per episode', () => {
        const watch = new PressureFallWatch();
        expect(watch.evaluate(fall, NOW, NOW, 'boat')).toBe(false);
        expect(watch.evaluate(fall, NOW + MIN, NOW + MIN, 'boat')).toBe(false);
        expect(watch.evaluate(fall, NOW + 2 * MIN, NOW + 2 * MIN, 'boat')).toBe(true);
        expect(watch.evaluate(fall, NOW + 3 * MIN, NOW + 3 * MIN, 'boat')).toBe(false);
        expect(watch.evaluate(flat, NOW + 4 * MIN, NOW + 4 * MIN, 'boat')).toBe(false);
        expect(watch.evaluate(flat, NOW + 9 * MIN, NOW + 9 * MIN, 'boat')).toBe(false);
        expect(watch.evaluate(fall, NOW + 10 * MIN, NOW + 10 * MIN, 'boat')).toBe(false);
        expect(watch.evaluate(fall, NOW + 12 * MIN, NOW + 12 * MIN, 'boat')).toBe(true);
    });
    it('stale data neither fires nor clears an episode', () => {
        const watch = new PressureFallWatch();
        watch.evaluate(fall, NOW, NOW, 'boat');
        expect(watch.evaluate(fall, NOW, NOW + 3 * MIN, 'boat')).toBe(false);
        expect(watch.evaluate(fall, NOW + 4 * MIN, NOW + 4 * MIN, 'boat')).toBe(false);
        expect(watch.evaluate(fall, NOW + 6 * MIN, NOW + 6 * MIN, 'boat')).toBe(true);
        watch.evaluate(flat, NOW, NOW + 10 * MIN, 'boat');
        expect(watch.evaluate(fall, NOW + 20 * MIN, NOW + 20 * MIN, 'boat')).toBe(false);
    });
    it('does not carry pending confirmation across a source or account change', () => {
        const watch = new PressureFallWatch();
        watch.evaluate(fall, NOW, NOW, 'A:boat');
        expect(watch.evaluate(fall, NOW + 2 * MIN, NOW + 2 * MIN, 'B:phone')).toBe(false);
    });
    it('requires advancing observations rather than repeated reads of one fresh sample', () => {
        const watch = new PressureFallWatch();
        expect(watch.evaluate(fall, NOW, NOW, 'boat')).toBe(false);
        expect(watch.evaluate(fall, NOW, NOW + MIN, 'boat')).toBe(false);
        expect(watch.evaluate(fall, NOW, NOW + 2 * MIN, 'boat')).toBe(false);
        expect(watch.evaluate(fall, NOW + 2 * MIN, NOW + 2 * MIN, 'boat')).toBe(true);
    });
});
