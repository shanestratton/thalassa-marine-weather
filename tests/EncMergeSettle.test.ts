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
    MERGE_ABORT_COOLDOWN_MAX_MS,
    MERGE_ABORT_COOLDOWN_MS,
    MERGE_SETTLE_MS,
    __resetMergeGenForTest,
    abortCooldownRemainingMs,
    awaitMergeAbortCooldown,
    awaitMergeGenSettle,
    claimMergeGen,
    isMergeGenStale,
    noteMergeAborted,
    noteMergeCompleted,
    mergeBudgetHoldMs,
    noteMergeParsePaid,
    MERGE_BUDGET_BYTES,
    MERGE_BUDGET_WINDOW_MS,
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

describe('abort cooldown — kill #30 (Mackay harbour browse churn)', () => {
    beforeEach(() => __resetMergeGenForTest());

    it('no aborts → no cooldown, settle behaves exactly as before', async () => {
        const c = makeClock();
        const gen = claimMergeGen(c.now());
        expect(abortCooldownRemainingMs(c.now())).toBe(0);
        await expect(awaitMergeGenSettle(gen, c.now, c.sleep)).resolves.toBe(true);
    });

    it('a mid-parse abort makes the NEXT build wait out the cooldown, not just the quiet', async () => {
        const c = makeClock();
        noteMergeAborted(c.now());
        const gen = claimMergeGen(c.now());
        const before = c.now();
        await expect(awaitMergeGenSettle(gen, c.now, c.sleep)).resolves.toBe(true);
        // The wait covered the full cooldown, not merely MERGE_SETTLE_MS.
        expect(c.now() - before).toBeGreaterThanOrEqual(MERGE_ABORT_COOLDOWN_MS);
    });

    it('consecutive aborts double the cooldown up to the cap', () => {
        const c = makeClock();
        noteMergeAborted(c.now());
        expect(abortCooldownRemainingMs(c.now())).toBe(MERGE_ABORT_COOLDOWN_MS);
        noteMergeAborted(c.now());
        expect(abortCooldownRemainingMs(c.now())).toBe(MERGE_ABORT_COOLDOWN_MAX_MS);
        // Nine aborts (the kill #30 trail) still cap — never an unbounded park.
        for (let i = 0; i < 7; i++) noteMergeAborted(c.now());
        expect(abortCooldownRemainingMs(c.now())).toBe(MERGE_ABORT_COOLDOWN_MAX_MS);
    });

    it('a completed merge clears the cooldown — churn over, full speed back', () => {
        const c = makeClock();
        noteMergeAborted(c.now());
        noteMergeAborted(c.now());
        noteMergeCompleted();
        expect(abortCooldownRemainingMs(c.now())).toBe(0);
    });

    it('the cooldown ages off by itself', () => {
        const c = makeClock();
        noteMergeAborted(c.now());
        c.advance(MERGE_ABORT_COOLDOWN_MS + 1);
        expect(abortCooldownRemainingMs(c.now())).toBe(0);
    });

    it('a newer claim during a cooldown wait still exits false immediately-free', async () => {
        const c = makeClock();
        noteMergeAborted(c.now());
        const gen = claimMergeGen(c.now());
        const wait = awaitMergeGenSettle(gen, c.now, c.sleep);
        claimMergeGen(c.now()); // the skipper nudges the camera again
        await expect(wait).resolves.toBe(false);
    });

    it('awaitMergeAbortCooldown parks a non-merge heavy build for the same window', async () => {
        const c = makeClock();
        noteMergeAborted(c.now());
        const before = c.now();
        await awaitMergeAbortCooldown(c.now, c.sleep);
        expect(c.now() - before).toBeGreaterThanOrEqual(MERGE_ABORT_COOLDOWN_MS);
        // And is a no-op once quiet.
        const t2 = c.now();
        await awaitMergeAbortCooldown(c.now, c.sleep);
        expect(c.now()).toBe(t2);
    });
});

describe('kill #30 wiring (source tripwires)', () => {
    const hazard = readFileSync(resolve(process.cwd(), 'services/enc/EncHazardService.ts'), 'utf8');
    const tracer = readFileSync(resolve(process.cwd(), 'services/routeTracer.ts'), 'utf8');

    it('a superseded abort arms the cooldown', () => {
        const failAt = hazard.indexOf("crumb('enc:merge-fail'");
        const noteAt = hazard.indexOf('noteMergeAborted()', failAt);
        expect(failAt).toBeGreaterThan(-1);
        expect(noteAt).toBeGreaterThan(-1);
    });

    it('a completed merge clears it', () => {
        const doneAt = hazard.indexOf("crumb('enc:merge-done'");
        const clearAt = hazard.indexOf('noteMergeCompleted()', doneAt);
        expect(doneAt).toBeGreaterThan(-1);
        expect(clearAt).toBeGreaterThan(-1);
    });

    it('the tracer context build waits out the cooldown before its start crumb', () => {
        const brakeAt = tracer.indexOf('await awaitHeapHeadroom();');
        const coolAt = tracer.indexOf('await awaitMergeAbortCooldown();');
        const startCrumbAt = tracer.indexOf("crumb('tracer:ctx-start'");
        expect(brakeAt).toBeGreaterThan(-1);
        expect(coolAt).toBeGreaterThan(brakeAt);
        expect(coolAt).toBeLessThan(startCrumbAt);
    });
});

describe('work-rate governor — the run up the coast breathes (kill #32)', () => {
    it('holds the next build once the 30s spend window exceeds budget', () => {
        __resetMergeGenForTest();
        let t = 1000;
        // Ten coastal reaches at ~12MB in quick succession ≈ kill #32's trail.
        for (let i = 0; i < 10; i++) noteMergeParsePaid(12 * 1024 * 1024, (t += 2000));
        expect(mergeBudgetHoldMs(t)).toBeGreaterThan(0);
        // The hold clears exactly as the oldest spend ages out of the window.
        expect(mergeBudgetHoldMs(t + MERGE_BUDGET_WINDOW_MS)).toBe(0);
    });

    it('stays silent under budget — ordinary browsing never breathes', () => {
        __resetMergeGenForTest();
        noteMergeParsePaid(9 * 1024 * 1024, 1000);
        noteMergeParsePaid(15 * 1024 * 1024, 5000);
        expect(mergeBudgetHoldMs(6000)).toBe(0);
        expect(MERGE_BUDGET_BYTES).toBe(48 * 1024 * 1024);
    });

    it('the settle loop waits out a breathe like a cooldown', async () => {
        __resetMergeGenForTest();
        let t = 0;
        for (let i = 0; i < 6; i++) noteMergeParsePaid(12 * 1024 * 1024, (t += 100));
        const gen = claimMergeGen(t);
        const sleeps: number[] = [];
        const settled = await awaitMergeGenSettle(
            gen,
            () => t,
            async (ms) => {
                sleeps.push(ms);
                t += ms; // time advances by exactly the requested sleep
            },
        );
        expect(settled).toBe(true);
        // It slept at least once for the breathe (longer than the 350ms settle).
        expect(Math.max(...sleeps)).toBeGreaterThan(350);
        // And the budget had genuinely drained by the time it ran.
        expect(mergeBudgetHoldMs(t)).toBe(0);
    });

    it('the tracer clearance waits the budget too', async () => {
        __resetMergeGenForTest();
        let t = 0;
        for (let i = 0; i < 6; i++) noteMergeParsePaid(12 * 1024 * 1024, (t += 100));
        let waited = 0;
        await awaitMergeAbortCooldown(
            () => t,
            async (ms) => {
                waited += ms;
                t += ms;
            },
        );
        expect(waited).toBeGreaterThan(0);
    });
});
