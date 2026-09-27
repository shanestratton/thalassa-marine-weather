/**
 * One fix timestamp, one answer (UX referee run 8, gps-one-truth — the only
 * HIGH). The System status Weather position box said 'This phone’s GPS
 * unavailable — showing forecast for the last location · fix just now', then
 * 'Last position 46 s ago', then 'No position yet — nothing is supplying a
 * fix': three clocks and two age formatters. The chart said a live-looking
 * 'Stopped' at the same moment.
 *
 * These tests pin the three states (live fix / last position / no position)
 * and prove the box's header row, its cards and the chart's own-ship label
 * read the same state, so they can no longer disagree.
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// The header row's resolver is pure; keep its component module's hooks light.
vi.mock('../context/WeatherContext', () => ({ useWeatherOptional: () => null }));
vi.mock('../components/nmea/useNmeaStore', () => ({
    useNmeaConnectionStatus: () => ({ status: 'disconnected', remote: null }),
}));

import {
    boatLiveFixMaxAgeMs,
    fixAgeText,
    fixPositionLine,
    followedReceiver,
    gpsFixState,
    newestFixAt,
    ownshipFixLabel,
    PHONE_LIVE_FIX_MAX_AGE_MS,
    type GpsFixState,
} from '../components/gpsFixState';
import {
    NO_GPS_FIX_LINE,
    presentWeatherPositionBox,
    type GpsDiagnosticSource,
    type WeatherBoxFix,
} from '../components/gpsDiagnosticsPresentation';
import { GpsDiagnosticsCards } from '../components/GpsDiagnosticsCards';
import { resolveGpsSourceState } from '../components/GpsSourceGlyph';
import { ownshipStatusLabel } from '../components/map/ownshipStatus';
import type { GpsReceiverStatus } from '../services/GpsReceiverStatusService';
import { NMEA_USABLE_MAX_AGE_MS } from '../services/nmea/nmeaCadence';

const NOW = 1_800_000_000_000;
/** An age the header row states: ' · 46 s ago'. The forecast's '(updated …)' is not a fix age. */
const HEADER_AGE = / · (just now|\d+ (?:s|min|h) ago)/;

const phoneSource = (positionAt: number | null): GpsDiagnosticSource => ({
    label: 'Phone location',
    phone: true,
    maxAgeMs: PHONE_LIVE_FIX_MAX_AGE_MS,
    positionAt,
    accuracyM: positionAt === null ? null : { value: 5, timestamp: positionAt },
});

const boatSource = (positionAt: number | null): GpsDiagnosticSource => ({
    label: 'Boat GPS · NMEA',
    maxAgeMs: NMEA_USABLE_MAX_AGE_MS,
    positionMaxAgeMs: NMEA_USABLE_MAX_AGE_MS,
    positionAt,
    satellites: { value: 9, timestamp: NOW },
});

const phoneReceiver: GpsReceiverStatus = {
    active: false,
    kind: 'phone',
    label: 'GPS Receiver',
    detail: 'No position yet — nothing is supplying a fix',
    isNmea: false,
    satellites: null,
    hdop: null,
    avgAccuracy: null,
    qualityLabel: null,
    deviceName: null,
};

/** The own-ship badge for a stopped boat, from the same fix state. */
const ownship = (fix: GpsFixState, viaVessel = false) =>
    ownshipStatusLabel(
        { latitude: -27.2, longitude: 153.1, speed: 0 },
        viaVessel,
        { state: 'idle', gpsSource: null },
        { role: 'vessel', sessionCode: null },
        { sessionCode: null, position: null, stale: true, cause: null },
        NOW,
        fix,
    );

describe('the three fix states', () => {
    it.each([null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, NOW + 60_000])(
        'no valid position time (%s) is no position — never an invented age',
        (fixAt) => {
            const fix = gpsFixState(fixAt, 30_000, NOW);
            expect(fix).toEqual({ kind: 'none', at: null, ageMs: null });
            expect(fixPositionLine(fix)).toBe('No position yet');
            expect(ownshipFixLabel(fix)).toBe('No fix');
        },
    );

    it('a fix inside its live gate is live, and says its age', () => {
        expect(gpsFixState(NOW, 30_000, NOW)).toEqual({ kind: 'live', at: NOW, ageMs: 0 });
        expect(fixPositionLine(gpsFixState(NOW, 30_000, NOW))).toBe('Position just now');
        expect(fixPositionLine(gpsFixState(NOW - 5_000, 30_000, NOW))).toBe('Position 5 s ago');
        // The gate itself is still live.
        expect(gpsFixState(NOW - 30_000, 30_000, NOW).kind).toBe('live');
        // A clock a fraction fast is not a future fix.
        expect(gpsFixState(NOW + 500, 30_000, NOW)).toMatchObject({ kind: 'live', ageMs: 0 });
        expect(ownshipFixLabel(gpsFixState(NOW - 5_000, 30_000, NOW))).toBeNull();
    });

    it('a fix past its gate is a last position that says it has no live fix', () => {
        const fix = gpsFixState(NOW - 46_000, 30_000, NOW);
        expect(fix).toEqual({ kind: 'last', at: NOW - 46_000, ageMs: 46_000 });
        expect(fixPositionLine(fix)).toBe('No live fix · last position 46 s ago');
        expect(ownshipFixLabel(fix)).toBe('Last fix 46 s');
        expect(fixPositionLine(gpsFixState(NOW - 180_000, 30_000, NOW))).toBe('No live fix · last position 3 min ago');
        expect(ownshipFixLabel(gpsFixState(NOW - 2 * 3_600_000, 30_000, NOW))).toBe('Last fix 2 h');
    });

    it('has one age wording', () => {
        expect(fixAgeText(0)).toBe('just now');
        expect(fixAgeText(999)).toBe('just now');
        expect(fixAgeText(46_900)).toBe('46 s ago');
        expect(fixAgeText(125_000)).toBe('2 min ago');
        expect(fixAgeText(3 * 3_600_000)).toBe('3 h ago');
    });

    it('takes the newest valid reading of one receiver as its one timestamp', () => {
        expect(newestFixAt([NOW - 46_000, NOW - 3_000, null, undefined], NOW)).toBe(NOW - 3_000);
        expect(newestFixAt([NOW - 46_000, NOW + 60_000, Number.NaN, 0], NOW)).toBe(NOW - 46_000);
        expect(newestFixAt([null, undefined], NOW)).toBeNull();
    });

    it('gives each receiver lane its own live gate', () => {
        expect(PHONE_LIVE_FIX_MAX_AGE_MS).toBe(30_000);
        expect(boatLiveFixMaxAgeMs({ connectionStatus: 'connected', remote: null })).toBe(NMEA_USABLE_MAX_AGE_MS);
        const remote = (via: 'lan' | 'cloud') =>
            ({ source: 'pi', via, deviceLabel: 'Boat', reportedAt: NOW, receivedAt: NOW }) as const;
        expect(boatLiveFixMaxAgeMs({ connectionStatus: 'remote', remote: remote('lan') })).toBe(20_000);
        expect(boatLiveFixMaxAgeMs({ connectionStatus: 'remote', remote: remote('cloud') })).toBe(60_000);
    });

    it('knows which receiver the weather follows', () => {
        expect(followedReceiver('phone')).toBe('phone');
        expect(followedReceiver('held', 'phone')).toBe('boat');
        expect(followedReceiver('bus')).toBe('boat');
        expect(followedReceiver(null, 'phone')).toBe('phone');
        expect(followedReceiver(null)).toBeNull();
    });
});

describe('the referee’s screen: retained phone weather, last phone position 46 s ago', () => {
    const weather: WeatherBoxFix = { kind: 'phone', target: 'phone', timestamp: NOW - 46_000 };
    const box = presentWeatherPositionBox({ now: NOW, boat: null, phone: phoneSource(NOW - 46_000), weather });
    const header = resolveGpsSourceState({
        weatherKind: 'phone',
        target: 'phone',
        status: 'unavailable',
        retainedWeather: true,
        timestamp: weather.timestamp,
        storeStatus: 'disconnected',
        remoteVia: null,
        fixes: box.fixes,
        forecastUpdatedAt: NOW - 20_000,
        now: NOW,
    });

    it('the header has a verb and dates the forecast, not a fix', () => {
        expect(header.label).toBe(
            'Position: this phone isn’t giving a position. Showing the forecast for your last location (updated just now).',
        );
        expect(header.label).not.toMatch(/fix just now|unavailable/);
    });

    it('the card says there is no live fix and how old the last position is', () => {
        const [phone] = box.sources;
        expect(phone.position).toBe('No live fix · last position 46 s ago');
        expect(phone.noFix).toBe(false);
        expect(phone.quality.text).toBe('No current fix');
    });

    it('the rendered card drops the native cache’s “No position yet” under a real last position', () => {
        render(<GpsDiagnosticsCards sources={box.sources} receiver={phoneReceiver} />);
        const card = within(screen.getByRole('region', { name: 'Phone location' }));
        expect(card.getByText('No live fix · last position 46 s ago')).toBeVisible();
        expect(card.queryByText(/No position yet/)).toBeNull();
        expect(card.queryByTestId('gps-receiver-connection')).toBeNull();
    });

    it('the chart’s own-ship badge reads the same state: Last fix 46 s, not Stopped', () => {
        expect(ownship(box.fixes.phone)).toBe('Last fix 46 s');
    });
});

describe('the lines cannot disagree', () => {
    const ages = [null, 0, 5_000, 29_000, 30_000, 31_000, 46_000, 59_000, 61_000, 10 * 60_000];
    // The weather's copy of the phone fix: the same fix, an older one, a newer one, or none.
    const weatherOffsets = [0, -20_000, 3_000, null];
    const statuses = [
        { status: 'live' as const, retainedWeather: false },
        { status: 'last-known' as const, retainedWeather: false },
        { status: 'unavailable' as const, retainedWeather: true },
        { status: 'unavailable' as const, retainedWeather: false },
    ];

    for (const phoneAge of ages) {
        for (const offset of weatherOffsets) {
            for (const { status, retainedWeather } of statuses) {
                const phoneAt = phoneAge === null ? null : NOW - phoneAge;
                const weatherAt = offset === null || phoneAt === null ? null : Math.min(NOW, phoneAt + offset);
                // With no fix the weather publishes only its target, as unavailable.
                if (weatherAt === null && (status !== 'unavailable' || retainedWeather)) continue;
                const name = `phone ${phoneAge ?? 'none'} ms, weather ${offset ?? 'none'}, ${status}${retainedWeather ? ' (retained)' : ''}`;
                it(name, () => {
                    const weather: WeatherBoxFix =
                        weatherAt === null
                            ? { kind: null, target: 'phone', timestamp: 0 }
                            : { kind: 'phone', target: 'phone', timestamp: weatherAt };
                    const box = presentWeatherPositionBox({
                        now: NOW,
                        boat: null,
                        phone: phoneSource(phoneAt),
                        weather,
                    });
                    const [card] = box.sources;
                    const fix = box.fixes.phone;
                    const header = resolveGpsSourceState({
                        weatherKind: weather.kind,
                        target: 'phone',
                        status,
                        retainedWeather,
                        timestamp: weather.timestamp,
                        storeStatus: 'disconnected',
                        remoteVia: null,
                        fixes: box.fixes,
                        forecastUpdatedAt: NOW - 20_000,
                        now: NOW,
                    }).label;
                    const badge = ownship(fix);

                    // One timestamp: the card is the fix state, whichever copy was newer.
                    expect(fix.at).toBe(newestFixAt([phoneAt, weather.kind ? weather.timestamp : null], NOW));
                    expect(card.fix).toEqual(fix);

                    // 'No position yet' only when no position time exists at all.
                    expect(card.position === 'No position yet').toBe(fix.kind === 'none');
                    expect(card.noFix).toBe(fix.kind === 'none');

                    // Any age the header states is the card's age, in the card's words.
                    const headerAge = header.match(HEADER_AGE)?.[1];
                    if (headerAge !== undefined) {
                        expect(fix.kind).not.toBe('none');
                        expect(headerAge).toBe(fixAgeText(fix.ageMs!));
                    }

                    if (fix.kind === 'live') {
                        expect(card.position).toBe(`Position ${fixAgeText(fix.ageMs)}`);
                        expect(header).not.toMatch(/isn’t giving a position|last fix/);
                        expect(badge).toBe('Stopped');
                    } else if (fix.kind === 'last') {
                        expect(card.position).toBe(`No live fix · last position ${fixAgeText(fix.ageMs)}`);
                        // Never the live-sounding 'this phone’s GPS' beside 'No live fix'.
                        expect(header).not.toMatch(/phone’s GPS$|live/);
                        expect(header).toMatch(/isn’t giving a position|last fix · /);
                        expect(badge).toBe(`Last fix ${fixAgeText(fix.ageMs).replace(/ ago$/, '')}`);
                    } else {
                        expect(header).not.toMatch(/last fix|phone’s GPS$|live/);
                        expect(badge).toBe('No fix');
                    }
                });
            }
        }
    }
});

describe('the boat card and the header agree on her one timestamp', () => {
    const kinds = ['bus', 'pi', 'cloud', 'held'] as const;
    const ages = [null, 0, 5_000, 13_000, 14_000, 46_000, 10 * 60_000];

    for (const kind of kinds) {
        for (const boatAge of ages) {
            it(`${kind}, boat position ${boatAge ?? 'none'} ms`, () => {
                const boatAt = boatAge === null ? null : NOW - boatAge;
                // The weather's own copy is older than the card's, as a held fix is.
                const weather: WeatherBoxFix = { kind, target: 'boat', timestamp: NOW - 20 * 60_000 };
                const box = presentWeatherPositionBox({
                    now: NOW,
                    boat: boatSource(boatAt),
                    phone: phoneSource(null),
                    weather,
                });
                const [card] = box.sources;
                const fix = box.fixes.boat!;
                const header = resolveGpsSourceState({
                    weatherKind: kind,
                    target: 'boat',
                    status: 'live',
                    timestamp: weather.timestamp,
                    storeStatus: 'connected',
                    remoteVia: null,
                    fixes: box.fixes,
                    now: NOW,
                }).label;

                expect(card.label).toBe('Boat GPS · NMEA');
                expect(fix.at).toBe(boatAt ?? weather.timestamp);
                expect(card.position).toBe(fixPositionLine(fix));
                const headerAge = header.match(HEADER_AGE)?.[1];
                if (headerAge !== undefined) expect(headerAge).toBe(fixAgeText(fix.ageMs!));
                if (fix.kind !== 'live') {
                    expect(card.position).toMatch(/^No live fix · last position /);
                    expect(header).not.toMatch(/live|through the cloud/);
                    expect(header).toMatch(/the boat’s last fix · /);
                    expect(ownship(fix, true)).toMatch(/^Last fix /);
                } else if (kind !== 'held') {
                    expect(header).not.toMatch(/last fix/);
                    expect(ownship(fix, true)).toBe('Stopped');
                }
            });
        }
    }
});

describe('the card rows off the one timestamp', () => {
    it('a boat card with readings but no position says No position yet, and only then', () => {
        const none = presentWeatherPositionBox({ now: NOW, boat: boatSource(null), phone: phoneSource(null) });
        expect(none.sources[0].position).toBe('No position yet');
        expect(none.sources[0].noFix).toBe(false);
        expect(none.sources[1].noFix).toBe(true);
        render(<GpsDiagnosticsCards sources={none.sources} receiver={phoneReceiver} />);
        expect(within(screen.getByRole('region', { name: 'Phone location' })).getByText(NO_GPS_FIX_LINE)).toBeVisible();
    });

    it('the weather’s copy of a fix never dates the other receiver’s card', () => {
        const box = presentWeatherPositionBox({
            now: NOW,
            boat: boatSource(null),
            phone: phoneSource(null),
            weather: { kind: 'phone', target: 'phone', timestamp: NOW - 5_000 },
        });
        expect(box.fixes.phone).toMatchObject({ kind: 'live', ageMs: 5_000 });
        expect(box.fixes.boat).toEqual({ kind: 'none', at: null, ageMs: null });
    });
});

// ── Adversarial review (gps-one-truth, review pass) ──

describe('a receiver clock a few seconds fast', () => {
    it('is live within the 5 s skew the own-ship arbiter and the weather accept, and none past it', () => {
        expect(gpsFixState(NOW + 4_000, 30_000, NOW)).toEqual({ kind: 'live', at: NOW + 4_000, ageMs: 0 });
        expect(gpsFixState(NOW + 6_000, 30_000, NOW).kind).toBe('none');
    });

    it('a Pi fix stamped 3 s ahead is the boat’s live GPS in the header AND the card, not “last fix” over “No position yet”', () => {
        const piAhead: WeatherBoxFix = { kind: 'pi', target: 'boat', timestamp: NOW + 3_000 };
        const box = presentWeatherPositionBox({
            now: NOW,
            boat: boatSource(null),
            phone: phoneSource(null),
            weather: piAhead,
        });
        expect(box.sources[0].position).toBe('Position just now');
        const header = resolveGpsSourceState({
            weatherKind: 'pi',
            target: 'boat',
            status: 'live',
            timestamp: piAhead.timestamp,
            storeStatus: 'remote',
            remoteVia: 'lan',
            fixes: box.fixes,
            now: NOW,
        }).label;
        expect(header).toBe('Position: the boat’s GPS, live');
        expect(ownship(box.fixes.boat!, true)).toBe('Stopped');
    });
});

/**
 * The boat card reads NmeaStore's position sample — the clock the chart's
 * badge and Radio read. The weather's boat copies are not all dated that way:
 * a bus fix off the Pi's LAN lane carries this phone's READ time, the cloud
 * row its REPORT time, a held fix either. They fill a card with no position
 * time, and never re-date one that has its own.
 */
describe('the weather’s boat copy never re-dates the boat’s position sample', () => {
    /** The Pi's cloud row: coordinates sampled 10 min ago, republished 5 s ago. */
    const cloudBoat = (positionAt: number | null): GpsDiagnosticSource => ({
        ...boatSource(positionAt),
        label: 'Boat GPS · cloud',
        positionMaxAgeMs: 60_000,
    });
    const header = (
        kind: 'cloud' | 'held' | 'pi' | 'bus',
        timestamp: number,
        box: ReturnType<typeof presentWeatherPositionBox>,
    ) =>
        resolveGpsSourceState({
            weatherKind: kind,
            target: 'boat',
            status: kind === 'held' ? 'last-known' : 'live',
            timestamp,
            storeStatus: 'remote',
            remoteVia: 'cloud',
            fixes: box.fixes,
            now: NOW,
        }).label;

    it.each(['cloud', 'held', 'bus', 'pi'] as const)(
        'a %s copy stamped 5 s ago does not make 10-min-old coordinates read as a live fix',
        (kind) => {
            const weather: WeatherBoxFix = { kind, target: 'boat', timestamp: NOW - 5_000 };
            const box = presentWeatherPositionBox({
                now: NOW,
                boat: cloudBoat(NOW - 10 * 60_000),
                phone: phoneSource(null),
                weather,
            });
            expect(box.fixes.boat).toEqual({ kind: 'last', at: NOW - 10 * 60_000, ageMs: 10 * 60_000 });
            expect(box.sources[0].position).toBe('No live fix · last position 10 min ago');
            expect(header(kind, weather.timestamp, box)).toMatch(/^Position: the boat’s last fix · 10 min ago/);
            expect(ownship(box.fixes.boat!, true)).toBe('Last fix 10 min');
        },
    );

    it.each(['cloud', 'held', 'bus', 'pi'] as const)(
        'a %s copy still fills a card that has no position time, so the header’s fix is never over “No position yet”',
        (kind) => {
            const weather: WeatherBoxFix = { kind, target: 'boat', timestamp: NOW - 20_000 };
            const box = presentWeatherPositionBox({
                now: NOW,
                boat: cloudBoat(null),
                phone: phoneSource(null),
                weather,
            });
            expect(box.fixes.boat).toMatchObject({ at: NOW - 20_000 });
            expect(box.sources[0].position).not.toBe('No position yet');
            expect(box.sources[0].position).toBe('Position 20 s ago');
        },
    );

    it('the phone’s copy is the same GPS’s own fix, so a newer one does join the phone card', () => {
        const box = presentWeatherPositionBox({
            now: NOW,
            boat: null,
            phone: phoneSource(NOW - 46_000),
            weather: { kind: 'phone', target: 'phone', timestamp: NOW - 2_000 },
        });
        expect(box.fixes.phone).toEqual({ kind: 'live', at: NOW - 2_000, ageMs: 2_000 });
        expect(box.sources[0].position).toBe('Position 2 s ago');
    });
});

/**
 * The review's constructed states, traced line by line: the box's header row,
 * each card's position line, and the own-ship badge for the receiver the chart
 * would be drawing. No line may call a last position live, say 'No position
 * yet' over a position time, or put 'just now' on a fix that is not live.
 */
describe('constructed states: every line of the box and the own-ship badge', () => {
    interface Case {
        name: string;
        phoneAt: number | null;
        boatAt?: number | null;
        weather: WeatherBoxFix | null;
        status?: 'live' | 'last-known' | 'unavailable' | 'resolving';
        retainedWeather?: boolean;
        chosenPlace?: string;
        header: string;
        phoneLine: string;
        boatLine?: string;
        /** The chart's badge: the boat when she is painting, else the phone. */
        badge: string | null;
        badgeViaVessel?: boolean;
    }
    const cases: Case[] = [
        {
            name: 'fresh phone fix',
            phoneAt: NOW - 3_000,
            weather: { kind: 'phone', target: 'phone', timestamp: NOW - 3_000 },
            status: 'live',
            header: 'Position: this phone’s GPS',
            phoneLine: 'Position 3 s ago',
            badge: 'Stopped',
        },
        {
            name: 'fresh phone fix, weather’s live copy published 10 min ago and never republished',
            phoneAt: NOW - 3_000,
            weather: { kind: 'phone', target: 'phone', timestamp: NOW - 10 * 60_000 },
            status: 'live',
            header: 'Position: this phone’s GPS',
            phoneLine: 'Position 3 s ago',
            badge: 'Stopped',
        },
        {
            name: 'stale phone fix',
            phoneAt: NOW - 90_000,
            weather: { kind: 'phone', target: 'phone', timestamp: NOW - 90_000 },
            status: 'last-known',
            header: 'Position: this phone’s last fix · 1 min ago',
            phoneLine: 'No live fix · last position 1 min ago',
            badge: 'Last fix 1 min',
        },
        {
            name: 'stale phone fix while the weather still says live',
            phoneAt: NOW - 46_000,
            weather: { kind: 'phone', target: 'phone', timestamp: NOW - 46_000 },
            status: 'live',
            header: 'Position: this phone’s last fix · 46 s ago',
            phoneLine: 'No live fix · last position 46 s ago',
            badge: 'Last fix 46 s',
        },
        {
            name: 'no fix ever',
            phoneAt: null,
            weather: { kind: null, target: 'phone', timestamp: 0 },
            status: 'unavailable',
            header: 'Position: this phone isn’t giving a position.',
            phoneLine: NO_GPS_FIX_LINE,
            badge: null,
        },
        {
            name: 'vessel GPS present',
            phoneAt: NOW - 3_000,
            boatAt: NOW - 2_000,
            weather: { kind: 'bus', target: 'boat', timestamp: NOW - 2_000 },
            status: 'live',
            header: 'Position: the boat’s GPS, live',
            phoneLine: 'Position 3 s ago',
            boatLine: 'Position 2 s ago',
            badge: 'Stopped',
            badgeViaVessel: true,
        },
        {
            name: 'vessel stale, phone fresh (the phone stands in for the arrow)',
            phoneAt: NOW - 2_000,
            boatAt: NOW - 120_000,
            weather: { kind: 'held', target: 'boat', timestamp: NOW - 120_000 },
            status: 'last-known',
            header: 'Position: the boat’s last fix · 2 min ago — tap to choose the boat or this phone',
            phoneLine: 'Position 2 s ago',
            boatLine: 'No live fix · last position 2 min ago',
            badge: 'Stopped',
        },
        {
            name: 'vessel stale, weather still on her last bus fix',
            phoneAt: NOW - 2_000,
            boatAt: NOW - 46_000,
            weather: { kind: 'bus', target: 'boat', timestamp: NOW - 46_000 },
            status: 'live',
            header: 'Position: the boat’s last fix · 46 s ago',
            phoneLine: 'Position 2 s ago',
            boatLine: 'No live fix · last position 46 s ago',
            badge: 'Last fix 46 s',
            badgeViaVessel: true,
        },
        {
            name: 'weather for a chosen place with GPS off',
            phoneAt: null,
            weather: null,
            chosenPlace: 'Gladstone',
            header: 'Position: Gladstone (chosen place) — GPS not in use',
            phoneLine: NO_GPS_FIX_LINE,
            badge: null,
        },
        {
            name: 'weather for a chosen place with the phone’s GPS still running',
            phoneAt: NOW - 4_000,
            weather: null,
            chosenPlace: 'Gladstone',
            header: 'Position: Gladstone (chosen place) — GPS not in use',
            phoneLine: 'Position 4 s ago',
            badge: 'Stopped',
        },
        {
            name: 'permission denied after a fix, forecast retained',
            phoneAt: NOW - 5 * 60_000,
            weather: { kind: 'phone', target: 'phone', timestamp: NOW - 5 * 60_000 },
            status: 'unavailable',
            retainedWeather: true,
            header: 'Position: this phone isn’t giving a position. Showing the forecast for your last location (updated just now).',
            phoneLine: 'No live fix · last position 5 min ago',
            badge: 'Last fix 5 min',
        },
        {
            name: 'permission denied, the phone watch never delivered, forecast retained from the weather’s own read',
            phoneAt: null,
            weather: { kind: 'phone', target: 'phone', timestamp: NOW - 46_000 },
            status: 'unavailable',
            retainedWeather: true,
            header: 'Position: this phone isn’t giving a position. Showing the forecast for your last location (updated just now).',
            phoneLine: 'No live fix · last position 46 s ago',
            badge: null,
        },
    ];

    it.each(cases)('$name', (c) => {
        const boat =
            c.boatAt === undefined
                ? null
                : ({ ...boatSource(c.boatAt), satellites: { value: 9, timestamp: NOW } } as GpsDiagnosticSource);
        const box = presentWeatherPositionBox({ now: NOW, boat, phone: phoneSource(c.phoneAt), weather: c.weather });
        const phoneCard = box.sources.at(-1)!;
        const boatCard = boat ? box.sources[0] : null;
        const header = resolveGpsSourceState({
            weatherKind: c.weather?.kind ?? null,
            target: c.weather?.target,
            status: c.status,
            retainedWeather: c.retainedWeather,
            timestamp: c.weather?.timestamp,
            storeStatus: boat ? 'connected' : 'disconnected',
            remoteVia: null,
            chosenPlace: c.chosenPlace ?? null,
            fixes: box.fixes,
            forecastUpdatedAt: NOW - 30_000,
            now: NOW,
        }).label;
        const line = (card: typeof phoneCard) => (card.noFix ? NO_GPS_FIX_LINE : card.position);

        expect(header).toBe(c.header);
        expect(line(phoneCard)).toBe(c.phoneLine);
        if (c.boatLine !== undefined) expect(line(boatCard!)).toBe(c.boatLine);
        const badgeFix = c.badgeViaVessel ? box.fixes.boat! : box.fixes.phone;
        // The chart has no marker until a fix has been painted.
        if (c.badge !== null) expect(ownship(badgeFix, c.badgeViaVessel)).toBe(c.badge);

        for (const [card, fix] of [
            [phoneCard, box.fixes.phone],
            ...(boatCard ? [[boatCard, box.fixes.boat!] as const] : []),
        ] as const) {
            // 'No position yet' (or the no-fix line) only when no position time exists.
            expect(card.position === 'No position yet' || card.noFix).toBe(fix.kind === 'none');
            // 'just now' belongs to a live fix only.
            if (fix.kind !== 'live') expect(line(card)).not.toMatch(/just now/);
        }
        // The header's only 'just now' may date the FORECAST ('updated just now').
        expect(header.replace('(updated just now)', '')).not.toMatch(/just now/);
    });
});
