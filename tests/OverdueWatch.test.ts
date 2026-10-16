import { describe, it, expect } from 'vitest';
import {
    evaluateOverdue,
    parseOverdueConfiguration,
    parseOverduePlan,
    parseOverdueState,
    overduePlanWords,
    overduePositionWords,
    parseOverdueNotice,
} from '../utils/overdueWatch';
import { reviewedRescueWords, MARINE_RESCUE_SERVICES } from '../services/marineRescueDirectory';
const now = 1800000000000,
    id = '10000000-0000-4000-8000-000000000001',
    revision = '20000000-0000-4000-8000-000000000001';
const plan = () => ({
    vesselLabel: 'Generic vessel',
    from: 'Departure',
    to: 'Destination',
    departureAt: now - 3600000,
    etaAt: null,
    overdueAt: now - 1000,
    persons: 2,
});
const cfg = () => ({
    enabled: true,
    plan: plan(),
    contacts: [{ id, revision }],
    sharePosition: false,
    rescueRegion: null,
});
const state = () => ({ ownerQueuedAt: null, ownerAttemptedAt: null, contactsQueuedAt: null, endedAt: null });
describe('explicit overdue state', () => {
    it('owner queue is not an attempted or delivered message; grace starts at actual attempt', () => {
        expect(evaluateOverdue(cfg(), state(), now).action).toBe('owner');
        const queued = { ...state(), ownerQueuedAt: now - 1000 };
        expect(evaluateOverdue(cfg(), queued, now).reason).toBe('awaiting-owner-attempt');
        const attempted = { ...queued, ownerAttemptedAt: now };
        expect(evaluateOverdue(cfg(), attempted, now + 599999).action).toBeNull();
        expect(evaluateOverdue(cfg(), attempted, now + 600000).action).toBe('contacts');
        expect(evaluateOverdue(cfg(), { ...attempted, contactsQueuedAt: now + 600000 }, now + 600000).reason).toBe(
            'notices-queued',
        );
    });
    it('off, explicit arrival/cancel and expired historical plan never escalate', () => {
        expect(evaluateOverdue({ ...cfg(), enabled: false }, state(), now).reason).toBe('off');
        expect(evaluateOverdue(cfg(), { ...state(), endedAt: now }, now).reason).toBe('ended');
        expect(evaluateOverdue(cfg(), state(), now + 86400000).reason).toBe('expired-review-required');
        expect(evaluateOverdue({ ...cfg(), plan: { ...plan(), overdueAt: now + 10000 } }, state(), now).reason).toBe(
            'not-due',
        );
    });
    it('unknown/missing/future clocks never become zero or a fresh grace receipt', () => {
        for (const s of [
            { ...state(), ownerAttemptedAt: now },
            { ...state(), ownerQueuedAt: now + 1 },
            { ...state(), ownerQueuedAt: 0 },
            { ...state(), ownerQueuedAt: now, ownerAttemptedAt: now - 1 },
        ])
            expect(evaluateOverdue(cfg(), s, now).reason).toBe('unknown');
        expect(
            parseOverdueState({
                ...state(),
                ownerQueuedAt: now - 1000,
                ownerAttemptedAt: now,
                contactsQueuedAt: now + 599999,
            }),
        ).toBeNull();
    });
    it('allows only bounded compact source and explicit contacts, with future arming review', () => {
        expect(parseOverdueConfiguration(cfg())).not.toBeNull();
        for (const c of [
            { ...cfg(), medicalNotes: 'private' },
            { ...cfg(), contacts: [] },
            { ...cfg(), contacts: Array.from({ length: 11 }, () => ({ id, revision })) },
            {
                ...cfg(),
                contacts: [
                    { id, revision },
                    { id, revision },
                ],
            },
            { ...cfg(), rescueRegion: 'worldwide' },
            { ...cfg(), plan: { ...plan(), persons: 0 } },
            { ...cfg(), plan: { ...plan(), from: 'x\r\nheader' } },
        ])
            expect(parseOverdueConfiguration(c)).toBeNull();
        expect(parseOverdueConfiguration(cfg(), now, true)).toBeNull();
        expect(
            parseOverdueConfiguration({ ...cfg(), plan: { ...plan(), overdueAt: now + 600000 } }, now, true),
        ).not.toBeNull();
        expect(parseOverduePlan({ ...plan(), waypoints: [] })).toBeNull();
    });
    it('last position remains an original-clock saved report, including valid0,0 and unknowns', () => {
        expect(overduePositionWords({ lat: 0, lon: 0, at: now - 7200000 }, now)).toContain('120 minutes old');
        expect(overduePositionWords({ lat: 0, lon: 0, at: now - 7200000 }, now)).toContain('not live tracking');
        for (const p of [
            null,
            { lat: 0, lon: 0, at: null },
            { lat: 91, lon: 0, at: now },
            { lat: 0, lon: 0, at: now + 1 },
            { lat: 0, lon: 0, at: now - 86400001 },
        ])
            expect(overduePositionWords(p, now)).toContain('unavailable');
        expect(overduePlanWords(plan())).toContain('not proof of distress');
    });
    it('requires exact fixed ordinary owner notice identity and finite future expiry', () => {
        const n = { overdue_watch: 1, boatId: id, revision, overdueAt: now - 1000, expiresAt: now + 600000 };
        expect(parseOverdueNotice(n, now)).not.toBeNull();
        for (const p of [
            { expiresAt: now },
            { expiresAt: now + 600001 },
            { overdueAt: now + 1 },
            { boatId: 'other' },
            { url: 'arbitrary' },
        ])
            expect(parseOverdueNotice({ ...n, ...p }, now)).toBeNull();
    });
    it('rescue advice is manual, typed and region reviewed; local short numbers have caller-context warnings', () => {
        expect(reviewedRescueWords(null)).toContain('unavailable');
        expect(reviewedRescueWords('au')).toContain('+61 2 6230 6811');
        expect(reviewedRescueWords('us')).toContain('caller location');
        expect(reviewedRescueWords('nz')).toContain('+64 4 577 8030');
        expect(reviewedRescueWords('unknown')).toContain('unavailable');
        const q = MARINE_RESCUE_SERVICES.find((s) => s.service === 'Marine Rescue Queensland')!;
        expect(q.purpose).toBe('assistance');
        expect(q.source).toBe('https://www.mrq.qld.gov.au/contact-us');
        expect(MARINE_RESCUE_SERVICES.find((s) => s.service === 'US Coast Guard')?.phone).toBe(
            '911 (within United States)',
        );
    });
});
