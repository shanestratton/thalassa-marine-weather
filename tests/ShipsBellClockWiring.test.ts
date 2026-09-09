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
    it('is the first section', () => {
        // The dot rail that used to list it went on 2026-09-09; the section
        // markers are the order now.
        const sections = [...page.matchAll(/── SECTION: ([^─]+?)──/g)].map((m) => m[1].split('(')[0].trim());
        expect(sections[0]).toBe('CLOCK');
    });

    it('has no Bells page any more — its switches live in Preferences and the panel follows them', () => {
        // Shane 2026-09-09: "get rid of the bells page". The clock stays and
        // still strikes; the on/off, Test and zone controls moved to Settings →
        // Preferences (the home for toggles). The panel must follow a change
        // made there while it is open, or the skipper flips a switch and hears
        // nothing until a relaunch.
        expect(page).not.toMatch(/── SECTION: BELLS ──/);
        expect(page).not.toMatch(/ShipsBellReference/);
        expect(page).toMatch(/window\.addEventListener\(SHIP_CLOCK_PREFS_EVENT, onPrefs\)/);
        expect(page).toMatch(/setBellsOn\(prefs\.bellsOn\)/);
        expect(page).toMatch(/setClockZone\(prefs\.zone\)/);
        const general = readFileSync('components/settings/GeneralTab.tsx', 'utf8');
        expect(general).toMatch(/<ShipClockSection \/>/);
        const section = readFileSync('components/settings/ShipClockSection.tsx', 'utf8');
        // Same keys the panel reads, so the two never disagree.
        const prefs = readFileSync('services/shipClockPrefs.ts', 'utf8');
        expect(prefs).toMatch(/CLOCK_ZONE_KEY = 'thalassa_clock_zone'/);
        expect(prefs).toMatch(/CLOCK_BELLS_KEY = 'thalassa_clock_bells'/);
        // Test strikes what the FACE shows (zone-aware), and unlocks audio on
        // the tap — the two rules the Bells page used to carry.
        expect(section).toMatch(/await ShipsBellChime\.unlock\(\)/);
        expect(section).toMatch(/clockInZone\(new Date\(\), effectiveZone\)/);
        expect(section).toMatch(/prefs\.zone === SHIP_ZONE_AUTO \? \(shipZone \?\? deviceTimeZone\(\)\) : prefs\.zone/);
    });

    it('reads the phone and shows which zone it is keeping', () => {
        // A clock showing a time without saying WHICH time is the one thing a
        // clock must never do.
        // Ship's time follows the BOAT's position by default (Shane 2026-09-06);
        // a picked zone still wins, and the phone is the fallback while no
        // position has been seen.
        expect(page).toMatch(/const zoneClock = clockInZone\(clockNow, effectiveZone\)/);
        expect(page).toMatch(/localStorage\.getItem\('thalassa_clock_zone'\) \|\| SHIP_ZONE_AUTO/);
        expect(page).toMatch(/clockZone === SHIP_ZONE_AUTO \? \(shipZone \?\? deviceTimeZone\(\)\) : clockZone/);
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

    it('computes watch alarms from the watch\u2019s own UTC start, never the displayed zone', () => {
        // The generic "next bell / next watch change" chips are gone: the Wake
        // Me pills are now driven by THIS crew member's assigned watch
        // (services/myWatches), so the alarm time comes from that watch's
        // concrete UTC start minus a lead, not from anything the face shows.
        // A displayed zone leaking in here would wake a skipper an hour out.
        const at = page.indexOf('const handleWakeForWatch');
        expect(at, 'the wake handler moved or was renamed').toBeGreaterThan(-1);
        const handler = page.slice(at, at + 1200);
        expect(handler.length).toBeGreaterThan(0);
        expect(handler).toMatch(/watch\.startsAt\.getTime\(\) - lead\.minutes \* 60_000/);
        expect(handler).not.toMatch(/zoneClock/);
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

    it('the zone select and the bell controls meet the touch floor', () => {
        // The controls lived on the panel's BELLS page from 2026-09-04 until
        // Shane dropped that page (2026-09-09: "get rid of the bells page");
        // they are now Settings → Preferences → Ship's clock. Same floor.
        const section = readFileSync('components/settings/ShipClockSection.tsx', 'utf8');
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
