/**
 * The Instrument Panel's shoaling trend reads the depth it is shown, in the
 * reference it is shown in (review 2026-09-29).
 *
 * Since 2026-09-29 the Pi — the phones' primary feed — sends the boat
 * display's depth UNDER THE KEEL. The trend still added the tape-measured
 * transducer-to-keel offset (-1.46 m) to it, subtracting the keel twice: a
 * keel figure of 1.65 m falling at 0.6 m/min read "keel down in about 0 min"
 * (about 2.75 min by the sounder), and any keel figure under 1.46 m always
 * read 0 min. And the trend track mixed references: when the feed flipped
 * from the keel figure to a raw transducer one, the 1.8 m step read as
 * "Deepening … good" at the moment the keel touched.
 *
 * Shane 2026-09-29: "we should not need the offset for the transducer. just
 * the draft … lets not make it too complicated for the punter." The trend's
 * only boat figure is now the draft from the vessel profile.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { depthTrendFor, keelOffsetFor, newDepthTrack, recordDepth } from '../components/nmea/depthTrend';

/** Serene Summer's draft, as Shane gave it (2026-09-29). The trend reads it from the vessel profile. */
const DRAFT = 2.4;

const nowMs = Date.parse('2026-09-29T03:00:00Z');
const nowS = nowMs / 1000;

/** A straight trace over the last `minutes` ending now, a reading about every 10 s. */
function trace(from: number, to: number, minutes: number) {
    const n = Math.max(4, Math.round((minutes * 60) / 10));
    const dt = (minutes * 60) / n;
    return Array.from({ length: n + 1 }, (_, i) => ({
        t: nowS - minutes * 60 + i * dt,
        d: from + ((to - from) * i) / n,
    }));
}

describe('the keel offset the trend adds, by what the depth is measured from', () => {
    it('adds nothing to a depth already under the keel', () => {
        expect(keelOffsetFor('below-keel', DRAFT)).toBe(0);
    });
    it('takes the draft, and only the draft, off any other depth', () => {
        expect(keelOffsetFor('below-waterline', DRAFT)).toBe(-2.4);
        expect(keelOffsetFor('below-transducer', DRAFT)).toBe(-2.4);
        expect(keelOffsetFor(null, DRAFT)).toBe(-2.4);
        expect(keelOffsetFor('below-transducer', 1.2)).toBe(-1.2);
    });
});

describe('the shoaling trend on a keel-referenced feed', () => {
    it('a keel figure of 2.0 falling to 1.65 at 0.6 m/min gives about 3 minutes, not 0', () => {
        const track = newDepthTrack();
        for (const p of trace(2.0, 1.65, 35 / 60)) recordDepth(track, p, 'below-keel');
        const trend = depthTrendFor(track, DRAFT, nowMs);
        expect(trend.text).toMatch(/^Shoaling 0\.6 m\/min/);
        expect(trend.note).toBe('keel down in about 3 min at this rate');
    });

    it('a keel figure under the old 1.46 m tape offset is not already aground', () => {
        const track = newDepthTrack();
        for (const p of trace(1.4, 1.2, 2)) recordDepth(track, p, 'below-keel');
        const trend = depthTrendFor(track, DRAFT, nowMs);
        expect(trend.text).toMatch(/^Shoaling/);
        expect(trend.note).toBe('keel down in about 12 min at this rate');
        expect(trend.level).toBe('serious');
    });

    it('a depth not measured from the keel has the draft taken off, from the vessel profile', () => {
        const track = newDepthTrack();
        for (const p of trace(4.4, 4.2, 2)) recordDepth(track, p, 'below-transducer');
        // (4.2 - 2.4) / 0.1 = 18 min.
        expect(depthTrendFor(track, DRAFT, nowMs).note).toBe('keel down in about 18 min at this rate');
    });
});

// Final review 2026-09-29 (low): with no draft in the vessel profile the draft
// is the 2.5 m fallback, so a deeper boat on a transducer or waterline feed was
// told an optimistic "keel down in N min". The keel time is claimed only from
// a draft the skipper set, or from a feed already measured from the keel.
describe('the shoaling trend when the draft is not set', () => {
    it('says the draft is not set instead of a keel time, for a depth not measured from the keel', () => {
        for (const reference of ['below-transducer', 'below-waterline', null] as const) {
            const track = newDepthTrack();
            for (const p of trace(4.4, 4.2, 2)) recordDepth(track, p, reference);
            const trend = depthTrendFor(track, 2.5, nowMs, true);
            expect(trend.text).toMatch(/^Shoaling 0\.1 m\/min/);
            expect(trend.note).toBe('draft not set');
            expect(trend.note).not.toMatch(/keel down/);
        }
    });

    // Safety tidy 2026-09-29: only the note changed. The colour was still worked
    // out from minutes to the fallback 2.5 m draft, so a deeper boat shoaling
    // on a transducer or waterline feed got an optimistic 'warning' (or worse,
    // a slow shoal in deep water read as nothing to worry about). Unknown draft,
    // shoaling: never below 'serious'.
    it('never gives an optimistic colour for a shoaling depth not measured from the keel', () => {
        for (const reference of ['below-transducer', 'below-waterline', null] as const) {
            // 17 min to a 2.5 m keel: 'warning' by the fallback draft.
            const track = newDepthTrack();
            for (const p of trace(4.4, 4.2, 2)) recordDepth(track, p, reference);
            expect(depthTrendFor(track, 2.5, nowMs, true).level).toBe('serious');
            // Slow, in deep water: past the hour, so the note was only "over the last …".
            const deep = newDepthTrack();
            for (const p of trace(20.4, 20.2, 2)) recordDepth(deep, p, reference);
            const slow = depthTrendFor(deep, 2.5, nowMs, true);
            expect(slow.text).toMatch(/^Shoaling/);
            expect(slow.level).toBe('serious');
            expect(slow.note).toBe('draft not set');
            // Already critical stays critical.
            const shoal = newDepthTrack();
            for (const p of trace(3.0, 2.6, 2)) recordDepth(shoal, p, reference);
            expect(depthTrendFor(shoal, 2.5, nowMs, true).level).toBe('critical');
        }
    });

    it('leaves steady, deepening and a short trace as they were', () => {
        for (const reference of ['below-transducer', 'below-waterline', null] as const) {
            const steady = newDepthTrack();
            for (const p of trace(4.2, 4.2, 2)) recordDepth(steady, p, reference);
            expect(depthTrendFor(steady, 2.5, nowMs, true)).toMatchObject({ text: 'Steady', level: 'good' });
            const deepening = newDepthTrack();
            for (const p of trace(4.2, 4.6, 2)) recordDepth(deepening, p, reference);
            expect(depthTrendFor(deepening, 2.5, nowMs, true)).toMatchObject({ level: 'good' });
            expect(depthTrendFor(deepening, 2.5, nowMs, true).text).toMatch(/^Deepening/);
            const short = newDepthTrack();
            recordDepth(short, { t: nowS - 5, d: 4.2 }, reference);
            recordDepth(short, { t: nowS, d: 4.1 }, reference);
            expect(depthTrendFor(short, 2.5, nowMs, true)).toMatchObject({
                level: 'muted',
                note: 'not enough of a trace yet',
            });
        }
    });

    it('keeps the keel figure colour, which needs no draft', () => {
        const track = newDepthTrack();
        for (const p of trace(4.4, 4.2, 2)) recordDepth(track, p, 'below-keel');
        // (4.2 - 0) / 0.1 = 42 min: 'warning' from the sounder's own keel figure.
        expect(depthTrendFor(track, 2.5, nowMs, true)).toMatchObject({
            level: 'warning',
            note: 'keel down in about 42 min at this rate',
        });
    });

    it('still gives the keel time for a keel figure, which needs no draft', () => {
        const track = newDepthTrack();
        for (const p of trace(2.0, 1.65, 35 / 60)) recordDepth(track, p, 'below-keel');
        expect(depthTrendFor(track, 2.5, nowMs, true).note).toBe('keel down in about 3 min at this rate');
    });

    it('gives the keel time when the draft was set', () => {
        const track = newDepthTrack();
        for (const p of trace(4.4, 4.2, 2)) recordDepth(track, p, 'below-transducer');
        expect(depthTrendFor(track, DRAFT, nowMs, false).note).toBe('keel down in about 18 min at this rate');
    });
});

describe('the trend track follows one reference', () => {
    it('a switch of reference restarts the track instead of reading as a 1.7 m step', () => {
        const track = newDepthTrack();
        // Keel figure falling to 0.05 m, then the feed flips to a raw transducer reading.
        for (const p of trace(0.4, 0.05, 1).map((q) => ({ ...q, t: q.t - 60 }))) recordDepth(track, p, 'below-keel');
        for (const p of trace(1.78, 1.7, 1)) recordDepth(track, p, 'below-transducer');
        const trend = depthTrendFor(track, DRAFT, nowMs);
        expect(trend.text).not.toMatch(/Deepening/);
        expect(trend.level).not.toBe('good');
        expect(track.reference).toBe('below-transducer');
        expect(track.points.every((p) => p.d >= 1.7)).toBe(true);
    });

    it('keeps 15 minutes of trace, as before', () => {
        const track = newDepthTrack();
        for (const p of trace(5, 4, 20)) recordDepth(track, p, 'below-keel');
        expect(nowS - track.points[0].t).toBeLessThanOrEqual(900);
    });
});

describe('The Instrument Panel wiring', () => {
    const panel = readFileSync(resolve(process.cwd(), 'components/nmea/TheGlassPage.tsx'), 'utf8');
    it('classes the trend by the depth reference and the vessel profile draft, never a fixed figure', () => {
        expect(panel).not.toMatch(/DEPTH_FALLBACK_OFFSET|DEPTH_MEASURED_OFFSET|DRAFT_M/);
        expect(panel).toMatch(/recordDepth\(depthTrackRef\.current,[\s\S]{0,120}?state\.depthReference\)/);
        expect(panel).toMatch(/vesselDraftMetres\(store\.settings\.vessel\)/);
        expect(panel).toMatch(/depthTrendFor\(depthTrackRef\.current, draftM[,)]/);
    });
    it('tells the trend whether the vessel profile draft was set', () => {
        expect(panel).toMatch(/vesselDraftIsAssumed\(store\.settings\.vessel\)/);
        expect(panel).toMatch(/depthTrendFor\(depthTrackRef\.current, draftM, Date\.now\(\), draftAssumed\)/);
    });
    it('restarts the depth sparkline when the reference changes', () => {
        expect(panel).toMatch(/useMetricHistory\(state\.depth,\s*state\.depthReference\)/);
    });
});
