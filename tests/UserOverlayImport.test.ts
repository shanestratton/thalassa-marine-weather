import { it, expect, vi, beforeEach, afterEach } from 'vitest';
const f = vi.hoisted(() => ({ scope: { key: 'A', generation: 1, userId: 'A' } }));
vi.mock('../services/authIdentityScope', () => ({
    getAuthIdentityScope: () => f.scope,
    isAuthIdentityScopeCurrent: (s: unknown) => s === f.scope,
}));
import { previewUserOverlay } from '../services/userOverlays/import';
class FakeWorker {
    static current: FakeWorker | null = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    terminate = vi.fn();
    postMessage = vi.fn();
    constructor() {
        FakeWorker.current = this;
    }
}
const file = (name = 'a.geojson', text = '{"type":"Point","coordinates":[0,0]}') =>
    ({
        name,
        size: new TextEncoder().encode(text).length,
        arrayBuffer: async () => new TextEncoder().encode(text).buffer,
    }) as File;
beforeEach(() => {
    f.scope = { key: 'A', generation: 1, userId: 'A' };
    FakeWorker.current = null;
    vi.stubGlobal('Worker', FakeWorker);
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});
it('owned worker gets a transferred bounded buffer; reply is normalized and worker terminated', async () => {
    const p = previewUserOverlay(file());
    await Promise.resolve();
    const call = FakeWorker.current!.postMessage.mock.calls[0] as [
        { format: string; bytes: ArrayBuffer },
        ArrayBuffer[],
    ];
    FakeWorker.current!.onmessage!({ data: { ok: true, preview: { data: { type: 'Point', coordinates: [0, 0] } } } });
    expect((await p).data.features[0].geometry).toEqual({ type: 'Point', coordinates: [0, 0] });
    expect(call[0].format).toBe('GeoJSON');
    expect(call[1][0]).toBe(call[0].bytes);
    expect(call[0].bytes.byteLength).toBe(file().size);
    expect(FakeWorker.current!.terminate).toHaveBeenCalled();
});
it('parallel admissions, invalid extension/size and malicious worker shape refuse', async () => {
    await expect(previewUserOverlay({ ...file(), size: 4 * 1024 * 1024 + 1 })).rejects.toThrow('4 MiB');
    await expect(previewUserOverlay(file('a.enc'))).rejects.toThrow('Choose');
    const p = previewUserOverlay(file());
    await Promise.resolve();
    await expect(previewUserOverlay(file())).rejects.toThrow('Another');
    FakeWorker.current!.onmessage!({ data: { ok: true, preview: { data: { layers: {} } } } });
    await expect(p).rejects.toThrow('chart pack');
});
it('abort, original account change and deadline terminate without a main-thread inflate fallback', async () => {
    const c = new AbortController(),
        p = previewUserOverlay(file(), c.signal);
    await Promise.resolve();
    c.abort();
    await expect(p).rejects.toThrow('cancelled');
    expect(FakeWorker.current!.terminate).toHaveBeenCalled();
    const q = previewUserOverlay(file());
    await Promise.resolve();
    f.scope = { key: 'B', generation: 2, userId: 'B' };
    FakeWorker.current!.onmessage!({ data: { ok: true, preview: { data: { type: 'Point', coordinates: [0, 0] } } } });
    await expect(q).rejects.toThrow('cancelled');
    const r = previewUserOverlay(file());
    const rejected = expect(r).rejects.toThrow('five seconds');
    await vi.advanceTimersByTimeAsync(5001);
    await rejected;
});
