/**
 * 'Auto with night' (131-03): a new display mode that is Auto by day and the
 * red Night from nautical dusk to dawn at the forecast location, with
 * hysteresis at the boundary and an honest word in a polar summer. It is the
 * default for new installs only; the old Auto is untouched.
 *
 * Fixtures are SunCalc's own nautical twilight for the place (see
 * tests/celestial.test.ts for the USNO checks of the same model): Newport,
 * Brisbane on 7 Oct 2026 has nautical dusk 18:42 and dawn 04:31; Bergen on
 * 5 May 2026 has its nautical dusk at 00:23 the next morning.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFirstLight, getLastLight, sunAltitudeDeg } from '../utils/celestial';
import { NIGHT_HYSTERESIS_MS, nightWindow } from '../utils/nightWindow';
import { useAutoNight, useAutoNightShown } from '../hooks/useAutoNight';
import { DisplayModeSection } from '../components/settings/AestheticsTab';
import { DisplayPrefsStep } from '../components/onboarding/DisplayPrefsStep';
import { DEFAULT_SETTINGS, mergeSettings } from '../stores/settingsStore';
import type { UserSettings } from '../types';

const MIN = 60_000;
const BNE = { lat: -27.21, lon: 153.09 };
const BNE_TZ = 'Australia/Brisbane';
const bneNoon = new Date('2026-10-07T12:00:00+10:00');
const bneDusk = getLastLight(bneNoon, BNE.lat, BNE.lon, BNE_TZ, 'nautical').at!.getTime();
const bneDawn = getFirstLight(
    new Date('2026-10-08T12:00:00+10:00'),
    BNE.lat,
    BNE.lon,
    BNE_TZ,
    'nautical',
).at!.getTime();
const bne = (ms: number, was: boolean | null = null) => nightWindow(ms, BNE.lat, BNE.lon, BNE_TZ, was);

afterEach(() => {
    vi.useRealTimers();
});

describe('the night window: nautical dusk to dawn at the location', () => {
    it('is night from nautical dusk to the next nautical dawn, and day either side', () => {
        expect(new Date(bneDusk).toLocaleTimeString('en-GB', { timeZone: BNE_TZ })).toMatch(/^18:4\d/);
        expect(bne(new Date('2026-10-07T15:00:00+10:00').getTime())).toEqual({ night: false, state: 'normal' });
        expect(bne(bneDusk - 10 * MIN).night).toBe(false);
        expect(bne(bneDusk + 10 * MIN).night).toBe(true);
        expect(bne(new Date('2026-10-07T23:30:00+10:00').getTime()).night).toBe(true);
        // After midnight the same night runs on to this morning's dawn.
        expect(bne(new Date('2026-10-08T02:00:00+10:00').getTime()).night).toBe(true);
        expect(bne(bneDawn - 10 * MIN).night).toBe(true);
        expect(bne(bneDawn + 10 * MIN).night).toBe(false);
    });

    it('reads the location’s own day, not the phone’s', () => {
        // 23:30 in Brisbane is 15:30 in Paris: the same instant, red at one, day at the other.
        const at = new Date('2026-10-07T23:30:00+10:00').getTime();
        expect(bne(at).night).toBe(true);
        expect(nightWindow(at, 43.3, 5.37, 'Europe/Paris').night).toBe(false);
    });

    it('a dusk that falls after midnight on the clock is still twilight until it comes', () => {
        const bergen = { lat: 60.39, lon: 5.32, tz: 'Europe/Oslo' };
        const dusk = getLastLight(
            new Date('2026-05-05T12:00:00+02:00'),
            bergen.lat,
            bergen.lon,
            bergen.tz,
            'nautical',
        ).at!.getTime();
        // The dusk belongs to 5 May but lands after midnight, on 6 May's clock.
        expect(new Date(dusk).toISOString() > '2026-05-05T22:00:00.000Z').toBe(true);
        const at = (ms: number) => nightWindow(ms, bergen.lat, bergen.lon, bergen.tz).night;
        // Already 6 May, before that dusk: today's dawn alone would have called it night.
        expect(at(dusk - 12 * MIN)).toBe(false);
        expect(at(dusk + 12 * MIN)).toBe(true);
    });

    it('in a polar summer there is no true night: never red, and it says why', () => {
        // Copenhagen at midsummer: the sun's lowest is 10.9° down, never the 12° of nautical dusk.
        for (const hour of ['00:30', '12:00', '23:45']) {
            const at = new Date(`2026-06-21T${hour}:00+02:00`).getTime();
            expect(nightWindow(at, 55.68, 12.57, 'Europe/Copenhagen')).toEqual({
                night: false,
                state: 'no-true-night',
            });
        }
    });

    it('in a polar winter where the sun stays 12° down all day, it is night all day', () => {
        const at = new Date('2026-12-21T12:00:00+01:00').getTime();
        expect(nightWindow(at, 81, 15, 'Arctic/Longyearbyen')).toEqual({ night: true, state: 'stays-dark' });
    });

    // 131-03 review: either side of the dark days one night has only one end.
    // Ny-Ålesund (79°N) has its last nautical light on 11 Dec 2026, for about
    // half an hour at midday, and its first again on 2 Jan 2027. Both nights
    // used to be left out: plain dark, the sun 12° to 34° down.
    it('runs on into the dark days from the last dusk, and out of them to the first dawn', () => {
        const ny = { lat: 79, lon: 11.9, tz: 'Arctic/Longyearbyen' };
        const at = (iso: string) => nightWindow(Date.parse(iso), ny.lat, ny.lon, ny.tz);
        // The evening of the last day with light, and the small hours of the first.
        expect(at('2026-12-11T18:00:00+01:00')).toEqual({ night: true, state: 'normal' });
        expect(at('2027-01-02T03:00:00+01:00')).toEqual({ night: true, state: 'normal' });
        // Their half hour of nautical light is still day.
        expect(at('2026-12-11T12:10:00+01:00').night).toBe(false);
        expect(at('2027-01-02T12:20:00+01:00').night).toBe(false);
        // And across both edges, every five minutes, as the clock would carry it:
        // red whenever the sun is clear of the line below (it grazes the line
        // for an hour or more here, so the band either side is left to the edges).
        for (const from of ['2026-12-09T00:00:00+01:00', '2026-12-31T00:00:00+01:00']) {
            let was: boolean | null = null;
            const start = Date.parse(from);
            for (let ms = start; ms < start + 4 * 24 * 60 * MIN; ms += 5 * MIN) {
                was = nightWindow(ms, ny.lat, ny.lon, ny.tz, was).night;
                if (sunAltitudeDeg(new Date(ms), ny.lat, ny.lon) < -12.5) {
                    expect(was, new Date(ms).toISOString()).toBe(true);
                }
            }
        }
    });
});

describe('hysteresis at dusk and dawn', () => {
    it('holds the last answer within five minutes of a boundary, then follows the sky', () => {
        expect(NIGHT_HYSTERESIS_MS).toBe(5 * MIN);
        // First look: the sky decides.
        expect(bne(bneDusk + 2 * MIN, null).night).toBe(true);
        // Coming from day, two minutes past dusk is still day; six minutes past is night.
        expect(bne(bneDusk + 2 * MIN, false).night).toBe(false);
        expect(bne(bneDusk + 6 * MIN, false).night).toBe(true);
        // Coming from night, just past dawn stays red; six minutes past is day.
        expect(bne(bneDawn + 2 * MIN, true).night).toBe(true);
        expect(bne(bneDawn + 6 * MIN, true).night).toBe(false);
        // Outside the band the last answer has no say.
        expect(bne(bneDusk - 30 * MIN, true).night).toBe(false);
    });

    it('a position wandering across dusk turns red once and stays red', () => {
        // A fix that hops ~1 km east and west moves dusk by seconds either way.
        let night: boolean | null = false;
        const answers: boolean[] = [];
        for (let i = -6; i <= 12; i++) {
            const lon = BNE.lon + (i % 2 === 0 ? 0.01 : -0.01);
            night = nightWindow(bneDusk + i * 30_000, BNE.lat, lon, BNE_TZ, night).night;
            answers.push(night);
        }
        const flips = answers.filter((v, i) => i > 0 && v !== answers[i - 1]).length;
        expect(flips).toBe(1);
        expect(answers.at(-1)).toBe(true);
    });
});

describe('useAutoNight — the clock behind the mode', () => {
    it('reads nothing while the mode is off, so Auto and the fixed modes are as they were', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-07T23:00:00+10:00'));
        const { result } = renderHook(() => ({ read: useAutoNight(false, BNE, BNE_TZ), shown: useAutoNightShown() }));
        expect(result.current.read).toBeNull();
        expect(result.current.shown).toBeNull();
    });

    it('answers in the first render: no lit frame at 2 am while it catches up', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-08T02:00:00+10:00'));
        let first: unknown;
        renderHook(() => {
            const read = useAutoNight(true, BNE, BNE_TZ);
            first ??= read;
            return read;
        });
        expect(first).toEqual({ night: true, state: 'normal' });
    });

    it('turns red past nautical dusk, held by the hysteresis, re-reading every minute', () => {
        vi.useFakeTimers();
        vi.setSystemTime(bneDusk - 3 * MIN);
        const { result } = renderHook(() => useAutoNight(true, BNE, BNE_TZ));
        expect(result.current?.night).toBe(false);
        act(() => vi.advanceTimersByTime(4 * MIN)); // one minute past dusk: held
        expect(result.current?.night).toBe(false);
        act(() => vi.advanceTimersByTime(5 * MIN)); // six past: red
        expect(result.current?.night).toBe(true);
    });

    it('re-reads the moment the app is back on screen: a phone that slept through dusk wakes up red', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-07T16:00:00+10:00'));
        const { result } = renderHook(() => useAutoNight(true, BNE, BNE_TZ));
        expect(result.current?.night).toBe(false);
        vi.setSystemTime(new Date('2026-10-07T22:00:00+10:00')); // asleep: no timer ran
        act(() => {
            document.dispatchEvent(new Event('visibilitychange'));
        });
        expect(result.current?.night).toBe(true);
    });

    it('does not re-render its host while the answer stands', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-07T13:00:00+10:00'));
        let renders = 0;
        renderHook(() => {
            renders++;
            return useAutoNight(true, BNE, BNE_TZ);
        });
        const before = renders;
        act(() => vi.advanceTimersByTime(30 * MIN));
        expect(renders).toBe(before);
    });

    it('has no answer without a real position (none yet, or the 0,0 cold-start stub)', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-07T23:00:00+10:00'));
        expect(renderHook(() => useAutoNight(true, undefined, BNE_TZ)).result.current).toBeNull();
        expect(renderHook(() => useAutoNight(true, { lat: 0, lon: 0 }, BNE_TZ)).result.current).toBeNull();
    });

    it('reads a new place at once, in that render', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-07T23:30:00+10:00'));
        const { result, rerender } = renderHook(({ place, tz }) => useAutoNight(true, place, tz), {
            initialProps: { place: BNE as { lat: number; lon: number }, tz: BNE_TZ },
        });
        expect(result.current?.night).toBe(true);
        rerender({ place: { lat: 43.3, lon: 5.37 }, tz: 'Europe/Paris' });
        expect(result.current?.night).toBe(false);
    });

    it('shares its answer with Settings, and takes it back when it goes', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-21T23:45:00+02:00'));
        const { result, unmount } = renderHook(() => ({
            read: useAutoNight(true, { lat: 55.68, lon: 12.57 }, 'Europe/Copenhagen'),
            shown: useAutoNightShown(),
        }));
        expect(result.current.shown).toEqual({ night: false, state: 'no-true-night' });
        expect(result.current.shown).toBe(result.current.read);
        unmount();
        expect(renderHook(() => useAutoNightShown()).result.current).toBeNull();
    });
});

function settingsFor(displayMode: UserSettings['displayMode']): UserSettings {
    return { ...DEFAULT_SETTINGS, displayMode };
}

describe('Settings → Display mode offers Auto + night', () => {
    it('a fifth tile, under Auto, saves the new mode', () => {
        const onSave = vi.fn();
        render(<DisplayModeSection settings={settingsFor('dark')} onSave={onSave} />);
        const tiles = screen.getAllByRole('button', { name: /display mode/ });
        expect(tiles.map((t) => t.getAttribute('aria-label'))).toEqual([
            'Light display mode — Daytime',
            'Dark display mode — Low glare',
            'Night display mode — Red tint',
            'Auto display mode — By the sun',
            'Auto + night display mode — Red at night',
        ]);
        fireEvent.click(screen.getByRole('button', { name: /^Auto \+ night display mode/ }));
        expect(onSave).toHaveBeenCalledWith({ displayMode: 'auto-night' });
        // The intro says what each auto does.
        expect(screen.getByText(/Auto \+ night also goes red from nautical dusk to dawn/)).toBeInTheDocument();
    });

    it('leaves Auto as it was: its own tile, its own value', () => {
        const onSave = vi.fn();
        render(<DisplayModeSection settings={settingsFor('auto')} onSave={onSave} />);
        expect(screen.getByRole('button', { name: /^Auto display mode/ })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('button', { name: /^Auto \+ night display mode/ })).toHaveAttribute(
            'aria-pressed',
            'false',
        );
        fireEvent.click(screen.getByRole('button', { name: /^Auto display mode/ }));
        expect(onSave).toHaveBeenCalledWith({ displayMode: 'auto' });
        expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('in a polar summer it says there is no true night', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-21T23:45:00+02:00'));
        const { unmount } = renderHook(() => useAutoNight(true, { lat: 55.68, lon: 12.57 }, 'Europe/Copenhagen'));
        render(<DisplayModeSection settings={settingsFor('auto-night')} onSave={vi.fn()} />);
        expect(screen.getByRole('status')).toHaveTextContent(/No true night here at this time of year/);
        unmount();
    });

    it('in a polar winter it says it stays red', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-12-21T12:00:00+01:00'));
        const { unmount } = renderHook(() => useAutoNight(true, { lat: 81, lon: 15 }, 'Arctic/Longyearbyen'));
        render(<DisplayModeSection settings={settingsFor('auto-night')} onSave={vi.fn()} />);
        expect(screen.getByRole('status')).toHaveTextContent(/stays more than 12° down all day here, so it stays red/);
        unmount();
    });

    it('with no position yet it says it works like Auto until it has one', () => {
        render(<DisplayModeSection settings={settingsFor('auto-night')} onSave={vi.fn()} />);
        expect(screen.getByRole('status')).toHaveTextContent(/Needs a position to know when night falls/);
    });

    it('says nothing extra on an ordinary dusk-to-dawn', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-07T15:00:00+10:00'));
        const { unmount } = renderHook(() => useAutoNight(true, BNE, BNE_TZ));
        render(<DisplayModeSection settings={settingsFor('auto-night')} onSave={vi.fn()} />);
        expect(screen.queryByRole('status')).not.toBeInTheDocument();
        unmount();
    });
});

describe('the default, for new installs only', () => {
    it('a new install starts on Auto + night', () => {
        expect(DEFAULT_SETTINGS.displayMode).toBe('auto-night');
        expect(readFileSync('components/OnboardingWizard.tsx', 'utf8')).toContain(
            "useState<DisplayMode>('auto-night')",
        );
    });

    it('an existing install keeps its own mode, and a saved blob without one keeps the old dark', () => {
        for (const mode of ['light', 'dark', 'night', 'auto'] as const) {
            expect(mergeSettings({ displayMode: mode }).displayMode).toBe(mode);
        }
        expect(mergeSettings({ firstName: 'Shane' }).displayMode).toBe('dark');
        expect(mergeSettings({ displayMode: 'auto-night' }).displayMode).toBe('auto-night');
    });

    it('onboarding offers it, picked and marked as the recommendation', () => {
        const onChange = vi.fn();
        render(
            <DisplayPrefsStep
                prefAlwaysOn={false}
                onAlwaysOnChange={vi.fn()}
                prefOrientation="portrait"
                onOrientationChange={vi.fn()}
                prefDisplayMode="auto-night"
                onDisplayModeChange={onChange}
                onFinish={vi.fn()}
            />,
        );
        const tile = screen.getByRole('button', { name: 'Display mode Auto + night' });
        expect(tile).toHaveAttribute('aria-pressed', 'true');
        expect(tile).toHaveTextContent('Red at night');
        // Dark is no longer called the default, and Auto goes by the sun, not the phone.
        expect(screen.getByRole('button', { name: 'Display mode Dark' })).not.toHaveTextContent('Default');
        expect(screen.getByRole('button', { name: 'Display mode Auto' })).toHaveTextContent('By the sun');
        fireEvent.click(screen.getByRole('button', { name: 'Display mode Auto' }));
        expect(onChange).toHaveBeenCalledWith('auto');
    });
});

// The map side is wired, not re-derived: App's one nightMode (its resolved
// mode) paints the relief's night palette, and in this mode it also drives
// the ENC night dim. tests/AutoWithNightChartDim131.test.ts covers the dim.
function source(path: string) {
    return readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
}

describe('the chart follows it', () => {
    it('drives the relief night palette through App’s resolved mode', () => {
        expect(source('App.tsx')).toMatch(/nightMode=\{effectiveMode === 'night'\}/);
        expect(source('components/map/MapHub.tsx')).toMatch(/setReliefPalette\(\s*map,\s*nightMode \? 'night'/);
    });

    it('drives the ENC night dim only in this mode', () => {
        expect(source('components/map/MapHub.tsx')).toMatch(
            /useTideDepthMode\(\s*mapRef,\s*mapReady,\s*planningSurface,\s*nightMode && settings\.displayMode === 'auto-night',/,
        );
    });
});
