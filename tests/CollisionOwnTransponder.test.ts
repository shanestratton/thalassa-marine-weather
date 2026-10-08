/**
 * Our own transponder is never a collision target (125-01 review finding).
 *
 * A boat whose gateway forwards her own transponder's !AIVDO, with no MMSI
 * typed into Settings → Vessel (optional, and often left empty), used to have
 * that echo graded as a vessel at her own position: CPA under 0.01 NM, TCPA
 * hovering round 0, so close quarters that cannot be muted, again and again.
 * The store now learns our MMSI from !AIVDO, and the guard never grades it.
 *
 * Real sentences through the real listener, decoder and store. Fictional
 * MMSIs only (MID 123 is unallocated). Waters off Brest.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
    update: vi.fn(),
    checkFeatures: vi.fn((..._args: unknown[]) => [] as unknown[]),
}));

vi.mock('../services/AisGuardZone', () => ({
    AisGuardZone: {
        getState: () => ({ enabled: true, radiusNm: 2, alerts: [], collisionChecked: true }),
        checkFeatures: hoisted.checkFeatures,
    },
}));
vi.mock('../services/ownshipPosition', () => ({
    resolveOwnshipPosition: () => ({ lat: 48.35, lon: -4.55, sog: 6, cog: 90, timestamp: Date.now(), source: 'nmea' }),
    resolveOwnMotion: () => ({ sogKn: 6, cogDeg: 90, source: 'nmea', pair: 'offshore' }),
}));
vi.mock('../stores/settingsStore', () => ({
    // No MMSI typed in: the only way to know our own is to hear it.
    useSettingsStore: { getState: () => ({ settings: { vessel: {} } }) },
}));
vi.mock('../services/CollisionAlarmService', () => ({
    CollisionAlarmService: { update: hoisted.update, disarm: vi.fn(), noFix: vi.fn(), unchecked: vi.fn() },
}));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { NmeaListenerService } from '../services/NmeaListenerService';
import { AisStore } from '../services/AisStore';
import { runGuardCheck } from '../services/AisGuardWatch';
import { isOwnShipAisSentence } from '../services/AisDecoder';
import { encodeAisPositionReport } from '../services/debug/aisInjector';
import type { CollisionAlarmCandidate } from '../services/CollisionAlarmService';

const OWN = 123450001;
const OTHER = 123450002;
const listener = NmeaListenerService as unknown as { parseNmeaSentence(sentence: string): void };

beforeEach(() => {
    AisStore.stop();
    hoisted.update.mockClear();
    hoisted.checkFeatures.mockClear();
});

describe('our own !AIVDO', () => {
    it('is recognised whatever the talker', () => {
        expect(isOwnShipAisSentence('!AIVDO,1,1,,A,x,0*00')).toBe(true);
        expect(isOwnShipAisSentence('!ABVDO,1,1,,A,x,0*00')).toBe(true);
        expect(isOwnShipAisSentence('!AIVDM,1,1,,A,x,0*00')).toBe(false);
    });

    it('never produces a collision candidate or a ring alert, with no vessel MMSI set', () => {
        // Our transponder reports us a few metres off our GPS, making our speed and course.
        const vdo = encodeAisPositionReport(
            { mmsi: OWN, sogKn: 6.2, lat: 48.35003, lon: -4.54995, cogDeg: 91, headingDeg: 91 },
            'VDO',
        );
        expect(vdo.startsWith('!AIVDO,')).toBe(true);
        listener.parseNmeaSentence(vdo);
        // And a real target, half a mile ahead and closing.
        listener.parseNmeaSentence(
            encodeAisPositionReport({ mmsi: OTHER, sogKn: 8, lat: 48.35, lon: -4.5375, cogDeg: 270, headingDeg: 270 }),
        );
        expect(AisStore.getOwnMmsi()).toBe(OWN);
        expect(AisStore.getLastHeardAt()).toBeGreaterThan(0);

        runGuardCheck(Date.now());
        const graded = hoisted.update.mock.calls.at(-1)![0] as CollisionAlarmCandidate[];
        expect(graded.map((c) => c.mmsi)).toEqual([OTHER]);
        expect(graded[0].assessment.alarm).toBe(true);
        const ring = hoisted.checkFeatures.mock.calls.at(-1)![2] as GeoJSON.Feature[];
        expect(ring.map((f) => f.properties?.mmsi)).toEqual([OTHER]);
    });
});
