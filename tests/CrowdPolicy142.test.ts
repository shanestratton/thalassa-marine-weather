import { describe, expect, it } from 'vitest';
import {
    CROWD_CONSENT_VERSION,
    parseCrowdCalibration,
    qualifyCrowdRow,
    reduceCrowdRow,
    requireCrowdRelease,
    type CrowdCalibration,
    type CrowdSource,
    type CrowdTide,
} from '../services/seabed/crowdPolicy';
import type { SeabedRow } from '../services/seabed/seabedCore';
const at = Date.UTC(2026, 8, 1, 12),
    now = at + 31 * 86400000;
const owner = '11111111-1111-4111-8111-111111111111',
    boat = '22222222-2222-4222-8222-222222222222';
const calibration: CrowdCalibration = {
    schema: 1,
    depthReference: 'T',
    depthSource: 'signalk:belowTransducer',
    sounderProduct: 'Fictional fixture sounder',
    measuredAt: at - 3600000,
    waterlineToTransducerM: 0.8,
    offsetUncertaintyM: 0.1,
    sounderUncertaintyM: 0.2,
    checkedDepthLimitM: 30,
    method: 'measured-offset-and-sounder-check',
};
const source: CrowdSource = {
    ownerId: owner,
    boatId: boat,
    batchId: '33333333-3333-4333-8333-333333333333',
    originalStoredSha256: 'a'.repeat(64),
    capturedStart: at,
    capturedEnd: at + 1000,
    eligibleAfter: at + 1000 + 30 * 86400000,
    meta: {
        time_source: 'gnss',
        depth_source: calibration.depthSource,
        surface_to_transducer_m: 0.8,
        draft_confirmed: true,
        vessel_draft_m: 2.4,
    },
    privacyZones: [],
    consent: {
        ownerId: owner,
        boatId: boat,
        revision: '44444444-4444-4444-8444-444444444444',
        consentVersion: CROWD_CONSENT_VERSION,
        mapEnabled: true,
        dcdbEnabled: false,
        effectiveFrom: at - 1000,
        calibration,
    },
};
const row: SeabedRow = {
    lon: 154,
    lat: -27,
    depth: 10,
    timeMs: at,
    depthRef: 'T',
    flags: 0,
    sogKn: 5,
    cogDeg: 45,
    hdgDeg: 45,
    heelDeg: 0,
    fixQ: 1,
    hdop: 1,
    sats: 8,
    posAgeMs: 100,
};
const tide: CrowdTide = {
    schema: 1,
    source: 'reviewed-official-observed',
    originalSha256: 'b'.repeat(64),
    station: 'fictional-fixture-only',
    hydroRegion: 'fictional-same-basin',
    datumId: 'fixture-station-MLLW-epoch',
    datumName: 'MLLW',
    verticalUnit: 'm',
    publiclyReusable: true,
    rightsReviewedAt: at - 86400000,
    rightsExpiresAt: now + 86400000,
    qc: 'verified',
    uncertaintyM: 0.2,
    samples: [
        [at - 600000, 1.2],
        [at + 600000, 1.6],
    ],
};
describe('separate public sounding policy', () => {
    it('reduces original transducer depth by one measured waterline offset and original tide, never vessel draft', () => {
        const reduced = reduceCrowdRow(source, row, tide, tide.hydroRegion, now);
        expect(reduced.depthM).toBeCloseTo(9.4, 12);
        expect(reduced.observedAt).toBe(at);
        expect(reduced.uncertaintyM).toBe(1);
        expect(reduced.contourIntervalM).toBe(0.5);
        expect(reduced.navigationAuthority).toBe(false);
        const waterline = {
            ...source,
            consent: { ...source.consent, calibration: { ...calibration, depthReference: 'W' as const } },
        };
        expect(
            reduceCrowdRow(waterline, { ...row, depth: 10.8, depthRef: 'W' }, tide, tide.hydroRegion, now).depthM,
        ).toBeCloseTo(9.4, 12);
    });
    it('phase1 consent, map-only permission, thirty-day hold and pre-consent captures never imply DCDB or historical release', () => {
        expect(() => requireCrowdRelease(source, 'dcdb', now)).toThrow(/separate owner permission/);
        for (const bad of [
            { ...source, consent: { ...source.consent, consentVersion: '2026-10-05' } },
            { ...source, consent: { ...source.consent, effectiveFrom: at + 1 } },
            { ...source, consent: { ...source.consent, mapEnabled: false } },
            { ...source, consent: { ...source.consent, ownerId: boat } },
            { ...source, eligibleAfter: at + 86400000 },
        ])
            expect(() => requireCrowdRelease(bad as CrowdSource, 'map', now)).toThrow();
        expect(() => requireCrowdRelease(source, 'map', source.eligibleAfter - 1)).toThrow();
        expect(() => requireCrowdRelease(source, 'map', NaN)).toThrow();
    });
    it('draft confirmation and sensor-reported offset cannot substitute for explicit sounder calibration', () => {
        expect(() =>
            requireCrowdRelease({ ...source, consent: { ...source.consent, calibration: null } }, 'map', now),
        ).toThrow();
        for (const bad of [
            { ...calibration, method: 'draft-confirmed' },
            { ...calibration, offsetUncertaintyM: 0 },
            { ...calibration, measuredAt: now + 1 },
            { ...calibration, unknown: true },
        ])
            expect(() => parseCrowdCalibration(bad, now)).toThrow();
        expect(() =>
            qualifyCrowdRow({ ...source, meta: { ...source.meta, surface_to_transducer_m: 2.4 } }, row, 'map', now),
        ).toThrow(/offset differs/);
    });
    it('refuses missing/current privacy state and applies current zones after the original private ingest', () => {
        const zone = { id: 'fixture', kind: 'home' as const, lat: -27, lon: 154, radius_m: 1000, jitter_m: 0 };
        expect(() => qualifyCrowdRow({ ...source, privacyZones: [zone] }, row, 'map', now)).toThrow(/privacy/);
        expect(() =>
            qualifyCrowdRow({ ...source, privacyZones: [{ ...zone, radius_m: NaN }] }, row, 'map', now),
        ).toThrow(/privacy/);
        expect(() =>
            qualifyCrowdRow({ ...source, meta: { ...source.meta, time_source: 'device-clock' } }, row, 'map', now),
        ).toThrow();
    });
    it.each([
        { flags: 128 },
        { flags: 4294967296 },
        { fixQ: 6 },
        { hdop: null },
        { sats: 3 },
        { posAgeMs: 3000 },
        { heelDeg: 11 },
        { depth: 31 },
        { depthRef: 'W' },
    ])('keeps unqualified original instrument rows out of publication: %j', (change) => {
        expect(() => qualifyCrowdRow(source, { ...row, ...change } as SeabedRow, 'map', now)).toThrow();
    });
    it('never substitutes WorldTides, unknown datum/region, receipt clocks or an unbracketed tide', () => {
        for (const bad of [
            { ...tide, source: 'worldtides' },
            { ...tide, datumId: '' },
            { ...tide, publiclyReusable: false },
            { ...tide, qc: 'preliminary' },
            { ...tide, rightsExpiresAt: now },
            { ...tide, verticalUnit: 'ft' },
            {
                ...tide,
                samples: [
                    [at + 1, 1],
                    [at + 1000, 2],
                ],
            },
        ])
            expect(() => reduceCrowdRow(source, row, bad as CrowdTide, tide.hydroRegion, now)).toThrow();
        expect(() => reduceCrowdRow(source, row, tide, 'other-basin', now)).toThrow();
    });
});
