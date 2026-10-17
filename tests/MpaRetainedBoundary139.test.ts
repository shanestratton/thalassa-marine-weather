import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
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
