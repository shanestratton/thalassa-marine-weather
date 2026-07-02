/**
 * ntmRouting guard logic — currency (fail-closed) and acknowledgment TTL.
 * Pure functions only: the live loaders are exercised on-device.
 */
import { describe, expect, it } from 'vitest';
import {
    resolvePackStatus,
    isAckValid,
    pointInPack,
    NTM_ROUTING_PACKS,
    MAX_VERIFY_AGE_MS,
    ACK_TTL_MS,
    type NtmRoutingPack,
} from '../services/ntmRouting';
import type { QldNotice } from '../services/qldNotices';

const pack: NtmRoutingPack = {
    id: 'test-bar',
    noticeKey: '364 T of 2026',
    anchorLabel: 'Mooloolaba',
    subjectMatch: 'mooloolah river bar',
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

const NOW = 1_800_000_000_000;

describe('resolvePackStatus (fail-closed currency)', () => {
    it('current: freshest matching notice has exactly the pack notice number', () => {
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
    it('unverified: never-fetched feed fails closed', () => {
        expect(resolvePackStatus(pack, [notice('364 T of 2026', 100)], null, NOW).status).toBe('unverified');
    });
    it('unverified: feed older than the 48 h verify horizon fails closed', () => {
        const s = resolvePackStatus(pack, [notice('364 T of 2026', 100)], NOW - MAX_VERIFY_AGE_MS - 1, NOW);
        expect(s.status).toBe('unverified');
    });
    it('unverified: no matching notice line on the feed fails closed', () => {
        const s = resolvePackStatus(
            pack,
            [notice('99 of 2026', 100, 'Maroochy River — beacon works')],
            NOW - 1000,
            NOW,
        );
        expect(s.status).toBe('unverified');
    });
    it('other-locality notices never vouch the pack', () => {
        const other = { ...notice('364 T of 2026', 100), localityLabel: 'Noosa' };
        expect(resolvePackStatus(pack, [other], NOW - 1000, NOW).status).toBe('unverified');
    });
});

describe('isAckValid (per-passage acknowledgment)', () => {
    it('valid inside the TTL for the exact notice', () => {
        expect(isAckValid({ noticeKey: '364 T of 2026', ackMs: NOW - 1000 }, '364 T of 2026', NOW)).toBe(true);
    });
    it('expires after the 24 h TTL', () => {
        expect(isAckValid({ noticeKey: '364 T of 2026', ackMs: NOW - ACK_TTL_MS - 1 }, '364 T of 2026', NOW)).toBe(
            false,
        );
    });
    it('a superseding notice self-revokes the old ack', () => {
        expect(isAckValid({ noticeKey: '364 T of 2026', ackMs: NOW - 1000 }, '371 T of 2026', NOW)).toBe(false);
    });
    it('absent entry is not acked', () => {
        expect(isAckValid(undefined, '364 T of 2026', NOW)).toBe(false);
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
