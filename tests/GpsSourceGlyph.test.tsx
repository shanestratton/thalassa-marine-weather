/**
 * The header glyph: a boat or a phone with a GPS dot, and no words on the
 * page (Shane 2026-09-08). The sentence lives only in the accessible name;
 * a held last fix makes the glyph a button that re-opens the boat-or-phone
 * question.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const world = vi.hoisted(() => ({
    weather: null as null | {
        positionSource: {
            kind: string | null;
            target?: 'phone' | 'boat';
            status?: 'live' | 'last-known' | 'unavailable' | 'resolving';
            timestamp?: number;
            retainedWeather?: boolean;
        } | null;
        positionChoice: { open: () => void } | null;
    },
    link: { status: 'disconnected', remote: null } as { status: string; remote: { via: 'lan' | 'cloud' } | null },
    open: vi.fn(),
}));
vi.mock('../context/WeatherContext', () => ({ useWeatherOptional: () => world.weather }));
vi.mock('../components/nmea/useNmeaStore', () => ({ useNmeaConnectionStatus: () => world.link }));

import { GpsSourceGlyph, GpsSourceRow, resolveGpsSourceState } from '../components/GpsSourceGlyph';
import { weatherLocationTitle } from '../utils/weatherLocationTitle';
import { useSettingsStore } from '../stores/settingsStore';

describe('resolveGpsSourceState', () => {
    const at = (weatherKind: any, storeStatus: any = 'disconnected', remoteVia: any = null) =>
        resolveGpsSourceState({ weatherKind, storeStatus, remoteVia });

    it('the selected weather receiver wins over unrelated instrument connectivity', () => {
        expect(at(null, 'connected')).toMatchObject({ glyph: 'none', tone: 'none' });
        expect(at('phone', 'remote', 'lan')).toMatchObject({ glyph: 'phone', tone: 'phone' });
        expect(at('phone', 'remote', 'cloud')).toMatchObject({ glyph: 'phone', tone: 'phone' });
        expect(at('bus')).toMatchObject({ glyph: 'boat', tone: 'live' });
        expect(at('pi')).toMatchObject({ glyph: 'boat', tone: 'live' });
    });

    it('the boat through the cloud is a boat with a sky dot', () => {
        expect(at('cloud')).toMatchObject({ glyph: 'boat', tone: 'cloud' });
        expect(at(null, 'remote', 'cloud')).toMatchObject({ glyph: 'none', tone: 'none' });
    });

    it('her held last fix is a boat with an amber dot, and can be changed', () => {
        expect(at('held')).toMatchObject({ glyph: 'boat', tone: 'held', canChoose: true });
        expect(at('held').label).toContain('tap to choose');
    });

    it('a chosen place names the place and says GPS is not in use', () => {
        const state = resolveGpsSourceState({
            weatherKind: null,
            storeStatus: 'disconnected',
            remoteVia: null,
            hasWeatherContext: true,
            chosenPlace: 'Gladstone',
        });
        expect(state).toMatchObject({ glyph: 'none', tone: 'none', canChoose: false });
        expect(state.label).toBe('Position: Gladstone (chosen place) — GPS not in use');
    });

    it('the phone is a phone; nothing yet is neither', () => {
        expect(at('phone')).toMatchObject({ glyph: 'phone', tone: 'phone', canChoose: false });
        expect(at(null)).toMatchObject({ glyph: 'none', tone: 'none' });
    });

    it('unavailable boat weather never becomes live just because instruments are connected', () => {
        expect(
            resolveGpsSourceState({
                weatherKind: null,
                target: 'boat',
                status: 'unavailable',
                storeStatus: 'connected',
                remoteVia: null,
            }),
        ).toMatchObject({
            glyph: 'boat',
            tone: 'none',
            label: 'Position: the boat isn’t giving a position.',
        });
    });

    it.each(['boat', 'phone'] as const)('a pending %s selection is neither unavailable nor live', (target) => {
        const state = resolveGpsSourceState({
            weatherKind: null,
            target,
            status: 'resolving',
            storeStatus: 'remote',
            remoteVia: 'lan',
            timestamp: 0,
        });
        expect(state).toMatchObject({ glyph: target, tone: 'none', canChoose: false });
        expect(state.label).toBe(`Position: finding ${target === 'boat' ? 'the boat’s' : 'this phone’s'} GPS location`);
        expect(state.label).not.toMatch(/unavailable|live|last fix/);
    });

    it('an older phone fix is explicitly last-known and carries its age', () => {
        expect(
            resolveGpsSourceState({
                weatherKind: 'phone',
                target: 'phone',
                status: 'last-known',
                timestamp: Date.now() - 300_000,
                storeStatus: 'remote',
                remoteVia: 'cloud',
            }),
        ).toMatchObject({
            glyph: 'phone',
            tone: 'held',
            label: 'Position: this phone’s last fix · 5 min ago',
        });
    });

    // UX referee run 8 (gps-one-truth): 'GPS unavailable — showing forecast
    // for the last location · fix just now' had no verb, and its 'fix just
    // now' read as a fresh fix. The row now says the receiver isn't giving a
    // position and dates the FORECAST; the fix's age is the card's line.
    it.each(['phone', 'boat'] as const)(
        'retained %s weather says the receiver is not giving a position and dates the forecast, not a fix',
        (target) => {
            const now = Date.now();
            const result = resolveGpsSourceState({
                weatherKind: target === 'phone' ? 'phone' : 'pi',
                target,
                status: 'unavailable',
                retainedWeather: true,
                timestamp: now - 300_000,
                forecastUpdatedAt: now - 20_000,
                storeStatus: 'remote',
                remoteVia: 'lan',
                now,
            });
            expect(result).toMatchObject({ glyph: target, tone: 'none', canChoose: false });
            expect(result.label).toBe(
                `Position: ${target === 'phone' ? 'this phone' : 'the boat'} isn’t giving a position. Showing the forecast for your last location (updated just now).`,
            );
            expect(result.label).not.toMatch(/live|fix/);
        },
    );

    it.each([undefined, null, 0, Number.NaN, Number.POSITIVE_INFINITY, Date.now() + 60_000])(
        'does not invent an update time for an invalid forecast time (%s)',
        (forecastUpdatedAt) => {
            expect(
                resolveGpsSourceState({
                    weatherKind: 'phone',
                    target: 'phone',
                    status: 'unavailable',
                    retainedWeather: true,
                    timestamp: Date.now() - 300_000,
                    forecastUpdatedAt,
                    storeStatus: 'connected',
                    remoteVia: null,
                }).label,
            ).toBe('Position: this phone isn’t giving a position. Showing the forecast for your last location.');
        },
    );
});

describe('<GpsSourceGlyph />', () => {
    it('renders a phone as an image with the sentence only in its accessible name', () => {
        world.weather = { positionSource: { kind: 'phone' }, positionChoice: { open: world.open } };
        world.link = { status: 'disconnected', remote: null };
        render(<GpsSourceGlyph />);
        const glyph = screen.getByTestId('gps-source-glyph');
        expect(glyph.getAttribute('data-glyph')).toBe('phone');
        expect(glyph.getAttribute('role')).toBe('img');
        expect(glyph.textContent).toBe('');
        expect(screen.getByRole('img', { name: /this phone’s GPS/ })).toBeInTheDocument();
    });

    it('a held fix is a button that re-opens the boat-or-phone question', () => {
        world.weather = { positionSource: { kind: 'held' }, positionChoice: { open: world.open } };
        world.link = { status: 'disconnected', remote: null };
        render(<GpsSourceGlyph />);
        const button = screen.getByRole('button', { name: /tap to choose the boat or this phone/ });
        expect(button.getAttribute('data-glyph')).toBe('boat');
        expect(button.getAttribute('data-tone')).toBe('held');
        fireEvent.click(button);
        expect(world.open).toHaveBeenCalledTimes(1);
    });

    it('works outside the weather provider, off the instrument store alone', () => {
        world.weather = null;
        world.link = { status: 'remote', remote: { via: 'lan' } };
        render(<GpsSourceGlyph />);
        expect(screen.getByTestId('gps-source-glyph').getAttribute('data-tone')).toBe('live');
    });
});

describe('<GpsSourceRow /> — the System Status panel row', () => {
    it('shows the glyph with the sentence beside it, minus the "Position:" prefix', () => {
        world.weather = { positionSource: { kind: 'cloud' }, positionChoice: null };
        world.link = { status: 'disconnected', remote: null };
        render(<GpsSourceRow />);
        const row = screen.getByTestId('gps-source-row');
        expect(row.getAttribute('data-glyph')).toBe('boat');
        expect(row.getAttribute('data-tone')).toBe('cloud');
        expect(screen.getByText('Position')).toBeInTheDocument();
        // Capitalised like the rows beside it ('Not tracking', 'Not deployed').
        expect(screen.getByText('The boat’s GPS, through the cloud')).toBeInTheDocument();
    });

    it('explains retained weather without treating a connected Pi as live phone GPS', () => {
        world.weather = {
            positionSource: {
                kind: 'phone',
                target: 'phone',
                status: 'unavailable',
                retainedWeather: true,
                timestamp: Date.now() - 300_000,
            },
            positionChoice: null,
            weatherData: { generatedAt: new Date(Date.now() - 300_000).toISOString() },
        } as unknown as typeof world.weather;
        world.link = { status: 'remote', remote: { via: 'lan' } };
        render(<GpsSourceRow />);
        const row = screen.getByTestId('gps-source-row');
        expect(row.getAttribute('data-glyph')).toBe('phone');
        expect(row.getAttribute('data-tone')).toBe('none');
        // The referee's wording: a verb, and the forecast's update time in
        // the forecast-age pill's words ('5m ago'), never 'fix just now'.
        expect(
            screen.getByText(
                'This phone isn’t giving a position. Showing the forecast for your last location (updated 5m ago).',
            ),
        ).toBeInTheDocument();
    });
});

describe('<GpsSourceRow /> — off GPS-follow', () => {
    it('names the place on the Glass instead of "none yet"', () => {
        const prev = useSettingsStore.getState().settings;
        useSettingsStore.setState({ settings: { ...prev, defaultLocation: 'Gladstone' } });
        try {
            world.weather = {
                positionSource: null,
                positionChoice: null,
                weatherData: { locationName: 'Gladstone' },
            } as unknown as typeof world.weather;
            world.link = { status: 'disconnected', remote: null };
            render(<GpsSourceRow compact />);
            expect(screen.getByText('Weather position')).toBeInTheDocument();
            expect(screen.getByText('Gladstone (chosen place) — GPS not in use')).toBeInTheDocument();
            expect(screen.queryByText(/none yet/i)).toBeNull();
        } finally {
            useSettingsStore.setState({ settings: prev });
        }
    });
});

describe('retained-weather location bar wiring', () => {
    // App has the full auth/map/native provider tree. Guard this narrow header
    // wiring here; context integration tests exercise retaining the actual report.
    const app = readFileSync(resolve(process.cwd(), 'App.tsx'), 'utf8');
    const title = app.slice(app.indexOf('const retainedLocationWeather'), app.indexOf('const showBackgroundImage'));
    const retry = app.slice(app.indexOf('{retainedLocationWeather ? ('), app.indexOf(') : isOffline ? ('));

    it('only retains the actual report title for an explicitly retained, unavailable position', () => {
        expect(title).toContain(
            "positionSource?.status === 'unavailable' && positionSource.retainedWeather && weatherData",
        );
        expect(app).toContain("import { weatherLocationTitle } from './utils/weatherLocationTitle'");
        expect(title).toContain(
            'const { title: rawTitle, resolvingLabel: resolvingLocationLabel } = weatherLocationTitle({',
        );
        expect(title).toContain('locationName: weatherData?.locationName');
        expect(title).toContain('status: positionSource?.status');
        expect(title).toContain('retainedWeather: retainedLocationWeather');
        expect(title).toContain('if (retainedLocationWeather) displayTitle = `Last · ${displayTitle}`');
        expect(app).toContain("value={displayTitle === 'Select Location' ? '' : displayTitle}");
    });

    it('uses a neutral selected-receiver label during lookup without a premature no-data error', () => {
        expect(title).toContain("const resolvingLocation = positionSource?.status === 'resolving'");
        expect(title).toMatch(/target:\s*positionSource\?\.target \?\?/);
        expect(title).toContain("settings.defaultLocation === 'Current Location' ? getWeatherFollowTarget() : null");
        expect(title).toContain('vesselName: settings.vessel?.name');
        const pending = app.slice(
            app.indexOf(') : resolvingLocation ? ('),
            app.indexOf(') : !weatherData && !loading && !settings.defaultLocation'),
        );
        expect(pending).toContain('role="status"');
        expect(pending).toContain('data-testid="weather-position-resolving"');
        expect(pending).toContain('{resolvingLocationLabel}');
        expect(pending).not.toMatch(/Retry|unavailable|bg-red/);
    });

    it.each(['phone', 'boat'] as const)(
        'the wired helper keeps unavailable %s titles fail-closed unless weather is retained',
        (target) => {
            const input = {
                locationName: 'Lady Musgrave',
                fallback: 'Current Location',
                target,
                status: 'unavailable' as const,
                vesselName: 'Serene Summer',
            };
            for (const retainedWeather of [undefined, false]) {
                expect(weatherLocationTitle({ ...input, retainedWeather }).title).toBe(
                    `${target === 'boat' ? 'Boat' : 'Phone'} GPS unavailable`,
                );
            }
            expect(weatherLocationTitle({ ...input, retainedWeather: true }).title).toBe('Lady Musgrave');
        },
    );

    it.each([
        ['phone', 'Serene Summer', 'Finding phone location…', 'Finding phone location…'],
        ['boat', 'Serene Summer', 'Serene Summer', 'Finding Serene Summer’s location…'],
        ['boat', undefined, 'Vessel location', 'Finding vessel location…'],
    ] as const)(
        'the wired helper keeps resolving %s neutral and independent of a previous report (%s)',
        (target, vesselName, expectedTitle, resolvingLabel) => {
            const resolved = weatherLocationTitle({
                locationName: 'Previous port',
                fallback: 'Current Location',
                target,
                status: 'resolving',
                vesselName,
            });
            expect(resolved).toEqual({ title: expectedTitle, resolvingLabel });
            expect(`${resolved.title} ${resolved.resolvingLabel}`).not.toMatch(
                /Previous port|Current Location|unavailable|No data|Retry/,
            );
        },
    );

    it('reuses the icon slot and existing refresh action without adding permission requests', () => {
        expect(retry).toContain('data-testid="weather-position-retry"');
        expect(retry).toContain('type="button"');
        expect(retry).toContain('onClick={() => refreshData()}');
        expect(retry).toContain('aria-label={positionRetryLabel}');
        expect(retry).toContain('absolute left-0 top-0 flex h-full w-12');
        expect(retry).not.toMatch(/requestPermissions|Geolocation|GpsService|setInterval/);
        expect(app).toContain('rounded-2xl pl-12 pr-12');
        expect(app).toContain('height: `${glassTopLayout.locationCardHeightPx}px`');
        expect(title).toContain('Showing forecast for last location: ${displayTitle}');
        expect(title).toContain('Retrying automatically; tap to retry now.');
        expect(title).toContain('Check location access');
    });
});
