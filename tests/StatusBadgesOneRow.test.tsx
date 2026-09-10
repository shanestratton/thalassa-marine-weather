/**
 * The Glass status strip is ONE row: location badge · forecast age · model
 * pill — and carries no word about which GPS is in use. Shane, 2026-09-07:
 * "we have no spare real estate to add lines to the page"; 2026-09-08: "remove
 * all of the references to which gps we are using" — the header glyph says
 * boat or phone instead (components/GpsSourceGlyph.tsx).
 */
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { formatAge } from '../components/ui/DataFreshness';
import type { WeatherModel } from '../types';
import { SPITFIRE_MODEL } from '../services/weather/forecastModels';

const weather = vi.hoisted(() => ({
    positionSource: null as null | {
        kind: 'bus' | 'pi' | 'cloud' | 'held' | 'phone';
        timestamp: number;
        lat: number;
        lon: number;
    },
    open: vi.fn(),
    loading: false,
    error: null as string | null,
}));
const settings = vi.hoisted(() => ({ forecastModel: 'ecmwf_ifs025' as WeatherModel }));

vi.mock('../context/ThemeContext', () => ({ useEnvironment: () => 'offshore' }));
vi.mock('../context/WeatherContext', () => ({
    useWeather: () => ({
        refreshData: vi.fn(),
        loading: weather.loading,
        backgroundUpdating: false,
        error: weather.error,
        positionSource: weather.positionSource,
        positionChoice: { prompt: null, open: weather.open, answer: vi.fn() },
    }),
}));
vi.mock('../services/weather/wxPublished', () => ({ listPublishedModels: () => Promise.resolve([]) }));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: (select: (state: { settings: typeof settings; updateSettings: typeof vi.fn }) => unknown) =>
        select({ settings, updateSettings: vi.fn() }),
}));
vi.mock('../components/dashboard/ModelPickerSheet', () => ({
    ModelPickerSheet: ({ visible, onClose }: { visible: boolean; onClose: () => void }) =>
        visible ? <button onClick={onClose}>Close model picker</button> : null,
}));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { StatusBadges } from '../components/dashboard/StatusBadges';

const AGE_MS = 90_000;

const renderStrip = (
    positionSource: typeof weather.positionSource,
    props: Partial<React.ComponentProps<typeof StatusBadges>> = {},
) => {
    weather.positionSource = positionSource;
    return render(
        <StatusBadges
            isLandlocked={false}
            locationName="Newport"
            displaySource="wx"
            nextUpdate={null}
            locationType="inshore"
            generatedAt={new Date(Date.now() - AGE_MS).toISOString()}
            {...props}
        />,
    );
};

const row = () => screen.getByTestId('glass-status-strip');
const fix = (kind: 'bus' | 'pi' | 'cloud' | 'held' | 'phone', ageMs = 0) => ({
    kind,
    timestamp: Date.now() - ageMs,
    lat: -27.2,
    lon: 153.1,
});

describe('the Glass status strip stays one row and names no receiver', () => {
    beforeEach(() => {
        settings.forecastModel = 'ecmwf_ifs025';
        weather.loading = false;
        weather.error = null;
    });

    it.each(['phone', 'held', 'bus', 'cloud'] as const)('%s: badge, age, model pill — nothing more', (kind) => {
        renderStrip(fix(kind, kind === 'held' ? 3 * 3_600_000 : 0));
        const strip = row();
        expect(strip.children).toHaveLength(3);
        expect(strip.parentElement!.children).toHaveLength(1);
        expect(strip.textContent).toContain(formatAge(AGE_MS));
        expect(strip.textContent).not.toMatch(/PHONE|VESSEL|Phone GPS|Boat GPS|last fix/);
        expect(screen.queryByRole('button', { name: /tap to change|tap to choose/ })).toBeNull();
    });

    it('no receiver known yet: just the age, as it always was', () => {
        renderStrip(null);
        const strip = row();
        expect(strip.children).toHaveLength(3);
        expect(strip.textContent).toContain(formatAge(AGE_MS));
    });

    it.each(['inshore', 'offshore', 'coastal', 'inland'] as const)(
        '%s: the left pill names only the environment; the right pill names the model',
        (locationType) => {
            renderStrip(null, { locationType });
            const label = locationType.toUpperCase();
            expect(screen.getByRole('status', { name: `Location type: ${label}` })).toHaveTextContent(
                new RegExp(`^${label}$`),
            );
            expect(within(row()).getAllByText('ECMWF')).toHaveLength(1);
            expect(screen.getByRole('button', { name: 'Choose forecast model' })).toHaveTextContent('ECMWF');
        },
    );

    it('an offshore override never puts the model into the location label', () => {
        renderStrip(null, { locationType: 'coastal', isOffshore: true, modelUsed: 'ECMWF IFS' });
        expect(screen.getByRole('status', { name: 'Location type: OFFSHORE' })).toHaveTextContent(/^OFFSHORE$/);
        expect(screen.getByRole('button', { name: 'Choose forecast model — showing ECMWF IFS' })).toHaveAttribute(
            'title',
            'Served by ECMWF IFS',
        );
    });

    it.each([
        ['dwd_icon', 'ICON'],
        ['ecmwf_ifs025', 'ECMWF'],
        ['ecmwf_aifs025_single', 'AIFS'],
        ['ukmo_global_deterministic_10km', 'UKMO'],
        ['jma_gsm', 'JMA'],
        [SPITFIRE_MODEL, 'SPITFIRE'],
        ['best_match', 'AUTO'],
    ] as const)('keeps %s in the right-hand picker', (id, label) => {
        settings.forecastModel = id;
        renderStrip(null, { isOffshore: true });
        const picker = screen.getByRole('button', { name: 'Choose forecast model' });
        expect(picker).toHaveTextContent(new RegExp(`^${label}$`));
        fireEvent.click(picker);
        fireEvent.click(screen.getByRole('button', { name: 'Close model picker' }));
        expect(screen.queryByRole('button', { name: 'Close model picker' })).toBeNull();
    });

    it('retains the stale forecast age and actual refresh failure', () => {
        weather.error = 'Network unavailable';
        renderStrip(null, { isOffshore: true, generatedAt: new Date(Date.now() - 7_200_000).toISOString() });
        expect(screen.getByRole('status', { name: 'Forecast updated 2h ago' })).toHaveTextContent('2h ago');
        const picker = screen.getByRole('button', { name: /Last refresh failed/ });
        expect(picker).toHaveTextContent('ECMWF');
        // The warning replaces the trailing chevron, not the decorative
        // indicator that is hidden in narrow containers. Never colour-only.
        const failureSlot = picker.lastElementChild!;
        expect(failureSlot).toHaveClass('flex', 'w-3', 'h-3');
        expect(failureSlot).not.toHaveClass('hidden');
        expect(failureSlot.querySelector('svg')).not.toBeNull();
    });

    it('keeps the picker on the right even without a forecast timestamp', () => {
        renderStrip(null, { isOffshore: true, generatedAt: undefined });
        expect(row().children).toHaveLength(2);
        expect(screen.queryByRole('status', { name: /Forecast updated/ })).toBeNull();
        expect(screen.getByRole('button', { name: 'Choose forecast model' })).toHaveClass('col-start-3');
    });
});
