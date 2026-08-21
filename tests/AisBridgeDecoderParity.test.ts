/**
 * The bridge's AIVDM decoder is a vendored copy of the app's AisDecoder —
 * it cannot import it (the Railway Docker build copies only the worker
 * directory), so THIS test is the anti-drift contract: both decoders read
 * the same reference sentences and must agree on every shared field. If
 * someone fixes a bit offset in one, this fails until they fix both.
 */
import { describe, expect, it } from 'vitest';
import { decodeAisSentence, __resetFragmentsForTest } from '../workers/ais-ingest/aivdm';
import { processAisSentence } from '../services/AisDecoder';

const VECTORS = [
    '!AIVDM,1,1,,B,17Ojo>0011btinahKV54lSqp0000,0*6D', // Class A position
    '!AIVDO,1,1,,B,B7Ojo>00=:g<MbL6qQAu1Sv00000,0*1F', // own-ship Class B
    '!AIVDM,1,1,,B,H7Ojo>1LPU<dE9<000000000000,0*4E', // msg 24 Part A (name)
    '!AIVDM,1,1,,B,H7Ojo>4T0000000F:>lmno104220,0*39', // msg 24 Part B
];

describe('bridge decoder ↔ app decoder parity', () => {
    it.each(VECTORS)('agrees with the app decoder on %s', (sentence) => {
        __resetFragmentsForTest();
        const bridge = decodeAisSentence(sentence);
        const app = processAisSentence(sentence);
        expect(bridge).not.toBeNull();
        expect(app).not.toBeNull();

        expect(bridge!.mmsi).toBe(app!.mmsi);
        if (bridge!.lat !== undefined) expect(bridge!.lat).toBeCloseTo(app!.lat!, 6);
        if (bridge!.lon !== undefined) expect(bridge!.lon).toBeCloseTo(app!.lon!, 6);
        if (bridge!.sog !== undefined) expect(bridge!.sog).toBeCloseTo(app!.sog!, 3);
        if (bridge!.cog !== undefined) expect(bridge!.cog).toBeCloseTo(app!.cog!, 3);
        if (bridge!.heading !== undefined) expect(bridge!.heading).toBe(app!.heading);
        if (bridge!.name !== undefined) expect(bridge!.name).toBe(app!.name);
        if (bridge!.call_sign !== undefined) expect(bridge!.call_sign).toBe(app!.callSign);
        if (bridge!.ship_type !== undefined) expect(bridge!.ship_type).toBe(app!.shipType);
    });

    it('assembles the same two-fragment type 5 the app assembles', () => {
        __resetFragmentsForTest();
        const F1 = '!AIVDM,2,1,7,A,57Ojo>02:N2W<HtKP00EHE:0@T4@Dl000000,0*66';
        const F2 = '!AIVDM,2,2,7,A,0016L961O400003QEl3lU00000000000000,2*5C';
        expect(decodeAisSentence(F1)).toBeNull();
        const bridge = decodeAisSentence(F2);
        processAisSentence(F1);
        const app = processAisSentence(F2);
        expect(bridge).not.toBeNull();
        expect(app).not.toBeNull();
        expect(bridge!.name).toBe(app!.name);
        expect(bridge!.call_sign).toBe(app!.callSign);
        expect(bridge!.destination).toBe(app!.destination);
    });
});
