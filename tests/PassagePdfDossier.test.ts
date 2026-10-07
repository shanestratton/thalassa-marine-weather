import { describe, expect, it } from 'vitest';

import { arrivalLightNote, generatePassagePdf, passageMoonlightLines } from '../services/PassagePdfService';
import type { PassageBriefData } from '../services/PassageBriefService';

function briefFixture(overrides: Partial<PassageBriefData> = {}): PassageBriefData {
    return {
        routeName: 'Newport → Lady Musgrave',
        origin: { name: 'Newport', lat: -27.205, lon: 153.093 },
        destination: { name: 'Lady Musgrave', lat: -23.907, lon: 152.404 },
        departureTime: '2026-08-10T06:00:00+10:00',
        totalDistanceNM: 218,
        estimatedDuration: 36,
        speed: 6,
        vesselName: 'Serene Summer',
        vesselType: 'sail',
        crewCount: 2,
        turnWaypoints: [
            { name: 'Caloundra', lat: -26.8, lon: 153.15, tws: 12, bng: 20 },
            { name: 'Double Island Pt', lat: -25.93, lon: 153.19, tws: 15, bng: 10 },
        ],
        departureTides: [
            { time: '2026-08-10T04:55:00+10:00', type: 'high', height: 2.1 },
            { time: '2026-08-10T11:10:00+10:00', type: 'low', height: 0.5 },
        ],
        arrivalTides: [{ time: '2026-08-11T17:20:00+10:00', type: 'high', height: 2.4 }],
        ...overrides,
    };
}

describe('PassagePdfService dossier', () => {
    it('renders the full dossier without throwing and produces a real document', () => {
        const blob = generatePassagePdf(briefFixture());
        expect(blob.size).toBeGreaterThan(5000);
    });

    it('still renders for a minimal single-handed day sail', () => {
        const blob = generatePassagePdf(
            briefFixture({
                crewCount: 1,
                estimatedDuration: 4.5,
                totalDistanceNM: 24,
                turnWaypoints: undefined,
                departureTides: undefined,
                arrivalTides: undefined,
            }),
        );
        expect(blob.size).toBeGreaterThan(3000);
    });

    it('handles a long multi-day passage with a big crew across page breaks', () => {
        const blob = generatePassagePdf(
            briefFixture({
                crewCount: 4,
                estimatedDuration: 7 * 24,
                totalDistanceNM: 800,
                turnWaypoints: Array.from({ length: 30 }, (_, i) => ({
                    name: `WP${i + 1}`,
                    lat: -27 + i * 0.2,
                    lon: 153 + i * 0.1,
                    tws: 10 + (i % 8),
                    bng: (i * 20) % 360,
                })),
            }),
        );
        expect(blob.size).toBeGreaterThan(8000);
    });
});

// ── Arrival before dark, judged at the destination (build 123, W1-06) ──
//
// The arrival check used the PHONE's clock (`06 <= hour < 18`), so a
// Brisbane phone planning into Sint Maarten read an 18:30 dusk landfall as
// 08:30 "daylight". It now uses the destination's civil dusk and dawn in the
// destination's own zone (tz-lookup) and names that zone.
//
// Civil twilight figures: USNO Astronomical Applications API v4.0.1,
// rstt/oneday, fetched 2026-10-07 (aa.usno.navy.mil/api/rstt/oneday).
// Run under TZ=Australia/Brisbane, America/Los_Angeles and Europe/Paris.

const at = (iso: string, hours: number) => ({ departureTime: iso, estimatedDuration: hours });

/** The words a jsPDF document draws, line by line joined with spaces (the
 *  dossier is written uncompressed, one (string) Tj per line). */
async function pdfText(blob: Blob): Promise<string> {
    const raw = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsBinaryString(blob);
    });
    const strings = Array.from(raw.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g), (m) => m[1].replace(/\\([()\\])/g, '$1'));
    // jsPDF's standard fonts are WinAnsi: the em dash is byte 0x97.
    return strings.join(' ').replace(/\x97/g, '—').replace(/\s+/g, ' ');
}

describe('PassagePdfService arrival light', () => {
    it('Newport → Lady Musgrave arriving 18:00 is after dark, as before', () => {
        // USNO Lady Musgrave (-23.907, 152.404, tz=10) 11 Aug 2026: End Civil
        // Twilight 17:55. Departure 06:00 + 36 h = 18:00 AEST.
        const note = arrivalLightNote(briefFixture());
        expect(note.timeZone).toBe('Australia/Brisbane');
        expect(note.daylight).toBe(false);
        expect(note.text).toContain('AFTER DARK');
        expect(note.text).toContain('Australia/Brisbane');
        expect(note.text).toContain('18:00');
        expect(
            note.lastLight?.toLocaleTimeString('en-GB', {
                timeZone: 'Australia/Brisbane',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
            }),
        ).toMatch(/^17:5[3-8]$/);
    });

    it('the same trip leaving two hours earlier arrives in daylight, as before', () => {
        const note = arrivalLightNote(briefFixture(at('2026-08-10T04:00:00+10:00', 36)));
        expect(note.daylight).toBe(true);
        expect(note.text).toContain('daylight');
        expect(note.text).toContain('16:00');
    });

    it('Sint Maarten at 18:30 local is after dark, whatever the phone clock reads', () => {
        // USNO Philipsburg (tz=-4) 7 Oct 2026: End Civil Twilight 18:18.
        // 22:30 UTC = 18:30 AST = 08:30 in Brisbane = 15:30 in Los Angeles.
        const note = arrivalLightNote(
            briefFixture({
                ...at('2026-10-07T12:30:00Z', 10),
                origin: { name: 'Gustavia', lat: 17.9, lon: -62.85 },
                destination: { name: 'Philipsburg', lat: 18.03, lon: -63.08 },
            }),
        );
        expect(note.timeZone).toBe('America/Lower_Princes');
        expect(note.daylight).toBe(false);
        expect(note.text).toContain('18:30');
        expect(note.text).toContain('America/Lower_Princes');
        expect(note.text).toContain('AFTER DARK');
    });

    it('Marseille at 14:00 local is daylight, whatever the phone clock reads', () => {
        // 12:00 UTC = 14:00 CEST = 22:00 in Brisbane.
        const note = arrivalLightNote(
            briefFixture({
                ...at('2026-10-07T02:00:00Z', 10),
                origin: { name: 'Porquerolles', lat: 43.0, lon: 6.2 },
                destination: { name: 'Marseille', lat: 43.3, lon: 5.37 },
            }),
        );
        expect(note.timeZone).toBe('Europe/Paris');
        expect(note.daylight).toBe(true);
        expect(note.text).toContain('14:00');
        expect(note.text).toContain('Europe/Paris');
        // USNO Marseille 7 Oct: End Civil Twilight 19:38.
        expect(note.text).toMatch(/Last light there is 19:(3[5-9]|4[0-1])/);
    });

    it('Tromsø at 23:00 in midsummer is light: no true night', () => {
        // USNO 21 Jun 2026: sun continuously above the horizon.
        const note = arrivalLightNote(
            briefFixture({
                ...at('2026-06-21T09:00:00Z', 12),
                origin: { name: 'Harstad', lat: 68.8, lon: 16.54 },
                destination: { name: 'Tromsø', lat: 69.65, lon: 18.96 },
            }),
        );
        expect(note.timeZone).toBe('Europe/Oslo');
        expect(note.daylight).toBe(true);
        expect(note.text).toContain('23:00');
        expect(note.text).toContain('no true night');
    });

    it('Tromsø at 00:40 in early May is twilight, with no true night: not “a daylight arrival”', () => {
        // USNO Tromsø (69.65, 18.96, tz=2), fetched 2026-10-07: 1 May 2026
        // sunset 22:06, 2 May sunrise 03:15, "Object continuously above the
        // Twilight Limit" both days. At 00:40 CEST the sun is about 5° down.
        for (const [departure, clock] of [
            ['2026-05-01T16:40:00Z', '00:40'],
            ['2026-05-01T15:45:00Z', '23:45'],
        ]) {
            const note = arrivalLightNote(
                briefFixture({
                    ...at(departure, 6),
                    origin: { name: 'Harstad', lat: 68.8, lon: 16.54 },
                    destination: { name: 'Tromsø', lat: 69.65, lon: 18.96 },
                }),
            );
            expect(note.daylight).toBe(true);
            expect(note.text).toContain(clock);
            expect(note.text).toContain('in civil twilight');
            expect(note.text).not.toContain('a daylight arrival');
            expect(note.text).toContain('no true night');
        }
    });

    it('an open-ocean rendezvous names its real offset, not the POSIX-signed Etc zone', () => {
        // tz-lookup gives 'Etc/GMT+3' at 30 N 40 W: POSIX signs, so UTC-3.
        // Printed as-is a reader takes it for UTC+3. 22:00 UTC = 19:00 there.
        const note = arrivalLightNote(
            briefFixture({
                ...at('2026-10-07T10:00:00Z', 12),
                origin: { name: 'Rendezvous A', lat: 31, lon: -42 },
                destination: { name: 'Rendezvous B', lat: 30, lon: -40 },
                turnWaypoints: undefined,
            }),
        );
        expect(note.timeZone).toBe('Etc/GMT+3');
        expect(note.text).toContain('19:00 (UTC-3 time)');
        expect(note.text).not.toContain('Etc/');
    });

    it('Tromsø at noon in midwinter is twilight, not daylight', () => {
        // USNO 21 Dec 2026 (tz=1): sun continuously below the horizon; civil
        // twilight 09:31 → 13:53.
        const note = arrivalLightNote(
            briefFixture({
                ...at('2026-12-21T05:00:00Z', 6),
                origin: { name: 'Skjervøy', lat: 70.03, lon: 20.97 },
                destination: { name: 'Tromsø', lat: 69.65, lon: 18.96 },
            }),
        );
        expect(note.daylight).toBe(true);
        expect(note.text).toContain('civil twilight');
        expect(note.text).not.toContain('a daylight arrival');
    });

    it('Longyearbyen in midwinter is after dark all day, and says so', () => {
        const note = arrivalLightNote(
            briefFixture({
                ...at('2026-12-21T05:00:00Z', 6),
                origin: { name: 'Barentsburg', lat: 78.07, lon: 14.21 },
                destination: { name: 'Longyearbyen', lat: 78.22, lon: 15.65 },
            }),
        );
        expect(note.daylight).toBe(false);
        expect(note.text).toContain('AFTER DARK');
        expect(note.text).toContain('all day');
    });
});

describe('PassagePdfService moonlight per night', () => {
    it('Newport → Lady Musgrave: one night, a thin moon, a dark night', () => {
        // USNO Lady Musgrave 11 Aug 2026: moonrise 04:57, civil dawn 05:56,
        // 4% illuminated (new moon 13 Aug). The 5 dark minutes before the
        // 18:00 arrival are under the half-hour floor.
        const lines = passageMoonlightLines(briefFixture());
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/^Night 1 \(Mon 10 Aug\)/);
        expect(lines[0]).toContain('A dark night');
    });

    it('Suva → Nukuʻalofa across the date line at full moon: every night bright', () => {
        // Full moon 26 Oct 2026 04:12 UTC (USNO). Departing 18:00 FJT 25 Oct.
        const lines = passageMoonlightLines(
            briefFixture({
                ...at('2026-10-25T06:00:00Z', 60),
                origin: { name: 'Suva', lat: -18.14, lon: 178.42 },
                destination: { name: 'Nukuʻalofa', lat: -21.14, lon: -175.2 },
                turnWaypoints: [{ name: 'Date line', lat: -19.6, lon: 180 }],
                totalDistanceNM: 400,
            }),
        );
        expect(lines.length).toBeGreaterThanOrEqual(2);
        expect(lines[0]).toMatch(/^Night 1 \(Sun 25 Oct\)/);
        for (const line of lines) expect(line).toContain('A bright night');
    });

    it('a midsummer Arctic passage has no nights to list', () => {
        const lines = passageMoonlightLines(
            briefFixture({
                ...at('2026-06-20T08:00:00Z', 48),
                origin: { name: 'Bodø', lat: 67.28, lon: 14.4 },
                destination: { name: 'Tromsø', lat: 69.65, lon: 18.96 },
                turnWaypoints: undefined,
            }),
        );
        expect(lines).toEqual([]);
    });

    it('the polar night gives one line per day, not one for the whole dark run', () => {
        // Tromsø → Longyearbyen in December: USNO has the sun continuously
        // below the horizon at both ends (21 Dec 2026), and at Longyearbyen
        // (78.22 N) below the civil twilight line too. Unsplit, three days of
        // dark read as one 67-hour "night", dated the 19th though it began
        // on the 18th.
        const lines = passageMoonlightLines(
            briefFixture({
                ...at('2026-12-18T08:00:00Z', 72),
                origin: { name: 'Tromsø', lat: 69.65, lon: 18.96 },
                destination: { name: 'Longyearbyen', lat: 78.22, lon: 15.65 },
                turnWaypoints: undefined,
                totalDistanceNM: 520,
            }),
        );
        // Measured: 22.2, 24.0 and 21.2 h of dark on the 18th, 19th and 20th
        // (plus half an hour before the 09:00 departure's civil dawn).
        expect(lines.length).toBeGreaterThanOrEqual(3);
        const hours = lines.map((l) => Number(/: ([\d.]+) h dark/.exec(l)?.[1]));
        for (const h of hours) expect(h).toBeLessThanOrEqual(24.05);
        expect(hours.reduce((a, b) => a + b, 0)).toBeGreaterThan(48);
        // Every line its own evening, in order.
        const dates = lines.map((l) => /^Night \d+ \(([^)]+)\)/.exec(l)?.[1]);
        expect(new Set(dates).size).toBe(dates.length);
        expect(dates).toEqual(expect.arrayContaining(['Fri 18 Dec', 'Sat 19 Dec', 'Sun 20 Dec']));
    });

    it('the PDF prints the destination-clock arrival note and the moonlight lines', async () => {
        // The brief itself, not just the exported helpers: Sint Maarten 18:30
        // AST is after dark on any phone clock (USNO end civil twilight 18:18).
        const blob = generatePassagePdf(
            briefFixture({
                ...at('2026-10-06T22:30:00Z', 24),
                origin: { name: 'English Harbour', lat: 17.0, lon: -61.76 },
                destination: { name: 'Philipsburg', lat: 18.03, lon: -63.08 },
                turnWaypoints: undefined,
                departureTides: undefined,
                arrivalTides: undefined,
                totalDistanceNM: 100,
            }),
        );
        const text = await pdfText(blob);
        expect(text).toContain('MOONLIGHT');
        expect(text).toMatch(/Night 1 \(Tue 6 Oct\): [\d.]+ h dark/);
        expect(text).toContain('18:30 (America/Lower_Princes time) — AFTER DARK (last light there 18:1');
        expect(text).toContain('ESTIMATED ARRIVAL (America/Lower_Princes)');
    });

    it('the PDF still renders with the moonlight section on a multi-night passage', () => {
        const blob = generatePassagePdf(
            briefFixture({
                ...at('2026-10-25T06:00:00Z', 60),
                origin: { name: 'Suva', lat: -18.14, lon: 178.42 },
                destination: { name: 'Nukuʻalofa', lat: -21.14, lon: -175.2 },
                turnWaypoints: [{ name: 'Date line', lat: -19.6, lon: 180 }],
            }),
        );
        expect(blob.size).toBeGreaterThan(5000);
    });
});
