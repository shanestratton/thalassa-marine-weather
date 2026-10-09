/**
 * Shore Watch's radar model (126-03a): what the swing-circle canvas is given
 * ashore, built from the latest broadcast and the trail this phone heard. No
 * fake full snapshot: only the fields the canvas reads.
 *
 * Fictional anchorages, worldwide: off Taveuni astride the 180° meridian, off
 * Horta in the Azores, off Longyearbyen at 78°N for high-latitude scale, and
 * off Airlie Beach and in Bequia's Admiralty Bay for the gaps a sleeping shore
 * phone leaves.
 */
import { describe, expect, it } from 'vitest';
import {
    SHORE_TRAIL_DRAW_MAX,
    SHORE_TRAIL_MAX_GAP_MS,
    shoreSwingModel,
} from '../components/anchor-watch/shoreSwingModel';
import { offsetFromAnchorM } from '../components/anchor-watch/SwingCircleCanvas';
import type { PositionBroadcast } from '../services/AnchorWatchSyncService';

const T0 = Date.UTC(2026, 9, 10, 2, 0, 0);

type LatLon = { latitude: number; longitude: number };

function broadcast(anchor: LatLon, vessel: LatLon & { accuracy?: number }, over: Partial<PositionBroadcast> = {}) {
    return {
        type: 'position',
        vessel: { heading: 0, speed: 0, timestamp: T0, accuracy: 4, ...vessel },
        anchor: { ...anchor, timestamp: T0 },
        distance: 20,
        swingRadius: 50,
        isAlarm: false,
        timestamp: T0,
        ...over,
    } as PositionBroadcast;
}

const HORTA = { latitude: 38.53, longitude: -28.62 };

describe('shoreSwingModel', () => {
    it('maps the broadcast alarm to the canvas alarm state, and holding to watching', () => {
        expect(shoreSwingModel(broadcast(HORTA, HORTA, { isAlarm: true }), []).state).toBe('alarm');
        expect(shoreSwingModel(broadcast(HORTA, HORTA, { isAlarm: false }), []).state).toBe('watching');
        // The shore's own confirmed drag (a push or an alarm packet) wins over
        // a holding position packet.
        expect(shoreSwingModel(broadcast(HORTA, HORTA, { isAlarm: false }), [], true).state).toBe('alarm');
    });

    it('takes the anchor, the boat and the swing radius from the broadcast', () => {
        const boat = { latitude: 38.5302, longitude: -28.6201 };
        const model = shoreSwingModel(broadcast(HORTA, boat, { swingRadius: 42 }), []);
        expect(model.anchorPosition).toMatchObject(HORTA);
        expect(model.vesselPosition).toMatchObject(boat);
        expect(model.swingRadius).toBe(42);
    });

    it(`caps the trail at ${SHORE_TRAIL_DRAW_MAX} half-minutes, the newest kept`, () => {
        expect(SHORE_TRAIL_DRAW_MAX).toBe(500);
        const trail = Array.from({ length: 600 }, (_, i) => ({
            latitude: 38.53 + i * 1e-7,
            longitude: -28.62,
            accuracy: 3,
            timestamp: T0 + i * 30_000,
        }));
        const model = shoreSwingModel(broadcast(HORTA, HORTA), trail);
        expect(model.positionHistory).toHaveLength(500);
        expect(model.positionHistory[0]).toEqual(trail[100]);
        expect(model.positionHistory[499]).toEqual(trail[599]);
        // A short trail is drawn whole.
        expect(shoreSwingModel(broadcast(HORTA, HORTA), trail.slice(0, 3)).positionHistory).toHaveLength(3);
    });

    it.each([
        ['missing (the Pi sends none)', undefined],
        ['not a number', Number.NaN],
        ['negative', -5],
    ])('an accuracy that is %s gives 0, so no accuracy ring is drawn', (_label, accuracy) => {
        const vessel: LatLon & { accuracy?: number } = { ...HORTA };
        if (accuracy !== undefined) vessel.accuracy = accuracy;
        const data = broadcast(HORTA, vessel);
        if (accuracy === undefined) delete (data.vessel as Partial<typeof data.vessel>).accuracy;
        expect(shoreSwingModel(data, []).gpsAccuracy).toBe(0);
    });

    it('a real accuracy is kept for the ring', () => {
        expect(shoreSwingModel(broadcast(HORTA, { ...HORTA, accuracy: 6 }), []).gpsAccuracy).toBe(6);
    });

    it('Taveuni, astride 180°: every trail offset is metres from the anchor, never a world away', () => {
        const anchor = { latitude: -16.8, longitude: 179.9998 };
        // She swings east across the meridian and back.
        const lons = [179.9999, -179.9999, -179.9998, -179.9997, -179.9998, 179.9999];
        const trail = lons.map((longitude, i) => ({
            latitude: -16.8 + (i % 2) * 0.0001,
            longitude,
            accuracy: 3,
            timestamp: T0 + i * 30_000,
        }));
        const model = shoreSwingModel(
            broadcast(anchor, { latitude: -16.8, longitude: -179.9997 }, { distance: 53 }),
            trail,
        );
        const offsets = [...model.positionHistory, model.vesselPosition!].map((p) => {
            const { dx, dy } = offsetFromAnchorM(model.anchorPosition!, p);
            return Math.hypot(dx, dy);
        });
        expect(offsets).toHaveLength(7);
        for (const metres of offsets) {
            expect(metres).toBeLessThan(100);
            expect(metres).toBeGreaterThan(0);
        }
    });

    it('Longyearbyen, 78°N: a degree of longitude is short, and the trail stays in metres', () => {
        const anchor = { latitude: 78.23, longitude: 15.6 };
        const trail = [0, 0.0005, 0.001].map((d, i) => ({
            latitude: 78.23,
            longitude: 15.6 + d,
            accuracy: 3,
            timestamp: T0 + i * 30_000,
        }));
        const model = shoreSwingModel(broadcast(anchor, { latitude: 78.23, longitude: 15.601 }), trail);
        const east = offsetFromAnchorM(model.anchorPosition!, model.positionHistory[2]).dx;
        // 0.001° at 78.23°N is about 22.7 m, not the 111 m of the equator.
        expect(east).toBeGreaterThan(20);
        expect(east).toBeLessThan(25);
    });

    // Review 126-03a: a shore phone that slept (locked, backgrounded, marina
    // LTE) hears nothing for hours. The trail must not join 07:05 to 12:00 with
    // a straight line, nor colour five-hour-old points as recent: only the
    // newest stretch heard without a gap is drawn, and it says when it starts.
    describe('her trail breaks where this phone heard nothing', () => {
        const AIRLIE = { latitude: -20.265, longitude: 148.72 };
        const HALF = 30_000;
        const at = (t: number, metresNorth: number, metresEast: number) => ({
            latitude: AIRLIE.latitude + metresNorth / 110540,
            longitude: AIRLIE.longitude + metresEast / (111320 * Math.cos((AIRLIE.latitude * Math.PI) / 180)),
            accuracy: 0,
            timestamp: t,
        });
        const morning = Date.UTC(2026, 9, 10, 21, 0, 0); // 07:00 at Airlie
        const noon = morning + 5 * 3_600_000;

        it('two runs 5 h apart: only the newest is drawn, and the trail is said to start at its first half-minute', () => {
            // 07:00-07:05 she lay north-east of the anchor; at noon, south-west.
            const early = Array.from({ length: 10 }, (_, i) => at(morning + i * HALF, 25, 25));
            const late = Array.from({ length: 4 }, (_, i) => at(noon + i * HALF, -25, -25));
            const latest = late[late.length - 1];
            const data = broadcast(AIRLIE, latest, { timestamp: latest.timestamp + 5_000 });
            data.vessel.timestamp = latest.timestamp + 5_000;
            const model = shoreSwingModel(data, [...early, ...late]);
            expect(model.positionHistory).toEqual(late);
            expect(model.trailSince).toBe(noon);
        });

        it('a lone half-minute after the gap draws no trail at all, never the old run', () => {
            const early = Array.from({ length: 10 }, (_, i) => at(morning + i * HALF, 25, 25));
            const first = at(noon, -25, -25);
            const data = broadcast(AIRLIE, first);
            data.vessel.timestamp = noon + 4_000;
            data.timestamp = noon + 4_000;
            const model = shoreSwingModel(data, [...early, first]);
            expect(model.positionHistory).toEqual([]);
            expect(model.trailSince).toBeNull();
        });

        it(`one or two missed half-minutes (up to ${SHORE_TRAIL_MAX_GAP_MS / 1000} s) do not break it; three do`, () => {
            expect(SHORE_TRAIL_MAX_GAP_MS).toBe(90_000);
            const BEQUIA = { latitude: 13.006, longitude: -61.243 };
            const t0 = Date.UTC(2026, 9, 10, 12, 0, 0);
            const fix = (t: number) => ({ ...BEQUIA, accuracy: 0, timestamp: t });
            const lastFix = (trail: { timestamp: number }[]) => {
                const data = broadcast(BEQUIA, BEQUIA);
                data.vessel.timestamp = trail[trail.length - 1].timestamp + 1_000;
                return data;
            };
            // 30, 60 and 90 s apart: one stretch.
            const kept = [fix(t0), fix(t0 + 30_000), fix(t0 + 90_000), fix(t0 + 180_000)];
            expect(shoreSwingModel(lastFix(kept), kept).positionHistory).toHaveLength(4);
            expect(shoreSwingModel(lastFix(kept), kept).trailSince).toBe(t0);
            // 120 s apart: a gap, so the trail starts after it.
            const broken = [fix(t0), fix(t0 + 30_000), fix(t0 + 150_000), fix(t0 + 180_000)];
            expect(shoreSwingModel(lastFix(broken), broken).positionHistory).toEqual(broken.slice(2));
            expect(shoreSwingModel(lastFix(broken), broken).trailSince).toBe(t0 + 150_000);
        });

        it('a trail that stopped long before her latest fix is not drawn: it does not lead to where she is', () => {
            const early = Array.from({ length: 10 }, (_, i) => at(morning + i * HALF, 25, 25));
            const data = broadcast(AIRLIE, at(noon, -25, -25));
            data.vessel.timestamp = noon;
            data.timestamp = noon;
            const model = shoreSwingModel(data, early);
            expect(model.positionHistory).toEqual([]);
            expect(model.trailSince).toBeNull();
        });

        it('the cap still keeps the newest 500 of an unbroken run, and the trail starts at the oldest drawn', () => {
            const long = Array.from({ length: 600 }, (_, i) => at(morning + i * HALF, 10, 0));
            const data = broadcast(AIRLIE, long[599]);
            data.vessel.timestamp = long[599].timestamp + 2_000;
            const model = shoreSwingModel(data, long);
            expect(model.positionHistory).toHaveLength(500);
            expect(model.trailSince).toBe(long[100].timestamp);
        });
    });
});
