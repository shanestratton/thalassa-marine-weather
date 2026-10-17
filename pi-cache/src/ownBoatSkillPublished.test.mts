import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OwnPublishedWindReader } from './ownBoatSkill/published.js';
import type { SkillOwnerFetch } from './ownBoatSkill/owner.js';
const NOW = Date.UTC(2026, 9, 17, 6, 30),
    ORIGIN = 'https://pcisdplnodrphauixcau.supabase.co';
function original() {
    const run = Date.UTC(2026, 9, 17, 3),
        at = new Date(run).toISOString(),
        hours = Array.from({ length: 96 }, (_, i) => new Date(run + i * 3600_000).toISOString());
    return JSON.stringify([
        {
            run_at: at,
            payload: {
                timezone: 'UTC',
                utc_offset_seconds: 0,
                latitude: -27.125,
                longitude: 153.125,
                hourly_units: { time: 'iso8601', wind_speed_10m: 'km/h' },
                hourly: { time: hours, wind_speed_10m: hours.map(() => 36) },
                thalassa_provenance: {
                    version: 2,
                    source: 'wx',
                    model: 'dwd_icon',
                    run_at: at,
                    cell_id: '-2725_15300',
                    cell_selection: 'sea',
                    sampling: 'cell-centre',
                    cell_degrees: 0.25,
                    latitude: -27.125,
                    longitude: 153.125,
                    source_domains: ['dwd_icon'],
                    source_runs: [{ domain: 'dwd_icon', run_at: at, data_end_at: hours.at(-1) }],
                },
            },
        },
    ]);
}
const json = (raw: string) => new Response(raw, { headers: { 'Content-Type': 'application/json' } });
test('private forecast reader reads only the exact own-server cell/model original with anonymous public headers', async () => {
    const calls: Parameters<SkillOwnerFetch>[] = [],
        raw = original();
    const reader = new OwnPublishedWindReader({
        trustedOrigin: ORIGIN,
        anonKey: () => 'synthetic-anon',
        now: () => NOW,
        fetchImpl: async (...args) => {
            calls.push(args);
            return json(raw);
        },
    });
    const value = await reader.read('dwd_icon', '-2725_15300', new AbortController().signal, () => true);
    assert(value);
    assert.equal(value.raw.toString(), raw);
    assert.equal(value.capturedAt, NOW);
    assert(value.points.every(([at, speed]) => at > NOW && speed === 10));
    const url = new URL(calls[0][0]);
    assert.equal(url.origin, ORIGIN);
    assert.equal(url.pathname, '/rest/v1/wx_point_forecasts');
    assert.equal(url.searchParams.get('cell_id'), 'eq.-2725_15300');
    assert.equal(url.searchParams.get('model'), 'eq.wx2:dwd_icon');
    assert.deepEqual(calls[0][1].headers, { apikey: 'synthetic-anon', Accept: 'application/json' });
    assert.equal(calls[0][1].redirect, 'error');
});
test('actual received bytes, stale source clock and invalid content type cannot become private captures', async () => {
    for (const response of [
        json('x'.repeat(131073)),
        new Response(original(), { headers: { 'Content-Type': 'text/plain' } }),
    ]) {
        const reader = new OwnPublishedWindReader({
            trustedOrigin: ORIGIN,
            anonKey: () => 'synthetic',
            now: () => NOW,
            fetchImpl: async () => response,
        });
        await assert.rejects(reader.read('dwd_icon', '-2725_15300', new AbortController().signal, () => true));
    }
    const reader = new OwnPublishedWindReader({
        trustedOrigin: ORIGIN,
        anonKey: () => 'synthetic',
        now: () => NOW + 86400_000,
        fetchImpl: async () => json(original()),
    });
    assert.equal(await reader.read('dwd_icon', '-2725_15300', new AbortController().signal, () => true), null);
});
test('parent abort refuses a stalled body and cancels the original reader', async () => {
    const parent = new AbortController();
    let cancelled = 0;
    const reader = new OwnPublishedWindReader({
        trustedOrigin: ORIGIN,
        anonKey: () => 'synthetic',
        now: () => NOW,
        fetchImpl: async () =>
            new Response(
                new ReadableStream({
                    cancel() {
                        cancelled++;
                    },
                }),
                { headers: { 'Content-Type': 'application/json' } },
            ),
    });
    const pending = reader.read('dwd_icon', '-2725_15300', parent.signal, () => true);
    await new Promise((r) => setTimeout(r, 5));
    parent.abort();
    await assert.rejects(pending);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(cancelled, 1);
});
test('two abort-ignoring native transports stay charged until each late original body is cancelled', async () => {
    const settle: ((v: Response) => void)[] = [];
    let cancelled = 0;
    const reader = new OwnPublishedWindReader({
        trustedOrigin: ORIGIN,
        anonKey: () => 'synthetic',
        now: () => NOW,
        timeoutMs: 10,
        fetchImpl: () => new Promise((resolve) => settle.push(resolve)),
    });
    for (let i = 0; i < 2; i++)
        await assert.rejects(reader.read('dwd_icon', '-2725_15300', new AbortController().signal, () => true));
    await assert.rejects(reader.read('dwd_icon', '-2725_15300', new AbortController().signal, () => true));
    assert.equal(settle.length, 2);
    for (const resolve of settle)
        resolve(
            new Response(
                new ReadableStream({
                    cancel() {
                        cancelled++;
                    },
                }),
                { headers: { 'Content-Type': 'application/json' } },
            ),
        );
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(cancelled, 2);
    const next = reader.read('dwd_icon', '-2725_15300', new AbortController().signal, () => true);
    settle.at(-1)!(json(original()));
    assert(await next);
});
test('resolve then queued source retirement still cancels the acquired original exactly once', async () => {
    let current = true,
        cancelled = 0;
    const reader = new OwnPublishedWindReader({
        trustedOrigin: ORIGIN,
        anonKey: () => 'synthetic',
        now: () => NOW,
        fetchImpl: () => {
            const response = new Response(
                new ReadableStream({
                    cancel() {
                        cancelled++;
                    },
                }),
                { headers: { 'Content-Type': 'application/json' } },
            );
            const value = Promise.resolve(response);
            queueMicrotask(() => {
                current = false;
            });
            return value;
        },
    });
    await assert.rejects(reader.read('dwd_icon', '-2725_15300', new AbortController().signal, () => current));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(cancelled, 1);
});
