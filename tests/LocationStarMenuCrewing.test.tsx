import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Shane 2026-10-05: "when a punter is invited to another yacht, in the location
 * box, instead of showing their yacht, can it instead show the yacht that they
 * are now invited to" — "maybe it could show both" — and "if they have gps on
 * their boat and on the invited boat, you would need to be able to check both
 * gps postions". So while crewing, the ★ menu lists the boat they crew on
 * first and their own boat below it, each following her own position and
 * showing her own GPS state. Fictional people and boats: crew member
 * 'crew-kim' owns 'Kestrel' and crews on 'Wind Dancer' (skipper 'skipper-wd').
 */
const h = vi.hoisted(() => ({
    settings: {
        defaultLocation: 'Current Location',
        savedLocations: [] as string[],
        savedLocationCoords: {} as Record<string, { lat: number; lon: number }>,
        homePort: undefined as string | undefined,
        vessel: { name: 'Kestrel' } as { name?: string } | undefined,
    },
    updateSettings: vi.fn(),
    selectLocation: vi.fn<() => Promise<void>>(async () => undefined),
    weatherData: { locationName: 'Magnetic Island', coordinates: { lat: -19.15, lon: 146.85 } },
    positionSource: null as null | {
        kind: 'bus' | 'pi' | 'cloud' | 'held' | 'phone' | null;
        timestamp: number;
        target?: 'phone' | 'boat' | 'crew';
        status?: 'live' | 'last-known' | 'unavailable' | 'resolving';
        retainedWeather?: boolean;
    },
    crewing: null as null | {
        ownerId: string;
        name: string | null;
        label: string;
        inSentence: string;
        instruments: boolean | null;
    },
    boatOrHeldFix: vi.fn<
        (now?: number, crewOwnerId?: string | null, options?: { readOnly?: boolean }) => Promise<unknown>
    >(async () => null),
}));

vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({ settings: h.settings, updateSettings: h.updateSettings }),
}));
vi.mock('../context/WeatherContext', () => ({
    useWeather: () => ({
        weatherData: h.weatherData,
        selectLocation: h.selectLocation,
        positionSource: h.positionSource,
    }),
}));
vi.mock('../hooks/useCrewingBoat', () => ({ useCrewingBoat: () => h.crewing }));
vi.mock('../services/weatherPosition', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/weatherPosition')>()),
    boatOrHeldFix: h.boatOrHeldFix,
}));
vi.mock('../components/Toast', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { LocationStarMenu } from '../components/LocationStarMenu';
import {
    getWeatherFollowCrewOwner,
    getWeatherFollowTarget,
    setWeatherFollowTarget,
    __resetWeatherPositionForTests,
} from '../services/weatherPosition';
import { authScopedStorageKey, setAuthIdentityScope } from '../services/authIdentityScope';

const SKIPPER = 'skipper-wd';
const WIND_DANCER = {
    ownerId: SKIPPER,
    name: 'Wind Dancer',
    label: 'Wind Dancer',
    inSentence: 'Wind Dancer',
    instruments: true,
};
const HELD = { lat: -19.2, lon: 146.8, timestamp: 1, kind: 'held', rung: 'cloud' };
const LIVE = { lat: -19.1, lon: 147.6, timestamp: 1, kind: 'cloud', rung: 'cloud' };

const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Saved locations' }));
const rowTexts = () => screen.getAllByRole('menuitem').map((el) => el.textContent ?? '');

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setAuthIdentityScope('crew-kim');
    __resetWeatherPositionForTests();
    h.settings.vessel = { name: 'Kestrel' };
    h.settings.defaultLocation = 'Current Location';
    h.crewing = { ...WIND_DANCER };
    h.positionSource = null;
    h.selectLocation.mockResolvedValue(undefined);
    // Unanswered unless a test answers it, so nothing settles after a test ends.
    h.boatOrHeldFix.mockReturnValue(new Promise(() => undefined));
});

describe('★ menu while crewing — both boats, each with her own GPS', () => {
    it('not crewing: the rows are exactly as they were, and nothing is asked on open', () => {
        h.crewing = null;
        render(<LocationStarMenu />);
        openMenu();
        expect(screen.queryByTestId('location-star-crew')).toBeNull();
        expect(screen.getByTestId('location-star-vessel')).toHaveTextContent('KestrelBoat');
        expect(rowTexts().findIndex((t) => t.includes('Kestrel'))).toBeLessThan(
            rowTexts().findIndex((t) => t.includes('Current Location')),
        );
        expect(h.boatOrHeldFix).not.toHaveBeenCalled();
    });

    it('crewing: the boat they crew on first, then their own, then the phone', () => {
        render(<LocationStarMenu />);
        openMenu();
        const rows = rowTexts();
        const crew = rows.findIndex((t) => t.includes('Wind Dancer'));
        const own = rows.findIndex((t) => t.includes('Kestrel'));
        const phone = rows.findIndex((t) => t.includes('Current Location'));
        expect(crew).toBe(0);
        expect(own).toBe(1);
        expect(phone).toBe(2);
        expect(screen.getByTestId('location-star-crew')).toHaveTextContent('Wind DancerCrewing');
        expect(screen.getByTestId('location-star-vessel')).toHaveTextContent('KestrelYour boat');
    });

    it('their own row is left out when she has no name, unless she is the one followed', () => {
        h.settings.vessel = { name: '' };
        const { unmount } = render(<LocationStarMenu />);
        openMenu();
        expect(screen.getByTestId('location-star-crew')).toBeInTheDocument();
        expect(screen.queryByTestId('location-star-vessel')).toBeNull();
        unmount();

        setWeatherFollowTarget('boat');
        render(<LocationStarMenu />);
        openMenu();
        // The tick never vanishes with its row.
        expect(screen.getByTestId('location-star-vessel')).toHaveAttribute('aria-current', 'location');
    });

    it('picking the boat they crew on follows her, and remembers where to go when the crewing ends', async () => {
        render(<LocationStarMenu />);
        openMenu();
        fireEvent.click(screen.getByTestId('location-star-crew'));
        await waitFor(() => expect(h.selectLocation).toHaveBeenCalledWith('Current Location'));
        expect(getWeatherFollowTarget()).toBe('crew');
        expect(getWeatherFollowCrewOwner()).toBe(SKIPPER);
        expect(JSON.parse(localStorage.getItem(authScopedStorageKey('thalassa_weather_follow_crew')) ?? '{}')).toEqual({
            ownerId: SKIPPER,
            fallback: 'boat',
        });
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();

        // No boat of their own: the phone, once the crewing ends.
        h.settings.vessel = { name: '' };
        openMenu();
        fireEvent.click(screen.getByTestId('location-star-crew'));
        expect(JSON.parse(localStorage.getItem(authScopedStorageKey('thalassa_weather_follow_crew')) ?? '{}')).toEqual({
            ownerId: SKIPPER,
            fallback: 'phone',
        });
    });

    it('each row follows her own boat: the followed one from the weather, the other asked when the menu opens', async () => {
        setWeatherFollowTarget('crew', { ownerId: SKIPPER, fallback: 'boat' });
        h.boatOrHeldFix.mockImplementation(async (_now, owner) => (owner === null ? HELD : LIVE));
        render(<LocationStarMenu />);
        openMenu();
        const crew = screen.getByTestId('location-star-crew');
        expect(crew).toHaveAttribute('aria-current', 'location');
        expect(h.boatOrHeldFix).toHaveBeenCalledTimes(1);
        // A look, not a follow: nothing is kept from it.
        expect(h.boatOrHeldFix).toHaveBeenCalledWith(expect.any(Number), null, { readOnly: true });
        const own = await screen.findByRole('menuitem', { name: 'Kestrel Your boat, no live fix, last position' });
        expect(within(own).getByText('No live fix · last position')).toHaveAttribute('aria-hidden', 'true');
        expect(own).not.toHaveAttribute('aria-current');
        // The followed boat's own answer is the weather's: live, so no note.
        expect(crew).toHaveAccessibleName('Wind Dancer Crewing');
    });

    it('following their own boat, the boat they crew on is the one asked', async () => {
        setWeatherFollowTarget('boat');
        h.boatOrHeldFix.mockResolvedValue(LIVE);
        render(<LocationStarMenu />);
        openMenu();
        expect(screen.getByTestId('location-star-vessel')).toHaveAttribute('aria-current', 'location');
        await waitFor(() =>
            expect(h.boatOrHeldFix).toHaveBeenCalledWith(expect.any(Number), SKIPPER, { readOnly: true }),
        );
        expect(h.boatOrHeldFix).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId('location-star-crew')).toHaveAccessibleName('Wind Dancer Crewing');
    });

    it('no position and the Instrument Panel not shared: ask the skipper', async () => {
        h.crewing = { ...WIND_DANCER, instruments: false };
        h.boatOrHeldFix.mockResolvedValue(null);
        render(<LocationStarMenu />);
        openMenu();
        const crew = await screen.findByRole('menuitem', {
            name: 'Wind Dancer Crewing, no live fix, ask your skipper to share the Instrument Panel',
        });
        expect(within(crew).getByText('Ask your skipper to share the Instrument Panel')).toHaveClass('text-amber-400');
    });

    it('no position and the share not known (or shared): says so plainly', async () => {
        h.crewing = { ...WIND_DANCER, instruments: null };
        h.boatOrHeldFix.mockResolvedValue(null);
        render(<LocationStarMenu />);
        openMenu();
        const crew = await screen.findByRole('menuitem', {
            name: 'Wind Dancer Crewing, no position from Wind Dancer yet',
        });
        expect(within(crew).getByText('No position from Wind Dancer yet')).toBeInTheDocument();
        expect(screen.queryByText(/Ask your skipper/)).toBeNull();
    });

    it('the followed crewed boat with no live fix carries the amber tick and the held words', () => {
        setWeatherFollowTarget('crew', { ownerId: SKIPPER, fallback: 'boat' });
        h.positionSource = { kind: null, timestamp: 1, target: 'crew', status: 'unavailable', retainedWeather: true };
        render(<LocationStarMenu />);
        openMenu();
        const crew = screen.getByRole('menuitem', {
            name: 'Wind Dancer Crewing, GPS unavailable, showing last location',
        });
        expect(crew).toHaveAttribute('aria-current', 'location');
        expect(crew.querySelector('svg.text-amber-400')).not.toBeNull();
        expect(within(crew).getByText('No live fix · last position')).toHaveAttribute('aria-hidden', 'true');
        // The own boat's row is not the one held.
        expect(screen.getByTestId('location-star-vessel')).not.toHaveTextContent(/showing last location/);
    });

    it('keyboard: the boat they crew on takes focus first and Escape restores the trigger', () => {
        render(<LocationStarMenu />);
        const trigger = screen.getByRole('button', { name: 'Saved locations' });
        fireEvent.click(trigger);
        const crew = screen.getByTestId('location-star-crew');
        expect(crew).toHaveFocus();
        fireEvent.keyDown(crew, { key: 'ArrowDown' });
        expect(screen.getByTestId('location-star-vessel')).toHaveFocus();
        fireEvent.keyDown(screen.getByTestId('location-star-vessel'), { key: 'Escape' });
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
    });
});
