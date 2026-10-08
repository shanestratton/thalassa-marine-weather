/**
 * The collision rule (build 125, package 125-01): ONE rule for the popup's
 * CPA chip, the collision alarm and Calypso's proximity answer.
 *
 * Shane's defaults (roadmap 125, recommended and shipped unless he says
 * otherwise): CPA 0.5 NM / TCPA 15 min offshore, 0.2 NM / 6 min inshore or
 * under 3 kn; a moored/anchored claim is believed only at <= 2 kn; targets
 * under 0.5 kn are ignored only while we make under 3 kn; close quarters
 * (CPA < 0.1 NM and TCPA < 3 min while we're moving) always alarms; a mute
 * lasts 30 min and never silences close quarters.
 *
 * Positions are worldwide on purpose (the Solent, Chesapeake Bay, Fiji across
 * the antimeridian): Thalassa is a global app.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    AIS_COG_NOT_AVAILABLE,
    AIS_HEADING_NOT_AVAILABLE,
    AIS_SOG_NOT_AVAILABLE,
    COLLISION_RULE,
    DEFAULT_COLLISION_PREFS,
    aisCogDeg,
    aisHeadingDeg,
    aisSogKn,
    assessCollision,
    collisionOpening,
    collisionPairFor,
    collisionShouldSound,
    collisionSourceCanAlarm,
    ownMotionState,
    sanitiseCollisionPrefs,
    type CollisionTarget,
    type CollisionVessel,
} from '../utils/collisionRule';
import { computeCpa } from '../utils/cpaCalculation';

/** Flat offset, good to a few metres over the couple of miles these use. */
function offset(lat: number, lon: number, bearingDeg: number, distNm: number): { lat: number; lon: number } {
    const b = (bearingDeg * Math.PI) / 180;
    const dLat = (distNm * Math.cos(b)) / 60;
    const dLon = (distNm * Math.sin(b)) / (60 * Math.cos((lat * Math.PI) / 180));
    let outLon = lon + dLon;
    if (outLon > 180) outLon -= 360;
    if (outLon < -180) outLon += 360;
    return { lat: lat + dLat, lon: outLon };
}

const SOLENT = { lat: 50.75, lon: -1.3 };
const CHESAPEAKE = { lat: 37.0, lon: -76.1 };

const own = (sogKn: number | null, cogDeg: number | null, at = SOLENT): CollisionVessel => ({ ...at, sogKn, cogDeg });
const tgt = (
    at: { lat: number; lon: number },
    sogKn: number | null,
    cogDeg: number | null,
    extra: Partial<CollisionTarget> = {},
): CollisionTarget => ({ ...at, sogKn, cogDeg, source: 'local', reportAgeSec: 5, ...extra });

describe('the defaults Shane was recommended', () => {
    it('ships 0.5 NM / 15 min offshore and 0.2 NM / 6 min inshore', () => {
        expect(DEFAULT_COLLISION_PREFS).toEqual({
            offshore: { cpaNm: 0.5, tcpaMin: 15 },
            inshore: { cpaNm: 0.2, tcpaMin: 6 },
        });
        expect(COLLISION_RULE.offshoreFromOwnSogKn).toBe(3);
        expect(COLLISION_RULE.inshoreBelowOwnSogKn).toBe(2.5);
        expect(COLLISION_RULE.minTargetSogKn).toBe(0.5);
        expect(COLLISION_RULE.stationaryClaimMaxSogKn).toBe(2);
        expect(COLLISION_RULE.closeQuarters).toEqual({ cpaNm: 0.1, tcpaMin: 3 });
        expect(COLLISION_RULE.muteMinutes).toBe(30);
    });
});

describe('the four classic encounters (failing-first)', () => {
    it('head-on: closing at 16 kn from 1.5 NM alarms', () => {
        const a = assessCollision(own(8, 0), tgt(offset(SOLENT.lat, SOLENT.lon, 0, 1.5), 8, 180))!;
        expect(a.rangeOnly).toBe(false);
        expect(a.cpaNm!).toBeLessThan(0.05);
        expect(a.tcpaMin!).toBeGreaterThan(5);
        expect(a.tcpaMin!).toBeLessThan(6);
        expect(a.risk).toBe('DANGER');
        expect(a.alarm).toBe(true);
        expect(a.closeQuarters).toBe(false);
    });

    it('crossing from starboard to meet us in 8 minutes alarms', () => {
        // We make 6 kn north; she makes 6 kn west; both reach C together.
        const meet = offset(CHESAPEAKE.lat, CHESAPEAKE.lon, 0, 0.8);
        const start = offset(meet.lat, meet.lon, 90, 0.8);
        const a = assessCollision(own(6, 0, CHESAPEAKE), tgt(start, 6, 270))!;
        expect(a.cpaNm!).toBeLessThan(0.05);
        expect(a.tcpaMin!).toBeCloseTo(8, 0);
        expect(a.risk).toBe('DANGER');
        expect(a.alarm).toBe(true);
    });

    it('overtaking: a 12 kn ship a mile astern on our track alarms', () => {
        const a = assessCollision(own(6, 0), tgt(offset(SOLENT.lat, SOLENT.lon, 180, 1), 12, 0))!;
        expect(a.tcpaMin!).toBeCloseTo(10, 0);
        expect(a.risk).toBe('DANGER');
        expect(a.alarm).toBe(true);
    });

    it('diverging (TCPA < 0): no alarm', () => {
        const a = assessCollision(own(6, 0), tgt(offset(SOLENT.lat, SOLENT.lon, 180, 1), 6, 180))!;
        expect(a.tcpaMin!).toBeLessThan(0);
        expect(a.risk).toBe('NONE');
        expect(a.alarm).toBe(false);
    });
});

describe('stopped and stationary targets', () => {
    it('a stopped target dead ahead while we make 6 kn alarms (COG not available, as stopped AIS often reports)', () => {
        const ahead = offset(SOLENT.lat, SOLENT.lon, 0, 1);
        for (const navStatus of [0, 15]) {
            const a = assessCollision(own(6, 0), tgt(ahead, 0, AIS_COG_NOT_AVAILABLE, { navStatus }))!;
            expect(a.rangeOnly, `status ${navStatus}`).toBe(false);
            expect(a.tcpaMin!).toBeCloseTo(10, 0);
            expect(a.risk).toBe('DANGER');
            expect(a.alarm).toBe(true);
        }
    });

    it('status 5 (moored) making 12 kn alarms: the claim is speed-checked', () => {
        const a = assessCollision(own(8, 0), tgt(offset(SOLENT.lat, SOLENT.lon, 0, 1.2), 12, 180, { navStatus: 5 }))!;
        expect(a.risk).toBe('DANGER');
        expect(a.alarm).toBe(true);
    });

    it('status 5 at 0.3 kn does not alarm', () => {
        const a = assessCollision(own(6, 0), tgt(offset(SOLENT.lat, SOLENT.lon, 0, 1), 0.3, 90, { navStatus: 5 }))!;
        expect(a.risk).toBe('NONE');
        expect(a.alarm).toBe(false);
    });

    it('keeps 2 kn inside the anchored envelope (inclusive), as riskLevel always has', () => {
        const ahead = offset(SOLENT.lat, SOLENT.lon, 0, 1);
        expect(assessCollision(own(6, 0), tgt(ahead, 2, 180, { navStatus: 1 }))!.alarm).toBe(false);
        expect(assessCollision(own(6, 0), tgt(ahead, 2.5, 180, { navStatus: 1 }))!.alarm).toBe(true);
    });

    it('an anchored ship dead ahead inside close quarters at 6 kn still alarms', () => {
        const a = assessCollision(own(6, 0), tgt(offset(SOLENT.lat, SOLENT.lon, 0, 0.2), 0, 360, { navStatus: 1 }))!;
        expect(a.closeQuarters).toBe(true);
        expect(a.alarm).toBe(true);
    });

    it('at marina speed (under 3 kn) a berthed or moored boat is filtered from the DANGER line only', () => {
        // 0.25 NM off our track, 2.5 min out at 2 kn: inside the inshore pair, outside close quarters.
        const berth = offset(SOLENT.lat, SOLENT.lon, 0, 0.08);
        const abeam = offset(berth.lat, berth.lon, 90, 0.15);
        for (const navStatus of [5, 15]) {
            const a = assessCollision(own(2, 0), tgt(abeam, 0, 360, { navStatus }))!;
            expect(a.alarm, `status ${navStatus}`).toBe(false);
            expect(a.closeQuarters).toBe(false);
        }
    });

    it('close quarters always alarms under way, a stopped or berthed boat dead ahead included (whatever the filters)', () => {
        // Review probes: 2.5 kn with a boat stopped dead ahead at 0.08 NM (broken
        // down, or drifting while fishing in a channel), status 0 or 15 or 5 ...
        const ahead = offset(SOLENT.lat, SOLENT.lon, 90, 0.08);
        for (const navStatus of [0, 5, 15]) {
            const a = assessCollision(own(2.5, 90), tgt(ahead, 0, 360, { navStatus }))!;
            expect(a.closeQuarters, `status ${navStatus}`).toBe(true);
            expect(a.alarm, `status ${navStatus}`).toBe(true);
        }
        // ... and 2.9 kn with a 0.2 kn drifter 0.05 NM ahead (the same geometry
        // alarmed at 3.0 kn, but not at 2.9).
        const close = offset(CHESAPEAKE.lat, CHESAPEAKE.lon, 0, 0.05);
        const drifter = assessCollision(own(2.9, 0, CHESAPEAKE), tgt(close, 0.2, 180))!;
        expect(drifter.closeQuarters).toBe(true);
        expect(drifter.alarm).toBe(true);
    });
});

describe('the pair switches with hysteresis', () => {
    it('offshore from 3 kn; once offshore, inshore again only under 2.5 kn', () => {
        expect(collisionPairFor(2.9, null)).toBe('inshore');
        expect(collisionPairFor(3, null)).toBe('offshore');
        expect(collisionPairFor(2.6, 'offshore')).toBe('offshore');
        expect(collisionPairFor(2.4, 'offshore')).toBe('inshore');
        expect(collisionPairFor(2.9, 'inshore')).toBe('inshore');
        expect(collisionPairFor(3.1, 'inshore')).toBe('offshore');
        // Unknown speed keeps the pair in use.
        expect(collisionPairFor(null, 'offshore')).toBe('offshore');
    });

    it('speed jitter across 3 kn (light air) never toggles the alarm for a ship on a collision course', () => {
        // Review probe: a crossing ship, CPA ~0.01 NM, TCPA ~9 min (inside the
        // offshore pair, outside the inshore one), own SOG jittering 2.8-3.2 kn.
        let pair: 'inshore' | 'offshore' | null = null;
        const pattern: string[] = [];
        for (let i = 0; i < 40; i++) {
            const ownSog = 3 + 0.2 * Math.sin(i * 2.3);
            pair = collisionPairFor(ownSog, pair);
            const meet = offset(SOLENT.lat, SOLENT.lon, 0, (ownSog * 9) / 60);
            const start = offset(meet.lat, meet.lon, 90, (8 * 9) / 60);
            const a = assessCollision({ ...own(ownSog, 0), pair }, tgt(start, 8, 270))!;
            pattern.push(a.alarm ? 'A' : '.');
        }
        // Once the pair has gone offshore it stays there: one change at most.
        const changes = pattern.slice(1).filter((p, i) => p !== pattern[i]).length;
        expect(changes, pattern.join('')).toBeLessThanOrEqual(1);
        expect(pattern.at(-1)).toBe('A');
    });
});

describe('the inshore / offshore pair', () => {
    // CPA ~0.3 NM, TCPA ~10 min: DANGER offshore, not inshore.
    const geometry = (ownSog: number) => {
        const passPoint = offset(SOLENT.lat, SOLENT.lon, 0, (ownSog * 10) / 60);
        const start = offset(passPoint.lat, passPoint.lon, 90, 0.3);
        return assessCollision(own(ownSog, 0), tgt(offset(start.lat, start.lon, 0, (8 * 10) / 60), 8, 180))!;
    };

    it('switches to the inshore pair under 3 kn of our own speed', () => {
        expect(geometry(3).pair).toBe('offshore');
        expect(geometry(3).alarm).toBe(true);
        expect(geometry(2.9).pair).toBe('inshore');
        expect(geometry(2.9).alarm).toBe(false);
    });

    it('reads the thresholds the skipper set, not constants', () => {
        const tight = sanitiseCollisionPrefs({
            offshore: { cpaNm: 0.2, tcpaMin: 15 },
            inshore: { cpaNm: 0.1, tcpaMin: 3 },
        });
        const passPoint = offset(SOLENT.lat, SOLENT.lon, 0, 1);
        const start = offset(passPoint.lat, passPoint.lon, 90, 0.3);
        const target = tgt(offset(start.lat, start.lon, 0, (8 * 10) / 60), 8, 180);
        expect(assessCollision(own(6, 0), target)!.alarm).toBe(true);
        expect(assessCollision(own(6, 0), target, tight)!.alarm).toBe(false);
    });

    it('ignores targets under 0.5 kn only while we make under 3 kn', () => {
        const ahead = offset(SOLENT.lat, SOLENT.lon, 0, 0.15);
        const slow = tgt(ahead, 0.3, 180);
        // 2 kn: the drifter is filtered, and outside close quarters (TCPA ~3.9 min).
        expect(assessCollision(own(2, 0), slow)!.alarm).toBe(false);
        // 3.5 kn: no filter.
        expect(assessCollision(own(3.5, 0), slow)!.alarm).toBe(true);
    });
});

describe("'not available' never feeds a CPA", () => {
    it('decodes the ITU sentinels to null', () => {
        expect(aisSogKn(AIS_SOG_NOT_AVAILABLE)).toBeNull();
        expect(aisSogKn(102.2)).toBeNull(); // '102.2 kn or more' is a bound, not a speed
        expect(aisSogKn(12.4)).toBe(12.4);
        expect(aisSogKn(null)).toBeNull();
        expect(aisSogKn(undefined)).toBeNull();
        expect(aisSogKn(-1)).toBeNull();
        expect(aisCogDeg(AIS_COG_NOT_AVAILABLE)).toBeNull();
        expect(aisCogDeg(409.5)).toBeNull();
        expect(aisCogDeg(359.9)).toBe(359.9);
        expect(aisCogDeg(0)).toBe(0);
        expect(aisCogDeg(null)).toBeNull();
        expect(aisHeadingDeg(AIS_HEADING_NOT_AVAILABLE)).toBeNull();
        expect(aisHeadingDeg(42)).toBe(42);
    });

    it('SOG 102.3 is range-only, never a CPA', () => {
        const a = assessCollision(own(6, 0), tgt(offset(SOLENT.lat, SOLENT.lon, 0, 0.5), AIS_SOG_NOT_AVAILABLE, 180))!;
        expect(a.rangeOnly).toBe(true);
        expect(a.reason).toBe('target-motion-unknown');
        expect(a.cpaNm).toBeNull();
        expect(a.tcpaMin).toBeNull();
        expect(a.alarm).toBe(false);
        expect(a.rangeNm).toBeCloseTo(0.5, 1);
    });

    it('COG 360 on a moving target is range-only, never a CPA', () => {
        const a = assessCollision(own(6, 0), tgt(offset(SOLENT.lat, SOLENT.lon, 0, 0.5), 8, AIS_COG_NOT_AVAILABLE))!;
        expect(a.rangeOnly).toBe(true);
        expect(a.alarm).toBe(false);
    });

    it('without our own course and speed it is range-only too', () => {
        const target = tgt(offset(SOLENT.lat, SOLENT.lon, 0, 0.5), 8, 180);
        expect(assessCollision(own(null, null), target)!.reason).toBe('own-motion-unknown');
        expect(assessCollision(own(6, null), target)!.rangeOnly).toBe(true);
        // Known to be stopped: no course needed.
        expect(assessCollision(own(0.1, null), target)!.rangeOnly).toBe(false);
    });

    it('computeCpa (the chip) gives no CPA for the same unknowns', () => {
        const at = offset(SOLENT.lat, SOLENT.lon, 0, 0.5);
        expect(computeCpa(SOLENT.lat, SOLENT.lon, 0, 6, at.lat, at.lon, 180, AIS_SOG_NOT_AVAILABLE)).toBeNull();
        expect(computeCpa(SOLENT.lat, SOLENT.lon, 0, 6, at.lat, at.lon, AIS_COG_NOT_AVAILABLE, 8)).toBeNull();
        expect(computeCpa(SOLENT.lat, SOLENT.lon, null, null, at.lat, at.lon, 180, 8)).toBeNull();
    });

    it('a report older than ten minutes is range-only: no CPA from a position that has moved on', () => {
        const a = assessCollision(own(6, 0), tgt(offset(SOLENT.lat, SOLENT.lon, 0, 1), 8, 180, { reportAgeSec: 601 }))!;
        expect(a.rangeOnly).toBe(true);
        expect(a.reason).toBe('report-too-old');
        expect(a.alarm).toBe(false);
    });
});

describe('the chip and the alarm agree', () => {
    it('for a grid of encounters, DANGER or close quarters on the chip is exactly the alarm', () => {
        let checked = 0;
        let alarms = 0;
        for (const ownSog of [0, 0.3, 1, 2.5, 3, 6, 12]) {
            for (const range of [0.05, 0.15, 0.4, 1, 2.5]) {
                for (const bearing of [0, 30, 90, 200]) {
                    for (const targetCog of [0, 90, 180, 225]) {
                        for (const [targetSog, navStatus] of [
                            [0, 15],
                            [0.3, 0],
                            [1.5, 1],
                            [6, 5],
                            [14, 0],
                        ] as const) {
                            const at = offset(CHESAPEAKE.lat, CHESAPEAKE.lon, bearing, range);
                            const chip = computeCpa(
                                CHESAPEAKE.lat,
                                CHESAPEAKE.lon,
                                0,
                                ownSog,
                                at.lat,
                                at.lon,
                                targetCog,
                                targetSog,
                                navStatus,
                            );
                            const alarm = assessCollision(
                                own(ownSog, 0, CHESAPEAKE),
                                tgt(at, targetSog, targetCog, { navStatus }),
                            )!;
                            expect(chip).not.toBeNull();
                            const chipAlarms = chip!.risk === 'DANGER' || chip!.closeQuarters;
                            expect(chipAlarms, JSON.stringify({ ownSog, range, bearing, targetCog, targetSog })).toBe(
                                alarm.alarm,
                            );
                            expect(chip!.risk).toBe(alarm.risk);
                            checked += 1;
                            if (alarm.alarm) alarms += 1;
                        }
                    }
                }
            }
        }
        expect(checked).toBe(7 * 5 * 4 * 4 * 5);
        // Not vacuous: the grid really contains alarms and non-alarms.
        expect(alarms).toBeGreaterThan(50);
        expect(alarms).toBeLessThan(checked - 50);
    });
});

describe('mute and close quarters', () => {
    const NOW = Date.UTC(2026, 9, 9, 3, 0, 0);
    it('a mute silences a DANGER target for 30 minutes', () => {
        const danger = { alarm: true, closeQuarters: false };
        expect(collisionShouldSound(danger, null, NOW)).toBe(true);
        expect(collisionShouldSound(danger, NOW + 29 * 60_000, NOW)).toBe(false);
        expect(collisionShouldSound(danger, NOW - 1, NOW)).toBe(true);
    });

    it('close quarters overrides a mute', () => {
        expect(collisionShouldSound({ alarm: true, closeQuarters: true }, NOW + 29 * 60_000, NOW)).toBe(true);
    });

    it('nothing sounds without an alarm', () => {
        expect(collisionShouldSound({ alarm: false, closeQuarters: false }, null, NOW)).toBe(false);
    });

    it('close quarters needs us moving, a real approach and both limits', () => {
        const ahead = offset(SOLENT.lat, SOLENT.lon, 0, 0.2);
        expect(assessCollision(own(6, 0), tgt(ahead, 6, 180))!.closeQuarters).toBe(true);
        // Stopped: awareness only (the anchor watch owns that case).
        expect(assessCollision(own(0, 0), tgt(ahead, 6, 180))!.closeQuarters).toBe(false);
        // Passing 0.15 NM off: not close quarters.
        const abeam = offset(ahead.lat, ahead.lon, 90, 0.15);
        expect(assessCollision(own(6, 0), tgt(abeam, 6, 180))!.closeQuarters).toBe(false);
    });

    it('close quarters alarms even when the skipper set thresholds tighter than it', () => {
        const tiny = sanitiseCollisionPrefs({
            offshore: { cpaNm: 0.05, tcpaMin: 1 },
            inshore: { cpaNm: 0.05, tcpaMin: 1 },
        });
        const a = assessCollision(own(6, 0), tgt(offset(SOLENT.lat, SOLENT.lon, 0, 0.2), 6, 180), tiny)!;
        expect(a.closeQuarters).toBe(true);
        expect(a.alarm).toBe(true);
    });
});

describe('antimeridian', () => {
    it('a Fiji pair across 179.95E closes and alarms on the right geometry', () => {
        const fijiEast = { lat: -16.9, lon: 179.98 };
        const fijiWest = { lat: -16.9, lon: -179.98 };
        const a = assessCollision(own(6, 90, fijiEast), tgt(fijiWest, 6, 270))!;
        expect(a.rangeNm).toBeCloseTo(0.04 * 60 * Math.cos((16.9 * Math.PI) / 180), 1);
        expect(a.bearingDeg).toBeGreaterThan(85);
        expect(a.bearingDeg).toBeLessThan(95);
        expect(a.cpaNm!).toBeLessThan(0.05);
        expect(a.tcpaMin!).toBeGreaterThan(10);
        expect(a.tcpaMin!).toBeLessThan(13);
        expect(a.alarm).toBe(true);

        // And from the other side of the line.
        const b = assessCollision(own(6, 270, fijiWest), tgt(fijiEast, 6, 90))!;
        expect(b.tcpaMin!).toBeCloseTo(a.tcpaMin!, 1);
        expect(b.alarm).toBe(true);

        // The chip agrees across the line as well.
        const chip = computeCpa(fijiEast.lat, fijiEast.lon, 90, 6, fijiWest.lat, fijiWest.lon, 270, 6, 0);
        expect(chip!.risk).toBe('DANGER');
    });
});

describe('evidence that an encounter is over', () => {
    it('is an opening CPA, or one well outside the CAUTION box, from known motion only', () => {
        const ahead = offset(SOLENT.lat, SOLENT.lon, 0, 1);
        // Closing head-on: alarming, so no evidence.
        expect(collisionOpening(assessCollision(own(6, 0), tgt(ahead, 6, 180))!)).toBe(false);
        // Diverging (TCPA < 0): evidence.
        expect(collisionOpening(assessCollision(own(6, 0), tgt(ahead, 12, 0))!)).toBe(true);
        // Passing 0.7 NM off at the offshore pair (inside 2 x 0.5 NM): not yet.
        const near = offset(ahead.lat, ahead.lon, 90, 0.7);
        expect(collisionOpening(assessCollision(own(6, 0), tgt(near, 6, 180))!)).toBe(false);
        // Passing 1.2 NM off: well outside, evidence.
        const wide = offset(ahead.lat, ahead.lon, 90, 1.2);
        expect(collisionOpening(assessCollision(own(6, 0), tgt(wide, 6, 180))!)).toBe(true);
        // Unknown motion is never evidence.
        expect(collisionOpening(assessCollision(own(null, null), tgt(ahead, 12, 0))!)).toBe(false);
        expect(collisionOpening(assessCollision(own(6, 0), tgt(ahead, 102.3, 360))!)).toBe(false);
        expect(collisionOpening(assessCollision(own(6, 0), tgt(ahead, 12, 0, { reportAgeSec: 900 }))!)).toBe(false);
    });

    it('says what our own motion lets the rule do', () => {
        expect(ownMotionState(6, 90)).toBe('moving');
        expect(ownMotionState(0.3, null)).toBe('stopped');
        expect(ownMotionState(6, null)).toBe('unknown');
        expect(ownMotionState(null, 90)).toBe('unknown');
        expect(ownMotionState(102.3, 90)).toBe('unknown');
    });
});

describe('only real sensors raise the alarm', () => {
    it("the boat's own receiver and network AIS can alarm; app-shared positions never can", () => {
        expect(collisionSourceCanAlarm('local')).toBe(true);
        expect(collisionSourceCanAlarm('cloud')).toBe(true);
        for (const source of ['app', 'presence', 'boat_presence', 'fleet-share', '', null, undefined, 42]) {
            expect(collisionSourceCanAlarm(source), String(source)).toBe(false);
        }
    });

    it('an app-reported boat on a collision course grades DANGER but never alarms', () => {
        const a = assessCollision(own(8, 0), tgt(offset(SOLENT.lat, SOLENT.lon, 0, 1.5), 8, 180, { source: 'app' }))!;
        expect(a.risk).toBe('DANGER');
        expect(a.alarm).toBe(false);
    });
});

describe('saved thresholds', () => {
    it('falls back to the defaults for anything unreadable and clamps the rest', () => {
        expect(sanitiseCollisionPrefs(undefined)).toEqual(DEFAULT_COLLISION_PREFS);
        expect(sanitiseCollisionPrefs('x')).toEqual(DEFAULT_COLLISION_PREFS);
        expect(sanitiseCollisionPrefs({ offshore: { cpaNm: 'a', tcpaMin: NaN } })).toEqual(DEFAULT_COLLISION_PREFS);
        expect(
            sanitiseCollisionPrefs({ offshore: { cpaNm: 99, tcpaMin: 999 }, inshore: { cpaNm: 0, tcpaMin: 0 } }),
        ).toEqual({
            offshore: { cpaNm: 3, tcpaMin: 60 },
            inshore: { cpaNm: 0.05, tcpaMin: 1 },
        });
        expect(sanitiseCollisionPrefs({ inshore: { cpaNm: 0.3 } })).toEqual({
            offshore: { cpaNm: 0.5, tcpaMin: 15 },
            inshore: { cpaNm: 0.3, tcpaMin: 6 },
        });
    });
});

describe('ready for the Pi copy (126-04)', () => {
    it('imports nothing and touches no browser or build globals', () => {
        const source = readFileSync(resolve(process.cwd(), 'utils/collisionRule.ts'), 'utf8');
        expect(source).not.toMatch(/^\s*import\s/m);
        expect(source).not.toMatch(/\brequire\(/);
        expect(source).not.toMatch(/import\.meta|\bwindow\b|\bdocument\b|localStorage|Capacitor/);
    });
});
