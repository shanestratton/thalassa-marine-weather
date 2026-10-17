import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

it('keeps only weak full-owner identity and drops full-entry locals before returning a bounded borrow', () => {
    const source = readFileSync('services/weather/api/mpaRetained.ts', 'utf8');
    expect(source).toContain('new WeakRef(captured)');
    expect(source).toContain('source = null;');
    const dropped = source.indexOf('captured = null;');
    expect(dropped).toBeGreaterThan(source.indexOf('features.push(feature)'));
    expect(source.slice(dropped + 'captured = null;'.length)).not.toMatch(/\bcaptured\b/);
    expect(source.slice(source.indexOf('const sameOwner'), source.indexOf('let active'))).not.toMatch(/\bcaptured\b/);
});

it('a route-only retained import has no loader, fetch, publisher DTO or verified-source flag', async () => {
    vi.resetModules();
    const fetch = vi.fn(async () => {
        throw Error('No implicit MPA source fetch is allowed.');
    });
    vi.stubGlobal('fetch', fetch);
    const retained = await import('../services/weather/api/mpaRetained');
    const before = retained.retainedMpaRoutingContextKey();
    const lease = retained.borrowRetainedMpaDataset({ bbox: [100, -40, 101, -39] });
    expect(lease.status).toBe('absent');
    expect(lease.data).toBeUndefined();
    expect(lease.isCurrent()).toBe(true);
    expect(() =>
        retained.registerVerifiedMpaRetainedOwner(
            JSON.parse('{"verified":true,"entry":{"generation":"invented"},"epoch":1}'),
        ),
    ).toThrow(/private reader closure/);
    expect(retained.retainedMpaRoutingContextKey()).toBe(before);
    expect(fetch).not.toHaveBeenCalled();
    await import('../services/weather/api/mpaDataset');
    expect(retained.retainedMpaRoutingContextKey()).toBe(before);
    expect(lease.isCurrent()).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    lease.release();
    expect(lease.isCurrent()).toBe(false);
});
