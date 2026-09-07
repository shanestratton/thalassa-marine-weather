/**
 * The Glass status strip is ONE row: location badge · forecast age with the
 * receiver word · model pill.
 *
 * Shane, 2026-09-07, build 103 matrix: "we have no spare real estate to add
 * lines to the page. if you want to put just phone or vessel in between that
 * is fine. but it needs to go back to how it was." The receiver line that
 * build 103 added under the row is gone; VESSEL or PHONE rides with the age.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatAge } from '../components/ui/DataFreshness';

const weather = vi.hoisted(() => ({
    positionSource: null as null | {
        kind: 'bus' | 'pi' | 'held' | 'phone';
        timestamp: number;
        lat: number;
        lon: number;
    },
    open: vi.fn(),
}));

vi.mock('../context/ThemeContext', () => ({ useEnvironment: () => 'offshore' }));
vi.mock('../context/WeatherContext', () => ({
    useWeather: () => ({
        refreshData: vi.fn(),
        loading: false,
        backgroundUpdating: false,
        error: null,
        positionSource: weather.positionSource,
        positionChoice: { prompt: null, open: weather.open, answer: vi.fn() },
    }),
}));
vi.mock('../services/weather/wxPublished', () => ({ listPublishedModels: () => Promise.resolve([]) }));
vi.mock('../components/dashboard/ModelPickerSheet', () => ({ ModelPickerSheet: () => null }));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { StatusBadges } from '../components/dashboard/StatusBadges';

const AGE_MS = 90_000;

const renderStrip = (positionSource: typeof weather.positionSource) => {
    weather.positionSource = positionSource;
    return render(
        <StatusBadges
            isLandlocked={false}
            locationName="Newport"
            displaySource="wx"
            nextUpdate={null}
            locationType="inshore"
            generatedAt={new Date(Date.now() - AGE_MS).toISOString()}
        />,
    );
};

const row = () => screen.getByTestId('glass-status-strip');
const fix = (kind: 'bus' | 'pi' | 'held' | 'phone', ageMs = 0) => ({
    kind,
    timestamp: Date.now() - ageMs,
    lat: -27.2,
    lon: 153.1,
});

describe('the Glass status strip stays one row', () => {
    beforeEach(() => {
        weather.open.mockClear();
    });

    it('phone: badge, age with the word PHONE, model pill — and nothing underneath', () => {
        renderStrip(fix('phone'));
        const strip = row();
        expect(strip.children).toHaveLength(3);
        // The strip is the only child of its wrapper: no second line.
        expect(strip.parentElement!.children).toHaveLength(1);
        expect(strip.textContent).toContain(formatAge(AGE_MS));
        expect(strip.textContent).toContain('PHONE');
        expect(screen.queryByText(/Phone GPS/)).toBeNull();
        expect(screen.queryByRole('button', { name: /tap to change/ })).toBeNull();
        // The full description lives in the accessible name only.
        expect(screen.getByRole('status', { name: /Weather position: Phone GPS/ })).toBeInTheDocument();
    });

    it('held last fix: the word VESSEL, and a tap re-opens the boat-or-phone question', () => {
        renderStrip(fix('held', 3 * 3_600_000));
        const strip = row();
        expect(strip.children).toHaveLength(3);
        expect(strip.parentElement!.children).toHaveLength(1);
        const middle = screen.getByRole('button', { name: /Boat's last fix · 3h ago · tap to change/ });
        expect(middle.textContent).toContain('VESSEL');
        expect(middle.textContent).toContain(formatAge(AGE_MS));
        fireEvent.click(middle);
        expect(weather.open).toHaveBeenCalledTimes(1);
    });

    it('live boat GPS: the word VESSEL, not a button', () => {
        renderStrip(fix('bus'));
        expect(row().textContent).toContain('VESSEL');
        expect(screen.queryByRole('button', { name: /tap to change/ })).toBeNull();
        expect(screen.getByRole('status', { name: /Boat GPS · live/ })).toBeInTheDocument();
    });

    it('no receiver known yet: just the age, as it always was', () => {
        renderStrip(null);
        const strip = row();
        expect(strip.children).toHaveLength(3);
        expect(strip.textContent).toContain(formatAge(AGE_MS));
        expect(strip.textContent).not.toMatch(/PHONE|VESSEL/);
    });
});
