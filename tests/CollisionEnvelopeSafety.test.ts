import { describe, expect, it } from 'vitest';
import { assessCollision, deadReckonAis, type CollisionOwnShip, type CollisionTarget } from '../utils/collisionRule';

const own: CollisionOwnShip = { lat: 0, lon: 0, sogKn: 6, cogDeg: 0, atAnchor: false };
const target: CollisionTarget = { lat: 0.05, lon: 0.005, sogKn: 6, cogDeg: 180, source: 'local' };

describe('the reported and dead-reckoned collision envelope', () => {
    it('uses the projected danger when the reported position is only caution', () => {
        const fresh = assessCollision(own, target)!;
        const aged = assessCollision(own, { ...target, reportAgeSec: 300 })!;
        expect(fresh.risk).toBe('CAUTION');
        expect(aged.risk).toBe('DANGER');
        expect(aged.positionBasis).toBe('dead-reckoned');
        expect(aged.uncertaintyNm).toBeCloseTo(0.5);
        expect(aged.alarm).toBe(true);
    });

    it('keeps the reported close-quarters alarm after the estimate has passed us', () => {
        const approaching = { ...target, lat: 0.01, lon: 0, sogKn: 12 };
        const dr = deadReckonAis(approaching.lat, approaching.lon, approaching.sogKn, approaching.cogDeg, 300)!;
        const estimateAlone = assessCollision(own, { ...approaching, lat: dr.lat, lon: dr.lon })!;
        expect(estimateAlone.tcpaMin).toBeLessThan(0);
        expect(estimateAlone.alarm).toBe(false);
        const envelope = assessCollision(own, { ...approaching, reportAgeSec: 300 })!;
        expect(envelope.positionBasis).toBe('report');
        expect(envelope.closeQuarters).toBe(true);
        expect(envelope.alarm).toBe(true);
    });

    it('allows exactly ten minutes, then makes both positions range-only', () => {
        expect(assessCollision(own, { ...target, reportAgeSec: 600 })!.rangeOnly).toBe(false);
        const stale = assessCollision(own, { ...target, reportAgeSec: 600.001 })!;
        expect(stale).toMatchObject({
            rangeOnly: true,
            reason: 'report-too-old',
            cpaNm: null,
            tcpaMin: null,
            alarm: false,
        });
        expect(stale.positionBasis).toBeUndefined();
    });

    it('never invents motion from unavailable AIS course or speed', () => {
        for (const motion of [{ sogKn: 102.3 }, { cogDeg: 360 }]) {
            const result = assessCollision(own, { ...target, ...motion, reportAgeSec: 300 })!;
            expect(result).toMatchObject({
                rangeOnly: true,
                reason: 'target-motion-unknown',
                alarm: false,
                cpaNm: null,
            });
        }
    });

    it('keeps two stopped vessels silent even when their reported courses are noisy', () => {
        const stopped = assessCollision(
            { ...own, sogKn: 0.2, cogDeg: 90 },
            {
                ...target,
                lat: 0.0001,
                lon: 0,
                sogKn: 0.2,
                cogDeg: 270,
                reportAgeSec: 600,
            },
        )!;
        expect(stopped).toMatchObject({ risk: 'NONE', closeQuarters: false, alarm: false });
    });

    it('keeps a boat swinging at anchor silent beside another slow boat', () => {
        const anchored = assessCollision(
            { ...own, sogKn: 1.8, cogDeg: null, atAnchor: true },
            {
                ...target,
                lat: 0.0001,
                lon: 0,
                sogKn: 1.5,
                cogDeg: 180,
                reportAgeSec: 600,
            },
        )!;
        expect(anchored.rangeOnly).toBe(false);
        expect(anchored.closeQuarters).toBe(false);
        expect(anchored.alarm).toBe(false);
    });

    it('still alarms at anchor when an underway vessel is close quarters', () => {
        const approaching = assessCollision(
            { ...own, sogKn: 1.8, cogDeg: null, atAnchor: true },
            {
                ...target,
                lat: 0.002,
                lon: 0,
                sogKn: 6,
                cogDeg: 180,
                reportAgeSec: 120,
            },
        )!;
        expect(approaching).toMatchObject({ closeQuarters: true, alarm: true });
    });

    it('does not grant an alarm to a nonsensor source through the envelope', () => {
        expect(assessCollision(own, { ...target, source: 'app', reportAgeSec: 300 })!.alarm).toBe(false);
    });
});
