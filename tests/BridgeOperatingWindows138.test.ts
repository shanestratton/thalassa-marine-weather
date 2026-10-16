import { describe, expect, it } from 'vitest';
import {
    assessBridgeOpening,
    isReviewedBridgeOpening,
    REVIEWED_BRIDGE_OPERATIONS,
    type BridgeOpeningRequest,
    type ReviewedBridgeOperations,
} from '../services/routing/bridgeOperatingWindows';
const T = Date.parse('2026-10-17T06:00:00Z'),
    HOUR = 3600000;
const request = (): BridgeOpeningRequest => ({
    lifetimeKey: 'fictional-lifetime',
    boatId: 'fictional-boat',
    bridgeFeatureKey: 'FICTIONAL-BRIDGE',
    chartContentKey: 'FICTIONAL-CELL@1',
    fromMs: T + HOUR,
    untilMs: T + HOUR + 300000,
    nowMs: T,
});
const record = (): ReviewedBridgeOperations => ({
    reviewId: 'FICTIONAL-OPERATING-REVIEW',
    bridgeFeatureKey: 'FICTIONAL-BRIDGE',
    chartContentKey: 'FICTIONAL-CELL@1',
    revision: 'FICTIONAL-REVISION-1',
    sourceReference: 'https://www.ecfr.gov/fictional-test-record',
    sourcePublishedAtMs: T - 100 * HOUR,
    timezone: 'Europe/London',
    effectiveFromMs: T - HOUR,
    effectiveUntilMs: T + 24 * HOUR,
    deviationsCheckedAtMs: T - 60000,
    expiresAtMs: T + HOUR,
    maxCheckAgeMs: 2 * HOUR,
    closureState: 'none-reported',
    noticeMs: 0,
    intervals: [
        { openMs: T + HOUR, closeMs: T + HOUR + 600000 },
        { openMs: T + 2 * HOUR, closeMs: T + 2 * HOUR + 600000 },
    ],
});
describe('reviewed explicit bridge opening intervals', () => {
    it('qualifies a fictional reviewed full crossing while still requiring the actual span opening', () => {
        const result = assessBridgeOpening(request(), null, [record()]);
        expect(result).toMatchObject({
            kind: 'opening-required',
            requiresActualOpening: true,
            scheduledOpenMs: T + HOUR,
        });
        expect(isReviewedBridgeOpening(result, request())).toBe(true);
        expect(isReviewedBridgeOpening(JSON.parse(JSON.stringify(result)), request())).toBe(false);
        expect(isReviewedBridgeOpening({ ...result }, request())).toBe(false);
        expect(isReviewedBridgeOpening(result, { ...request(), lifetimeKey: 'next-generation' })).toBe(false);
        expect(isReviewedBridgeOpening(result, { ...request(), nowMs: T + HOUR })).toBe(false);
        expect(REVIEWED_BRIDGE_OPERATIONS).toEqual([]);
        expect(assessBridgeOpening(request()).kind).toBe('unavailable');
    });
    it('does not join distinct UTC slots, round a close outward or make a timezone recurrence', () => {
        expect(assessBridgeOpening({ ...request(), untilMs: T + HOUR + 600001 }, null, [record()]).kind).toBe('closed');
        expect(
            assessBridgeOpening({ ...request(), fromMs: T + HOUR + 600000, untilMs: T + 2 * HOUR }, null, [record()])
                .kind,
        ).toBe('closed');
        expect(
            assessBridgeOpening({ ...request(), fromMs: T + 2 * HOUR, untilMs: T + 2 * HOUR + 300000 }, null, [
                record(),
            ]).kind,
        ).toBe('opening-required');
        expect(assessBridgeOpening(request(), null, [{ ...record(), timezone: 'Unknown/Timezone' }]).kind).toBe(
            'unavailable',
        );
    });
    it('keeps stale/unknown temporary-deviation status and overlapping/incomplete source intervals unknown', () => {
        expect(assessBridgeOpening(request(), null, [{ ...record(), closureState: 'unknown' }]).kind).toBe(
            'unavailable',
        );
        expect(assessBridgeOpening(request(), null, [{ ...record(), closureState: 'closed' }]).kind).toBe('closed');
        expect(assessBridgeOpening(request(), null, [{ ...record(), deviationsCheckedAtMs: T - 3 * HOUR }]).kind).toBe(
            'unavailable',
        );
        expect(assessBridgeOpening(request(), null, [{ ...record(), sourcePublishedAtMs: T + 1 }]).kind).toBe(
            'unavailable',
        );
        expect(
            assessBridgeOpening(request(), null, [
                { ...record(), intervals: [record().intervals[0], record().intervals[0]] },
            ]).kind,
        ).toBe('unavailable');
        expect(assessBridgeOpening(request(), null, [record(), record()]).kind).toBe('unavailable');
    });
    it('requires source-specific operator confirmation for the exact boat/revision/crossing when notice is required', () => {
        const reviewed = { ...record(), noticeMs: 30 * 60000 };
        const confirmation = {
            lifetimeKey: request().lifetimeKey,
            boatId: request().boatId,
            bridgeFeatureKey: request().bridgeFeatureKey,
            revision: reviewed.revision,
            crossingFromMs: request().fromMs,
            crossingUntilMs: request().untilMs,
            confirmedAtMs: T - 1000,
            operatorReference: 'FICTIONAL operator confirmation',
        };
        expect(assessBridgeOpening(request(), null, [reviewed]).kind).toBe('unavailable');
        expect(assessBridgeOpening(request(), confirmation, [reviewed]).kind).toBe('opening-required');
        expect(assessBridgeOpening(request(), { ...confirmation, boatId: 'other-boat' }, [reviewed]).kind).toBe(
            'unavailable',
        );
        expect(assessBridgeOpening(request(), { ...confirmation, revision: 'old-revision' }, [reviewed]).kind).toBe(
            'unavailable',
        );
        expect(assessBridgeOpening(request(), { ...confirmation, confirmedAtMs: T + 1 }, [reviewed]).kind).toBe(
            'unavailable',
        );
    });
});
