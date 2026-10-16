import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
    generation: 1,
    load: vi.fn(),
    read: vi.fn(),
    mpaCurrent: true,
    mpaRelease: vi.fn(),
    mpaStatus: 'available',
    mpaData: { type: 'FeatureCollection', features: [] } as unknown,
}));
vi.mock('../services/userOverlays/store', () => ({
    userOverlayGeneration: () => h.generation,
    loadUserOverlays: h.load,
    readUserOverlay: h.read,
}));
vi.mock('../services/weather/api/mpaDataset', () => ({
    retainedMpaRoutingContextKey: () => JSON.stringify([h.mpaCurrent, h.mpaStatus]),
    borrowRetainedMpaDataset: () => ({
        data: h.mpaData,
        status: h.mpaStatus,
        isCurrent: () => h.mpaCurrent,
        release: h.mpaRelease,
    }),
}));
import { readCurrentRoutingExclusions, routingExclusionContextKey } from '../services/routing/routingExclusions';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { normalizeOverlay, overlayPolygonOverlaps } from '../services/userOverlays/model';
const polygon = {
        type: 'Polygon' as const,
        coordinates: [
            [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
                [0, 0],
            ],
        ],
    },
    bbox = [-0.1, -0.1, 1.1, 1.1] as const;
beforeEach(() => {
    setAuthIdentityScope('routing-owner-a');
    h.generation++;
    h.mpaCurrent = true;
    h.mpaStatus = 'available';
    h.mpaData = { type: 'FeatureCollection', features: [] };
    h.mpaRelease.mockReset();
    h.load.mockReset().mockResolvedValue({
        overlays: [
            { id: 'enabled', avoidRouting: true, visible: false, alerts: false },
            { id: 'visible', avoidRouting: false, visible: true, alerts: true },
        ],
    });
    h.read.mockReset().mockResolvedValue(
        normalizeOverlay({
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', properties: { name: 'Own area' }, geometry: polygon },
                { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [0.5, 0.5] } },
            ],
        }).data,
    );
});
it('reads only explicit enabled policy, keeps complete polygons and treats indicative parks as caution', async () => {
    const context = await readCurrentRoutingExclusions({ bbox });
    expect(h.read).toHaveBeenCalledOnce();
    expect(h.read.mock.calls[0][0].id).toBe('enabled');
    expect(context.manual?.features).toHaveLength(1);
    expect(context.manual?.features[0].geometry).toEqual(polygon);
    expect(context.manual?.features[0].properties).toEqual({});
    expect(context.marineParks).toBe(h.mpaData);
    expect(context.advisories.join(' ')).toMatch(/indicative.*caution only/);
    context.release();
    expect(context.isCurrent()).toBe(false);
    expect(context.manual).toBeUndefined();
    expect(context.marineParks).toBeUndefined();
    expect(h.mpaRelease).toHaveBeenCalledOnce();
});
it.each(['source', 'account', 'generation'])('rejects %s replacement during a private file await', async (kind) => {
    let finish!: (value: unknown) => void;
    const old = normalizeOverlay(polygon).data;
    h.read.mockImplementationOnce(
        () =>
            new Promise((r) => {
                finish = r;
            }),
    );
    const reading = readCurrentRoutingExclusions({ bbox }),
        rejected = expect(reading).rejects.toThrow('context changed');
    await vi.waitFor(() => expect(h.read).toHaveBeenCalled());
    if (kind === 'source') h.mpaCurrent = false;
    if (kind === 'generation') h.generation++;
    if (kind === 'account') {
        setAuthIdentityScope('routing-owner-b');
        setAuthIdentityScope('routing-owner-a');
    }
    finish(old);
    await rejected;
    expect(h.mpaRelease).toHaveBeenCalledOnce();
});
it('retires the complete borrowed context when aborted after adoption', async () => {
    const controller = new AbortController(),
        context = await readCurrentRoutingExclusions({ bbox, signal: controller.signal });
    controller.abort();
    expect(context.isCurrent()).toBe(false);
    expect(context.manual).toBeUndefined();
    expect(h.mpaRelease).toHaveBeenCalledOnce();
});
it.each(['absent', 'expired', 'bounded-out'])('reports MPA %s without manufacturing a restriction', async (status) => {
    h.mpaStatus = status;
    h.mpaData = undefined;
    const context = await readCurrentRoutingExclusions({ bbox });
    expect(context.marineParks).toBeUndefined();
    expect(context.advisories.join(' ')).toMatch(/unavailable/);
    expect(context.manual?.features).toHaveLength(1);
    context.release();
});
it('fails closed when the enabled policy has no complete verified polygon', async () => {
    h.read.mockResolvedValueOnce(normalizeOverlay({ type: 'Point', coordinates: [0.5, 0.5] }).data);
    await expect(readCurrentRoutingExclusions({ bbox })).rejects.toThrow('no verified polygon');
    expect(h.mpaRelease).toHaveBeenCalledOnce();
});
it('keeps dateline and enclosing polygons complete without clipping the route window', () => {
    const across = {
        type: 'Polygon' as const,
        coordinates: [
            [
                [179, -1],
                [-179, -1],
                [-179, 1],
                [179, 1],
                [179, -1],
            ],
        ],
    };
    expect(overlayPolygonOverlaps(across, [179.5, -0.5, -179.5, 0.5])).toBe(true);
    expect(overlayPolygonOverlaps(across, [0, -0.5, 1, 0.5])).toBe(false);
    expect(overlayPolygonOverlaps(polygon, [0.4, 0.4, 0.6, 0.6])).toBe(true);
    expect(overlayPolygonOverlaps(polygon, [2, 2, 3, 3])).toBe(false);
});
it('snapshots caller bounds before an await instead of silently changing the selected hard constraints', async () => {
    const window: [number, number, number, number] = [-0.1, -0.1, 1.1, 1.1];
    h.load.mockImplementationOnce(async () => {
        window.splice(0, 4, 10, 10, 11, 11);
        return { overlays: [{ id: 'enabled', avoidRouting: true }] };
    });
    const context = await readCurrentRoutingExclusions({ bbox: window });
    expect(context.manual?.features).toHaveLength(1);
    context.release();
});
it('dedupe keys retire on an overlay edit, auth A/B/A and a retained-source state change', () => {
    const initial = routingExclusionContextKey();
    expect(routingExclusionContextKey()).toBe(initial);
    h.generation++;
    const edited = routingExclusionContextKey();
    expect(edited).not.toBe(initial);
    setAuthIdentityScope('routing-owner-b');
    setAuthIdentityScope('routing-owner-a');
    const switched = routingExclusionContextKey();
    expect(switched).not.toBe(edited);
    h.mpaCurrent = false;
    expect(routingExclusionContextKey()).not.toBe(switched);
});
