/**
 * Tests for the 👍/🆗/👎 weather-window verdict in the metric deep-dive.
 * A wrong direction here would tell a sailor a poor window is good — pin it.
 */
import { describe, it, expect } from 'vitest';
import { windowVerdict } from '../components/dashboard/hero/MetricDeepDiveModal';

describe('windowVerdict', () => {
    const wind = { good: 15, poor: 22 }; // lower is better

    it('lower-is-better: good / marginal / poor by threshold', () => {
        expect(windowVerdict(wind, true, 10)).toBe('good');
        expect(windowVerdict(wind, true, 15)).toBe('good'); // boundary inclusive
        expect(windowVerdict(wind, true, 18)).toBe('marginal');
        expect(windowVerdict(wind, true, 22)).toBe('poor'); // boundary inclusive
        expect(windowVerdict(wind, true, 30)).toBe('poor');
    });

    it('higher-is-better (visibility): direction inverts', () => {
        const vis = { good: 9.26, poor: 3.7 }; // km, no lowerIsBetter
        expect(windowVerdict(vis, false, 12)).toBe('good');
        expect(windowVerdict(vis, undefined, 6)).toBe('marginal');
        expect(windowVerdict(vis, false, 2)).toBe('poor');
    });

    it('no thresholds or no value ⇒ no verdict', () => {
        expect(windowVerdict(undefined, true, 10)).toBeNull();
        expect(windowVerdict(wind, true, null)).toBeNull();
        expect(windowVerdict(wind, true, NaN)).toBeNull();
    });
});
