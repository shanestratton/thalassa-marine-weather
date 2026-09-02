/**
 * The compass card must always take the short way round — including after the
 * accumulated angle has drifted positive, which is where JS's signed `%` sent
 * it the long way (audit 2026-09-02).
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useUnwrappedAngle } from '../components/nmea/gauges/useUnwrappedAngle';

const mod = (x: number) => ((x % 360) + 360) % 360;

describe('useUnwrappedAngle', () => {
    it('every step is at most 180° and lands on the target modulo 360, even after drifting positive', () => {
        // Headings stepping DOWN by 170° each time push the accumulator positive
        // (the card renders -heading), which is the regime that used to break.
        const headings = [0, 190, 20, 210, 40, 230, 60, 250, 80, 270, 100, 290, 120, 310, 140, 330, 160, 350, 180, 10];
        const { result, rerender } = renderHook(({ h }: { h: number }) => useUnwrappedAngle(-h), {
            initialProps: { h: headings[0] },
        });
        let prev = result.current;
        for (const h of headings.slice(1)) {
            act(() => rerender({ h }));
            const next = result.current;
            expect(Math.abs(next - prev), `heading ${h}: swung ${next - prev}°`).toBeLessThanOrEqual(180);
            expect(mod(next)).toBeCloseTo(mod(-h), 6);
            prev = next;
        }
    });
    it('crossing north nudges, never spins', () => {
        const { result, rerender } = renderHook(({ h }: { h: number }) => useUnwrappedAngle(-h), {
            initialProps: { h: 359 },
        });
        const before = result.current;
        act(() => rerender({ h: 1 }));
        expect(Math.abs(result.current - before)).toBeCloseTo(2, 6);
    });
});
