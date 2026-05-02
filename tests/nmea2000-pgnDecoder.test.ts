/**
 * Tests for the N2K PGN decoder.
 *
 * Each PGN test constructs the buffer that a real-world Actisense /
 * canboat-derived gateway would emit, then verifies the decoded
 * shape. Round-trip values are derived from the documented N2K
 * resolutions (e.g. 1e-4 rad → degrees) so the tests double as
 * documentation for future contributors.
 */
import { describe, expect, it } from 'vitest';
import { decodePgn, PGN } from '../services/nmea2000/pgnDecoder';
import type {
    N2KAttitude,
    N2KCogSog,
    N2KEngineParametersDynamic,
    N2KEngineParametersRapid,
    N2KGnssPosition,
    N2KPositionRapid,
    N2KSpeedThroughWater,
    N2KVesselHeading,
    N2KWaterDepth,
    N2KWindData,
} from '../services/nmea2000/types';

// ── Encoding helpers — write LE values into a Uint8Array ─────────────
// These mirror the decoder's read*** helpers; if a test breaks because
// of a sign / endianness mismatch, the bug is most likely here.

function writeU16(buf: Uint8Array, o: number, v: number): void {
    buf[o] = v & 0xff;
    buf[o + 1] = (v >> 8) & 0xff;
}
function writeI16(buf: Uint8Array, o: number, v: number): void {
    if (v < 0) v += 0x10000;
    writeU16(buf, o, v);
}
function writeU32(buf: Uint8Array, o: number, v: number): void {
    buf[o] = v & 0xff;
    buf[o + 1] = (v >>> 8) & 0xff;
    buf[o + 2] = (v >>> 16) & 0xff;
    buf[o + 3] = (v >>> 24) & 0xff;
}
function writeI32(buf: Uint8Array, o: number, v: number): void {
    if (v < 0) v += 0x100000000;
    writeU32(buf, o, v);
}
function writeI64(buf: Uint8Array, o: number, v: bigint): void {
    let b = v < 0n ? v + 0x10000000000000000n : v;
    for (let i = 0; i < 8; i++) {
        buf[o + i] = Number(b & 0xffn);
        b >>= 8n;
    }
}

// ── Encoding helpers — physical → raw N2K integer ────────────────────
const RAD = Math.PI / 180;
const KTS_TO_MS = 1 / 1.94384;
const degToHeadingRaw = (deg: number) => Math.round((deg * RAD) / 1e-4);
const ktsToSpeedRaw = (kts: number) => Math.round((kts * KTS_TO_MS) / 1e-2);
const latLonToRaw = (deg: number) => Math.round(deg / 1e-7);

// ── Tests ────────────────────────────────────────────────────────────

describe('decodePgn — VESSEL_HEADING (127250)', () => {
    it('decodes a true heading of 90° with no deviation/variation', () => {
        const buf = new Uint8Array(8);
        buf[0] = 0x12; // SID
        writeU16(buf, 1, degToHeadingRaw(90));
        writeI16(buf, 3, 0); // deviation
        writeI16(buf, 5, 0); // variation
        buf[7] = 0; // reference = true

        const m = decodePgn(PGN.VESSEL_HEADING, buf) as N2KVesselHeading;
        expect(m.pgn).toBe(PGN.VESSEL_HEADING);
        expect(m.sid).toBe(0x12);
        expect(m.headingDeg).toBeCloseTo(90, 2);
        expect(m.deviationDeg).toBeCloseTo(0, 2);
        expect(m.variationDeg).toBeCloseTo(0, 2);
        expect(m.reference).toBe('true');
    });

    it('decodes a magnetic heading with small variation', () => {
        const buf = new Uint8Array(8);
        buf[0] = 0;
        writeU16(buf, 1, degToHeadingRaw(187));
        writeI16(buf, 3, 0);
        writeI16(buf, 5, degToHeadingRaw(11)); // 11° variation
        buf[7] = 1; // magnetic

        const m = decodePgn(PGN.VESSEL_HEADING, buf) as N2KVesselHeading;
        expect(m.headingDeg).toBeCloseTo(187, 1);
        expect(m.variationDeg).toBeCloseTo(11, 1);
        expect(m.reference).toBe('magnetic');
    });

    it('returns null fields when N2K "not available" sentinel is present', () => {
        const buf = new Uint8Array(8);
        buf[0] = 0;
        writeU16(buf, 1, 0xffff); // heading = NA
        writeI16(buf, 3, 0x7fff); // deviation = NA
        writeI16(buf, 5, 0x7fff); // variation = NA
        buf[7] = 0;

        const m = decodePgn(PGN.VESSEL_HEADING, buf) as N2KVesselHeading;
        expect(m.headingDeg).toBeNull();
        expect(m.deviationDeg).toBeNull();
        expect(m.variationDeg).toBeNull();
    });

    it('rejects buffers shorter than 8 bytes', () => {
        expect(decodePgn(PGN.VESSEL_HEADING, new Uint8Array(7))).toBeNull();
    });
});

describe('decodePgn — ATTITUDE (127257)', () => {
    it('decodes positive yaw, negative pitch, zero roll', () => {
        const buf = new Uint8Array(7);
        writeI16(buf, 1, degToHeadingRaw(45));
        writeI16(buf, 3, degToHeadingRaw(-7));
        writeI16(buf, 5, 0);

        const m = decodePgn(PGN.ATTITUDE, buf) as N2KAttitude;
        expect(m.yawDeg).toBeCloseTo(45, 1);
        expect(m.pitchDeg).toBeCloseTo(-7, 1);
        expect(m.rollDeg).toBeCloseTo(0, 1);
    });
});

describe('decodePgn — POSITION_RAPID (129025)', () => {
    it('decodes Brisbane-ish coordinates (-27.4698°, 153.0251°)', () => {
        const buf = new Uint8Array(8);
        writeI32(buf, 0, latLonToRaw(-27.4698));
        writeI32(buf, 4, latLonToRaw(153.0251));

        const m = decodePgn(PGN.POSITION_RAPID, buf) as N2KPositionRapid;
        expect(m.latitude).toBeCloseTo(-27.4698, 4);
        expect(m.longitude).toBeCloseTo(153.0251, 4);
    });
});

describe('decodePgn — COG_SOG (129026)', () => {
    it('decodes COG 187°T at 5.5 kts', () => {
        const buf = new Uint8Array(8);
        buf[0] = 0;
        buf[1] = 0; // reference = true
        writeU16(buf, 2, degToHeadingRaw(187));
        writeU16(buf, 4, ktsToSpeedRaw(5.5));

        const m = decodePgn(PGN.COG_SOG, buf) as N2KCogSog;
        expect(m.cogDeg).toBeCloseTo(187, 1);
        expect(m.sogKts).toBeCloseTo(5.5, 1);
        expect(m.cogReference).toBe('true');
    });
});

describe('decodePgn — WIND_DATA (130306)', () => {
    it('decodes apparent wind 18 kts at 35° AWA', () => {
        const buf = new Uint8Array(8);
        buf[0] = 0;
        writeU16(buf, 1, ktsToSpeedRaw(18));
        writeU16(buf, 3, degToHeadingRaw(35));
        buf[5] = 2; // reference = apparent

        const m = decodePgn(PGN.WIND_DATA, buf) as N2KWindData;
        expect(m.speedKts).toBeCloseTo(18, 1);
        expect(m.angleDeg).toBeCloseTo(35, 1);
        expect(m.reference).toBe('apparent');
    });

    it('correctly maps the true_water reference frame', () => {
        const buf = new Uint8Array(8);
        buf[0] = 0;
        writeU16(buf, 1, ktsToSpeedRaw(12));
        writeU16(buf, 3, degToHeadingRaw(140));
        buf[5] = 4; // reference = true (water referenced)

        const m = decodePgn(PGN.WIND_DATA, buf) as N2KWindData;
        expect(m.reference).toBe('true_water');
    });
});

describe('decodePgn — WATER_DEPTH (128267)', () => {
    it('decodes 4.27m below transducer with 0.5m offset', () => {
        const buf = new Uint8Array(8);
        buf[0] = 0;
        writeU32(buf, 1, Math.round(4.27 / 1e-2));
        writeI16(buf, 5, Math.round(0.5 / 1e-3));
        buf[7] = 50; // 500m max range scale (raw × 10)

        const m = decodePgn(PGN.WATER_DEPTH, buf) as N2KWaterDepth;
        expect(m.depthBelowTransducerM).toBeCloseTo(4.27, 2);
        expect(m.offsetM).toBeCloseTo(0.5, 2);
        expect(m.maxRangeM).toBe(500);
    });

    it('handles deep ocean depth (~5000m)', () => {
        const buf = new Uint8Array(8);
        buf[0] = 0;
        writeU32(buf, 1, Math.round(5012 / 1e-2));
        writeI16(buf, 5, 0x7fff); // offset NA
        buf[7] = 0xff;

        const m = decodePgn(PGN.WATER_DEPTH, buf) as N2KWaterDepth;
        expect(m.depthBelowTransducerM).toBeCloseTo(5012, 1);
        expect(m.offsetM).toBeNull();
        expect(m.maxRangeM).toBeNull();
    });
});

describe('decodePgn — SPEED_THROUGH_WATER (128259)', () => {
    it('decodes 6.2 kts STW with paddle-wheel sensor', () => {
        const buf = new Uint8Array(6);
        buf[0] = 0;
        writeU16(buf, 1, ktsToSpeedRaw(6.2));
        writeU16(buf, 3, 0xffff); // SOG NA (PGN 129026 covers it)
        buf[5] = 0; // paddle wheel

        const m = decodePgn(PGN.SPEED_THROUGH_WATER, buf) as N2KSpeedThroughWater;
        expect(m.stwKts).toBeCloseTo(6.2, 1);
        expect(m.sogKts).toBeNull();
        expect(m.sensorType).toBe('paddle_wheel');
    });
});

describe('decodePgn — GNSS_POSITION (129029)', () => {
    it('decodes high-precision position with 8 satellites and HDOP 0.7', () => {
        const buf = new Uint8Array(43);
        buf[0] = 0; // SID
        // High-resolution lat/lon: deg × 1e-16
        const latRaw = BigInt(Math.round(-27.4698 / 1e-16));
        const lonRaw = BigInt(Math.round(153.0251 / 1e-16));
        writeI64(buf, 7, latRaw);
        writeI64(buf, 15, lonRaw);
        buf[33] = 8; // 8 satellites
        writeI16(buf, 34, 70); // HDOP 0.7
        writeI16(buf, 36, 110); // PDOP 1.1

        const m = decodePgn(PGN.GNSS_POSITION, buf) as N2KGnssPosition;
        expect(m.latitude).toBeCloseTo(-27.4698, 4);
        expect(m.longitude).toBeCloseTo(153.0251, 4);
        expect(m.numSatellites).toBe(8);
        expect(m.hdop).toBeCloseTo(0.7, 1);
        expect(m.pdop).toBeCloseTo(1.1, 1);
    });
});

describe('decodePgn — ENGINE_PARAMETERS_RAPID (127488)', () => {
    it('decodes 2400 RPM on engine instance 0', () => {
        const buf = new Uint8Array(8);
        buf[0] = 0; // engine instance
        writeU16(buf, 1, Math.round(2400 / 0.25)); // 2400 RPM
        writeU16(buf, 3, 0xffff); // boost NA
        buf[5] = 0x7f; // tilt NA

        const m = decodePgn(PGN.ENGINE_PARAMETERS_RAPID, buf) as N2KEngineParametersRapid;
        expect(m.instance).toBe(0);
        expect(m.rpm).toBeCloseTo(2400, 0);
        expect(m.boostPressureHpa).toBeNull();
    });

    it('decodes idle RPM (~700) on engine instance 1 (twin-engine starboard)', () => {
        const buf = new Uint8Array(8);
        buf[0] = 1;
        writeU16(buf, 1, Math.round(720 / 0.25));
        writeU16(buf, 3, 0xffff);
        buf[5] = 0x7f;

        const m = decodePgn(PGN.ENGINE_PARAMETERS_RAPID, buf) as N2KEngineParametersRapid;
        expect(m.instance).toBe(1);
        expect(m.rpm).toBeCloseTo(720, 0);
    });
});

describe('decodePgn — ENGINE_PARAMETERS_DYNAMIC (127489)', () => {
    it('decodes a healthy diesel: 380kPa oil, 80°C engine, 14.4V alt, 3.2 L/h', () => {
        const buf = new Uint8Array(26);
        buf[0] = 0;
        writeU16(buf, 1, 3800); // oil pressure 3800 hPa = 380 kPa
        writeU16(buf, 3, Math.round((80 + 273.15) / 0.1)); // oil temp K × 0.1
        writeU16(buf, 5, Math.round((80 + 273.15) / 0.01)); // engine temp K × 0.01
        writeU16(buf, 7, Math.round(14.4 / 0.01)); // alt 14.4V
        writeI16(buf, 9, Math.round(3.2 / 0.1)); // fuel rate 3.2 L/h
        writeU32(buf, 11, 1234 * 3600); // 1234 hours in seconds
        writeU16(buf, 15, 0xffff);
        writeU16(buf, 17, 0xffff);

        const m = decodePgn(PGN.ENGINE_PARAMETERS_DYNAMIC, buf) as N2KEngineParametersDynamic;
        expect(m.oilPressureHpa).toBe(3800);
        expect(m.oilTempC).toBeCloseTo(80, 1);
        expect(m.engineTempC).toBeCloseTo(80, 1);
        expect(m.alternatorVolts).toBeCloseTo(14.4, 2);
        expect(m.fuelRateLph).toBeCloseTo(3.2, 1);
        expect(m.engineHoursS).toBe(1234 * 3600);
    });
});

describe('decodePgn — unsupported PGN', () => {
    it("returns null for a PGN we don't handle", () => {
        // PGN 127245 = Rudder — not in our decoder table
        expect(decodePgn(127245, new Uint8Array(8))).toBeNull();
    });

    it('returns null for short payloads on a known PGN', () => {
        expect(decodePgn(PGN.WIND_DATA, new Uint8Array(3))).toBeNull();
    });

    it('survives a decoder throwing — returns null instead of crashing', () => {
        // Pass a buffer where an internal read will succeed but the
        // shape is bizarre; the decoder shouldn't propagate any thrown
        // exception. (decodePgn wraps every decoder in try/catch.)
        const buf = new Uint8Array(0); // shorter than any decoder needs
        expect(decodePgn(PGN.GNSS_POSITION, buf)).toBeNull();
    });
});
