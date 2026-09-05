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
    it('gives Shane the Queensland number at Newport, Moreton Bay', () => {
        const s = suggestMarineRescue(-27.2, 153.1);
        expect(s?.service.service).toBe('Volunteer Marine Rescue QLD');
        expect(s?.text).toBe('Volunteer Marine Rescue QLD · 07 3635 3600');
    });

    it('switches to NSW below the border, not at the country level', () => {
        expect(suggestMarineRescue(-33.85, 151.2)?.service.service).toBe('Marine Rescue NSW');
        // Lady Musgrave, on his Coral Sea leg — still Queensland.
        expect(suggestMarineRescue(-23.9, 152.4)?.service.service).toBe('Volunteer Marine Rescue QLD');
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

    it('every number it can suggest already existed in the app', () => {
        // The guard against a number arriving from nowhere. If an entry is
        // added, its source belongs in EmergencyPlan too — or this test should
        // be replaced by one that names where it was verified.
        const known = readFileSync('components/passage/EmergencyPlan.tsx', 'utf8');
        for (const s of MARINE_RESCUE_SERVICES) {
            expect(known, `${s.service} — ${s.phone} is not in EmergencyPlan`).toContain(s.phone);
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
