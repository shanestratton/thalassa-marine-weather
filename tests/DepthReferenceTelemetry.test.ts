/**
 * The depth the phones show is the depth the boat's own display shows.
 *
 * Serene Summer's sounder has its keel offset set, so her display reads depth
 * under the keel ("0 = crash, 0.1 = ok", Shane 2026-09-29). The Pi sent Signal
 * K's raw belowTransducer instead, and the phones labelled it "Below
 * transducer": 1.8 m MORE water under the keel than the boat said. The live
 * document that day, in a marina berth, is the fixture below.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/NmeaListenerService', () => ({
    NmeaListenerService: {
        getStatus: () => 'disconnected',
        getSavedConfig: () => null,
        onSample: () => vi.fn(),
        onStatusChange: () => vi.fn(),
    },
}));
vi.mock('../services/NmeaGpsProvider', () => ({ NmeaGpsProvider: { start: vi.fn(), stop: vi.fn() } }));
vi.mock('../services/AisStore', () => ({ AisStore: { start: vi.fn(), stop: vi.fn() } }));
vi.mock('../services/AisHubService', () => ({ AisHubService: { init: vi.fn(), destroy: vi.fn() } }));

import { readDepth, readTelemetrySnapshot } from '../pi-cache/src/trackSignalk';
import { buildTelemetryBody } from '../pi-cache/src/telemetryPublisher';
import { parseTelemetryBody } from '../supabase/functions/telemetry-relay/parse';
import { snapshotFromWire } from '../services/telemetryWire';
import { NmeaStore } from '../services/NmeaStore';
import { nmeaDepthReferenceLabel } from '../services/nmea/nmeaSentence';

const now = Date.parse('2026-09-29T02:37:40Z');
const at = (msAgo: number) => new Date(now - msAgo).toISOString();

/** Calypso's environment.depth at 2026-09-29T02:37:37Z (curl of /signalk/v1/api). */
function liveDepth(overrides: Record<string, unknown> = {}) {
    return {
        environment: {
            depth: {
                belowTransducer: { value: 4.76, $source: 'ydwg-tcp.YD', timestamp: at(2_403), sentence: 'DBT' },
                transducerToKeel: { value: 1.8, $source: 'ydwg-tcp.YD', timestamp: at(2_404), sentence: 'DPT' },
                belowKeel: { value: 2.96, $source: 'ydwg-tcp.YD', timestamp: at(2_404), sentence: 'DPT' },
                // This sounder fills DBS with the keel figure, not the surface one.
                belowSurface: { value: 2.96, $source: 'ydwg-tcp.YD', timestamp: at(2_403), sentence: 'DBS' },
                ...overrides,
            },
        },
    };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    NmeaStore.stop();
    NmeaStore.clearRemote();
    NmeaStore.start();
});
afterEach(() => {
    NmeaStore.stop();
    vi.useRealTimers();
});

describe('the depth the Pi sends the phones', () => {
    it("is the boat display's depth under the keel, with its reference and offset", () => {
        expect(readDepth(liveDepth())).toEqual({ depthM: 2.96, reference: 'below-keel', offsetM: -1.8 });
        const snapshot = readTelemetrySnapshot(liveDepth(), () => now)!;
        expect(snapshot.depthM).toBe(2.96);
        expect(snapshot.extra).toMatchObject({ depth_reference: 'below-keel', depth_offset_m: -1.8 });
    });

    // Review 2026-09-29 (medium): the lag fallback used to send the RAW 4.76
    // "below transducer" — 1.8 m more water than the boat's display, and a
    // 1.8 m step in the Glass trend every time DPT dropped out. The offset is
    // an installation constant, so the keel figure is still known.
    it('keeps the keel figure from the raw reading when the keel figure has stopped updating', () => {
        const stale = liveDepth({ belowKeel: { value: 2.96, timestamp: at(60_000) } });
        expect(readDepth(stale, now)).toEqual({ depthM: 2.96, reference: 'below-keel', offsetM: -1.8 });
        // Lagging the raw reading by more than 10 s, though still recent itself.
        const lagging = liveDepth({ belowKeel: { value: 3.5, timestamp: at(2_403 + 11_000) } });
        expect(readDepth(lagging, now)).toEqual({ depthM: 2.96, reference: 'below-keel', offsetM: -1.8 });
    });

    // Final review 2026-09-29 (low): Signal K's DPT hook writes
    // transducerToKeel and belowKeel only for a NEGATIVE offset and keeps the
    // old values for ever. Set the sounder to show depth below the transducer
    // (offset 0) or below the waterline and both stop, while DBT carries on:
    // raw minus a stale 1.8 m went out labelled "below keel" under a display
    // that no longer showed the keel. The offset counts only while it is
    // current with the raw reading, or the keel figure stopped just now.
    it('sends the raw reading below the transducer once the keel offset has stopped updating too', () => {
        const offsetOff = liveDepth({
            belowKeel: { value: 2.96, timestamp: at(300_000) },
            transducerToKeel: { value: 1.8, timestamp: at(300_000) },
        });
        expect(readDepth(offsetOff, now)).toEqual({ depthM: 4.76, reference: 'below-transducer', offsetM: null });
        const snapshot = readTelemetrySnapshot(offsetOff, () => now)!;
        expect(snapshot.extra).toMatchObject({ depth_reference: 'below-transducer' });
        expect(snapshot.extra?.depth_offset_m).toBeUndefined();
    });

    it('rides out a short DPT gap on the keel figure', () => {
        const gap = liveDepth({
            belowKeel: { value: 2.96, timestamp: at(60_000) },
            transducerToKeel: { value: 1.8, timestamp: at(60_000) },
        });
        expect(readDepth(gap, now)).toEqual({ depthM: 2.96, reference: 'below-keel', offsetM: -1.8 });
    });

    // This sounder fills DBS with its LIVE keel figure, and once DBT and DPT go
    // quiet a DBS figure cannot be told apart from a genuine waterline depth.
    // Guessing let a keel number out as "below waterline", and then a genuine
    // waterline number out as "below keel" — MORE water than the boat's
    // display (final review 2026-09-29). On a sounder with a keel setting DBS
    // is never sent; no depth goes out until DBT or DPT return.
    describe('DBS on a sounder set to show the keel figure', () => {
        const quiet = (msAgo: number) => ({
            belowTransducer: { value: 4.76, timestamp: at(msAgo) },
            transducerToKeel: { value: 1.8, timestamp: at(msAgo) },
            belowKeel: { value: 2.96, timestamp: at(msAgo) },
        });
        const dbs = (value: number, msAgo = 1_000, frozenMsAgo = 60_000) =>
            liveDepth({ ...quiet(frozenMsAgo), belowSurface: { value, timestamp: at(msAgo) } });
        const nothing = { depthM: null, reference: null, offsetM: null };

        it('sends no depth rather than guess what a live DBS figure means', () => {
            // The keel figure it echoes, drifted, and a figure that looks like a waterline depth.
            for (const value of [2.965, 2.9, 3.03, 3.2, 3.46, 3.8, 4.6, 5.2, 5.7]) {
                expect(readDepth(dbs(value), now)).toEqual(nothing);
            }
            // However long ago the keel figure stopped.
            expect(readDepth(dbs(5.7, 1_000, 300_000), now)).toEqual(nothing);
            // With depth the only reading, there is nothing to send at all.
            const snapshot = readTelemetrySnapshot(dbs(3.2), () => now);
            expect(snapshot?.depthM ?? null).toBeNull();
            expect(snapshot?.extra?.depth_reference).toBeUndefined();
        });

        it('never reports more water than the keel figure the display showed', () => {
            for (const value of [3.2, 3.46, 5.7]) {
                const out = readDepth(dbs(value), now);
                expect(out.depthM === null || out.depthM <= 2.96).toBe(true);
            }
        });

        it('a transducerToKeel on its own still marks the sounder as keel-set', () => {
            const offsetOnly = liveDepth({
                belowTransducer: { value: 4.76, timestamp: at(300_000) },
                transducerToKeel: { value: 1.8, timestamp: at(300_000) },
                belowKeel: undefined,
                belowSurface: { value: 2.9, timestamp: at(1_000) },
            });
            expect(readDepth(offsetOnly, now)).toEqual(nothing);
        });
    });

    it('sends the raw reading as below the transducer only when no keel offset is known', () => {
        const noOffset = liveDepth({ belowKeel: { value: 2.96, timestamp: at(60_000) }, transducerToKeel: undefined });
        expect(readDepth(noOffset, now)).toEqual({ depthM: 4.76, reference: 'below-transducer', offsetM: null });
    });

    // Review 2026-09-29 (high): Signal K's belowKeel is belowTransducer minus
    // transducerToKeel, so it goes NEGATIVE whenever the raw reading is under
    // 1.8 m — while she is still afloat (the tape puts the keel 1.46 m down,
    // the sounder is set 0.34 m pessimistic). readDepth refused the negative
    // keel figure and sent the raw 1.6 m "below transducer": the phone jumped
    // from 0.05 "Below keel" to ~1.75 at the moment the keel touched.
    it('keeps a negative keel figure below the keel, never switching to the raw reading', () => {
        const touching = liveDepth({
            belowTransducer: { value: 1.6, timestamp: at(1_000) },
            belowKeel: { value: -0.2, timestamp: at(1_000) },
            belowSurface: { value: -0.2, timestamp: at(1_000) },
        });
        const depth = readDepth(touching, now);
        expect(depth.reference).toBe('below-keel');
        expect(depth.depthM).not.toBeNull();
        expect(depth.depthM!).toBeLessThanOrEqual(0);
        expect(depth).toEqual({ depthM: -0.2, reference: 'below-keel', offsetM: -1.8 });
        // And it survives the cloud relay (depth_m floor -5) to the phone as the keel figure.
        const body = buildTelemetryBody(readTelemetrySnapshot(touching, () => now)!, 'test-vessel');
        const relayed = parseTelemetryBody(body, now);
        if (!relayed.ok) throw new Error(relayed.error);
        const reading = snapshotFromWire(relayed.row as unknown as Record<string, unknown>, 'cloud')!;
        expect(reading.snapshot.depthM).toBe(-0.2);
        expect(reading.snapshot.depthReference).toBe('below-keel');
    });

    it('refuses a keel figure deeper below the transducer than the keel itself sits', () => {
        const nonsense = liveDepth({ belowKeel: { value: -2.5, timestamp: at(1_000) } });
        // -2.5 would put the bottom above the transducer: fall back to the raw reading, still keel-referenced.
        expect(readDepth(nonsense, now)).toEqual({ depthM: 2.96, reference: 'below-keel', offsetM: -1.8 });
    });

    // Review 2026-09-29 (medium): nothing checked the age of the depth
    // itself. With the sounder switched off (or silent after losing bottom
    // lock), Signal K keeps the last values for ever and the Pi republished
    // 2.96 every 5 s; the phones stamped it with the receipt time and showed
    // it live while the tide fell under her.
    it('sends no depth at all when every depth reading has stopped updating', () => {
        const hourOld = liveDepth({
            belowTransducer: { value: 4.76, timestamp: at(3_600_000) },
            transducerToKeel: { value: 1.8, timestamp: at(3_600_000) },
            belowKeel: { value: 2.96, timestamp: at(3_600_000) },
            belowSurface: { value: 2.96, timestamp: at(3_600_000) },
        });
        expect(readDepth(hourOld, now)).toEqual({ depthM: null, reference: null, offsetM: null });
        const snapshot = readTelemetrySnapshot(
            { ...hourOld, environment: { ...hourOld.environment, water: { temperature: { value: 296 } } } },
            () => now,
        )!;
        expect(snapshot.depthM).toBeNull();
        expect(snapshot.extra?.depth_reference).toBeUndefined();
        expect(snapshot.extra?.depth_offset_m).toBeUndefined();
        // Past the 20 s gate the reading is not live; nor is one stamped in the future.
        // (A keel figure alone going old falls back to raw minus the offset.)
        expect(readDepth(liveDepth({ belowKeel: { value: 2.96, timestamp: at(21_000) } }), now).depthM).toBe(2.96);
        const allOld = (ms: number) =>
            liveDepth({
                belowTransducer: { value: 4.76, timestamp: at(ms) },
                belowKeel: { value: 2.96, timestamp: at(ms) },
                belowSurface: { value: 2.96, timestamp: at(ms) },
            });
        expect(readDepth(allOld(21_000), now).depthM).toBeNull();
        expect(readDepth(allOld(15_000), now).depthM).toBe(2.96);
        expect(readDepth(allOld(-60_000), now).depthM).toBeNull();
    });

    it('uses what there is, and says what it is', () => {
        // No keel figure, but the sounder's keel offset is known: the keel figure from the raw one.
        expect(readDepth(liveDepth({ belowKeel: undefined }))).toEqual({
            depthM: 2.96,
            reference: 'below-keel',
            offsetM: -1.8,
        });
        expect(readDepth(liveDepth({ belowKeel: undefined, transducerToKeel: undefined }))).toMatchObject({
            depthM: 4.76,
            reference: 'below-transducer',
        });
        expect(readDepth({ environment: { depth: { belowSurface: { value: 6.3, timestamp: at(1_000) } } } })).toEqual({
            depthM: 6.3,
            reference: 'below-waterline',
            offsetM: null,
        });
        expect(readDepth({ environment: {} })).toEqual({ depthM: null, reference: null, offsetM: null });
        const dry = readTelemetrySnapshot({ environment: { water: { temperature: { value: 296 } } } }, () => now)!;
        expect(dry.extra?.depth_reference).toBeUndefined();
        expect(dry.extra?.depth_offset_m).toBeUndefined();
    });

    it('reaches a phone as "Below keel" over the cloud relay and the LAN, with no migration', () => {
        const body = buildTelemetryBody(readTelemetrySnapshot(liveDepth(), () => now)!, 'test-vessel');
        const relayed = parseTelemetryBody(body, now);
        if (!relayed.ok) throw new Error(relayed.error);
        for (const [wire, via] of [
            [relayed.row, 'cloud'],
            [body, 'lan'],
        ] as const) {
            const reading = snapshotFromWire(wire as unknown as Record<string, unknown>, via)!;
            expect(reading.snapshot.depthM).toBe(2.96);
            expect(reading.snapshot.depthReference).toBe('below-keel');
            expect(reading.snapshot.depthOffsetM).toBe(-1.8);
        }
    });

    it('labels an older Pi\'s raw depth "Below transducer", as it always was', () => {
        const reading = snapshotFromWire(
            { reported_at: new Date(now).toISOString(), depth_m: 4.76, extra: {} },
            'lan',
        )!;
        expect(reading.snapshot.depthReference).toBeUndefined();
        expect(
            snapshotFromWire(
                { reported_at: new Date(now).toISOString(), depth_m: 4.76, extra: { depth_reference: 'sideways' } },
                'lan',
            )!.snapshot.depthReference,
        ).toBeUndefined();
    });
});

describe('the phone store', () => {
    it('keeps the reference that came with the depth, and labels it for the skipper', () => {
        const reading = snapshotFromWire(
            buildTelemetryBody(readTelemetrySnapshot(liveDepth(), () => now)!, 'test-vessel') as unknown as Record<
                string,
                unknown
            >,
            'lan',
        )!;
        NmeaStore.ingestRemote(reading.snapshot);
        const state = NmeaStore.getState();
        expect(state.depth.value).toBe(2.96);
        expect(state.depthReference).toBe('below-keel');
        expect(state.depthOffsetM).toBe(-1.8);
        expect(nmeaDepthReferenceLabel(state.depthReference)).toBe('Below keel');
    });

    it('treats a depth with no reference as below the transducer', () => {
        const reading = snapshotFromWire(
            { reported_at: new Date(now).toISOString(), depth_m: 4.76, source: 'pi', extra: {} },
            'lan',
        )!;
        NmeaStore.ingestRemote(reading.snapshot);
        expect(NmeaStore.getState().depthReference).toBe('below-transducer');
        expect(NmeaStore.getState().depthOffsetM).toBeNull();
    });
});
