/**
 * useRoutingPolar — the routers' polar for a screen that shows ETAs (the
 * Passage HUD, Plan Your Day). Build 125, package 125-08.
 *
 * The learned grid lives on disk. The snapshot is taken AFTER the first
 * render (never during it, so the HUD paints at once on the factory polar)
 * and again whenever the learned grid or the skipper's polar settings change.
 * A factory choice never touches the learned store.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VesselProfile } from '../types';

const storage = vi.hoisted(() => ({
    loadLargeData: vi.fn(async (): Promise<unknown> => null),
    saveLargeData: vi.fn(async () => undefined),
}));
vi.mock('../services/nativeStorage', () => ({
    loadLargeData: storage.loadLargeData,
    saveLargeData: storage.saveLargeData,
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../stores/settingsStore', async () => {
    const { create } = await import('zustand');
    const useSettingsStore = create(() => ({ settings: {} as Record<string, unknown> }));
    return { useSettingsStore };
});

import { useSettingsStore } from '../stores/settingsStore';
import { SmartPolarStore } from '../services/SmartPolarStore';
import { useRoutingPolar } from '../hooks/useRoutingPolar';

const SLOOP: VesselProfile = {
    name: 'Kittiwake',
    type: 'sail',
    length: 36,
    beam: 12,
    draft: 6,
    displacement: 14000,
    maxWaveHeight: 8,
    cruisingSpeed: 6,
};

const setSettings = (settings: Record<string, unknown>) =>
    act(() => {
        (useSettingsStore as unknown as { setState: (s: unknown) => void }).setState({ settings });
    });

/** Ten clean samples in each of nine buckets: enough for routing to use them. */
function teach(n = 10) {
    for (const tws of [8, 10, 12]) {
        for (const twa of [60, 90, 120]) {
            for (let i = 0; i < n; i++) SmartPolarStore.recordSample(tws, twa, 5 + tws / 10);
        }
    }
}

beforeEach(async () => {
    vi.useRealTimers();
    storage.loadLargeData.mockReset();
    storage.loadLargeData.mockResolvedValue(null);
    storage.saveLargeData.mockReset();
    await SmartPolarStore.ensureLoaded();
    await SmartPolarStore.reset();
    setSettings({});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('useRoutingPolar', () => {
    it('a factory choice resolves at once and never touches the learned store', () => {
        const ensureLoaded = vi.spyOn(SmartPolarStore, 'ensureLoaded');
        const exportSpy = vi.spyOn(SmartPolarStore, 'exportToPolarData');
        setSettings({ polarSource: 'factory' });
        const { result } = renderHook(() => useRoutingPolar(SLOOP));
        expect(result.current.source).toBe('default');
        expect(result.current.label).toBe('Generic cruising polar');
        expect(ensureLoaded).not.toHaveBeenCalled();
        expect(exportSpy).not.toHaveBeenCalled();
    });

    it('Smart: the first render is never blocked on the learned grid, then the snapshot arrives', async () => {
        teach();
        const exportSpy = vi.spyOn(SmartPolarStore, 'exportToPolarData');
        setSettings({ polarSource: 'smart', smartPolarsEnabled: true });
        let firstRenderExports: number | null = null;
        const { result } = renderHook(() => {
            const r = useRoutingPolar(SLOOP);
            firstRenderExports ??= exportSpy.mock.calls.length;
            return r;
        });
        // Nothing read during the first render: it sails on the factory polar meanwhile.
        expect(firstRenderExports).toBe(0);
        await waitFor(() => expect(result.current.source).toBe('learned'));
        expect(result.current.label).toMatch(/^Learned \(\d+ of 42 cells\), the rest from Generic cruising polar$/);
    });

    it('Smart: when the learned grid changes (a save after new samples), the snapshot is taken again', async () => {
        setSettings({ polarSource: 'smart', smartPolarsEnabled: true });
        const { result } = renderHook(() => useRoutingPolar(SLOOP));
        await waitFor(() =>
            expect(result.current.label).toBe('Learning (0 of 42 cells), sailing on Generic cruising polar'),
        );
        vi.useFakeTimers();
        teach();
        // SmartPolarStore saves 5 s after a sample, and tells its listeners.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5_000);
        });
        vi.useRealTimers();
        await waitFor(() => expect(result.current.source).toBe('learned'));
    });

    it('the learner switch is read live: switched off, nothing says it is learning', async () => {
        setSettings({ polarSource: 'smart', smartPolarsEnabled: false });
        const { result } = renderHook(() => useRoutingPolar(SLOOP));
        await waitFor(() =>
            expect(result.current.label).toBe(
                'Smart polar (0 of 42 cells, learning off), sailing on Generic cruising polar',
            ),
        );
        expect(result.current.learning).toBe(false);
        setSettings({ polarSource: 'smart', smartPolarsEnabled: true });
        await waitFor(() =>
            expect(result.current.label).toBe('Learning (0 of 42 cells), sailing on Generic cruising polar'),
        );
        expect(result.current.learning).toBe(true);
    });

    it('the same figures again give the same object: an unchanged grid never re-walks a plan', async () => {
        teach();
        setSettings({ polarSource: 'smart' });
        const { result } = renderHook(() => useRoutingPolar(SLOOP));
        await waitFor(() => expect(result.current.source).toBe('learned'));
        const before = result.current;
        await act(async () => {
            await SmartPolarStore.reset();
        });
        await waitFor(() => expect(result.current.source).toBe('default'));
        teach();
        await act(async () => {
            await (SmartPolarStore as unknown as { save: () => Promise<void> }).save();
        });
        await waitFor(() => expect(result.current.source).toBe('learned'));
        expect(result.current.signature).toBe(before.signature);
        const settled = result.current;
        await act(async () => {
            await (SmartPolarStore as unknown as { save: () => Promise<void> }).save();
        });
        expect(result.current).toBe(settled);
    });

    it('changing her polar in Settings changes what the screen sails on', () => {
        const { result } = renderHook(() => useRoutingPolar(SLOOP));
        expect(result.current.source).toBe('default');
        setSettings({
            polarSource: 'factory',
            polarSource_type: 'file_import',
            polarBoatModel: 'Kittiwake.pol',
            polarData: {
                windSpeeds: [6, 10, 15, 20],
                angles: [40, 60, 90, 120, 150, 180],
                matrix: [
                    [3.8, 5.0, 5.6, 5.8],
                    [4.6, 5.9, 6.5, 6.8],
                    [5.0, 6.4, 7.1, 7.5],
                    [4.8, 6.3, 7.2, 7.8],
                    [4.0, 5.6, 6.7, 7.4],
                    [3.4, 4.9, 6.0, 6.8],
                ],
            },
        });
        expect(result.current.source).toBe('imported');
        expect(result.current.label).toBe('Kittiwake.pol (imported)');
    });
});
