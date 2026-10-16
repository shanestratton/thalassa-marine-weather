import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ load: vi.fn(), accept: vi.fn(), retire: vi.fn() }));
vi.mock('../services/radar/piRadar', () => ({ loadPiRadarPicture: f.load }));
vi.mock('../services/radar/radarStore', () => ({ RadarStore: { acceptPi: f.accept, retirePi: f.retire } }));
import { retainPiRadar } from '../services/radar/radarPiSession';
beforeEach(() => {
    vi.useFakeTimers();
    f.load.mockReset();
    f.accept.mockReset();
    f.retire.mockReset();
});
afterEach(() => vi.useRealTimers());
describe('leased private Pi radar polling', () => {
    it('shares one read between display/watch and only the final owner can stop it', async () => {
        const token = { feedId: 'pi:generated' };
        f.load.mockResolvedValue({ connected: true });
        f.accept.mockReturnValue(token);
        const display = retainPiRadar(),
            watch = retainPiRadar();
        await Promise.resolve();
        expect(f.load).toHaveBeenCalledTimes(1);
        display();
        expect(f.retire).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2000);
        expect(f.load).toHaveBeenCalledTimes(2);
        watch();
        expect(f.retire).toHaveBeenCalledWith(token);
        await vi.advanceTimersByTimeAsync(10000);
        expect(f.load).toHaveBeenCalledTimes(2);
        watch();
        expect(f.retire).toHaveBeenCalledTimes(1);
    });
    it('aborts a retired read and refuses its late completion after a replacement starts', async () => {
        const responses: Array<(v: unknown) => void> = [];
        f.load.mockImplementation(() => new Promise((r) => responses.push(r)));
        const old = retainPiRadar();
        const request = f.load.mock.calls[0][0];
        old();
        expect(request.signal.aborted).toBe(true);
        const next = retainPiRadar();
        responses[0]({ connected: true, feedId: 'old' });
        await Promise.resolve();
        expect(f.accept).not.toHaveBeenCalled();
        responses[1]({ connected: true, feedId: 'next' });
        await Promise.resolve();
        expect(f.accept).toHaveBeenCalledWith({ connected: true, feedId: 'next' });
        next();
    });
    it('a failed read never manufactures a clear picture or drops another owner lease', async () => {
        f.load.mockRejectedValue(Error('private lane unavailable'));
        const a = retainPiRadar(),
            b = retainPiRadar();
        await Promise.resolve();
        expect(f.accept).not.toHaveBeenCalled();
        a();
        await vi.advanceTimersByTimeAsync(2000);
        expect(f.load).toHaveBeenCalledTimes(2);
        expect(f.retire).not.toHaveBeenCalled();
        b();
    });
});
