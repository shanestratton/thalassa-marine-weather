/**
 * "wx sources 6513ms total: weatherkit=569 unified=570 tides=2318
 *  openmeteo=2477 marine=2862 stormglass=6509"  — Shane's device, 2026-09-05.
 *
 * Promise.allSettled waits for the SLOWEST member. Every source the report
 * actually needs was in at 2,477 ms; the remaining 4 s bought one
 * supplementary marine reading while a finished report sat in memory. The
 * weather fetch was gated on the slowest provider, not on the data it needed.
 *
 * The fix is a grace window rather than a second wall clock: the supplementary
 * tier is cut SUPPLEMENTARY_GRACE_MS after the essential tier settles. A
 * uniformly slow network therefore still gets every source — only a source
 * slow RELATIVE to its siblings is cut.
 *
 * Cutting throws nothing away. withTimeout cannot cancel (utils/deadline.ts:
 * the CapacitorHttp patch ignores AbortSignal), so the fetch runs on and
 * writes its own cache, and StormGlass caches to localStorage on the 6-hourly
 * model cycle. The answer is waiting, already paid for, on the next fetch —
 * and fetchStormGlassWeather's in-flight dedupe means a re-fetch during the
 * window joins that request instead of buying a second one.
 *
 * OFFSHORE IS EXEMPT. Out there StormGlass is asked for the full atmospheric
 * suite too, because WeatherKit has no ocean station data — cutting it would
 * cost wind and pressure, not just waves.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, afterEach } from 'vitest';

const src = readFileSync('services/weather/index.ts', 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const BUDGET_MS = 8_000;
const GRACE_MS = 1_500;

/** The tiering, restated independently of the service. */
async function runReport(
    latencies: Record<string, number>,
    { offshore = false } = {},
): Promise<{ totalMs: number; got: string[]; cut: string[] }> {
    const started = Date.now();
    const got: string[] = [];
    const cut: string[] = [];
    const CUT = Symbol('cut');

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const source = (label: string) => sleep(latencies[label]).then(() => label);

    const bounded = (label: string, cutWhen?: Promise<unknown>) => {
        const budgeted = Promise.race([source(label), sleep(BUDGET_MS).then(() => null)]);
        const raced = cutWhen ? Promise.race([budgeted, cutWhen.then(() => CUT)]) : budgeted;
        return raced.then((v) => {
            if (v === CUT) cut.push(label);
            else if (v !== null) got.push(label);
            return v === CUT ? null : v;
        });
    };

    const unified = bounded('unified');
    const tides = bounded('tides');
    const om = bounded('openmeteo');
    const wk = bounded('weatherkit');
    const essentials = Promise.all([unified, tides, om, wk]);
    const graceGate = essentials.then(() => sleep(GRACE_MS));

    await Promise.all([
        unified,
        tides,
        om,
        wk,
        bounded('stormglass', offshore ? undefined : graceGate),
        bounded('marine', graceGate),
    ]);
    return { totalMs: Date.now() - started, got, cut };
}

/** Drive the simulation on fake timers so the assertions are exact. */
async function simulate(fn: () => Promise<unknown>) {
    vi.useFakeTimers();
    const p = fn();
    await vi.runAllTimersAsync();
    return (await p) as { totalMs: number; got: string[]; cut: string[] };
}

afterEach(() => vi.useRealTimers());

describe('weather source budget tiers', () => {
    it("does not hold the report for Shane's slow StormGlass", async () => {
        const r = await simulate(() =>
            runReport({
                weatherkit: 569,
                unified: 570,
                tides: 2318,
                openmeteo: 2477,
                marine: 2862,
                stormglass: 6509,
            }),
        );
        // Essentials in at 2,477; grace expires at 3,977. Was 6,513.
        expect(r.totalMs).toBe(2477 + GRACE_MS);
        expect(r.cut).toEqual(['stormglass']);
        // marine landed at 2,862, inside the window — it is NOT lost.
        expect(r.got).toContain('marine');
        expect(r.totalMs).toBeLessThan(6509);
    });

    it('still collects every source on a uniformly slow network', async () => {
        // The grace clock starts when the essentials settle, so slow-everywhere
        // is not the same thing as one-slow-source. This is the property a
        // fixed second budget would have got wrong.
        const r = await simulate(() =>
            runReport({
                weatherkit: 4200,
                unified: 4300,
                tides: 4500,
                openmeteo: 4600,
                marine: 4900,
                stormglass: 5200,
            }),
        );
        expect(r.cut).toEqual([]);
        expect(r.got).toEqual(expect.arrayContaining(['stormglass', 'marine']));
    });

    it('never cuts StormGlass offshore, where it carries the atmospherics too', async () => {
        const r = await simulate(() =>
            runReport(
                {
                    weatherkit: 500,
                    unified: 500,
                    tides: 600,
                    openmeteo: 700,
                    marine: 6000,
                    stormglass: 6509,
                },
                { offshore: true },
            ),
        );
        expect(r.cut).toEqual(['marine']);
        expect(r.got).toContain('stormglass');
        expect(r.totalMs).toBe(6509);
    });

    it('keeps the hard 8 s budget as the outer bound', async () => {
        const r = await simulate(() =>
            runReport(
                { weatherkit: 500, unified: 500, tides: 600, openmeteo: 700, marine: 100, stormglass: 60_000 },
                { offshore: true },
            ),
        );
        expect(r.got).not.toContain('stormglass');
        expect(r.totalMs).toBe(BUDGET_MS);
    });

    it('an essential source is never cut by the grace window', async () => {
        // openmeteo is slowest here; the gate cannot open before it settles,
        // so it can only ever be bounded by the 8 s budget.
        const r = await simulate(() =>
            runReport({
                weatherkit: 100,
                unified: 100,
                tides: 100,
                openmeteo: 5000,
                marine: 100,
                stormglass: 100,
            }),
        );
        expect(r.cut).toEqual([]);
        expect(r.got).toContain('openmeteo');
        expect(r.totalMs).toBe(5000);
    });

    it('the service wires the tiers this way', () => {
        expect(code).toMatch(/const SUPPLEMENTARY_GRACE_MS = 1_500;/);
        expect(code).toMatch(/const SOURCE_BUDGET_MS = 8_000;/);

        // The gate hangs off the ESSENTIAL tier, not a timer started at t0.
        expect(code).toMatch(/const essentials = Promise\.all\(\[/);
        expect(code).toMatch(/const graceGate = essentials\.then\(/);
        for (const essential of ['unifiedPromise', 'tidePromise', 'omPromise', 'weatherKitParallel']) {
            const at = code.indexOf('const essentials = Promise.all([');
            expect(code.slice(at, at + 260)).toContain(essential);
        }

        // Only the supplementary sources are handed the gate.
        expect(code).toMatch(/bounded\('marine', fetchMarine\(lat, lon\), graceGate\)/);
        expect(code).toMatch(/const sgCutWhen = isOffshore \? undefined : graceGate;/);
        expect(code).toMatch(/bounded\('stormglass',[\s\S]{0,120}sgCutWhen\)/);

        // An essential must never be given a cut promise, or the gate could
        // close on the very tier it waits for.
        for (const call of ["bounded('unified'", "bounded('tides'", "bounded('openmeteo'", "bounded('weatherkit'"]) {
            const at = code.indexOf(call);
            expect(at, `${call} missing`).toBeGreaterThan(0);
            expect(code.slice(at, code.indexOf(')', code.indexOf('(', at + call.length)) + 1)).not.toContain(
                'graceGate',
            );
        }
    });

    it('reports a cut distinctly from a give-up', () => {
        // "!" and "~" are different facts: one says the data is gone, the
        // other says it is still coming and will be cached.
        expect(code).toMatch(/timings\.push\(`\$\{label\}=\$\{ms\}\$\{cut \? '~' : value === null \? '!' : ''\}`\)/);
    });
});
