/**
 * The Glass header's Sun and moon chip opens a centred sheet (build 123,
 * W1-09): civil, nautical and astronomical twilight, the day's length, the
 * moon's altitude, and how long the moon is up in tonight's dark. Every time
 * is the place's own, read on any phone. Checked against the US Naval
 * Observatory where USNO prints a figure (the W1-06 almanac fixtures,
 * rstt/oneday, fetched 2026-10-07); nautical and astronomical twilight have
 * no printed figure there, so they are checked for order and spacing.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CompactHeaderRow } from '../components/dashboard/CompactHeaderRow';
import { SunMoonSheet } from '../components/dashboard/SunMoonSheet';
import {
    MOON_STAYS_UP,
    NO_TRUE_NIGHT,
    SUN_STAYS_DOWN,
    SUN_STAYS_UP,
    moonlightByNight,
    sunAltitudeDeg,
} from '../utils/celestial';

const minutes = (hhmm: string) => {
    const m = /(\d{2}):(\d{2})/.exec(hhmm);
    return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};
const cell = (id: string) => screen.getByTestId(id).textContent ?? '';
const near = (id: string, usno: string, tolerance = 2) =>
    expect(Math.abs(minutes(cell(id)) - minutes(usno)), `${id} ${cell(id)} vs USNO ${usno}`).toBeLessThanOrEqual(
        tolerance,
    );

afterEach(() => {
    vi.useRealTimers();
});

describe('the header’s Sun and moon chip', () => {
    it('is a button that opens the sheet, keeping its spoken times', () => {
        // Midday, so the chip shows the times rather than Golden hour.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(2026, 8, 26, 12, 0));
        const onOpen = vi.fn();
        render(
            <CompactHeaderRow
                alerts={[]}
                sunrise="05:42"
                sunset="17:53"
                moonPhase="🌕"
                moonPhaseName="Full"
                onOpenSunMoon={onOpen}
            />,
        );
        const chip = screen.getByRole('button', { name: /^Sunrise 05:42,\s*sunset 17:53,\s*full moon$/ });
        expect(chip).toHaveAttribute('aria-haspopup', 'dialog');
        expect(chip).toHaveAccessibleDescription('Sun and moon details');
        // 40 pt drawn, 44 pt to the finger, as the alerts pill beside it.
        expect(chip.className).toContain('hit-target-44');
        expect(chip.className).toContain('h-[40px]');
        fireEvent.click(chip);
        expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it('keeps "No sunset" in polar day (W1-06) when it is a button', () => {
        render(
            <CompactHeaderRow
                alerts={[]}
                sunrise={SUN_STAYS_UP}
                sunset={SUN_STAYS_UP}
                moonPhase="🌕"
                moonPhaseName="Full"
                onOpenSunMoon={vi.fn()}
            />,
        );
        const chip = screen.getByRole('button', { name: /^Sun stays up all day,\s*full moon$/ });
        expect(chip.querySelector('[data-sun-all-day="up"]')).toHaveTextContent('No sunset');
    });

    it('stays a plain group where nothing can open the sheet', () => {
        render(<CompactHeaderRow alerts={[]} sunrise="05:42" sunset="17:53" moonPhase="🌕" />);
        expect(screen.getByRole('group', { name: 'Sun and moon' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Sunrise/ })).toBeNull();
    });
});

describe('SunMoonSheet', () => {
    it('Marseille’s own day: the sun, three twilights and the day’s length (USNO, CEST)', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-07T10:00:00Z')); // 12:00 in Marseille
        render(
            <SunMoonSheet
                onClose={vi.fn()}
                lat={43.3}
                lon={5.37}
                timeZone="Europe/Paris"
                isoDate="2026-10-07"
                isToday
            />,
        );
        const dialog = screen.getByRole('dialog', { name: 'Sun and moon' });
        expect(dialog).toHaveTextContent('Wed 7 Oct');
        expect(dialog).toHaveTextContent('Times in Europe/Paris');
        near('sun-sunrise', '07:43');
        near('sun-sunset', '19:09');
        near('twilight-civil-dawn', '07:14');
        near('twilight-civil-dusk', '19:38');
        // 07:43 to 19:09.
        expect(cell('sun-daylength')).toMatch(/^11 h 2[4-8] min$/);
        // Each twilight a step further from the sun, about half an hour apart at 43° N.
        const order = [
            'twilight-astronomical-dawn',
            'twilight-nautical-dawn',
            'twilight-civil-dawn',
            'sun-sunrise',
            'sun-sunset',
            'twilight-civil-dusk',
            'twilight-nautical-dusk',
            'twilight-astronomical-dusk',
        ].map((id) => minutes(cell(id)));
        for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1]);
        expect(order[1] - order[0]).toBeGreaterThanOrEqual(28);
        expect(order[1] - order[0]).toBeLessThanOrEqual(38);
        const table = within(dialog).getByRole('table', { name: 'Twilight' });
        expect(
            within(table)
                .getAllByRole('rowheader')
                .map((h) => h.textContent),
        ).toEqual(['Civil', 'Nautical', 'Astronomical']);
    });

    it('Marseille’s moon: its phase, rise and set, its altitude now and its hours in tonight’s dark', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-07T10:00:00Z'));
        render(
            <SunMoonSheet
                onClose={vi.fn()}
                lat={43.3}
                lon={5.37}
                timeZone="Europe/Paris"
                isoDate="2026-10-07"
                isToday
            />,
        );
        // USNO: 12 % lit, waning crescent; rise 03:58, set 17:38.
        expect(cell('moon-phase')).toMatch(/^Waning crescent, 1[0-3]% lit$/);
        near('moon-rise', '03:58');
        near('moon-set', '17:38');
        // Up since 03:58 and setting at 17:38: well above the horizon at noon.
        expect(cell('moon-altitude')).toMatch(/^Now \d+° above the horizon$/);
        // Tonight's dark runs from 19:38 to 07:15; the next moonrise is 05:11
        // (USNO, 8 Oct), so the moon is up for about two hours of it.
        const tonight = /^Up (\d+\.\d) h of (\d+\.\d) h of darkness$/.exec(cell('moon-tonight'));
        expect(tonight, cell('moon-tonight')).not.toBeNull();
        expect(Number(tonight![2])).toBeGreaterThan(11.3);
        expect(Number(tonight![2])).toBeLessThan(11.9);
        expect(Number(tonight![1])).toBeGreaterThan(1.7);
        expect(Number(tonight![1])).toBeLessThan(2.4);
    });

    it('a later day gives the moon’s highest point in that night’s dark, not “now” (Whitsundays)', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-05T02:00:00Z'));
        render(
            <SunMoonSheet
                onClose={vi.fn()}
                lat={-20.27}
                lon={148.72}
                timeZone="Australia/Brisbane"
                isoDate="2026-10-07"
                isToday={false}
            />,
        );
        near('sun-sunrise', '05:42');
        near('twilight-civil-dusk', '18:27');
        near('moon-rise', '03:13');
        expect(cell('moon-altitude')).toMatch(/^Highest in tonight’s dark: \d+°$/);
    });

    it('Sint Maarten and Suva on their own clocks, read on any phone (USNO)', () => {
        const { unmount } = render(
            <SunMoonSheet
                onClose={vi.fn()}
                lat={18.03}
                lon={-63.08}
                timeZone="America/Lower_Princes"
                isoDate="2026-10-07"
                isToday={false}
            />,
        );
        near('sun-sunrise', '06:04');
        near('twilight-civil-dawn', '05:42');
        near('moon-set', '15:59');
        unmount();
        render(
            <SunMoonSheet
                onClose={vi.fn()}
                lat={-18.14}
                lon={178.42}
                timeZone="Pacific/Fiji"
                isoDate="2026-10-07"
                isToday={false}
            />,
        );
        near('sun-sunset', '18:05');
        near('twilight-civil-dusk', '18:27');
        near('moon-rise', '03:08');
    });

    it('Tromsø midsummer: the sun stays up, no true night, no darkness tonight', () => {
        render(
            <SunMoonSheet
                onClose={vi.fn()}
                lat={69.65}
                lon={18.96}
                timeZone="Europe/Oslo"
                isoDate="2026-06-21"
                isToday={false}
            />,
        );
        expect(cell('sun-sunrise')).toBe(SUN_STAYS_UP);
        expect(cell('sun-sunset')).toBe(SUN_STAYS_UP);
        expect(cell('sun-daylength')).toBe('24 h, the sun never sets');
        for (const kind of ['civil', 'nautical', 'astronomical'])
            expect(cell(`twilight-${kind}-dawn`)).toBe(NO_TRUE_NIGHT);
        expect(cell('moon-tonight')).toBe('No darkness tonight');
        expect(screen.getByRole('dialog')).not.toHaveTextContent('--:--');
    });

    it('Tromsø midwinter: the sun stays down, civil twilight still comes, the moon stays up', () => {
        render(
            <SunMoonSheet
                onClose={vi.fn()}
                lat={69.65}
                lon={18.96}
                timeZone="Europe/Oslo"
                isoDate="2026-12-21"
                isToday={false}
            />,
        );
        expect(cell('sun-sunrise')).toBe(SUN_STAYS_DOWN);
        expect(cell('sun-daylength')).toBe('None, the sun never rises');
        // USNO 2026-12-21: civil twilight 09:31 to 13:53.
        near('twilight-civil-dawn', '09:31', 5);
        near('twilight-civil-dusk', '13:53', 5);
        expect(cell('moon-rise')).toBe(MOON_STAYS_UP);
    });

    // Review 2026-10-08: tonight's window started at the CLOCK noon, but the
    // nights split at MEAN SOLAR noon, so where solar noon comes after clock
    // noon a polar night was cut to its first stub (Dikson: 1.7 h of ~24).
    for (const place of [
        { name: 'Dikson', lat: 73.5, lon: 80.5, timeZone: 'Asia/Krasnoyarsk' },
        { name: 'Resolute', lat: 74.7, lon: -94.83, timeZone: 'America/Resolute' },
        { name: 'Qaanaaq', lat: 77.47, lon: -69.23, timeZone: 'America/Thule' },
    ])
        it(`${place.name} midwinter: the whole polar night is tonight's darkness, not a stub of it`, () => {
            render(
                <SunMoonSheet
                    onClose={vi.fn()}
                    lat={place.lat}
                    lon={place.lon}
                    timeZone={place.timeZone}
                    isoDate="2026-12-20"
                    isToday={false}
                />,
            );
            expect(cell('sun-daylength')).toBe('None, the sun never rises');
            const tonight = /^Up (\d+\.\d) h of (\d+\.\d) h of darkness$/.exec(cell('moon-tonight'));
            expect(tonight, cell('moon-tonight')).not.toBeNull();
            expect(Number(tonight![2])).toBeGreaterThanOrEqual(22);
            expect(Number(tonight![1])).toBeLessThanOrEqual(Number(tonight![2]));
        });

    it('on a night watch, today gives the night the boat is in, not the next one (mid-Atlantic, 02:00)', () => {
        const lat = 20;
        const lon = -40;
        // 02:00 on Thu 8 Oct at UTC-3: dark, between Wednesday's dusk and Thursday's dawn.
        const now = Date.parse('2026-10-08T05:00:00Z');
        expect(sunAltitudeDeg(new Date(now), lat, lon)).toBeLessThan(-6);
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(now);
        render(
            <SunMoonSheet onClose={vi.fn()} lat={lat} lon={lon} timeZone="Etc/GMT+3" isoDate="2026-10-08" isToday />,
        );
        // The night holding now, from Wednesday's mean solar noon.
        const wedNoon = Date.parse('2026-10-07T12:00:00Z') + (-lon / 15) * 3_600_000;
        const night = moonlightByNight(wedNoon, wedNoon + 24 * 3_600_000, () => ({ lat, lon })).find(
            (n) => n.startMs <= now && now < n.endMs,
        )!;
        expect(night).toBeDefined();
        expect(cell('moon-tonight')).toBe(
            `This night: up ${night.moonUpHours.toFixed(1)} h of ${night.darkHours.toFixed(1)} h of darkness`,
        );
    });

    it('in daylight, today still gives tonight’s darkness (Marseille at noon)', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-07T10:00:00Z'));
        render(
            <SunMoonSheet
                onClose={vi.fn()}
                lat={43.3}
                lon={5.37}
                timeZone="Europe/Paris"
                isoDate="2026-10-07"
                isToday
            />,
        );
        expect(cell('moon-tonight')).toMatch(/^Up \d+\.\d h of \d+\.\d h of darkness$/);
    });

    it('labels an open-ocean zone by its real offset, not its POSIX-signed ID (20° N 40° W)', () => {
        render(
            <SunMoonSheet
                onClose={vi.fn()}
                lat={20}
                lon={-40}
                timeZone="Etc/GMT+3"
                isoDate="2026-10-08"
                isToday={false}
            />,
        );
        const dialog = screen.getByRole('dialog', { name: 'Sun and moon' });
        expect(dialog).toHaveTextContent('Thu 8 Oct · Times in UTC-3');
        expect(dialog).not.toHaveTextContent('GMT+3');
        // And the times are on that clock: sunrise near 05:33 at UTC-3.
        near('sun-sunrise', '05:33', 5);
    });

    it('is a centred dialog clear of the tab bar that closes on Escape and on its button', () => {
        const onClose = vi.fn();
        render(
            <SunMoonSheet
                onClose={onClose}
                lat={54.3}
                lon={7.9}
                timeZone="Europe/Berlin"
                isoDate="2026-10-08"
                isToday={false}
            />,
        );
        const dialog = screen.getByRole('dialog', { name: 'Sun and moon' });
        const overlay = dialog.parentElement!;
        expect(overlay.className).toContain('items-center');
        expect(overlay.className).toContain('justify-center');
        expect(overlay.className).toContain('pb-[calc(4rem+env(safe-area-inset-bottom)+1rem)]');
        expect(dialog.className).toContain('overflow-y-auto');
        fireEvent.keyDown(document.activeElement ?? dialog, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
        expect(onClose).toHaveBeenCalledTimes(2);
        // Worked out on this phone: no data source to credit, but say so.
        expect(dialog).toHaveTextContent('Worked out on this phone');
    });
});
