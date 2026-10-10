/**
 * Source tripwires for the build-124 route-check wiring that is awkward to
 * mount in jsdom (MapHub is a 5,000-line map surface; App.tsx boots the whole
 * shell). Each pins one decision from the agreed plan, with its reason.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) =>
    readFileSync(resolve(process.cwd(), file), 'utf8')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');

describe('MapHub (B5 + the tracer-active flag)', () => {
    const map = read('components/map/MapHub.tsx');
    const site = map.slice(map.indexOf('const departureLabelForRef'), map.indexOf('const saveCurrentTrace'));
    const hook = read('components/map/useTracerAutoBank.ts');

    it('banks an unchanged stored line without Save, through the one shared rule and the safe bank', () => {
        expect(site).toContain('useTracerAutoBank({');
        expect(hook).toContain('traceAutoBankSignature(');
        expect(hook).toContain('bankTraceVerification(');
        // The old ack-only gate is gone: a check of an unchanged line banks
        // whether or not a leg was acknowledged.
        expect(hook).not.toMatch(/ackedLegs\.size\s*===\s*0\)\s*return/);
        expect(hook).not.toContain('saveTrace(');
        expect(map).not.toMatch(/saveTrace\([^)]*verification: release/);
    });

    it('banks only verdicts graded for this line at this keel, by an open tracer, with this tide window', () => {
        expect(hook).toContain('if (!coordCaptureMode) return;');
        expect(hook).toContain('tracerGradingMatches(legVerdicts, capturedCoords, vessel)');
        // MapHub records which verdicts its tide window answers, and clears it
        // while a new window is computed.
        expect(map).toContain('departureLabelForRef.current = null;');
        expect(map).toContain('departureLabelForRef.current = { verdicts: legVerdicts, departureMs };');
        expect(site).toContain('tideLabelForRef: departureLabelForRef');
    });

    it('holds the background queue only while Route Tracer is on screen or grading, not on capture mode alone', () => {
        expect(map).not.toContain('setTracerActive(coordCaptureMode)');
        expect(site).toContain("onScreen: currentView === 'map'");
        expect(site).toContain("grading: tracerStatus === 'loading'");
        expect(site).toContain('setTracerActive(true)');
    });
});

/**
 * Grade stubs (127-C-b): after a relaunch, legs over licensed charts come back
 * as their grade alone, and only her own tap checks them again on her charts.
 * The refusal must leave that tap reachable, and the tide panel must never ask
 * for tides at the charted sounding.
 */
describe('MapHub: her taps re-check grade stubs; no charted spot off the device', () => {
    const map = read('components/map/MapHub.tsx');
    const after = (from: string, to: string) => {
        const start = map.indexOf(from);
        return map.slice(start, map.indexOf(to, start));
    };

    it('Save stays tappable when the only refusal is stubs, and its tap checks them again', () => {
        const button = after('onClick={saveCurrentTrace}', "'Save this checked route'");
        expect(button).toMatch(/!traceReleaseGate\.allowed && !traceReleaseGate\.recheck/);
        expect(after('const saveCurrentTrace', 'triggerHaptic(')).toContain('regradeStubLegsRef.current()');
    });

    it('a refused Sail checks them again too', () => {
        expect(after('const sailTrace', 'triggerHaptic(')).toContain('regradeStubLegsRef.current()');
    });

    it('the tide panel reads at the shallow spot’s 0.25° bucket centre', () => {
        const anchor = after('const tideAnchor', '[legVerdicts, capturedCoords]');
        expect(anchor).toContain('tideCurveBucket(shallow.lat, shallow.lon)');
        expect(anchor).not.toContain('return { lat: shallow.lat, lon: shallow.lon }');
    });
});

describe('App.tsx recovers checks after the boot sync', () => {
    it('runs recovery only after syncSavedRoutes resolves, lazily', () => {
        const app = read('App.tsx');
        const sync = app.indexOf('syncSavedRoutes()');
        const recover = app.indexOf("import('./services/traceCheckRecovery')");
        expect(sync).toBeGreaterThan(-1);
        expect(recover).toBeGreaterThan(sync);
    });
});

describe('savedRoutesSync closes the lost-update race', () => {
    it('re-reads the local library after the fetch, before merging', () => {
        const sync = read('services/savedRoutesSync.ts');
        const fetched = sync.indexOf('await fetchRows(true)');
        const fresh = sync.indexOf('const fresh = loadSavedTraces(scope)');
        expect(fetched).toBeGreaterThan(-1);
        expect(fresh).toBeGreaterThan(fetched);
        expect(sync).toContain('new Map(fresh.map((trace) => [trace.id, trace]))');
    });
});

describe('the background queue stays cold and lazy', () => {
    const queue = read('services/traceBackgroundCheck.ts');

    it('loads the grader only when it runs, and never touches the verdict cache', () => {
        // A type-only import is erased; a value import would pull the grader in.
        expect(queue).not.toMatch(/^import (?!type )[^;]*from '\.\/traceRecheck'/m);
        expect(queue).toContain("import('./traceRecheck')");
        expect(queue).not.toContain('hydrateLegVerdicts');
        expect(queue).not.toContain('persistLegVerdicts');
    });

    it('logs every outcome with log.warn (log.info is a no-op in production)', () => {
        expect(queue).not.toContain('log.info(');
        expect(queue).toContain('log.warn(');
    });
});

describe('the Log page banks through the safe bank', () => {
    const page = read('pages/LogPage.tsx');

    it('never writes a check with a bare saveTrace', () => {
        expect(page).not.toMatch(/saveTrace\([^)]*verification/);
        expect(page).toContain('bankTraceVerification(');
    });

    it("wires a row's Check now and Stop to the background queue (Check now jumps it)", () => {
        // Check now adopts an account-only route first (checkRouteNow), then jumps the queue.
        expect(page).toContain('onCheckNow={checkRouteNow}');
        expect(page).toContain("enqueueTraceChecks([savedRouteId], 'manual')");
        expect(page).toContain("onStopCheck={(savedRouteId) => cancelTraceChecks('stop', [savedRouteId])}");
        // No second, foreground grader competing with the queue.
        expect(page).not.toContain('recheckTrace(');
    });
});
