/**
 * Calypso's "anything close?" answer folds onto the collision rule (125-01
 * scope item 1): it used to carry its own copy of the CPA maths, with its own
 * idea of what is alarming, so the voice could call a ship quiet while the
 * chip said DANGER. Now its numbers, risk and alarm flag are the rule's, and
 * its inputs (position, own motion, pair, the skipper's saved thresholds, our
 * own MMSIs) are the alarm's own (AisGuardWatch.readCollisionInputs).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AisTarget } from '../types/navigation';

const hoisted = vi.hoisted(() => ({
    targets: new Map<number, AisTarget>(),
    fix: { lat: 43.29, lon: 5.36, sog: 7, cog: 180, timestamp: 0, source: 'nmea' } as Record<string, unknown> | null,
    motion: { sogKn: 7 as number | null, cogDeg: 180 as number | null, source: 'nmea', pair: 'offshore' },
    settings: {} as Record<string, unknown>,
}));

vi.mock('../services/AisStore', () => ({
    AisStore: {
        getTargets: () => hoisted.targets,
        getOwnMmsi: () => null,
        toGeoJSON: () => ({
            type: 'FeatureCollection',
            features: [...hoisted.targets.values()].map((t) => ({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [t.lon, t.lat] },
                properties: { ...t },
            })),
        }),
        subscribe: () => () => undefined,
        getLastHeardAt: () => 0,
    },
}));
vi.mock('../services/ownshipPosition', () => ({
    resolveOwnshipPosition: () => hoisted.fix,
    resolveOwnMotion: () => hoisted.motion,
}));
vi.mock('../stores/settingsStore', () => ({ useSettingsStore: { getState: () => ({ settings: hoisted.settings }) } }));
vi.mock('../services/CollisionAlarmService', () => ({
    CollisionAlarmService: { update: vi.fn(), disarm: vi.fn(), noFix: vi.fn(), unchecked: vi.fn() },
}));

import { aisProximity } from '../services/voice/integrations/aisProximity';
import { collisionCandidates, readCollisionInputs } from '../services/AisGuardWatch';
import { assessCollision } from '../utils/collisionRule';

const NOW = Date.now();
function target(mmsi: number, lat: number, lon: number, sog: number, cog: number, navStatus = 0): AisTarget {
    return {
        mmsi,
        name: `FICTIONAL ${mmsi}`,
        lat,
        lon,
        sog,
        cog,
        heading: 511,
        navStatus,
        shipType: 70,
        callSign: '',
        destination: '',
        lastUpdated: NOW - 10_000,
    };
}

beforeEach(() => {
    hoisted.targets = new Map();
    hoisted.fix = { lat: 43.29, lon: 5.36, sog: 7, cog: 180, timestamp: NOW, source: 'nmea' };
    hoisted.motion = { sogKn: 7, cogDeg: 180, source: 'nmea', pair: 'offshore' };
    hoisted.settings = {};
});

describe('aisProximity speaks the collision rule', () => {
    it('reports the same CPA, TCPA, risk and alarm as the rule for each target', async () => {
        // Off Marseille, heading south: one ship closing head-on, one crossing
        // well clear, one moored astern.
        hoisted.targets.set(123400001, target(123400001, 43.27, 5.36, 9, 0));
        hoisted.targets.set(123400002, target(123400002, 43.28, 5.4, 6, 90));
        hoisted.targets.set(123400003, target(123400003, 43.3, 5.36, 0.2, 0, 5));

        const out = JSON.parse((await aisProximity(10, 5)).content);
        expect(out.status).toBe('targets');
        expect(out.targets).toHaveLength(3);
        for (const reported of out.targets) {
            const t = hoisted.targets.get(reported.mmsi)!;
            const rule = assessCollision(
                { lat: 43.29, lon: 5.36, sogKn: 7, cogDeg: 180 },
                {
                    lat: t.lat,
                    lon: t.lon,
                    sogKn: t.sog,
                    cogDeg: t.cog,
                    navStatus: t.navStatus,
                    reportAgeSec: 10,
                    source: 'local',
                },
            )!;
            expect(reported.cpa_nm).toBeCloseTo(rule.cpaNm!, 1);
            expect(reported.tcpa_min).toBeCloseTo(rule.tcpaMin!, 0);
            expect(reported.risk).toBe(rule.risk);
            expect(reported.alarm).toBe(rule.alarm);
        }
        const headOn = out.targets.find((t: { mmsi: number }) => t.mmsi === 123400001);
        expect(headOn.alarm).toBe(true);
        const moored = out.targets.find((t: { mmsi: number }) => t.mmsi === 123400003);
        expect(moored.alarm).toBe(false);
    });

    it('never gives a CPA for a target whose speed or course is not available', async () => {
        hoisted.targets.set(123400004, target(123400004, 43.28, 5.36, 102.3, 360));
        const out = JSON.parse((await aisProximity(10, 5)).content);
        const [only] = out.targets;
        expect(only.cpa_nm).toBeNull();
        expect(only.tcpa_min).toBeNull();
        expect(only.target_sog).toBeNull();
        expect(only.target_cog).toBeNull();
        expect(only.alarm).toBe(false);
    });

    it('gives range and bearing only when our own motion is unknown', async () => {
        hoisted.motion = { sogKn: null, cogDeg: null, source: 'phone', pair: 'inshore' };
        hoisted.targets.set(123400001, target(123400001, 43.27, 5.36, 9, 0));
        const out = JSON.parse((await aisProximity(10, 5)).content);
        expect(out.targets[0].cpa_nm).toBeNull();
        expect(out.targets[0].range_nm).toBeGreaterThan(1);
    });

    it("says exactly what the alarm says with the skipper's own thresholds, not the defaults", async () => {
        // Offshore CPA opened up to 1 NM (review probe: a ship passing 0.8 NM
        // in ~10 min alarms; Calypso used to call her quiet).
        hoisted.settings = { collisionAlarm: { offshore: { cpaNm: 1, tcpaMin: 15 } }, vessel: { mmsi: '123400099' } };
        // Off Marseille heading south: one passing 0.8 NM east in ~10 min, one
        // head-on, one well clear, and our own transponder.
        hoisted.targets.set(
            123400005,
            target(123400005, 43.29 - (7 * 10) / 60 / 60, 5.36 + 0.8 / 60 / Math.cos((43.29 * Math.PI) / 180), 0, 0),
        );
        hoisted.targets.set(123400001, target(123400001, 43.27, 5.36, 9, 0));
        hoisted.targets.set(123400002, target(123400002, 43.2, 5.5, 6, 90));
        hoisted.targets.set(123400099, target(123400099, 43.2901, 5.3601, 7, 180));

        const out = JSON.parse((await aisProximity(20, 10)).content);
        const inputs = readCollisionInputs(NOW);
        const local = [...hoisted.targets.values()].map((t) => ({
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [t.lon, t.lat] },
            properties: { ...t, source: 'local' },
        }));
        const alarming = collisionCandidates(inputs.own!, inputs.motion, local, inputs.prefs, inputs.ownMmsis, NOW);
        const voiceAlarming = out.targets
            .filter((t: { alarm: boolean }) => t.alarm)
            .map((t: { mmsi: number }) => t.mmsi);
        expect(voiceAlarming.sort()).toEqual(alarming.map((c) => c.mmsi).sort());
        expect(voiceAlarming).toContain(123400005);
        // Our own transponder is not traffic.
        expect(out.targets.map((t: { mmsi: number }) => t.mmsi)).not.toContain(123400099);
    });
});
