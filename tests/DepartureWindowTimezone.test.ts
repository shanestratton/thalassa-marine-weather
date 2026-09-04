/**
 * A departure window means the same instant wherever the skipper is standing.
 *
 * Open-Meteo is asked for `timezone: auto`, so its hourly timestamps read in
 * the DESTINATION's own hours and carry no offset: "2026-09-06T14:00". The
 * acceptance path then did `new Date(win.time).toISOString()`, which resolves
 * that string in the DEVICE's zone — so planning a Whitsundays passage from
 * the UK accepted a departure hours away from the one on screen (audit
 * 2026-09-04, item 5).
 *
 * The window now carries `timeUtc` — the same instant, absolute — and the card
 * accepts from that. Local stays for display, which is the rule the watch
 * times already follow.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const svc = readFileSync('services/WeatherWindowService.ts', 'utf8');
const card = readFileSync('components/passage/WeatherWindowCard.tsx', 'utf8');

/** The conversion the service performs, restated independently. */
function toUtcIso(local: string, utcOffsetSeconds: number): string {
    return new Date(Date.parse(`${local}Z`) - utcOffsetSeconds * 1000).toISOString();
}

describe('departure windows carry an absolute instant', () => {
    it('converts a location-local time through the location offset', () => {
        // Whitsundays: UTC+10. 14:00 local is 04:00Z, whatever the phone says.
        expect(toUtcIso('2026-09-06T14:00', 10 * 3600)).toBe('2026-09-06T04:00:00.000Z');
        // And a western offset goes the other way.
        expect(toUtcIso('2026-09-06T14:00', -5 * 3600)).toBe('2026-09-06T19:00:00.000Z');
    });

    it('a missing offset means UTC, not the device zone', () => {
        expect(toUtcIso('2026-09-06T14:00', 0)).toBe('2026-09-06T14:00:00.000Z');
        expect(svc).toMatch(/Number\.isFinite\(wind\.utc_offset_seconds\)/);
    });

    it('the service asks for the offset it needs to do this', () => {
        expect(svc).toMatch(/utc_offset_seconds\?: number;/);
        expect(svc).toMatch(/timeUtc: toUtcIso\(times\[i\]\)/);
    });

    it('acceptance uses timeUtc, never the bare local string', () => {
        expect(card).toMatch(/const departureSource = win\?\.timeUtc \?\? win\?\.time;/);
        expect(card).not.toMatch(/new Date\(win\.time\)\.toISOString\(\)/);
    });
});
