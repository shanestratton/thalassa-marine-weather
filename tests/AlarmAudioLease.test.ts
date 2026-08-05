import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const audioMocks = vi.hoisted(() => ({
    startAlarm: vi.fn().mockResolvedValue({ playing: true }),
    stopAlarm: vi.fn().mockResolvedValue({ stopped: true }),
    isAlarmPlaying: vi.fn().mockResolvedValue({ playing: true }),
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => 'ios',
    },
    registerPlugin: () => audioMocks,
}));

import { AlarmAudioService } from '../services/AlarmAudioService';

beforeEach(async () => {
    audioMocks.startAlarm.mockReset().mockResolvedValue({ playing: true });
    audioMocks.stopAlarm.mockReset().mockResolvedValue({ stopped: true });
    audioMocks.isAlarmPlaying.mockReset().mockResolvedValue({ playing: true });
    await AlarmAudioService.forceStop();
    audioMocks.stopAlarm.mockClear();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('AlarmAudioService ownership leases', () => {
    it('does not let a Calypso chime release stop an Anchor Watch alarm', async () => {
        const anchorLease = await AlarmAudioService.acquire('anchor-watch');
        const calypsoLease = await AlarmAudioService.acquire('calypso-alert');

        expect(audioMocks.startAlarm).toHaveBeenCalledOnce();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(2);

        await AlarmAudioService.release(calypsoLease);
        expect(audioMocks.stopAlarm).not.toHaveBeenCalled();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(1);

        await AlarmAudioService.release(anchorLease);
        expect(audioMocks.stopAlarm).toHaveBeenCalledOnce();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(0);
    });

    it('makes an unknown or already-released token unable to stop another owner', async () => {
        const anchorLease = await AlarmAudioService.acquire('anchor-watch');

        await AlarmAudioService.release('not-a-live-token');
        expect(audioMocks.stopAlarm).not.toHaveBeenCalled();

        await AlarmAudioService.release(anchorLease);
        await AlarmAudioService.release(anchorLease);
        expect(audioMocks.stopAlarm).toHaveBeenCalledOnce();
    });

    it('does not create a phantom lease when native start rejects', async () => {
        audioMocks.startAlarm.mockRejectedValueOnce(new Error('native start failed'));

        await expect(AlarmAudioService.acquire('anchor-watch')).rejects.toThrow('native start failed');
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(0);
    });

    it('retries a detached release without silencing an owner that arrives meanwhile', async () => {
        vi.useFakeTimers();
        const soundCheckLease = await AlarmAudioService.acquire('anchor-sound-check');
        audioMocks.stopAlarm.mockRejectedValueOnce(new Error('native stop failed'));

        AlarmAudioService.releaseEventually(soundCheckLease);
        await vi.waitFor(() => expect(audioMocks.stopAlarm).toHaveBeenCalledOnce());
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(1);

        const anchorLease = await AlarmAudioService.acquire('anchor-watch');
        await vi.advanceTimersByTimeAsync(1_000);

        expect(AlarmAudioService.getActiveLeaseCount()).toBe(1);
        expect(audioMocks.stopAlarm).toHaveBeenCalledOnce();

        await AlarmAudioService.release(anchorLease);
        expect(audioMocks.stopAlarm).toHaveBeenCalledTimes(2);
    });

    it('always invokes native stop during forceStop even when JS is already idle', async () => {
        expect(AlarmAudioService.getIsPlaying()).toBe(false);

        await AlarmAudioService.forceStop();

        expect(audioMocks.stopAlarm).toHaveBeenCalledOnce();
    });
});
