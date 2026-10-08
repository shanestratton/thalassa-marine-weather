/**
 * AIS 'not available' values stay unknown all the way from the radio to the
 * collision rule (125-01 scope item 4).
 *
 * ITU-R M.1371: SOG 1023 (102.3 kn), COG 3600 (360.0°) and heading 511 mean
 * "not available". The decoder keeps those ITU sentinels; what used to go
 * wrong is everywhere a MISSING value became 0 — a stopped boat pointing due
 * north, fed to CPA as if that were a measurement. These pin the phone's
 * side of every path the guard reads: the receiver decoder, the store's
 * defaults, the Pi relay's parser and the internet feed.
 *
 * NOT YET THE PI LANE END TO END: the Pi's own serialiser
 * (pi-cache/src/lanTelemetry.ts) still sends a missing Signal K course or
 * speed as 0, which this parser cannot tell from a real 0. That is a Pi
 * change, queued with the Pi copy of the rule (126-04).
 *
 * Fictional MMSIs only (MID 123 is unallocated): this repository is public.
 */
import { describe, expect, it } from 'vitest';
import { processAisSentence } from '../services/AisDecoder';
import { AisStore } from '../services/AisStore';
import { aisTargetFromWire } from '../services/PiTelemetryService';
import { normaliseInternetAisFeature } from '../components/map/useAisStreamLayer';
import { encodeAisPositionReport, encodeAisStaticName } from '../services/debug/aisInjector';
import { aisCogDeg, aisHeadingDeg, aisSogKn } from '../utils/collisionRule';

describe('the receiver decoder keeps the ITU sentinels', () => {
    it('round-trips a full position report', () => {
        const sentence = encodeAisPositionReport({
            mmsi: 123456789,
            navStatus: 0,
            sogKn: 12.3,
            lat: 50.7512,
            lon: -1.3021,
            cogDeg: 271.4,
            headingDeg: 270,
        });
        expect(sentence).toMatch(/^!AIVDM,1,1,,A,[0-9:;<=>?@A-W`a-w]+,0\*[0-9A-F]{2}$/);
        const decoded = processAisSentence(sentence)!;
        expect(decoded.mmsi).toBe(123456789);
        expect(decoded.navStatus).toBe(0);
        expect(decoded.sog).toBeCloseTo(12.3, 5);
        expect(decoded.cog).toBeCloseTo(271.4, 5);
        expect(decoded.heading).toBe(270);
        expect(decoded.lat).toBeCloseTo(50.7512, 4);
        expect(decoded.lon).toBeCloseTo(-1.3021, 4);
    });

    it("emits 102.3 / 360 / 511 for 'not available', which the rule reads as unknown", () => {
        const decoded = processAisSentence(
            encodeAisPositionReport({
                mmsi: 123456780,
                navStatus: 15,
                sogKn: null,
                lat: -16.9,
                lon: 179.98,
                cogDeg: null,
                headingDeg: null,
            }),
        )!;
        expect(decoded.sog).toBe(102.3);
        expect(decoded.cog).toBe(360);
        expect(decoded.heading).toBe(511);
        expect(aisSogKn(decoded.sog)).toBeNull();
        expect(aisCogDeg(decoded.cog)).toBeNull();
        expect(aisHeadingDeg(decoded.heading)).toBeNull();
    });

    it('decodes the static name the injector sends', () => {
        const decoded = processAisSentence(encodeAisStaticName(123456789, 'DEBUG CROSSER'))!;
        expect(decoded).toMatchObject({ mmsi: 123456789, name: 'DEBUG CROSSER' });
    });
});

describe('AisStore never invents a zero speed or course', () => {
    it('a target first heard by name has unknown kinematics until its position report arrives', () => {
        AisStore.update({ mmsi: 123450001, name: 'STATIC FIRST', lastUpdated: Date.now() });
        const target = AisStore.getTargets().get(123450001)!;
        expect(aisSogKn(target.sog)).toBeNull();
        expect(aisCogDeg(target.cog)).toBeNull();
        expect(aisHeadingDeg(target.heading)).toBeNull();

        AisStore.update({ mmsi: 123450001, lat: 37, lon: -76.1, sog: 4.2, cog: 88, lastUpdated: Date.now() });
        const merged = AisStore.getTargets().get(123450001)!;
        expect(merged.sog).toBe(4.2);
        expect(merged.cog).toBe(88);
        AisStore.stop();
    });
});

describe("the Pi relay (the phone's parser only; see the note at the top)", () => {
    it('keeps a missing course and speed unknown rather than 0', () => {
        const target = aisTargetFromWire({ mmsi: 123450002, lat: 37, lon: -76.1, lastUpdated: 1 })!;
        expect(aisSogKn(target.sog)).toBeNull();
        expect(aisCogDeg(target.cog)).toBeNull();
        expect(target.heading).toBe(511);
    });

    it('passes real values through', () => {
        const target = aisTargetFromWire({ mmsi: 123450003, lat: 37, lon: -76.1, lastUpdated: 1, sog: 6.5, cog: 12 })!;
        expect(target.sog).toBe(6.5);
        expect(target.cog).toBe(12);
    });
});

describe('the internet feed', () => {
    it('keeps an unavailable course and speed null', () => {
        const normalised = normaliseInternetAisFeature(
            {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [-1.3, 50.75] },
                properties: { mmsi: 123450004, sog: 102.3, cog: 360, heading: 511, updatedAt: Date.now() },
            },
            Date.now(),
        )!;
        expect(normalised.properties!.sog).toBeNull();
        expect(normalised.properties!.cog).toBeNull();
        expect(normalised.properties!.heading).toBe(511);
    });
});
