import { afterEach, expect, it, vi } from 'vitest';
import { waitForLocalChart } from '../services/charts/localChartWait';
afterEach(() => vi.useRealTimers());
it('bounds a never-resolved load and ignores a late completion', async () => {
    vi.useFakeTimers();
    let done!: (value: string) => void;
    const pending = waitForLocalChart(
        new Promise<string>((resolve) => {
            done = resolve;
        }),
        () => {},
        performance.now() + 15000,
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(15000);
    expect(await pending).toMatchObject({ message: 'Local chart opening timed out.' });
    done('late');
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
});
it('retires a pending load on its actual owner check without aborting a successful caller', async () => {
    vi.useFakeTimers();
    let current = true;
    const pending = waitForLocalChart(
        new Promise<string>(() => {}),
        () => {
            if (!current) throw new Error('Retired');
        },
        performance.now() + 15000,
    ).catch((error: unknown) => error);
    current = false;
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toMatchObject({ message: 'Retired' });
    const controller = new AbortController();
    expect(
        await waitForLocalChart(
            Promise.resolve('ok'),
            () => {
                if (controller.signal.aborted) throw new Error('Stopped');
            },
            performance.now() + 15000,
        ),
    ).toBe('ok');
    expect(controller.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
});
