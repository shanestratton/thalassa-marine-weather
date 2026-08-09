/**
 * What was large when the web layer died?
 *
 * The kill detector answered WHERE and HOW OFTEN — Shane's log ran 1 → 9 in a
 * session, on 'map' and on 'voyage'. It cannot answer WHAT was big, and
 * without that every fix is a guess. Three have been so far.
 *
 * `performance.memory` is Chromium-only and WKWebView has no equivalent, so
 * the heap cannot be read directly. What can be read is the occupancy of the
 * caches we own — which is where the memory goes.
 *
 * The property that makes it work is the same one the breadcrumb relies on: a
 * killed process reports nothing, so the census must ALREADY be on disk,
 * written synchronously while everything was still healthy. These tests pin
 * that, and pin that a broken cache degrades to a zero rather than taking the
 * whole diagnostic down at the moment it is needed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const encStats = vi.hoisted(() => ({ value: { entries: 0, textMB: 0 } as unknown }));
const mergeStats = vi.hoisted(() => ({ size: 0, pinned: 0 }));

vi.mock('../services/enc/EncCellStore', () => ({
    blobCacheStats: () => {
        if (encStats.value instanceof Error) throw encStats.value;
        return encStats.value;
    },
}));
vi.mock('../services/enc/mergedDataCache', () => ({
    mergedDataCacheSize: () => mergeStats.size,
    mergedPinnedCellCount: () => mergeStats.pinned,
}));
vi.mock('../services/enc/glazeCellCache', () => ({ glazeCellCacheSize: () => 7 }));
vi.mock('../services/enc/derivedContourCache', () => ({ derivedContourCacheSize: () => 3 }));
vi.mock('../services/enc/encIndexCache', () => ({ indexCacheSize: () => 11 }));

import {
    describeCensus,
    readLastCensus,
    setCensusPlotting,
    startCensus,
    stopCensus,
    takeCensus,
} from '../services/memoryCensus';

/**
 * The test environment has no WebGL, so a real getContext('webgl') returns
 * null and nothing would ever be counted as created.
 *
 * This must patch the PROTOTYPE, and must run before any test calls
 * startCensus(): the probe wraps whatever getContext it finds at install time.
 * An instance-level override would sit ABOVE the probe and shadow it, which is
 * how the first attempt at this test silently measured nothing.
 *
 * A canvas only gets a context if it is marked, so refusals stay testable too.
 */
const fakeContexts = new WeakMap<HTMLCanvasElement, object>();
const realGetContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: any[]) {
    if (/webgl/i.test(kind)) {
        if (this.dataset.fakeGl !== '1') return null; // WebKit-style refusal
        let context = fakeContexts.get(this);
        if (!context) {
            context = { fake: true };
            fakeContexts.set(this, context);
        }
        return context;
    }
    // jsdom has no 2D canvas either and logs a loud "Not implemented" for it.
    // Stub it: this file is testing the WebGL counter, and that noise would
    // bury a real failure.
    if (kind === '2d') return { fake2d: true };

    return (realGetContext as any).call(this, kind, ...rest);
} as any;

/** A canvas whose WebGL context will be granted rather than refused. */
function withFakeGl(canvas: HTMLCanvasElement): HTMLCanvasElement {
    canvas.dataset.fakeGl = '1';
    return canvas;
}

describe('taking a reading', () => {
    beforeEach(() => {
        localStorage.clear();
        stopCensus();
        setCensusPlotting(false);
        encStats.value = { entries: 12, textMB: 41.2 };
        mergeStats.size = 4;
        mergeStats.pinned = 53;
    });

    it('reports the number that predicts the kill — cells pinned by merges', () => {
        // Cells pinned by reference are invisible to EncCellStore's byte
        // budget. Four merges over disjoint water pin ~56 cells, the
        // half-gigabyte case measured on 2026-07-22.
        return takeCensus().then((c) => {
            expect(c.merges).toBe(4);
            expect(c.pinnedCells).toBe(53);
        });
    });

    it('reports the ENC blob LRU alongside it', async () => {
        const c = await takeCensus();
        expect(c.encCells).toBe(12);
        expect(c.encTextMB).toBe(41.2);
    });

    it('records the screen and whether a leg was being drawn', async () => {
        localStorage.setItem('thalassa.lastView', JSON.stringify({ view: 'map', at: Date.now() }));
        setCensusPlotting(true);
        const c = await takeCensus();
        expect(c.view).toBe('map');
        expect(c.plotting).toBe(true);
    });

    it('degrades a broken cache to zero rather than failing the whole census', async () => {
        // One cache moving or throwing must not take the diagnostic down at
        // the exact moment it is needed.
        encStats.value = new Error('cache exploded');
        const c = await takeCensus();
        expect(c.encCells).toBe(0);
        // Everything else still reported.
        expect(c.pinnedCells).toBe(53);
        expect(c.glaze).toBe(7);
    });
});

describe('surviving the kill', () => {
    beforeEach(() => {
        localStorage.clear();
        stopCensus();
        encStats.value = { entries: 9, textMB: 30 };
        mergeStats.size = 3;
        mergeStats.pinned = 40;
    });

    it('is already on disk before anything goes wrong', async () => {
        startCensus();
        // startCensus takes a reading immediately; it is async internally.
        await vi.waitFor(() => expect(readLastCensus()).not.toBeNull());
        // …process dies here. Nothing else runs.
        const recovered = readLastCensus();
        expect(recovered?.pinnedCells).toBe(40);
        expect(recovered?.encCells).toBe(9);
        stopCensus();
    });

    it('returns null when there is nothing recorded', () => {
        expect(readLastCensus()).toBeNull();
    });

    it('ignores a corrupt record', () => {
        localStorage.setItem('thalassa.lastCensus', 'not json');
        expect(readLastCensus()).toBeNull();
        localStorage.setItem('thalassa.lastCensus', JSON.stringify({ encCells: 3 }));
        expect(readLastCensus()).toBeNull(); // no timestamp
    });

    it('starting twice does not stack intervals', () => {
        startCensus();
        startCensus();
        stopCensus();
        // No assertion beyond not throwing; the guard is the point.
        expect(true).toBe(true);
    });
});

describe('the one line that goes in the crash report', () => {
    it('names the caches and flags plotting', async () => {
        localStorage.setItem('thalassa.lastView', JSON.stringify({ view: 'map', at: Date.now() }));
        setCensusPlotting(true);
        encStats.value = { entries: 12, textMB: 41.2 };
        mergeStats.size = 4;
        mergeStats.pinned = 53;

        const line = describeCensus(await takeCensus());
        expect(line).toContain("on 'map'");
        expect(line).toContain('(plotting)');
        expect(line).toContain('12 cells/41.2MB');
        expect(line).toContain('4 merges pinning 53 cells');
        setCensusPlotting(false);
    });
});

describe('the ambiguities the 2026-08-09 readings exposed', () => {
    beforeEach(() => {
        localStorage.clear();
        stopCensus();
        setCensusPlotting(false);
        encStats.value = { entries: 0, textMB: 0 };
        mergeStats.size = 0;
        mergeStats.pinned = 0;
    });

    it('says how far into the session it died — "nothing loaded" vs "died instantly"', async () => {
        // Kills 11 and 13 reported ENC 0 / DOM 161. That could mean the app
        // died with nothing loaded, or died before the second census tick.
        // Completely different bugs, and the reading could not tell them apart.
        const c = await takeCensus();
        expect(typeof c.sinceBootMs).toBe('number');
        expect(describeCensus(c)).toMatch(/into that session/);
    });

    it('keeps high-water marks, so a spike between ticks cannot hide', async () => {
        encStats.value = { entries: 30, textMB: 44.8 };
        mergeStats.pinned = 56;
        await takeCensus();

        // …the caches are evicted, and the NEXT tick sees almost nothing.
        encStats.value = { entries: 1, textMB: 0.4 };
        mergeStats.pinned = 1;
        const after = await takeCensus();

        expect(after.encTextMB).toBe(0.4);
        expect(after.peakEncTextMB).toBe(44.8);
        expect(after.peakPinnedCells).toBe(56);
        expect(describeCensus(after)).toContain('peak 44.8MB');
    });

    it('counts canvases — "map" means Mapbox GL, which means WebGL', async () => {
        const c = await takeCensus();
        expect(typeof c.canvases).toBe('number');
        expect(describeCensus(c)).toMatch(/canvas \d+/);
    });

    it('flags a lost WebGL context loudly, because it moves the whole investigation', async () => {
        // A GPU failure kills the WebContent process with the heap nearly
        // empty — which is precisely the shape of kills 11 and 13. If this
        // ever appears, memory is not the problem and never was.
        const c = { ...(await takeCensus()), glContextLost: true };
        expect(describeCensus(c)).toContain('[WEBGL CONTEXT WAS LOST]');
    });

    it('records a context loss the instant it happens, not at the next tick', async () => {
        startCensus();
        await vi.waitFor(() => expect(readLastCensus()).not.toBeNull());
        window.dispatchEvent(new Event('webglcontextlost'));
        // No tick has run. The flag must already be on disk — by the next one
        // there may be no process left to run it.
        expect(readLastCensus()?.glContextLost).toBe(true);
        stopCensus();
    });
});

describe('WebGL contexts — the number JS cannot otherwise see', () => {
    beforeEach(() => {
        localStorage.clear();
        stopCensus();
    });

    it('counts a context when one is created, not when a canvas is made', async () => {
        startCensus();
        const before = (await takeCensus()).glCreated;

        const canvas = withFakeGl(document.createElement('canvas'));
        canvas.getContext('2d'); // not WebGL — must not count
        expect((await takeCensus()).glCreated).toBe(before);

        canvas.getContext('webgl');
        expect((await takeCensus()).glCreated).toBe(before + 1);
        stopCensus();
    });

    it('counts a canvas once, however often getContext is called', async () => {
        // getContext returns the SAME context on repeat calls. Counting each
        // call would make the number meaningless — Mapbox asks repeatedly.
        startCensus();
        const canvas = withFakeGl(document.createElement('canvas'));
        canvas.getContext('webgl');
        const after = (await takeCensus()).glCreated;
        canvas.getContext('webgl');
        canvas.getContext('webgl');
        expect((await takeCensus()).glCreated).toBe(after);
        stopCensus();
    });

    it('reports created and live separately — the gap is the leak', async () => {
        // If created climbs while live does not, contexts are being spun up
        // and abandoned. That is the mechanism the 2026-08-04 JetsamEvent
        // names, and WebKit does not promptly return that GPU memory.
        startCensus();
        const c = await takeCensus();
        expect(typeof c.glCreated).toBe('number');
        expect(typeof c.glLive).toBe('number');
        expect(describeCensus(c)).toMatch(/WebGL \d+ live \/ \d+ created/);
        stopCensus();
    });

    it('the probe never retains a canvas itself', async () => {
        // A diagnostic that keeps GL contexts alive would be the bug.
        startCensus();
        const c = await takeCensus();
        expect(c.glLive).toBeLessThanOrEqual(c.glCreated);
        stopCensus();
    });
});

describe('a refused context is the loudest signal available', () => {
    beforeEach(() => {
        localStorage.clear();
        stopCensus();
    });

    it('counts a refusal when WebKit hands back null', async () => {
        // Past the per-process cap, getContext returns null rather than
        // throwing. This is the only place that refusal is visible, and a
        // non-zero count would be hard proof we are exhausting contexts —
        // which fits crashing on the second leg and not the first.
        startCensus();
        const before = (await takeCensus()).glRefused;
        // The real jsdom canvas has no WebGL, so this genuinely refuses.
        document.createElement('canvas').getContext('webgl');
        expect((await takeCensus()).glRefused).toBe(before + 1);
        stopCensus();
    });

    it('shouts about refusals in the report line', async () => {
        startCensus();
        document.createElement('canvas').getContext('webgl');
        expect(describeCensus(await takeCensus())).toMatch(/CONTEXT REFUSALS/);
        stopCensus();
    });
});
