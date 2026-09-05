/**
 * The float plan's overdue number is the one field on the page that gets
 * DIALLED by someone who is worried. This file exists to keep it honest.
 *
 * Shane, 2026-09-05: "can we auto fill the Raise the Alarm section of the Float
 * Plan claude with the closest marine rescue phone number."
 *
 * What was built is deliberately narrower than a squadron directory. Every
 * number in services/marineRescueDirectory.ts already existed in this repo
 * (components/passage/EmergencyPlan.tsx); none was sourced fresh or guessed.
 * It is also the correct call for an overdue vessel — a state coordination
 * centre is staffed and can task whoever is closest, while a volunteer
 * squadron's clubhouse line may be unattended.
 *
 * The boxes route a position to the most relevant PUBLISHED number. They do
 * not describe who is legally responsible for a search, and nothing may
 * present them as though they do.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MARINE_RESCUE_SERVICES, suggestMarineRescue } from '../services/marineRescueDirectory';

describe('suggestMarineRescue', () => {
    it('gives Shane the Queensland hotline at Newport, Moreton Bay', () => {
        const s = suggestMarineRescue(-27.2, 153.1);
        expect(s?.service.service).toBe('Marine Rescue Queensland');
        expect(s?.text).toBe('Marine Rescue Queensland · 131 677');
    });

    it('does not still carry the superseded VMR QLD number anywhere', () => {
        // VMR Queensland and the Australian Volunteer Coast Guard merged into
        // Marine Rescue Queensland (131 MRQ). Shane caught 07 3635 3600 still
        // sitting in the app on 2026-09-05. A stale number in an emergency
        // list is the worst place for one, so this hunts it across both homes.
        //
        // Comments stripped first: BOTH files record the correction in prose,
        // naming the old number so the next reader knows it was retired rather
        // than lost. A note about a dead number is not a dead number, and a
        // guard that cannot tell them apart would delete the explanation.
        const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        const emergency = readFileSync('components/passage/EmergencyPlan.tsx', 'utf8');
        for (const [file, src] of [
            ['marineRescueDirectory', readFileSync('services/marineRescueDirectory.ts', 'utf8')],
            ['EmergencyPlan', emergency],
        ] as const) {
            expect(strip(src), file).not.toContain('07 3635 3600');
        }
        expect(strip(emergency)).toContain('131 677');
    });

    it('covers the other states Shane sourced', () => {
        // Adelaide, and Fremantle.
        expect(suggestMarineRescue(-34.9, 138.5)?.service.service).toBe('SA SES Marine Rescue');
        expect(suggestMarineRescue(-32.05, 115.7)?.service.service).toBe('DFES Western Australia');
    });

    it('switches to NSW below the border, not at the country level', () => {
        expect(suggestMarineRescue(-33.85, 151.2)?.service.service).toBe('Marine Rescue NSW');
        // Lady Musgrave, on his Coral Sea leg — still Queensland.
        expect(suggestMarineRescue(-23.9, 152.4)?.service.service).toBe('Marine Rescue Queensland');
    });

    it('falls to the national coordinator offshore, where no state box reaches', () => {
        // Well east of the Queensland box but inside the Australian SRR.
        const s = suggestMarineRescue(-25.0, 160.0);
        expect(s?.service.service).toContain('AMSA');
    });

    it('prefers the state service over the national one where both cover', () => {
        const qld = suggestMarineRescue(-27.2, 153.1)!.service;
        const amsa = MARINE_RESCUE_SERVICES.find((x) => x.service.includes('AMSA'))!;
        expect(qld.rank).toBeGreaterThan(amsa.rank);
    });

    it('returns NULL rather than a guess where nothing covers', () => {
        // Mid-Pacific. There is no local number, and inventing one would be
        // worse than the blank field that makes someone look it up.
        expect(suggestMarineRescue(-10, -140)).toBeNull();
        // Southern Ocean.
        expect(suggestMarineRescue(-65, 90)).toBeNull();
    });

    it('refuses nonsense coordinates instead of matching a box by accident', () => {
        expect(suggestMarineRescue(Number.NaN, 153)).toBeNull();
        expect(suggestMarineRescue(-27, Number.POSITIVE_INFINITY)).toBeNull();
        expect(suggestMarineRescue(-999, 153)).toBeNull();
        expect(suggestMarineRescue(-27, 999)).toBeNull();
    });

    it('every entry carries a number, a coverage sentence and a sane box', () => {
        for (const s of MARINE_RESCUE_SERVICES) {
            expect(s.phone.trim(), s.service).not.toBe('');
            expect(s.coverage.trim(), s.service).not.toBe('');
            const [south, west, north, east] = s.box;
            expect(south, s.service).toBeLessThan(north);
            expect(west, s.service).toBeLessThan(east);
            expect(south, s.service).toBeGreaterThanOrEqual(-90);
            expect(north, s.service).toBeLessThanOrEqual(90);
        }
    });

    it('every number says where it was verified', () => {
        // The guard against a number arriving from nowhere. It used to require
        // that every entry already appeared in EmergencyPlan.tsx, which was
        // the best available check while nothing had been sourced fresh — and
        // it would have BLESSED the stale VMR QLD number, because that number
        // was in EmergencyPlan. "It is already in the app" is not provenance.
        // Naming the source is.
        for (const s of MARINE_RESCUE_SERVICES) {
            expect(s.source?.trim(), `${s.service} has no source`).toBeTruthy();
            expect(s.source.length, `${s.service}'s source is not a real citation`).toBeGreaterThan(12);
        }
    });
});

describe('the float plan field', () => {
    const sheet = readFileSync('components/vessel/FloatPlanSheet.tsx', 'utf8');

    it('suggests from the DEPARTURE waypoint, not the destination', () => {
        expect(sheet).toMatch(/const start = savedWaypoints\?\.\[0\];/);
        expect(sheet).toContain('suggestMarineRescue(start.lat, start.lon)');
    });

    it('never fills the field on its own — a tap does it', () => {
        // No effect may write this value. It is dialled in an emergency, and a
        // number that appeared while someone was typing is a number nobody
        // chose.
        expect(sheet).not.toMatch(/useEffect\([^)]*setWhoToCall/);
        expect(sheet).toMatch(/onClick=\{\(\) => \{\s*setWhoToCall\(rescueSuggestion\.text\);/);
    });

    it('drops the "suggested" note the moment a human edits it', () => {
        expect(sheet).toMatch(/setWhoToCall\(event\.target\.value\);\s*setRescueSuggestionUsed\(false\);/);
    });

    it('tells the skipper to check it, and stays required either way', () => {
        expect(sheet).toContain('published');
        expect(sheet).toMatch(/id="float-who"[\s\S]{0,600}required/);
    });
});
