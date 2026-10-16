import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignalKNotificationAudio } from '../services/signalk/notificationAudio';
import type { SignalKNotice } from '../pi-cache/src/signalkProtocol';
const notice: SignalKNotice = {
    path: 'notifications.mob',
    source: 'fixture',
    message: 'Fictional MOB',
    state: 'emergency',
    at: 100,
    receivedAt: 100,
    soundRequested: true,
};
const settle = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
};
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
});
afterEach(() => vi.useRealTimers());
describe('Signal K audio owns only its session alarm lease', () => {
    it('cannot turn a delayed module load into a stale alarm cue', async () => {
        const audio = { acquire: vi.fn(async () => 'lease'), releaseEventually: vi.fn() };
        let resolve!: (value: typeof audio) => void;
        const cue = new SignalKNotificationAudio(
            () => true,
            () => new Promise<typeof audio>((r) => (resolve = r)),
        );
        cue.setEnabled(true);
        cue.update([notice], [{ notice, fresh: true }]);
        await vi.advanceTimersByTimeAsync(11000);
        resolve(audio);
        await settle();
        expect(audio.acquire).not.toHaveBeenCalled();
        cue.stop();
    });
    it('requires explicit opt-in and a new source-dated sound alarm, never initial replay', async () => {
        const audio = { acquire: vi.fn(async () => 'our-lease'), releaseEventually: vi.fn() },
            load = vi.fn(async () => audio),
            cue = new SignalKNotificationAudio(() => true, load);
        cue.update([notice], [{ notice, fresh: true }]);
        await settle();
        expect(load).not.toHaveBeenCalled();
        cue.setEnabled(true);
        cue.update([notice], [{ notice, fresh: false }]);
        await settle();
        expect(load).not.toHaveBeenCalled();
        cue.update([notice], [{ notice, fresh: true }]);
        await settle();
        expect(audio.acquire).toHaveBeenCalledExactlyOnceWith('signalk-notification');
        cue.stop();
        expect(audio.releaseEventually).toHaveBeenCalledExactlyOnceWith('our-lease');
    });
    it('retires only its lease after three seconds or a matching clear', async () => {
        vi.useFakeTimers();
        const audio = { acquire: vi.fn(async () => 'our-lease'), releaseEventually: vi.fn() },
            cue = new SignalKNotificationAudio(
                () => true,
                async () => audio,
            );
        cue.setEnabled(true);
        cue.update([notice], [{ notice, fresh: true }]);
        await settle();
        await vi.advanceTimersByTimeAsync(3000);
        expect(audio.releaseEventually).toHaveBeenCalledWith('our-lease');
        cue.update([notice], [{ notice: { ...notice, at: 200 }, fresh: true }]);
        await settle();
        cue.update([], []);
        expect(audio.releaseEventually).toHaveBeenCalledTimes(2);
        cue.stop();
    });
    it('releases a late acquired lease after account/session retirement or source clearing', async () => {
        let resolve!: (lease: string) => void;
        const audio = { acquire: vi.fn(() => new Promise<string>((r) => (resolve = r))), releaseEventually: vi.fn() },
            cue = new SignalKNotificationAudio(
                () => true,
                async () => audio,
            );
        cue.setEnabled(true);
        cue.update([notice], [{ notice, fresh: true }]);
        await settle();
        cue.update([], []);
        resolve('late-lease');
        await settle();
        expect(audio.releaseEventually).toHaveBeenCalledWith('late-lease');
        cue.stop();
    });
});
