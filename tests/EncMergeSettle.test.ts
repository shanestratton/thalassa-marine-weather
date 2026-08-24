/**
 * mergeSettle — behaviour of the quiet-camera discipline, plus the source
 * tripwires that keep EncHazardService actually using it.
 *
 * Kill #27 (Lady Musgrave, 2026-08-25): six enc:merge-start/merge-fail pairs
 * in five seconds — stale builds each paying the brake, the crumb and a
 * multi-MB parse before the first slice boundary could kill them — then one
 * fresh build landing on the fattened process and dying. The native gauge
 * read 3.3 GB "available" throughout (it answers for the host app process,
 * not the WebContent process that died), so this death class cannot be
 * braked by measurement; mergeSettle is the by-construction fix. See
 * services/enc/mergeSettle.ts for the full trail.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
    MERGE_SETTLE_MS,
    __resetMergeGenForTest,
    awaitMergeGenSettle,
    claimMergeGen,
    isMergeGenStale,
} from '../services/enc/mergeSettle';

/** Manual clock + instant sleep so settle loops run without real timers. */
function makeClock(startMs = 1000) {
    let t = startMs;
    return {
        now: () => t,
        advance: (ms: number) => {
            t += ms;
        },
        /** Sleep advances the clock by the requested nap — the loop's own
         *  arithmetic drives time, no fake-timer scheduling involved. */
        sleep: (ms: number) => {
            t += ms;
            return Promise.resolve();
        },
    };
}

beforeEach(() => {
    __resetMergeGenForTest();
});

describe('claim/stale mechanics', () => {
    it('claims are monotonic and stale-ness tracks the newest claim', () => {
        const a = claimMergeGen(0);
        const b = claimMergeGen(1);
        expect(b).toBeGreaterThan(a);
        expect(isMergeGenStale(a)).toBe(true);
        expect(isMergeGenStale(b)).toBe(false);
    });
});

describe('awaitMergeGenSettle', () => {
    it('resolves false immediately for a stale generation — no waiting, no allocation window', async () => {
        const clock = makeClock();
        const stale = claimMergeGen(clock.now());
        claimMergeGen(clock.now()); // superseded before it reached the front
        const before = clock.now();
        await expect(awaitMergeGenSettle(stale, clock.now, clock.sleep)).resolves.toBe(false);
        expect(clock.now()).toBe(before); // never even napped
    });

    it('resolves true once the claim has been quiet for MERGE_SETTLE_MS', async () => {
        const clock = makeClock();
        const gen = claimMergeGen(clock.now());
        await expect(awaitMergeGenSettle(gen, clock.now, clock.sleep)).resolves.toBe(true);
        // The loop napped exactly the remaining age — one settle window.
        expect(clock.now()).toBe(1000 + MERGE_SETTLE_MS);
    });

    it('an already-aged claim passes without napping', async () => {
        const clock = makeClock();
        const gen = claimMergeGen(clock.now());
        clock.advance(MERGE_SETTLE_MS); // camera quiet since the claim
        const before = clock.now();
        await expect(awaitMergeGenSettle(gen, clock.now, clock.sleep)).resolves.toBe(true);
        expect(clock.now()).toBe(before);
    });

    it('flips to false when a newer claim lands mid-settle — the zoom-flight case', async () => {
        const clock = makeClock();
        const gen = claimMergeGen(clock.now());
        // First nap fires a fresh claim, the way each bucket-edge crossing
        // enqueued a new merge every ~0.8 s in kill #27's trail.
        let naps = 0;
        const sleep = (ms: number): Promise<void> => {
            clock.advance(ms);
            if (naps++ === 0) claimMergeGen(clock.now());
            return Promise.resolve();
        };
        await expect(awaitMergeGenSettle(gen, clock.now, sleep)).resolves.toBe(false);
        expect(naps).toBe(1); // died at the first re-check, not after a timeout
    });
});

describe('EncHazardService wields the discipline (source tripwires)', () => {
    const hazard = readFileSync(resolve(process.cwd(), 'services/enc/EncHazardService.ts'), 'utf8');
    const jobStart = hazard.indexOf('const build = mergeBuildQueue(');
    const job = hazard.slice(jobStart, hazard.indexOf('setInflightMerge(cacheKey, build);', jobStart));

    it('a stale job skips before the brake, the start crumb, or any parse', () => {
        const skipAt = job.indexOf('isMergeGenStale(enqueueGen)');
        const settleAt = job.indexOf('awaitMergeGenSettle(enqueueGen)');
        const brakeAt = job.indexOf('await awaitHeapHeadroom();');
        const startCrumbAt = job.indexOf("'enc:merge-start'");
        expect(skipAt).toBeGreaterThan(-1);
        expect(settleAt).toBeGreaterThan(-1);
        expect(brakeAt).toBeGreaterThan(-1);
        expect(startCrumbAt).toBeGreaterThan(-1);
        expect(skipAt).toBeLessThan(brakeAt);
        expect(settleAt).toBeLessThan(brakeAt);
        expect(brakeAt).toBeLessThan(startCrumbAt);
    });

    it('skips leave a crumb so the next Last Flight trail shows the discipline working', () => {
        expect(job).toContain("crumb('enc:merge-skip'");
    });

    it('re-checks staleness after the brake — the brake can park for seconds', () => {
        const brakeAt = job.indexOf('await awaitHeapHeadroom();');
        const postBrake = job.slice(brakeAt);
        const recheckAt = postBrake.indexOf('isMergeGenStale(enqueueGen)');
        const startCrumbAt = postBrake.indexOf("'enc:merge-start'");
        expect(recheckAt).toBeGreaterThan(-1);
        expect(recheckAt).toBeLessThan(startCrumbAt);
    });

    it('a skipped build never crumbs merge-done', () => {
        const awaitAt = hazard.indexOf('const merged = await build;');
        const doneAt = hazard.indexOf("crumb('enc:merge-done'", awaitAt);
        const nullGuardAt = hazard.indexOf('if (!merged) return null;', awaitAt);
        expect(nullGuardAt).toBeGreaterThan(-1);
        expect(nullGuardAt).toBeLessThan(doneAt);
    });

    it('full/seaway merges (zoom null) bypass the discipline entirely', () => {
        // Their gen is null: the skip/settle block is gated on enqueueGen.
        expect(job).toContain('if (enqueueGen != null) {');
    });
});
