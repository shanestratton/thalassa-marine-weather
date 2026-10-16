/**
 * The Polars page says which polar routes really sail, and shows and edits
 * the figures they use (build 131, package 130-B6, was 126-B6b; polars-02,
 * polars-03, polars-07).
 *
 * - One line at the top: "Routes sail on: …", the routing resolver's own
 *   words (hooks/useRoutingPolar), as the passage banner, the HUD and Plan
 *   Your Day have them.
 * - A yacht-database table is shown, charted and edited scaled to her
 *   cruising speed, as routes scale it. Editing its raw figures saved the
 *   whole raw table as her own figures and made every route ~45% slow.
 * - "Routing uses: Your polar | Smart" — 'Factory' is gone.
 *
 * Fictional boat; the learned grid is SmartPolarStore's own, on mocked storage.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PolarData, VesselProfile } from '../types';

const chart = vi.hoisted(() => ({ data: null as PolarData | null }));
vi.mock('../components/settings/PolarChart', () => ({
    PolarChart: ({ data }: { data: PolarData }) => {
        chart.data = data;
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
import { resolveRoutingPolarFrom, yourPolarAsSailed } from '../services/routingPolar';
import { polarReferenceKts } from '../services/passagePlan';
import { POLAR_DATABASE } from '../data/polarDatabase';

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
const OCEANIS = POLAR_DATABASE.find((entry) => entry.model === 'Beneteau Oceanis 38.1')!;
const DATABASE = {
    polarData: OCEANIS.polar,
    polarBoatModel: OCEANIS.model,
    polarSource_type: 'database' as const,
    vessel: SLOOP,
};
const SCALED = yourPolarAsSailed(OCEANIS.polar, 'database', SLOOP).polar;

/** What the page saves: the patch PolarManagerTab hands onSave. */
type SavedPolar = {
    polarData: PolarData;
    polarBoatModel: string;
    polarSource_type: 'database' | 'file_import' | 'manual';
};
/** The mocked store's own setState and getState (the real store's types are UserSettings'). */
const store = useSettingsStore as unknown as {
    setState: (s: { settings: Record<string, unknown> }) => void;
    getState: () => { settings: Record<string, unknown> };
};

const cell = (p: PolarData, twa: number, tws: number) => p.matrix[p.angles.indexOf(twa)][p.windSpeeds.indexOf(tws)];
const cellInput = (twa: number, tws: number) =>
    screen.getByRole('spinbutton', {
        name: `Boat speed at ${twa} degrees true wind angle and ${tws} knots true wind speed`,
    }) as HTMLInputElement;

/** Let the first SmartPolarStore load settle. */
const settle = () =>
    act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });

function openManual() {
    fireEvent.click(screen.getByRole('button', { name: 'Enter polar figures' }));
    fireEvent.click(screen.getByRole('button', { name: 'Manual' }));
}

beforeEach(async () => {
    chart.data = null;
    await SmartPolarStore.ensureLoaded();
    await SmartPolarStore.reset();
    act(() => {
        store.setState({ settings: {} });
    });
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('the Polars page shows and edits the figures routes sail on (130-B6)', () => {
    it('a yacht-database polar is charted scaled to her cruising speed, not ~45% slow', async () => {
        render(<PolarManagerTab settings={DATABASE} />);
        await settle();
        expect(chart.data).toEqual(SCALED);
        expect(cell(chart.data!, 90, 15)).toBeGreaterThan(6);
        expect(cell(OCEANIS.polar, 90, 15)).toBeCloseTo(3.5, 1);
    });

    it('the Manual tab shows the scaled figures, and says what they are and what an edit does', async () => {
        render(<PolarManagerTab settings={DATABASE} />);
        await settle();
        openManual();
        expect(cellInput(90, 15).value).toBe(String(cell(SCALED, 90, 15)));
        expect(cellInput(45, 6).value).toBe(String(cell(SCALED, 45, 6)));
        expect(
            screen.getByText(
                /The yacht database figures, scaled to her cruising speed of 6\.5 kn: the figures routes sail on\./,
            ),
        ).toBeDefined();
        expect(screen.getByText(/Change one and the whole table becomes your own figures/)).toBeDefined();
    });

    it('changing one cell saves the scaled table with that cell changed: routes are not ~45% slow', async () => {
        const onSave = vi.fn();
        render(<PolarManagerTab settings={DATABASE} onSave={onSave} />);
        await settle();
        openManual();
        vi.useFakeTimers();
        fireEvent.change(cellInput(45, 10), { target: { value: '5.2' } });
        act(() => {
            vi.advanceTimersByTime(1500);
        });
        expect(onSave).toHaveBeenCalledTimes(1);
        const patch = onSave.mock.calls[0][0] as SavedPolar;
        expect(patch.polarSource_type).toBe('manual');
        expect(patch.polarBoatModel).toBe(OCEANIS.model);
        const expected = SCALED.matrix.map((row, a) =>
            row.map((v, w) => (SCALED.angles[a] === 45 && SCALED.windSpeeds[w] === 10 ? 5.2 : v)),
        );
        expect(patch.polarData.matrix).toEqual(expected);

        // What routes sail now: her own figures, at her cruising speed.
        const before = resolveRoutingPolarFrom({ settings: DATABASE, vessel: SLOOP, learned: null });
        const after = resolveRoutingPolarFrom({ settings: { ...DATABASE, ...patch }, vessel: SLOOP, learned: null });
        expect(after.source).toBe('manual');
        expect(polarReferenceKts(after.polar)).toBeCloseTo(polarReferenceKts(before.polar), 1);
        // The page now shows exactly what was saved.
        expect(cellInput(45, 10).value).toBe('5.2');
        expect(cellInput(90, 15).value).toBe(String(cell(SCALED, 90, 15)));
    });

    it('her own figures (imported) are shown as stored, with no scaling note', async () => {
        const imported = { ...DATABASE, polarSource_type: 'file_import' as const, polarBoatModel: 'Fair Wind.pol' };
        render(<PolarManagerTab settings={imported} />);
        await settle();
        expect(chart.data).toEqual(OCEANIS.polar);
        openManual();
        expect(cellInput(90, 15).value).toBe(String(cell(OCEANIS.polar, 90, 15)));
        expect(screen.queryByText(/scaled to her cruising speed/)).toBeNull();
    });

    it('the top line says which polar routes really sail, and is left out when nothing says', async () => {
        render(<PolarManagerTab settings={DATABASE} routesSailOn="Beneteau Oceanis 38.1 (shape scaled to 6.5 kn)" />);
        await settle();
        expect(screen.getByTestId('polars-routes-sail-on').textContent).toBe(
            'Routes sail on: Beneteau Oceanis 38.1 (shape scaled to 6.5 kn)',
        );
        cleanup();
        render(<PolarManagerTab settings={DATABASE} />);
        await settle();
        expect(screen.queryByTestId('polars-routes-sail-on')).toBeNull();
    });
});

describe("'Routing uses: Your polar | Smart' — 'Factory' is gone (130-B6)", () => {
    it('names her polar "Your polar", and choosing it saves the same setting as before', async () => {
        // Some learned samples: the switch shows once there is something to choose.
        for (let i = 0; i < 3; i++) SmartPolarStore.recordSample(10, 90, 6.1);
        const onSave = vi.fn();
        const { container } = render(
            <PolarManagerTab settings={{ ...DATABASE, polarSource: 'smart' }} onSave={onSave} />,
        );
        await settle();
        const yours = await screen.findByRole('button', { name: 'Your polar for routing' });
        expect(yours.textContent).toBe('Your polar');
        expect(yours.getAttribute('aria-pressed')).toBe('false');
        expect(screen.getByRole('button', { name: 'Smart polar data for routing' }).getAttribute('aria-pressed')).toBe(
            'true',
        );
        expect(container.textContent).not.toMatch(/factory/i);
        fireEvent.click(yours);
        expect(onSave).toHaveBeenCalledWith({ polarSource: 'factory' });
        expect(yours.getAttribute('aria-pressed')).toBe('true');
    });
});

describe('PolarPage: the top line is the resolver the passage HUD and Plan Your Day sail on (130-B6)', () => {
    const setSettings = (settings: Record<string, unknown>) =>
        act(() => {
            store.setState({ settings });
        });

    it('a yacht-database polar: "Routes sail on: <model> (shape scaled to <her cruising speed>)"', async () => {
        setSettings(DATABASE);
        render(<PolarPage onBack={vi.fn()} />);
        await settle();
        expect(screen.getByTestId('polars-routes-sail-on').textContent).toBe(
            'Routes sail on: Beneteau Oceanis 38.1 (shape scaled to 6.5 kn)',
        );
    });

    it('routing set to Smart and still learning: it says so, and what she sails on meanwhile', async () => {
        setSettings({ ...DATABASE, polarSource: 'smart', smartPolarsEnabled: true });
        render(<PolarPage onBack={vi.fn()} />);
        await settle();
        await waitFor(() =>
            expect(screen.getByTestId('polars-routes-sail-on').textContent).toBe(
                'Routes sail on: Learning (0 of 63 cells), sailing on Beneteau Oceanis 38.1 (shape scaled to 6.5 kn)',
            ),
        );
    });

    it('after one figure is changed and saved, the line says routes sail her own figures', async () => {
        setSettings(DATABASE);
        render(<PolarPage onBack={vi.fn()} />);
        await settle();
        openManual();
        vi.useFakeTimers();
        fireEvent.change(cellInput(45, 10), { target: { value: '5.2' } });
        act(() => {
            vi.advanceTimersByTime(1500);
        });
        const saved = store.getState().settings as unknown as SavedPolar;
        expect(saved.polarSource_type).toBe('manual');
        expect(cell(saved.polarData, 90, 15)).toBe(cell(SCALED, 90, 15));
        expect(screen.getByTestId('polars-routes-sail-on').textContent).toBe(
            'Routes sail on: Beneteau Oceanis 38.1 (your own figures)',
        );
    });

    it('no polar chosen: the generic polar, as the passage banner says it', async () => {
        setSettings({ vessel: SLOOP });
        render(<PolarPage onBack={vi.fn()} />);
        await settle();
        expect(screen.getByTestId('polars-routes-sail-on').textContent).toBe('Routes sail on: Generic cruising polar');
    });
});
