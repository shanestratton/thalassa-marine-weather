/**
 * A census must not hide its own blind spots.
 *
 * The first probe registry silently skipped any probe that threw. Shane's
 * device then reported `probes: {}` — which reads as "nothing registered",
 * when the truth may have been "something registered and is broken". Those are
 * completely different bugs, and the reading could not tell them apart.
 *
 * That is the same failure this whole instrument exists to prevent, committed
 * inside the instrument itself.
 */
import { describe, expect, it } from 'vitest';
import { registerCensusProbe, takeCensus } from '../services/memoryCensus';

describe('census probes', () => {
    it('carries a working probe', async () => {
        const off = registerCensusProbe('good', () => 5);
        expect((await takeCensus()).probes.good).toBe(5);
        off();
    });

    it('records a THROWING probe as -2 rather than dropping it', async () => {
        const off = registerCensusProbe('broken', () => {
            throw new Error('nope');
        });
        expect((await takeCensus()).probes.broken).toBe(-2);
        off();
    });

    it('records a nonsense answer as -1, which is not the same as absent', async () => {
        const off = registerCensusProbe('nan', () => Number.NaN);
        const c = await takeCensus();
        expect(c.probes.nan).toBe(-1);
        expect(c.probes.neverRegistered).toBeUndefined();
        off();
    });

    it('always reports canvas MEGABYTES, not just a count', async () => {
        // 16 canvases means nothing without their size: one full-screen retina
        // canvas is ~14MB, so the same count is either trivial or a quarter of
        // a gigabyte.
        const c = await takeCensus();
        expect(typeof c.probes.canvasMB).toBe('number');
    });

    it('a broken probe cannot cost the rest of the census', async () => {
        const off = registerCensusProbe('alsoBroken', () => {
            throw new Error('nope');
        });
        const c = await takeCensus();
        expect(c.domNodes).toBeGreaterThanOrEqual(0);
        expect(c.sinceBootMs).toBeGreaterThanOrEqual(0);
        off();
    });
});
