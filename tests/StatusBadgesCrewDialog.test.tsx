/**
 * The hold dialog names the boat being followed (Shane 2026-10-05: crew see
 * "the yacht that they are now invited to"). Fictional boats: the account's
 * own 'Kestrel', and 'Wind Dancer', which it crews on.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    target: 'crew' as 'phone' | 'boat' | 'crew',
    crewing: {
        ownerId: 'skipper-wd',
        name: 'Wind Dancer',
        label: 'Wind Dancer',
        inSentence: 'Wind Dancer',
        instruments: true,
    } as null | {
        ownerId: string;
        name: string | null;
        label: string;
        inSentence: string;
        instruments: boolean | null;
    },
}));
const settings = vi.hoisted(() => ({
    forecastModel: 'ecmwf_ifs025',
    offshoreModel: 'ecmwf',
    vessel: { name: 'Kestrel' },
}));

vi.mock('../context/ThemeContext', () => ({ useEnvironment: () => 'offshore' }));
vi.mock('../context/WeatherContext', () => ({
    useWeather: () => ({
        refreshData: vi.fn(),
        loading: false,
        backgroundUpdating: false,
        error: null,
        positionSource: { kind: 'held', timestamp: Date.now() - 3_600_000, target: h.target, status: 'last-known' },
        positionChoice: {
            prompt: { held: { lat: -19.2, lon: 146.8, timestamp: Date.now() - 3_600_000, kind: 'held' }, phone: null },
            open: vi.fn(),
            answer: vi.fn(),
        },
    }),
}));
vi.mock('../hooks/useCrewingBoat', () => ({ useCrewingBoat: () => h.crewing }));
vi.mock('../services/weather/wxPublished', () => ({ listPublishedModels: () => Promise.resolve([]) }));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: (select: (state: { settings: typeof settings; updateSettings: typeof vi.fn }) => unknown) =>
        select({ settings, updateSettings: vi.fn() }),
}));
vi.mock('../components/dashboard/ModelPickerSheet', () => ({ ModelPickerSheet: () => null }));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { StatusBadges } from '../components/dashboard/StatusBadges';

const renderStrip = () =>
    render(
        <StatusBadges
            isLandlocked={false}
            locationName="Magnetic Island"
            displaySource="wx"
            nextUpdate={null}
            locationType="inshore"
            generatedAt={new Date().toISOString()}
        />,
    );

describe('the hold dialog names the boat being followed', () => {
    beforeEach(() => {
        h.target = 'crew';
        h.crewing = {
            ownerId: 'skipper-wd',
            name: 'Wind Dancer',
            label: 'Wind Dancer',
            inSentence: 'Wind Dancer',
            instruments: true,
        };
    });

    it('while the weather follows the boat they crew on, it is hers', () => {
        renderStrip();
        expect(screen.getByRole('dialog')).toHaveTextContent('Wind Dancer last reported her position 1h ago.');
        expect(screen.getByRole('dialog')).not.toHaveTextContent('Kestrel');
    });

    it('while it follows their own boat, it is still their own', () => {
        h.target = 'boat';
        renderStrip();
        expect(screen.getByRole('dialog')).toHaveTextContent('Kestrel last reported her position 1h ago.');
    });
});
