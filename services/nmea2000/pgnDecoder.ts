/**
 * NMEA 2000 PGN decoder — converts raw 8-byte payload buffers into
 * typed app-state values.
 *
 * NMEA 2000 frames over CAN bus are 29-bit identifier + ≤8 byte data
 * frames. Multi-frame PGNs (Fast Packet) are reassembled upstream;
 * this module assumes a fully assembled payload buffer.
 *
 * The marine PGNs covered here are the highest-leverage ones for a
 * sailing yacht — position, COG/SOG, heading, wind, depth, water
 * temperature, vessel attitude, engine parameters. Future iterations
 * can add electrical (PGN 127505/127506/127508), AIS (PGN 129038–
 * 129044), or autopilot (PGN 127237).
 *
 * Wire layer (separate, not in this file):
 *   - **Bosun-side, preferred**: SignalK with Actisense NGT-1 plugin
 *     handles N2K → JSON; Thalassa subscribes via SignalK.
 *   - **iOS direct**: would require MFi USB or Yacht Devices W2K-1
 *     Bluetooth (BLE serial). Not yet wired.
 *   - **Pi N2K Hat**: PiCAN-M Hat → SocketCAN → SignalK.
 *
 * Reference: Maretron NMEA 2000 Documentation, plus the open-source
 * canboat project's PGN definitions (https://github.com/canboat/canboat).
 */
import { createLogger } from '../../utils/createLogger';
import {
    type N2KAttitude,
    type N2KCogSog,
    type N2KEngineParametersRapid,
    type N2KEngineParametersDynamic,
    type N2KGnssPosition,
    type N2KMessage,
    type N2KPositionRapid,
    type N2KSpeedThroughWater,
    type N2KVesselHeading,
    type N2KWaterDepth,
    type N2KWindData,
    PGN,
} from './types';

const log = createLogger('N2K.PGN');

// ── Number-of-resolution unit conversions ─────────────────────────────
//
// N2K encodes most physical quantities as scaled integers. Decoding requires
// multiplying by the documented resolution. These constants are the most
// common ones; some PGNs use bespoke values that we apply inline.
const RES_LATLON = 1e-7; // 32-bit signed × 1e-7 deg = ~1.1 cm
const RES_LATLON_64 = 1e-16; // 64-bit signed × 1e-16 deg (high-res GNSS PGN)
const RES_RADIANS = 1e-4; // angular: 1e-4 rad = 0.00573 deg
const RES_KPH = 1e-2; // speed: 0.01 m/s
const RES_DEPTH = 1e-2; // depth: 0.01 m
const RES_TEMP = 1e-2; // temperature: 0.01 K
const RES_PRESSURE_HPA = 1e-2; // 100 Pa = 1 hPa
const RAD_TO_DEG = 180 / Math.PI;
const KELVIN_TO_C = 273.15;
const MS_TO_KTS = 1.94384;

// ── "Not available" sentinels ─────────────────────────────────────────
//
// N2K uses all-bits-set as the "data not available" sentinel. The exact
// value depends on signed/unsigned + bit width. We treat the canonical
// values as null and propagate that through the decoded object.
const NA_INT8 = 0x7f; // signed
const NA_UINT8 = 0xff;
const NA_INT16 = 0x7fff;
const NA_UINT16 = 0xffff;
const NA_INT32 = 0x7fffffff;
const NA_UINT32 = 0xffffffff;

const isNA8 = (v: number) => v === NA_UINT8 || v === NA_INT8;
const isNA16 = (v: number) => v === NA_UINT16 || v === NA_INT16;
const isNA32 = (v: number) => v === NA_UINT32 || v === NA_INT32;

// ── Buffer readers ────────────────────────────────────────────────────
//
// All N2K integers are little-endian. Node's Buffer has built-in LE
// readers but we work with `Uint8Array` to stay portable across
// browser / RN / Capacitor.
function readU8(buf: Uint8Array, o: number): number {
    return buf[o];
}
function readI8(buf: Uint8Array, o: number): number {
    const v = buf[o];
    return v < 0x80 ? v : v - 0x100;
}
function readU16(buf: Uint8Array, o: number): number {
    return buf[o] | (buf[o + 1] << 8);
}
function readI16(buf: Uint8Array, o: number): number {
    const v = readU16(buf, o);
    return v < 0x8000 ? v : v - 0x10000;
}
function readU32(buf: Uint8Array, o: number): number {
    // Use unsigned right shift to avoid the >>> 0 trap when bit 31 is set.
    return (buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24)) >>> 0;
}
function readI32(buf: Uint8Array, o: number): number {
    return buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24);
}
function readI64(buf: Uint8Array, o: number): bigint {
    // 8-byte signed little-endian → bigint. Used by PGN 129029 high-res GNSS lat/lon.
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(buf[o + i]);
    // Two's-complement sign fix
    if (v >= 0x8000000000000000n) v -= 0x10000000000000000n;
    return v;
}

// ── Per-PGN decoders ──────────────────────────────────────────────────
//
// Each decoder returns null when the PGN is unrecognised or the payload
// is shorter than expected. Otherwise it returns an N2KMessage whose
// `pgn` field is the discriminator.

function decodeVesselHeading(buf: Uint8Array): N2KVesselHeading | null {
    if (buf.length < 8) return null;
    // Byte 0:    Sequence ID
    // Byte 1-2:  Heading (rad × 1e-4, unsigned)
    // Byte 3-4:  Deviation (rad × 1e-4, signed)
    // Byte 5-6:  Variation (rad × 1e-4, signed)
    // Byte 7:    Heading reference (lower 2 bits): 0=true, 1=magnetic
    const headingRaw = readU16(buf, 1);
    const deviationRaw = readI16(buf, 3);
    const variationRaw = readI16(buf, 5);
    const ref = buf[7] & 0x03;
    return {
        pgn: PGN.VESSEL_HEADING,
        sid: buf[0],
        headingDeg: isNA16(headingRaw) ? null : headingRaw * RES_RADIANS * RAD_TO_DEG,
        deviationDeg: isNA16(deviationRaw) ? null : deviationRaw * RES_RADIANS * RAD_TO_DEG,
        variationDeg: isNA16(variationRaw) ? null : variationRaw * RES_RADIANS * RAD_TO_DEG,
        reference: ref === 0 ? 'true' : ref === 1 ? 'magnetic' : 'unknown',
    };
}

function decodeAttitude(buf: Uint8Array): N2KAttitude | null {
    if (buf.length < 7) return null;
    // Byte 0:    Sequence ID
    // Byte 1-2:  Yaw (rad × 1e-4, signed)
    // Byte 3-4:  Pitch (rad × 1e-4, signed)
    // Byte 5-6:  Roll (rad × 1e-4, signed)
    const yaw = readI16(buf, 1);
    const pitch = readI16(buf, 3);
    const roll = readI16(buf, 5);
    return {
        pgn: PGN.ATTITUDE,
        sid: buf[0],
        yawDeg: isNA16(yaw) ? null : yaw * RES_RADIANS * RAD_TO_DEG,
        pitchDeg: isNA16(pitch) ? null : pitch * RES_RADIANS * RAD_TO_DEG,
        rollDeg: isNA16(roll) ? null : roll * RES_RADIANS * RAD_TO_DEG,
    };
}

function decodePositionRapid(buf: Uint8Array): N2KPositionRapid | null {
    if (buf.length < 8) return null;
    // Byte 0-3: Latitude (deg × 1e-7, signed)
    // Byte 4-7: Longitude (deg × 1e-7, signed)
    const lat = readI32(buf, 0);
    const lon = readI32(buf, 4);
    return {
        pgn: PGN.POSITION_RAPID,
        latitude: isNA32(lat) ? null : lat * RES_LATLON,
        longitude: isNA32(lon) ? null : lon * RES_LATLON,
    };
}

function decodeCogSog(buf: Uint8Array): N2KCogSog | null {
    if (buf.length < 8) return null;
    // Byte 0:    Sequence ID
    // Byte 1:    COG reference (lower 2 bits): 0=true, 1=magnetic
    // Byte 2-3:  COG (rad × 1e-4)
    // Byte 4-5:  SOG (m/s × 1e-2)
    // Byte 6-7:  Reserved
    const ref = buf[1] & 0x03;
    const cog = readU16(buf, 2);
    const sog = readU16(buf, 4);
    return {
        pgn: PGN.COG_SOG,
        sid: buf[0],
        cogReference: ref === 0 ? 'true' : ref === 1 ? 'magnetic' : 'unknown',
        cogDeg: isNA16(cog) ? null : cog * RES_RADIANS * RAD_TO_DEG,
        sogKts: isNA16(sog) ? null : sog * RES_KPH * MS_TO_KTS,
    };
}

function decodeWindData(buf: Uint8Array): N2KWindData | null {
    if (buf.length < 8) return null;
    // Byte 0:    Sequence ID
    // Byte 1-2:  Wind speed (m/s × 1e-2)
    // Byte 3-4:  Wind angle (rad × 1e-4)
    // Byte 5:    Wind reference (lower 3 bits): 0=true(N), 1=magnetic, 2=apparent, 3=true(boat), 4=true(water)
    const speed = readU16(buf, 1);
    const angle = readU16(buf, 3);
    const ref = buf[5] & 0x07;
    return {
        pgn: PGN.WIND_DATA,
        sid: buf[0],
        speedKts: isNA16(speed) ? null : speed * RES_KPH * MS_TO_KTS,
        angleDeg: isNA16(angle) ? null : angle * RES_RADIANS * RAD_TO_DEG,
        reference:
            ref === 0
                ? 'true_north'
                : ref === 1
                  ? 'magnetic'
                  : ref === 2
                    ? 'apparent'
                    : ref === 3
                      ? 'true_boat'
                      : ref === 4
                        ? 'true_water'
                        : 'unknown',
    };
}

function decodeWaterDepth(buf: Uint8Array): N2KWaterDepth | null {
    if (buf.length < 8) return null;
    // Byte 0:    Sequence ID
    // Byte 1-4:  Depth below transducer (m × 1e-2, unsigned)
    // Byte 5-6:  Offset (transducer to surface or keel, m × 1e-3, signed)
    // Byte 7:    Maximum range scale (m × 10, unsigned)
    const depthCm = readU32(buf, 1);
    const offsetMm = readI16(buf, 5);
    const range = buf[7];
    return {
        pgn: PGN.WATER_DEPTH,
        sid: buf[0],
        depthBelowTransducerM: isNA32(depthCm) ? null : depthCm * RES_DEPTH,
        offsetM: isNA16(offsetMm) ? null : offsetMm * 1e-3,
        maxRangeM: isNA8(range) ? null : range * 10,
    };
}

function decodeSpeedThroughWater(buf: Uint8Array): N2KSpeedThroughWater | null {
    if (buf.length < 6) return null;
    // Byte 0:    Sequence ID
    // Byte 1-2:  Speed water referenced (m/s × 1e-2)
    // Byte 3-4:  Speed ground referenced (m/s × 1e-2) — usually 0xFFFF
    // Byte 5:    Speed water reference type (lower 4 bits): 0=paddle wheel, 1=pitot, 2=doppler, 3=correlation, 4=electromagnetic
    const stw = readU16(buf, 1);
    const sog = readU16(buf, 3);
    const refType = buf[5] & 0x0f;
    return {
        pgn: PGN.SPEED_THROUGH_WATER,
        sid: buf[0],
        stwKts: isNA16(stw) ? null : stw * RES_KPH * MS_TO_KTS,
        sogKts: isNA16(sog) ? null : sog * RES_KPH * MS_TO_KTS,
        sensorType:
            refType === 0
                ? 'paddle_wheel'
                : refType === 1
                  ? 'pitot'
                  : refType === 2
                    ? 'doppler'
                    : refType === 3
                      ? 'correlation'
                      : refType === 4
                        ? 'electromagnetic'
                        : 'unknown',
    };
}

function decodeGnssPosition(buf: Uint8Array): N2KGnssPosition | null {
    // PGN 129029 is fast-packet, 43 bytes when fully assembled.
    if (buf.length < 43) return null;
    // Byte 0:     Sequence ID
    // Byte 1-2:   Position date (days since 1970)
    // Byte 3-6:   Position time (s × 1e-4)
    // Byte 7-14:  Latitude (deg × 1e-16, 64-bit signed)
    // Byte 15-22: Longitude (deg × 1e-16, 64-bit signed)
    // Byte 23-30: Altitude (m × 1e-6, 64-bit signed)
    // Byte 31:    GNSS type (lower 4 bits) | Method (upper 4 bits)
    // Byte 32:    Integrity (lower 2 bits) | Reserved
    // Byte 33:    Number of SVs
    // Byte 34-35: HDOP (signed × 1e-2)
    // Byte 36-37: PDOP (signed × 1e-2)
    // Byte 38-41: Geoidal separation (m × 1e-2, signed)
    // (Plus optional reference station fields, ignored here.)
    const lat = readI64(buf, 7);
    const lon = readI64(buf, 15);
    const numSvs = buf[33];
    const hdop = readI16(buf, 34);
    const pdop = readI16(buf, 36);
    return {
        pgn: PGN.GNSS_POSITION,
        sid: buf[0],
        // 64-bit math through bigint, then back to number — values are
        // small enough to fit in float64 once scaled.
        latitude: lat === 0n ? null : Number(lat) * RES_LATLON_64,
        longitude: lon === 0n ? null : Number(lon) * RES_LATLON_64,
        numSatellites: isNA8(numSvs) ? null : numSvs,
        hdop: isNA16(hdop) ? null : hdop * 1e-2,
        pdop: isNA16(pdop) ? null : pdop * 1e-2,
    };
}

function decodeEngineParametersRapid(buf: Uint8Array): N2KEngineParametersRapid | null {
    if (buf.length < 8) return null;
    // Byte 0:    Engine instance (0=single, 0=port, 1=starboard, etc.)
    // Byte 1-2:  Engine speed (RPM × 0.25, unsigned)
    // Byte 3-4:  Engine boost pressure (hPa, unsigned)
    // Byte 5:    Engine tilt/trim (% × 1)
    const instance = buf[0];
    const rpm = readU16(buf, 1);
    const boost = readU16(buf, 3);
    const tilt = readI8(buf, 5);
    return {
        pgn: PGN.ENGINE_PARAMETERS_RAPID,
        instance,
        rpm: isNA16(rpm) ? null : rpm * 0.25,
        boostPressureHpa: isNA16(boost) ? null : boost,
        tiltTrimPct: isNA8(buf[5]) ? null : tilt,
    };
}

function decodeEngineParametersDynamic(buf: Uint8Array): N2KEngineParametersDynamic | null {
    if (buf.length < 26) return null;
    // Byte 0:     Engine instance
    // Byte 1-2:   Oil pressure (hPa)
    // Byte 3-4:   Oil temperature (K × 0.1)
    // Byte 5-6:   Engine temperature (K × 0.01)
    // Byte 7-8:   Alternator potential (V × 0.01)
    // Byte 9-10:  Fuel rate (L/h × 0.1, signed)
    // Byte 11-14: Total engine hours (s × 1)
    // Byte 15-16: Coolant pressure (hPa)
    // Byte 17-18: Fuel pressure (hPa)
    const instance = buf[0];
    const oilPressure = readU16(buf, 1);
    const oilTempRaw = readU16(buf, 3);
    const engineTempRaw = readU16(buf, 5);
    const altVoltRaw = readU16(buf, 7);
    const fuelRateRaw = readI16(buf, 9);
    const engineHoursS = readU32(buf, 11);
    const coolantPressure = readU16(buf, 15);
    const fuelPressure = readU16(buf, 17);
    return {
        pgn: PGN.ENGINE_PARAMETERS_DYNAMIC,
        instance,
        oilPressureHpa: isNA16(oilPressure) ? null : oilPressure,
        oilTempC: isNA16(oilTempRaw) ? null : oilTempRaw * 0.1 - KELVIN_TO_C,
        engineTempC: isNA16(engineTempRaw) ? null : engineTempRaw * RES_TEMP - KELVIN_TO_C,
        alternatorVolts: isNA16(altVoltRaw) ? null : altVoltRaw * 0.01,
        fuelRateLph: isNA16(fuelRateRaw) ? null : fuelRateRaw * 0.1,
        engineHoursS: isNA32(engineHoursS) ? null : engineHoursS,
        coolantPressureHpa: isNA16(coolantPressure) ? null : coolantPressure,
        fuelPressureHpa: isNA16(fuelPressure) ? null : fuelPressure,
    };
}

// Type guard for the PGN enum to keep the dispatch table well-typed.
const DECODERS: Partial<Record<PGN, (buf: Uint8Array) => N2KMessage | null>> = {
    [PGN.VESSEL_HEADING]: decodeVesselHeading,
    [PGN.ATTITUDE]: decodeAttitude,
    [PGN.POSITION_RAPID]: decodePositionRapid,
    [PGN.COG_SOG]: decodeCogSog,
    [PGN.WIND_DATA]: decodeWindData,
    [PGN.WATER_DEPTH]: decodeWaterDepth,
    [PGN.SPEED_THROUGH_WATER]: decodeSpeedThroughWater,
    [PGN.GNSS_POSITION]: decodeGnssPosition,
    [PGN.ENGINE_PARAMETERS_RAPID]: decodeEngineParametersRapid,
    [PGN.ENGINE_PARAMETERS_DYNAMIC]: decodeEngineParametersDynamic,
};

/**
 * Top-level entry point: given a fully-assembled PGN payload, return a
 * typed N2KMessage. Returns null for unsupported PGNs or short buffers
 * — the caller can decide whether to log+drop or accumulate for a
 * higher-level handler.
 */
export function decodePgn(pgn: number, payload: Uint8Array): N2KMessage | null {
    const decoder = DECODERS[pgn as PGN];
    if (!decoder) return null;
    try {
        return decoder(payload);
    } catch (e) {
        // A buggy frame should not crash the pipeline. Log + null-drop.
        log.warn(`decoder for PGN ${pgn} threw`, e);
        return null;
    }
}

// Re-export the constants the decoder uses internally so tests can
// reference them without re-deriving the unit-conversion logic.
export const _testHelpers = { RES_RADIANS, RAD_TO_DEG, MS_TO_KTS, KELVIN_TO_C, NA_UINT16, NA_UINT32 };

export { PGN };
