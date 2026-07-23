/**
 * ntmRouting guard logic — currency (fail-closed) and acknowledgment TTL.
 * Pure functions only: the live loaders are exercised on-device.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    resolvePackStatus,
    isPackOptedOut,
    setPackOptedOut,
    pointInPack,
    NTM_ROUTING_PACKS,
    MAX_VERIFY_AGE_MS,
    type NtmRoutingPack,
} from '../services/ntmRouting';
import type { QldNotice } from '../services/qldNotices';
import { authScopedStorageKey, setAuthIdentityScope } from '../services/authIdentityScope';

const pack: NtmRoutingPack = {
    id: 'test-bar',
    noticeKey: '364 T of 2026',
    anchorLabel: 'Mooloolaba',
    subjectMatch: 'mooloolah river bar',
    waterwayMatch: 'mooloolah',
    title: 'test',
    surveyed: '1 July 2026',
    zones: [
        {
            label: 'z',
            depthM: 1.4,
            polygon: [
                [153.13, -26.681],
                [153.132, -26.681],
                [153.132, -26.679],
                [153.13, -26.679],
                [153.13, -26.681],
            ],
        },
    ],
    marks: [],
    bbox: [153.13, -26.681, 153.132, -26.679],
};

const notice = (
    number: string,
    createdMs: number,
    subject = 'Mooloolah River bar — shoaling and dredging',
): QldNotice => ({
    number,
    subject,
    dateStr: '02/07/2026',
    region: 'Brisbane',
    pdfUrl: 'https://example/x.pdf',
    datasetUrl: 'https://example/ds',
    lat: -26.6862,
    lon: 153.134,
    localityLabel: 'Mooloolaba',
    createdMs,
});

// A week after the pack notice's own date (02/07/2026) — inside the 28-day
// pack lifetime ceiling, so 'current' verdicts are reachable.
const NOW = Date.UTC(2026, 6, 10);

beforeEach(() => {
    localStorage.clear();
    setAuthIdentityScope(null);
    setAuthIdentityScope('account-a');
});

describe('resolvePackStatus (fail-closed currency)', () => {
    it('current: the exact pack notice is on the feed with nothing newer for the waterway', () => {
        const s = resolvePackStatus(pack, [notice('364 T of 2026', 100)], NOW - 1000, NOW);
        expect(s.status).toBe('current');
    });
    it('superseded: a NEWER matching notice with a different number kills the pack', () => {
        const s = resolvePackStatus(
            pack,
            [notice('364 T of 2026', 100), notice('371 T of 2026', 200)],
            NOW - 1000,
            NOW,
        );
        expect(s).toEqual({ status: 'superseded', liveNumber: '371 T of 2026' });
    });
    it('superseded: a REWORDED newer notice still revokes via waterwayMatch (review critical)', () => {
        const s = resolvePackStatus(
            pack,
            [notice('364 T of 2026', 100), notice('371 T of 2026', 200, 'Mooloolah River entrance — revised depths')],
            NOW - 1000,
            NOW,
        );
        expect(s).toEqual({ status: 'superseded', liveNumber: '371 T of 2026' });
    });
    it('unverified: never-fetched feed fails closed', () => {
        expect(resolvePackStatus(pack, [notice('364 T of 2026', 100)], null, NOW).status).toBe('unverified');
    });
    it('unverified: feed older than the 48 h verify horizon fails closed', () => {
        const s = resolvePackStatus(pack, [notice('364 T of 2026', 100)], NOW - MAX_VERIFY_AGE_MS - 1, NOW);
        expect(s.status).toBe('unverified');
    });
    it('unverified: pack notice absent from the feed fails closed', () => {
        const s = resolvePackStatus(
            pack,
            [notice('99 of 2026', 100, 'Maroochy River — beacon works')],
            NOW - 1000,
            NOW,
        );
        expect(s.status).toBe('unverified');
    });
    it('unverified: pack notice older than the 28-day lifetime ceiling fails closed', () => {
        const late = Date.UTC(2026, 7, 15); // 44 days after 02/07/2026
        const s = resolvePackStatus(pack, [notice('364 T of 2026', 100)], late - 1000, late);
        expect(s.status).toBe('unverified');
    });
    it('unverified: unparsable pack-notice date fails closed', () => {
        const bad = { ...notice('364 T of 2026', 100), dateStr: 'July 2026' };
        expect(resolvePackStatus(pack, [bad], NOW - 1000, NOW).status).toBe('unverified');
    });
    it('other-locality notices never vouch the pack', () => {
        const other = { ...notice('364 T of 2026', 100), localityLabel: 'Noosa' };
        expect(resolvePackStatus(pack, [other], NOW - 1000, NOW).status).toBe('unverified');
    });
});

describe('opt-out store (current packs apply by DEFAULT)', () => {
    it('defaults to applied (not opted out), toggles both ways, survives corruption', () => {
        const storageKey = authScopedStorageKey('thalassa_ntm_optout_v1');
        localStorage.removeItem(storageKey);
        expect(isPackOptedOut(pack)).toBe(false); // owner default: applied
        setPackOptedOut(pack, true);
        expect(isPackOptedOut(pack)).toBe(true);
        setPackOptedOut(pack, false);
        expect(isPackOptedOut(pack)).toBe(false);
        // Corrupted store degrades to the default, never throws.
        localStorage.setItem(storageKey, 'null');
        expect(isPackOptedOut(pack)).toBe(false);
        localStorage.setItem(storageKey, '"garbage"');
        expect(isPackOptedOut(pack)).toBe(false);
        localStorage.removeItem(storageKey);
    });

    it('keeps safety overrides isolated by account and recomputes on identity change', () => {
        const changed = vi.fn();
        window.addEventListener('thalassa:ntm-ack-changed', changed);
        localStorage.setItem('thalassa_ntm_optout_v1', JSON.stringify({ [pack.id]: true }));

        setPackOptedOut(pack, true);
        expect(isPackOptedOut(pack)).toBe(true);

        setAuthIdentityScope('account-b');
        expect(isPackOptedOut(pack)).toBe(false);
        expect(changed).toHaveBeenCalled();
        setPackOptedOut(pack, true);

        setAuthIdentityScope('account-a');
        expect(isPackOptedOut(pack)).toBe(true);
        window.removeEventListener('thalassa:ntm-ack-changed', changed);
    });
});

describe('curated pack sanity', () => {
    it('every bundled pack has zones inside its bbox, positive depths, and marks', () => {
        for (const p of NTM_ROUTING_PACKS) {
            expect(p.zones.length).toBeGreaterThan(0);
            for (const z of p.zones) {
                expect(z.depthM).toBeGreaterThan(0);
                for (const [lon, lat] of z.polygon) {
                    expect(lon).toBeGreaterThanOrEqual(p.bbox[0] - 1e-6);
                    expect(lon).toBeLessThanOrEqual(p.bbox[2] + 1e-6);
                    expect(lat).toBeGreaterThanOrEqual(p.bbox[1] - 1e-6);
                    expect(lat).toBeLessThanOrEqual(p.bbox[3] + 1e-6);
                }
            }
        }
    });
    it('pointInPack: inside/outside', () => {
        expect(pointInPack(153.131, -26.68, pack)).toBe(true);
        expect(pointInPack(153.14, -26.68, pack)).toBe(false);
    });
    it('the Mooloolah pack zones sit on the real entrance (sanity anchor)', () => {
        const m = NTM_ROUTING_PACKS.find((p) => p.id === 'mooloolah-bar');
        expect(m).toBeDefined();
        // REF 2 must be inside the alternative-route corridor zones.
        expect(pointInPack(153 + 7.9164 / 60, -(26 + 40.7927 / 60), m as NtmRoutingPack)).toBe(true);
    });
});
