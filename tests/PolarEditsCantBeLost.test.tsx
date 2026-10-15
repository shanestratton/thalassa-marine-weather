/**
 * Polar edits and imports you can't lose (build 132, package 132-B22).
 *
 * - An edit waits 1.5 s before it saves; the save line says 'Saving…' while
 *   it waits (it never showed), and leaving the page or the app inside that
 *   wait saves it (the timer was cleared and the edit lost).
 * - An import is read and shown first — what it was read as, its size, her
 *   best figure, its chart — and a file routes cannot sail on is refused
 *   with the reason; nothing is saved until 'Use this polar'.
 * - 'Clear all', and an import over a polar with figures, ask first, in the
 *   app's own ConfirmDialog.
 * - 'Choose one in Settings' opens Settings at Vessel profile.
 * - The page keeps clear of the tab bar once, not twice.
 *
 * Fictional boat; the learned grid is SmartPolarStore's own, on mocked
 * storage; the settings store is a small stand-in. Fixtures are made up
 * (tests/fixtures/polars); no network.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PolarData, VesselProfile } from '../types';

const chart = vi.hoisted(() => ({ drawn: [] as PolarData[] }));
vi.mock('../components/settings/PolarChart', () => ({
    PolarChart: ({ data }: { data: PolarData }) => {
        chart.drawn.push(data);
        return <div data-testid="polar-chart" />;
    },
}));
vi.mock('../services/SmartPolarService', () => ({
    SmartPolarService: { onStatusChange: vi.fn(() => () => undefined), start: vi.fn(), stop: vi.fn() },
}));
vi.mock('../services/smartPolarFeed', () => ({
    learnerFeedState: () => 'pi',
    subscribeLearnerFeedState: () => () => undefined,
}));
vi.mock('../services/nativeStorage', () => ({
    loadLargeData: vi.fn(async () => null),
    saveLargeData: vi.fn(async () => undefined),
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../stores/settingsStore', async () => {
    const { create } = await import('zustand');
    const useSettingsStore = create<{
        settings: Record<string, unknown>;
        updateSettings: (patch: Record<string, unknown>) => void;
    }>((set) => ({
        settings: {},
        updateSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
    }));
    return { useSettingsStore };
});
vi.mock('../context/SettingsContext', async () => {
    const { useSettingsStore } = await import('../stores/settingsStore');
    return { useSettings: () => useSettingsStore() };
});

import { PolarManagerTab } from '../components/settings/PolarManagerTab';
import { PolarPage } from '../components/vessel/PolarPage';
import { SmartPolarStore } from '../services/SmartPolarStore';
import { useSettingsStore } from '../stores/settingsStore';
import { authScopedStorageKey } from '../services/authIdentityScope';
import { readPolarFile } from '../utils/polarParser';

const SLOOP: VesselProfile = {
    name: 'Fair Wind',
    type: 'sail',
    length: 38,
    beam: 12.8,
    draft: 6.2,
    displacement: 15000,
    maxWaveHeight: 10,
    cruisingSpeed: 6.5,
};
/** Her own figures, typed in: shown and saved as given. */
const MINE: PolarData = {
    windSpeeds: [6, 10, 16],
    angles: [45, 90, 150],
    matrix: [
        [4.4, 5.8, 6.2],
        [5.4, 6.9, 7.5],
        [3.6, 5.4, 6.9],
    ],
};
const OWN = { polarData: MINE, polarBoatModel: 'Fair Wind', polarSource_type: 'manual' as const, vessel: SLOOP };

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures/polars', name), 'utf8');
const EXPEDITION = fixture('fair-wind-expedition.txt');

type SavedPolar = { polarData: PolarData; polarBoatModel: string; polarSource_type: string };
const store = useSettingsStore as unknown as {
    setState: (s: { settings: Record<string, unknown> }) => void;
    getState: () => { settings: Record<string, unknown> };
};

const cellInput = (twa: number, tws: number) =>
    screen.getByRole('spinbutton', {
        name: `Boat speed at ${twa} degrees true wind angle and ${tws} knots true wind speed`,
    }) as HTMLInputElement;
const saveLine = () => screen.getByTestId('polar-save-state').textContent ?? '';

/** Let the first SmartPolarStore load settle. */
const settle = () =>
    act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });

function openTab(tab: 'Import' | 'Manual') {
    fireEvent.click(screen.getByRole('button', { name: 'Enter polar figures' }));
    fireEvent.click(screen.getByRole('button', { name: tab }));
}

/** Choose a file in the Import tab. The tab reads only a file's name and text(). */
async function chooseFile(name: string, text: string) {
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = { name, text: () => Promise.resolve(text) } as unknown as File;
    await act(async () => {
        fireEvent.change(input, { target: { files: [file] } });
        await Promise.resolve();
        await Promise.resolve();
    });
}

beforeEach(async () => {
    chart.drawn = [];
    await SmartPolarStore.ensureLoaded();
    await SmartPolarStore.reset();
    act(() => {
        store.setState({ settings: {} });
    });
    localStorage.clear();
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

describe("an edit can't be lost (132-B22)", () => {
    it("says 'Saving…' while an edit waits, then 'Saved' when it is written", async () => {
        const onSave = vi.fn();
        render(<PolarManagerTab settings={OWN} onSave={onSave} />);
        await settle();
        expect(saveLine()).toBe('Saved');
        openTab('Manual');
        vi.useFakeTimers();
        fireEvent.change(cellInput(90, 10), { target: { value: '7.1' } });
        expect(saveLine()).toBe('Saving…');
        expect(onSave).not.toHaveBeenCalled();
        act(() => {
            vi.advanceTimersByTime(1499);
        });
        expect(saveLine()).toBe('Saving…');
        act(() => {
            vi.advanceTimersByTime(1);
        });
        expect(onSave).toHaveBeenCalledTimes(1);
        expect(saveLine()).toMatch(/^Saved .+/);
    });

    it('typing several figures is one save, of the last table', async () => {
        const onSave = vi.fn();
        render(<PolarManagerTab settings={OWN} onSave={onSave} />);
        await settle();
        openTab('Manual');
        vi.useFakeTimers();
        fireEvent.change(cellInput(90, 10), { target: { value: '7' } });
        fireEvent.change(cellInput(90, 10), { target: { value: '7.1' } });
        fireEvent.change(cellInput(45, 6), { target: { value: '4.5' } });
        act(() => {
            vi.advanceTimersByTime(1500);
        });
        expect(onSave).toHaveBeenCalledTimes(1);
        const saved = onSave.mock.calls[0][0] as SavedPolar;
        expect(saved.polarData.matrix[1][1]).toBe(7.1);
        expect(saved.polarData.matrix[0][0]).toBe(4.5);
    });

    it('leaving the page inside the wait saves the edit — once — and routes then sail it', async () => {
        act(() => {
            store.setState({ settings: OWN });
        });
        const view = render(<PolarPage onBack={vi.fn()} />);
        await settle();
        openTab('Manual');
        vi.useFakeTimers();
        fireEvent.change(cellInput(90, 10), { target: { value: '7.1' } });
        // Back, 200 ms later: the page closes before the 1.5 s are up.
        act(() => {
            vi.advanceTimersByTime(200);
        });
        expect((store.getState().settings as SavedPolar).polarData.matrix[1][1]).toBe(6.9);
        view.unmount();
        const saved = store.getState().settings as SavedPolar;
        expect(saved.polarData.matrix[1][1]).toBe(7.1);
        expect(saved.polarSource_type).toBe('manual');
        expect(saved.polarBoatModel).toBe('Fair Wind');
        // The timer it left does not save a second time.
        const afterLeaving = store.getState().settings;
        act(() => {
            vi.advanceTimersByTime(5000);
        });
        expect(store.getState().settings).toBe(afterLeaving);
        // Opened again, the page — and so the HUD, Plan Your Day and routes,
        // one resolver — sails the saved figure.
        vi.useRealTimers();
        render(<PolarPage onBack={vi.fn()} />);
        await settle();
        expect(screen.getByTestId('polars-routes-sail-on').textContent).toBe(
            'Routes sail on: Fair Wind (your own figures)',
        );
        openTab('Manual');
        expect(cellInput(90, 10).value).toBe('7.1');
    });

    it('the app going to the background inside the wait saves the edit', async () => {
        const onSave = vi.fn();
        render(<PolarManagerTab settings={OWN} onSave={onSave} />);
        await settle();
        openTab('Manual');
        vi.useFakeTimers();
        fireEvent.change(cellInput(90, 10), { target: { value: '7.1' } });
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        act(() => {
            document.dispatchEvent(new Event('visibilitychange'));
        });
        expect(onSave).toHaveBeenCalledTimes(1);
        expect((onSave.mock.calls[0][0] as SavedPolar).polarData.matrix[1][1]).toBe(7.1);
        expect(saveLine()).toMatch(/^Saved .+/);
        act(() => {
            vi.advanceTimersByTime(5000);
        });
        expect(onSave).toHaveBeenCalledTimes(1);
    });

    it('a page closed with nothing waiting saves nothing', async () => {
        const onSave = vi.fn();
        const view = render(<PolarManagerTab settings={OWN} onSave={onSave} />);
        await settle();
        view.unmount();
        expect(onSave).not.toHaveBeenCalled();
    });
});

describe("'Clear all' asks first (132-B22)", () => {
    it("'Keep figures' keeps them; 'Clear all' empties the table and saves at once", async () => {
        const onSave = vi.fn();
        render(<PolarManagerTab settings={OWN} onSave={onSave} />);
        await settle();
        openTab('Manual');
        fireEvent.click(screen.getByRole('button', { name: 'Clear all polar matrix values' }));
        const ask = screen.getByRole('dialog', { name: 'Clear every figure?' });
        expect(ask.textContent).toContain('Until you enter new figures, routes use the generic cruising polar.');
        fireEvent.click(screen.getByRole('button', { name: 'Keep figures' }));
        expect(screen.queryByRole('dialog', { name: 'Clear every figure?' })).toBeNull();
        expect(onSave).not.toHaveBeenCalled();
        expect(cellInput(90, 10).value).toBe('6.9');

        fireEvent.click(screen.getByRole('button', { name: 'Clear all polar matrix values' }));
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
        });
        expect(onSave).toHaveBeenCalledTimes(1);
        const saved = onSave.mock.calls[0][0] as SavedPolar;
        expect(saved.polarSource_type).toBe('manual');
        expect(saved.polarData.matrix.flat().every((v) => v === 0)).toBe(true);
        expect(screen.queryByRole('dialog', { name: 'Clear every figure?' })).toBeNull();
        // The figures dialog is still open, now empty.
        expect(screen.getByRole('dialog', { name: 'Enter polar figures' })).toBeDefined();
    });
});

describe('an import is shown first, refused if routes cannot sail it, and asks before replacing (132-B22)', () => {
    it('a real Expedition file: what it was read as, its size, her best figure and its chart — nothing saved yet', async () => {
        const onSave = vi.fn();
        render(<PolarManagerTab settings={OWN} onSave={onSave} />);
        await settle();
        openTab('Import');
        chart.drawn = [];
        await chooseFile('Fair Wind.txt', EXPEDITION);
        const preview = screen.getByTestId('polar-import-preview');
        expect(preview.textContent).toContain('Read as an Expedition polar');
        expect(preview.textContent).toContain('6 wind speeds (6–20 kn) × 20 angles (38–179°)');
        expect(preview.textContent).toContain('Fastest: 8.4 kn at 135° in 20 kn of wind');
        expect(chart.drawn[chart.drawn.length - 1]).toEqual(readPolarFile(EXPEDITION).polar);
        expect(onSave).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Use this polar' })).toBeDefined();
    });

    it("over her own figures it asks: 'Keep mine' keeps them, 'Replace polar' saves the file at once", async () => {
        const onSave = vi.fn();
        render(<PolarManagerTab settings={OWN} onSave={onSave} />);
        await settle();
        openTab('Import');
        await chooseFile('Fair Wind.txt', EXPEDITION);
        fireEvent.click(screen.getByRole('button', { name: 'Use this polar' }));
        const ask = screen.getByRole('dialog', { name: 'Replace your polar?' });
        expect(ask.textContent).toContain('Your polar (Fair Wind) will be replaced by the figures from Fair Wind.');
        fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
        expect(onSave).not.toHaveBeenCalled();
        expect(screen.getByTestId('polar-import-preview')).toBeDefined();

        fireEvent.click(screen.getByRole('button', { name: 'Use this polar' }));
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Replace polar' }));
        });
        // At once: no 1.5 s wait for an import to be lost in.
        expect(onSave).toHaveBeenCalledTimes(1);
        expect(onSave.mock.calls[0][0]).toEqual({
            polarData: readPolarFile(EXPEDITION).polar,
            polarBoatModel: 'Fair Wind',
            polarSource_type: 'file_import',
        });
        expect(screen.queryByRole('dialog', { name: 'Enter polar figures' })).toBeNull();
        expect(saveLine()).toMatch(/^Saved .+/);
    });

    it('with no figures yet there is nothing to replace: it saves without asking', async () => {
        const onSave = vi.fn();
        render(<PolarManagerTab settings={{ vessel: SLOOP }} onSave={onSave} />);
        await settle();
        openTab('Import');
        await chooseFile('Fair Wind.pol', EXPEDITION);
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Use this polar' }));
        });
        expect(screen.queryByRole('dialog', { name: 'Replace your polar?' })).toBeNull();
        expect(onSave).toHaveBeenCalledTimes(1);
        expect((onSave.mock.calls[0][0] as SavedPolar).polarBoatModel).toBe('Fair Wind');
    });

    it('a file routes cannot sail on is refused with the reason, and nothing is saved', async () => {
        const onSave = vi.fn();
        render(<PolarManagerTab settings={OWN} onSave={onSave} />);
        await settle();
        openTab('Import');
        await chooseFile('upwind-only.pol', fixture('upwind-only.pol'));
        expect(screen.getByRole('alert').textContent).toBe(
            "Routes can't sail on this file: too many of its figures off the wind are zero. Your polar has not changed.",
        );
        expect(screen.queryByTestId('polar-import-preview')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Use this polar' })).toBeNull();
        expect(onSave).not.toHaveBeenCalled();
    });

    it('a file that is not a polar says so plainly', async () => {
        render(<PolarManagerTab settings={OWN} onSave={vi.fn()} />);
        await settle();
        openTab('Import');
        await chooseFile('shopping.txt', 'Bread\nMilk');
        expect(screen.getByRole('alert').textContent).toBe('No valid wind speeds found in header.');
    });

    it('says what it reads by layout, not that .pol is Expedition', async () => {
        render(<PolarManagerTab settings={OWN} />);
        await settle();
        openTab('Import');
        expect(screen.getByText('Reads Expedition polars and TWA × TWS tables (.pol, .csv, .txt)')).toBeDefined();
        expect(document.body.textContent).not.toContain('.pol (Expedition)');
    });
});

describe('the Polars page (132-B22)', () => {
    it("'Choose one in Settings' opens Settings at Vessel profile", async () => {
        act(() => {
            store.setState({ settings: { vessel: SLOOP } });
        });
        const onOpenVesselProfile = vi.fn();
        render(<PolarPage onBack={vi.fn()} onOpenVesselProfile={onOpenVesselProfile} />);
        await settle();
        fireEvent.click(screen.getByRole('button', { name: 'Choose one in Settings' }));
        expect(localStorage.getItem(authScopedStorageKey('thalassa_settings_initial_tab'))).toBe('vessel');
        expect(onOpenVesselProfile).toHaveBeenCalledTimes(1);
    });

    it('keeps clear of the tab bar once: the page body, not the scroll inside it too', async () => {
        act(() => {
            store.setState({ settings: OWN });
        });
        render(<PolarPage onBack={vi.fn()} />);
        await settle();
        const body = screen.getByTestId('polars-page-body');
        expect(body.style.paddingBottom).toContain('safe-area-inset-bottom');
        const scroller = body.firstElementChild as HTMLElement;
        expect(scroller.className).toContain('overflow-y-auto');
        expect(scroller.className).not.toMatch(/safe-area|5\.5rem/);
    });
});
