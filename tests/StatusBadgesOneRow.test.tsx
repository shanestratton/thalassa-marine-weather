/**
 * The Glass status strip is ONE row: location badge · forecast age · model
 * pill — and carries no word about which GPS is in use. Shane, 2026-09-07:
 * "we have no spare real estate to add lines to the page"; 2026-09-08: "remove
 * all of the references to which gps we are using" — the header glyph says
 * boat or phone instead (components/GpsSourceGlyph.tsx).
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { formatAge } from '../components/ui/DataFreshness';

const weather = vi.hoisted(() => ({
    positionSource: null as null | {
        kind: 'bus' | 'pi' | 'cloud' | 'held' | 'phone';
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
const fix = (kind: 'bus' | 'pi' | 'cloud' | 'held' | 'phone', ageMs = 0) => ({
    kind,
    timestamp: Date.now() - ageMs,
    lat: -27.2,
    lon: 153.1,
});

describe('the Glass status strip stays one row and names no receiver', () => {
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
});
