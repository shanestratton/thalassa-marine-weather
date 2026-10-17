import { beforeEach, afterEach, afterAll, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { SshObservation } from '../services/weather/api/sshObservations';
import type { ScalarGrid } from '../services/weather/scalarGridImage';
vi.stubEnv('VITE_ENABLE_OCEAN_EDDIES', 'true');
const { useSshObservation } = await import('../components/map/useSshObservation');
const now = Date.UTC(2026, 9, 17);
function data(): SshObservation {
    const grid: ScalarGrid = {
        width: 2,
        height: 2,
        west: -90,
        south: -30,
        dx: 180,
        dy: 60,
        values: new Float32Array(4),
        validMask: new Uint8Array(4).fill(1),
        wrapLongitude: true,
    };
    return {
        generation: 'original-cohort',
        sourceTimeMs: now - 86_400_000,
        validUntilMs: now + 10_000,
        adt: grid,
        sla: grid,
        eastward: grid,
        northward: grid,
    };
}
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});
afterAll(() => {
    vi.unstubAllEnvs();
});
it('never requests an unselected Obs layer', () => {
    const load = vi.fn();
    const hook = renderHook(() => useSshObservation(false, load));
    expect(load).not.toHaveBeenCalled();
    expect(hook.result.current.phase).toBe('off');
    expect(hook.result.current.sourceCurrent()).toBe(false);
});
it('holds offline without an automatic queued request', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const load = vi.fn();
    const hook = renderHook(() => useSshObservation(true, load));
    expect(load).not.toHaveBeenCalled();
    expect(hook.result.current.phase).toBe('unavailable');
});
it('retains the original observation time and retires exactly at its deadline', async () => {
    const load = vi.fn().mockResolvedValue(data());
    const hook = renderHook(() => useSshObservation(true, load));
    await act(async () => {
        await Promise.resolve();
    });
    expect(hook.result.current.data?.sourceTimeMs).toBe(now - 86_400_000);
    expect(hook.result.current.sourceCurrent()).toBe(true);
    act(() => {
        vi.advanceTimersByTime(10_001);
    });
    expect(hook.result.current.data).toBeNull();
    expect(hook.result.current.phase).toBe('unavailable');
    expect(hook.result.current.sourceCurrent()).toBe(false);
    expect(load).toHaveBeenCalledOnce();
});
it('aborts when deselected and ignores a late successful native result', async () => {
    let resolve!: (v: SshObservation) => void;
    const load = vi.fn(
        (_signal: AbortSignal) =>
            new Promise<SshObservation>((r) => {
                resolve = r;
            }),
    );
    const hook = renderHook(({ enabled }) => useSshObservation(enabled, load), { initialProps: { enabled: true } });
    const signal = load.mock.calls[0][0] as AbortSignal;
    hook.rerender({ enabled: false });
    expect(signal.aborted).toBe(true);
    await act(async () => {
        resolve(data());
    });
    expect(hook.result.current.data).toBeNull();
    expect(hook.result.current.phase).toBe('off');
});
it('retiring the foreground view aborts its request without retaining a cohort', async () => {
    let resolve!: (v: SshObservation) => void;
    const load = vi.fn(
        (_signal: AbortSignal) =>
            new Promise<SshObservation>((r) => {
                resolve = r;
            }),
    );
    const hook = renderHook(() => useSshObservation(true, load));
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => {
        resolve(data());
    });
    expect(hook.result.current.data).toBeNull();
    expect(hook.result.current.phase).toBe('off');
});
it('does not automatically retry failed or stale observations', async () => {
    const old = { ...data(), validUntilMs: now - 1 },
        load = vi.fn().mockResolvedValue(old);
    const hook = renderHook(() => useSshObservation(true, load));
    await act(async () => {
        await Promise.resolve();
    });
    act(() => {
        vi.advanceTimersByTime(100_000);
    });
    expect(hook.result.current.data).toBeNull();
    expect(hook.result.current.phase).toBe('unavailable');
    expect(load).toHaveBeenCalledOnce();
});
it('refuses presentation when a clock rollback makes the original observation future', async () => {
    const load = vi.fn().mockResolvedValue(data());
    const hook = renderHook(() => useSshObservation(true, load));
    await act(async () => {
        await Promise.resolve();
    });
    expect(hook.result.current.sourceCurrent()).toBe(true);
    vi.setSystemTime(data().sourceTimeMs - 1);
    expect(hook.result.current.sourceCurrent()).toBe(false);
    expect(load).toHaveBeenCalledOnce();
});
