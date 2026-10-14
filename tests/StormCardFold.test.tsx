/**
 * The storm overlay, tidied (129-13), from Shane's 14 Oct look at build 129
 * against the live feed: the threat chip sat on the storm card's header with
 * its "W" on a line of its own; chip, card and "2 / 3 · SIMON" stepper filled
 * the top half of the screen and ran under MOB; and the card said
 * "E · ep202026". Now: one card, the chip's words and the stepper inside it,
 * the basin and the storm's number in words.
 */
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/weather/api/blitzortungLightning', () => ({ subscribeLightningStrikes: () => () => {} }));
vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));

import { createStormHud, ensureStormSwitcher, refreshStormCardInPlace } from '../components/map/useCycloneLayer';
import { ThreatBanner } from '../components/map/ThreatBanner';
import { basinName, stormIdentityWords, stormNumberWords, stormDistance } from '../components/map/stormWords';
import type { ActiveCyclone } from '../services/weather/CycloneTrackingService';

const RAW_ID = /\b[a-z]{2}\d{6}\b/i;
const at = new Date(Date.now() - 3_600_000).toISOString();

const storm = (over: Partial<ActiveCyclone>): ActiveCyclone =>
    ({
        sid: 'ep312026',
        name: 'ZZSIMONETTA',
        basin: 'E',
        category: 1,
        categoryLabel: '1',
        currentPosition: { lat: 20.1, lon: -107.6, time: at, windKts: 80, pressureMb: 977 },
        lastAdvisoryTime: at,
        track: [],
        forecastTrack: [],
        maxWindKts: 80,
        minPressureMb: 977,
        nature: 'TS',
        forecastBy: { by: 'NHC', advisory: '26', issued: at },
        issuer: { official: true, text: 'NHC official forecast' },
        ...over,
    }) as ActiveCyclone;

/** A made-up port on a made-up coast, 138 NM east of the storm. */
const PLACE = { lat: 20.6, lon: -105.2 };

afterEach(cleanup);

describe('the basin and the storm, in words', () => {
    it('names every basin the feeds spell, by letter or by two', () => {
        const cases: [string, number, number, string][] = [
            ['L', 25, -60, 'Atlantic'],
            ['AL', 25, -60, 'Atlantic'],
            ['E', 15, -110, 'East Pacific'],
            ['EP', 15, -110, 'East Pacific'],
            ['C', 15, -160, 'Central Pacific'],
            ['CP', 15, -160, 'Central Pacific'],
            ['W', 24.2, 128.4, 'West Pacific'],
            ['WP', 24.2, 128.4, 'West Pacific'],
            ['A', 15, 65, 'North Indian'],
            ['B', 15, 88, 'North Indian'],
            ['IO', 15, 88, 'North Indian'],
            // South of the equator the region goes by where the storm is.
            ['S', -18, 50, 'South-West Indian'],
            ['SI', -18, 50, 'South-West Indian'],
            ['S', -15, 120, 'Australian region'],
            ['P', -16, 150, 'Australian region'],
            ['P', -17.4, 179.6, 'South Pacific'],
            ['SH', -17.4, -175, 'South Pacific'],
            ['SP', -20, -150, 'South Pacific'],
            ['Q', -28, -45, 'South Atlantic'],
        ];
        for (const [code, lat, lon, name] of cases) expect([code, basinName(code, '', lat, lon)]).toEqual([code, name]);
        // No code: the id's two letters, else the ocean the storm is in.
        expect(basinName('', 'al092026', 25, -90)).toBe('Atlantic');
        expect(basinName(undefined, 'sh372027', -17, 179)).toBe('South Pacific');
        expect(basinName('?', 'x', 12, 135)).toBe('West Pacific');
        // The Gulf of Mexico and the East Pacific share their longitudes: no guess.
        expect(basinName('?', 'x', 25, -90)).toBeNull();
    });

    it('says the storm’s number, or that it is an invest, never the raw id', () => {
        expect(stormNumberWords('ep202026')).toBe('storm 20');
        expect(stormNumberWords('sh372027')).toBe('storm 37');
        expect(stormNumberWords('wp932026')).toBe('invest 93');
        expect(stormNumberWords('2026285N20253')).toBeNull();
        expect(stormIdentityWords('E', 'ep202026', 20.1, -107.6)).toBe('East Pacific · storm 20');
        expect(stormIdentityWords('P', 'sh372027', -17.4, 179.6)).toBe('South Pacific · storm 37');
        expect(stormIdentityWords('?', '2026285N20253', 25, -90)).toBe('Tropical cyclone');
    });

    it('the card’s meta line for each basin carries no raw id', () => {
        for (const s of [
            storm({}),
            storm({
                sid: 'wp332026',
                basin: 'W',
                currentPosition: { lat: 24.2, lon: 128.4, time: at, windKts: 105, pressureMb: 955 },
            }),
            storm({
                sid: 'sh372027',
                basin: 'P',
                currentPosition: { lat: -17.4, lon: 179.6, time: at, windKts: 88, pressureMb: 968 },
            }),
            storm({
                sid: 'io042026',
                basin: 'B',
                currentPosition: { lat: 15, lon: 88, time: at, windKts: 50, pressureMb: 990 },
            }),
        ]) {
            const hud = createStormHud(s, [s], () => {});
            const meta = hud.querySelector('[data-storm-meta]')!.textContent!;
            expect(meta).not.toMatch(RAW_ID);
            expect(meta).not.toMatch(/^[A-Z]{1,2} ·/);
        }
        const meta = createStormHud(storm({}), [], () => {}).querySelector('[data-storm-meta]')!.textContent;
        expect(meta).toBe('East Pacific · storm 31 · 20.1°N 107.6°W');
    });
});

describe('one card: the chip’s words and the stepper inside it', () => {
    const all = [
        storm({}),
        storm({ sid: 'wp332026', name: 'ZZKOHARU', basin: 'W' }),
        storm({ sid: 'sh372027', name: 'ZZTAVITA', basin: 'P' }),
    ];

    it('says how far and which way the storm is, as the chip did, on one card with the stepper as its last row', () => {
        const hud = createStormHud(all[0], all, () => {}, { from: PLACE });
        expect(hud.className).toBe('storm-hud-badges');
        // One card: the stepper is inside it now, not a second box under it.
        expect(hud.children).toHaveLength(1);
        const card = hud.firstElementChild!.firstElementChild as HTMLElement;
        const stepper = card.querySelector('[data-storm-switcher]') as HTMLElement;
        expect(stepper).not.toBeNull();
        expect(stepper.parentElement!.hasAttribute('data-storm-footer')).toBe(true);
        expect(card.lastElementChild).toBe(stepper.parentElement);
        const away = card.querySelector('[data-storm-distance]')!;
        // "NM W" never wraps away from its number: no-break spaces.
        expect(away.textContent).toBe('138\u00a0NM\u00a0W · Cat 1 · 80 kt winds');
        expect((away as HTMLElement).dataset.stormDistance).toBe('warning');
        // The credits are a licence condition: marked as one, so the clear view keeps them.
        const credits = [...card.querySelectorAll('[data-map-credit]')].map((el) => el.textContent);
        expect(credits).toEqual(['Track: NHC (NOAA)']);
    });

    it('keeps the stepper in the card through a refresh, and a stepper arriving late lands there too', () => {
        const container = document.createElement('div');
        const hud = createStormHud(all[0], all, () => {}, { from: PLACE });
        container.append(hud);
        refreshStormCardInPlace(container, storm({ minPressureMb: 960 }), PLACE);
        const card = hud.firstElementChild!.firstElementChild as HTMLElement;
        expect(card.querySelector('[data-storm-footer] [data-storm-switcher]')).not.toBeNull();
        expect(hud.querySelectorAll('[data-storm-switcher]')).toHaveLength(1);
        // Moving 30 NM east, the distance line moves with the boat.
        refreshStormCardInPlace(container, storm({ minPressureMb: 960 }), { lat: 20.6, lon: -104.7 });
        expect(hud.querySelector('[data-storm-distance]')!.textContent).toMatch(/^1[67]\d\u00a0NM\u00a0W/);
        // First run, one storm known: no stepper; the list arrives and it appears in the card.
        const lone = document.createElement('div');
        const oneHud = createStormHud(all[0], [all[0]], () => {});
        lone.append(oneHud);
        expect(oneHud.querySelector('[data-storm-switcher]')).toBeNull();
        ensureStormSwitcher(lone, all, all[0], () => {});
        expect(oneHud.querySelector('[data-storm-footer] [data-storm-switcher]')).not.toBeNull();
    });
});

describe('the chip stands aside for the card', () => {
    const near = storm({});
    const props = { userLat: PLACE.lat, userLon: PLACE.lon, lightningActive: false, flyTo: vi.fn() };

    it('shows no chip for the storm the card already measures', async () => {
        render(<ThreatBanner {...props} visible cyclones={[near]} stormCardSid={near.sid} />);
        await act(async () => {});
        expect(screen.queryByRole('button', { name: /Threat alert/ })).toBeNull();
    });

    it('still shows a nearer storm than the card’s, as wide as its words, with "NM W" kept on its number', async () => {
        const other = storm({
            sid: 'ep322026',
            name: 'ZZFAR',
            currentPosition: { lat: 10, lon: -120, time: at, windKts: 50, pressureMb: 999 },
        });
        render(
            <div data-testid="map-hub">
                <ThreatBanner {...props} visible cyclones={[near, other]} stormCardSid={other.sid} />
            </div>,
        );
        await act(async () => {});
        const chip = screen.getByRole('button', { name: /Threat alert/ });
        expect(chip.textContent).toContain('ZZSIMONETTA · 138\u00a0NM\u00a0W');
        // At left 50 % a shrink-to-fit box got half the screen, so "W" wrapped at 390.
        expect(chip.style.width).toBe('max-content');
        expect(chip.style.maxWidth).toBe('calc(100vw - 32px)');
        // Its bottom edge, for the card under it: one measured stack.
        expect(screen.getByTestId('map-hub').style.getPropertyValue('--thalassa-threat-chip-bottom')).toMatch(
            /^\d+px$/,
        );
        // Under 300 NM: a warning, which the clear view hides with the rest.
        expect(chip.hasAttribute('data-clear-view-keep')).toBe(false);
    });

    it('an urgent storm, under 100 NM, stays in the clear view', async () => {
        const close = storm({ currentPosition: { lat: 20.5, lon: -105.9, time: at, windKts: 80, pressureMb: 977 } });
        expect(stormDistance(PLACE.lat, PLACE.lon, 20.5, -105.9)!.severity).toBe('danger');
        render(<ThreatBanner {...props} visible cyclones={[close]} />);
        await act(async () => {});
        expect(screen.getByRole('button', { name: /Threat alert/ }).hasAttribute('data-clear-view-keep')).toBe(true);
    });
});
