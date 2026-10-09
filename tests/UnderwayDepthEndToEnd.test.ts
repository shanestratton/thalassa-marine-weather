/**
 * The shoal alarm reads the depth the boat's own display reads (126-02a).
 *
 * A known transducer offset never reaches the phone as an offset: the Pi
 * (pi-cache/src/trackSignalk.ts readDepth) and the NMEA path both fold it into
 * a 'below-keel' reading first, so a 'below-transducer' reading on the phone
 * always means "offset unknown" and the shoal rule takes the draft off it
 * (Shane 2026-09-29: "just the draft"). These run a Signal K self document
 * through the Pi's own reader, the wire, the phone's telemetryWire and
 * NmeaStore, into the shoal rule, as tests/DepthReferenceTelemetry.test.ts
 * does for the Instrument Panel.
 *
 * Fictional boat 'Kestrel', draft 2.4 m.
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

import { readTelemetrySnapshot } from '../pi-cache/src/trackSignalk';
import { buildTelemetryBody } from '../pi-cache/src/telemetryPublisher';
import { snapshotFromWire } from '../services/telemetryWire';
import { NmeaStore } from '../services/NmeaStore';
import { SHOAL_START, nextShoalState, shoalDepthFrom, type ShoalState } from '../services/underway/underwayRule';
import { underKeelClearanceM } from '../services/underway/underKeelClearance';

const start = Date.parse('2026-10-10T02:00:00Z');
const DRAFT_M = 2.4;

/** A Signal K self document at `now`: the sounder's raw reading, and its keel offset when one is set. */
function selfDocument(now: number, belowTransducer: number, transducerToKeel?: number) {
    const at = new Date(now - 1_000).toISOString();
    return {
        navigation: {
            position: { value: { latitude: 50.75, longitude: -1.35 }, timestamp: at },
            speedOverGround: { value: 3, timestamp: at },
        },
        environment: {
            depth: {
                belowTransducer: { value: belowTransducer, timestamp: at, sentence: 'DBT' },
                ...(transducerToKeel === undefined
                    ? {}
                    : { transducerToKeel: { value: transducerToKeel, timestamp: at, sentence: 'DPT' } }),
            },
        },
    };
}

/** Three readings, 2 s apart, each through the whole chain, then the shoal rule. */
function threeReadings(belowTransducer: number, transducerToKeel: number | undefined, via: 'lan' | 'cloud') {
    let state: ShoalState = SHOAL_START;
    for (let i = 0; i < 3; i++) {
        const now = start + i * 2_000;
        vi.setSystemTime(now);
        const snapshot = readTelemetrySnapshot(selfDocument(now, belowTransducer, transducerToKeel), () => now)!;
        const body = buildTelemetryBody(snapshot, 'test-vessel');
        const reading = snapshotFromWire(body as unknown as Record<string, unknown>, via)!;
        NmeaStore.ingestRemote({ ...reading.snapshot, via });
        const depth = shoalDepthFrom(NmeaStore.getState(), NmeaStore.isBoatFeed());
        state = nextShoalState(state, {
            ...depth,
            underWay: true,
            draftM: DRAFT_M,
            draftAssumed: false,
            marginM: underKeelClearanceM(),
        });
    }
    return state;
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    NmeaStore.stop();
    NmeaStore.clearRemote();
    NmeaStore.start();
});
afterEach(() => {
    NmeaStore.stop();
    NmeaStore.clearRemote();
    vi.useRealTimers();
});

describe('a Signal K sounder through the Pi, the LAN and the phone, into the shoal rule', () => {
    it('belowTransducer 4.76 with transducerToKeel 1.8 reaches the rule as 2.96 m below the keel: quiet', () => {
        const state = threeReadings(4.76, 1.8, 'lan');
        expect(NmeaStore.getState().depthReference).toBe('below-keel');
        expect(state.reference).toBe('below-keel');
        expect(state.underKeelM).toBeCloseTo(2.96, 6);
        expect(state.sounding).toBe(false);
    });

    it('no transducerToKeel: 2.6 m below the transducer, the draft taken off, and it sounds', () => {
        const state = threeReadings(2.6, undefined, 'lan');
        expect(NmeaStore.getState().depthReference).toBe('below-transducer');
        expect(state.reference).toBe('below-transducer');
        expect(state.underKeelM).toBeCloseTo(0.2, 6);
        expect(state.sounding).toBe(true);
    });

    it('the same reading down the Pi’s cloud row never sounds: it is the boat seen from afar', () => {
        const state = threeReadings(2.6, undefined, 'cloud');
        expect(NmeaStore.isBoatFeed()).toBe(false);
        expect(state.sounding).toBe(false);
        expect(state.status).toBe('no-depth');
    });
});
