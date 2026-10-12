// @vitest-environment node
/**
 * Where a skipper's licensed charts are, in one helper (127-C-c decision 11).
 * Licensed charts stay on the boat's Pi and open in this phone's memory on the
 * boat's Wi-Fi only (o-charts, 2026-10-10). Every surface that says so reads
 * these words: the map's no-chart notice, the Charts card, Auto, the Route
 * tracer and Cast Off. Global boat names, and a missing one.
 */
import { describe, expect, it } from 'vitest';
import {
    BOAT_CHARTS_FOOT,
    boatChartsAboardLine,
    boatChartsLine,
    boatChartsRefusal,
} from '../services/enc/boatChartsWords';

const NAMES = ['Serene Summer', "L'Étoile du Pacifique", 'Nordlys av Tromsø'];

describe('boatChartsLine', () => {
    it.each(NAMES)('says exactly where her charts are: %s', (name) => {
        expect(boatChartsLine('away', name)).toBe(
            `${name}'s licensed charts open on the boat's Wi-Fi. Open charts only here.`,
        );
        expect(boatChartsLine('away', name, 'strip')).toBe(`${name}'s charts open on the boat's Wi-Fi.`);
        expect(boatChartsLine('tailnet', name)).toBe(
            `Licensed charts open only on ${name}'s own Wi-Fi, not over remote access.`,
        );
        expect(boatChartsLine('off', name)).toBe(`Licensed charts stay on ${name}'s Pi in this build.`);
        expect(boatChartsLine('opening', name)).toBe(`Opening ${name}'s charts from the Pi…`);
        expect(boatChartsLine('slow', name)).toBe(
            `${name}'s charts are slow to open from the Pi. Until they do, legs are checked on open charts.`,
        );
        expect(boatChartsLine('recheck', name)).toBe(
            `Checked on ${name}'s charts. They open on the boat's Wi-Fi; recheck there before Cast Off.`,
        );
    });

    it('with no name it says "your boat", capitalised where it leads', () => {
        expect(boatChartsLine('away', null)).toBe(
            "Your boat's licensed charts open on the boat's Wi-Fi. Open charts only here.",
        );
        expect(boatChartsLine('opening', '  ')).toBe("Opening your boat's charts from the Pi…");
        expect(boatChartsLine('tailnet', undefined)).toBe(
            "Licensed charts open only on your boat's own Wi-Fi, not over remote access.",
        );
    });

    it("keeps DESKMAP's two web states, and 'web-open' never claims a licence or a boat", () => {
        expect(boatChartsLine('web', 'Serene Summer', 'strip')).toBe('Licensed charts stay on Serene Summer');
        for (const name of [...NAMES, null])
            for (const form of ['strip', 'notice'] as const) {
                const line = boatChartsLine('web-open', name, form);
                expect(line).not.toMatch(/licensed|stay on/i);
                for (const n of NAMES) expect(line).not.toContain(n);
            }
    });

    it('the Save, Follow and Cast Off refusal adds what to do', () => {
        expect(boatChartsRefusal('away', 'Serene Summer')).toBe(
            "Serene Summer's licensed charts open on the boat's Wi-Fi. Check it on the boat's Wi-Fi.",
        );
        expect(boatChartsRefusal('tailnet', 'Nordlys av Tromsø')).toBe(
            "Licensed charts open only on Nordlys av Tromsø's own Wi-Fi, not over remote access. Check it on the boat's Wi-Fi.",
        );
        expect(boatChartsRefusal('slow', null)).toBe(
            "Your boat's charts are still opening from the Pi. Check it once they open.",
        );
    });

    it('the Charts card: aboard count and the foot line', () => {
        expect(boatChartsAboardLine(1031, 'Serene Summer')).toBe(
            '1,031 charts aboard Serene Summer · opened in memory, never saved on this phone',
        );
        expect(boatChartsAboardLine(1, null)).toBe(
            '1 chart aboard your boat · opened in memory, never saved on this phone',
        );
        expect(BOAT_CHARTS_FOOT).toBe(
            "Licensed charts stay on your boat's Pi. This phone opens them in memory on the boat's Wi-Fi and never saves them, as the chart licences require. Open charts (NOAA) are kept on this phone.",
        );
    });
});
