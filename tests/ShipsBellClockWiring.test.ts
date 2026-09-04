/**
 * The clock is wired into the panel, and its alarm cannot fire an hour out.
 *
 * The one bug this feature could have that would actually matter: the face
 * shows a chosen zone (UTC, say) while the phone's alarm fires on the phone's
 * own clock — so an alarm computed from the DISPLAYED time would wake the
 * skipper an hour early or late, silently, on exactly the night they were
 * relying on it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync('components/nmea/TheGlassPage.tsx', 'utf8');
const clock = readFileSync('components/nmea/gauges/ShipsBellClock.tsx', 'utf8');

describe("the ship's bell clock in the instrument panel", () => {
    it('is a section, and the dot rail knows about it', () => {
        expect(page).toMatch(/── SECTION: CLOCK ──/);
        const rail = page.match(/const base = \[([^\]]+)\]/);
        expect(rail).not.toBeNull();
        expect((rail as RegExpMatchArray)[1]).toContain("'Clock'");
    });

    it('reads the phone and shows which zone it is keeping', () => {
        // A clock showing a time without saying WHICH time is the one thing a
        // clock must never do.
        expect(page).toMatch(/const zoneClock = clockInZone\(clockNow, clockZone\)/);
        expect(page).toMatch(/zoneLabel=\{zoneClock\.label\}/);
        expect(clock).toMatch(/\{zoneLabel\}/);
    });

    it('ticks every second, and clears its interval', () => {
        const tick = page.slice(page.indexOf('const [clockNow'), page.indexOf('const [clockZone'));
        expect(tick).toMatch(/setInterval\(\(\) => setClockNow\(new Date\(\)\), 1000\)/);
        expect(tick).toMatch(/return \(\) => clearInterval\(id\)/);
    });

    it('remembers the chosen zone across launches', () => {
        expect(page).toMatch(/localStorage\.setItem\('thalassa_clock_zone', clockZone\)/);
        expect(page).toMatch(/localStorage\.getItem\('thalassa_clock_zone'\)/);
    });

    it('computes alarms from the DEVICE clock, never the displayed zone', () => {
        const choices = page.slice(page.indexOf('const alarmChoices'), page.indexOf('const handleSetBellAlarm'));
        // nextBellFrom/Date arithmetic on clockNow — the device's own instant.
        expect(choices).toMatch(/nextBellFrom\(clockNow\)/);
        // The displayed-zone reading must not leak into the alarm time.
        expect(choices).not.toMatch(/zoneClock/);
    });

    it("its alarms cannot reach the crew's assigned watch alarms", () => {
        const service = readFileSync('services/ShipsBellAlarmService.ts', 'utf8');
        expect(service).toMatch(/const ID_BASE = 910_000_000;/);
        // cancel() refuses any id outside this service's own band.
        expect(service).toMatch(/if \(id < ID_BASE \|\| id >= ID_BASE \+ MAX_ALARMS\) return;/);
    });

    it('refuses to "set" an alarm in the past rather than silently doing nothing', () => {
        const service = readFileSync('services/ShipsBellAlarmService.ts', 'utf8');
        expect(service).toMatch(/if \(!Number\.isFinite\(when\) \|\| when <= Date\.now\(\)\)/);
    });

    it('the zone select and the alarm controls meet the touch floor', () => {
        // Scoped to BELLS, where the controls live since the clock was split
        // onto its own page (2026-09-04). The old slice ran from CLOCK to SAIL
        // PLAN, which after the split swallowed Wind, Barometer, Position and
        // every other section between them.
        const section = page.slice(page.indexOf('── SECTION: BELLS ──'), page.indexOf('── SECTION: WIND ──'));
        expect(section.length).toBeGreaterThan(0);
        // Every interactive control in the section carries the 44px floor.
        // Matched by WINDOW rather than by tag: a non-greedy tag pattern stops
        // at the '>' inside an arrow function, and silently passed by reading
        // only half the tag.
        const starts = [...section.matchAll(/<(select|button)\b/g)].map((m) => m.index ?? 0);
        expect(starts.length).toBeGreaterThan(0);
        for (const at of starts) {
            expect(section.slice(at, at + 700)).toMatch(/min-h-\[44px\]/);
        }
    });
});
