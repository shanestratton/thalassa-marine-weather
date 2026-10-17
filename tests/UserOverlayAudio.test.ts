import { beforeEach, afterEach, it, expect, vi } from 'vitest';
const f = vi.hoisted(() => ({ alarm: false, stops: vi.fn(), starts: vi.fn() }));
vi.mock('../services/AlarmAudioService', () => ({ AlarmAudioService: { getIsPlaying: () => f.alarm } }));
class Context {
    state = 'running';
    currentTime = 0;
    destination = {};
    resume = async () => {};
    createOscillator() {
        return {
            frequency: { setValueAtTime: vi.fn() },
            connect: () => ({ connect: vi.fn() }),
            disconnect: vi.fn(),
            start: f.starts,
            stop: f.stops,
            onended: null,
        };
    }
    createGain() {
        return {
            gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
            connect: vi.fn(),
            disconnect: vi.fn(),
        };
    }
}
beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubGlobal('AudioContext', Context);
    f.alarm = false;
    f.starts.mockClear();
    f.stops.mockClear();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});
it('quiet cue needs explicit unlock, stays off under safety alarm/background, and stops only its own oscillator', async () => {
    const a = await import('../services/userOverlays/audio');
    expect(a.playOverlayChime()).toBe(false);
    await a.unlockOverlayChime();
    f.alarm = true;
    expect(a.playOverlayChime()).toBe(false);
    f.alarm = false;
    expect(a.playOverlayChime()).toBe(true);
    expect(f.starts).toHaveBeenCalledTimes(1);
    f.alarm = true;
    await vi.advanceTimersByTimeAsync(50);
    expect(f.stops).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    f.alarm = false;
    expect(a.playOverlayChime()).toBe(false);
    a.stopOverlayChime();
});
