/**
 * NMEA 2000 type definitions for the PGN decoder.
 *
 * `PGN` enum is a subset — the marine-yacht-relevant PGNs we currently
 * decode. Add to it as more decoders land. The numeric values are the
 * official PGN numbers from the NMEA 2000 spec.
 */

export enum PGN {
    /** Vessel Heading (rad → deg). 100ms cadence. */
    VESSEL_HEADING = 127250,
    /** Attitude — yaw / pitch / roll. 100ms cadence. */
    ATTITUDE = 127257,
    /** Engine Parameters Rapid — RPM, boost, tilt. 100ms cadence per engine. */
    ENGINE_PARAMETERS_RAPID = 127488,
    /** Engine Parameters Dynamic — temps, fuel rate, alternator V, hours. 500ms. */
    ENGINE_PARAMETERS_DYNAMIC = 127489,
    /** Speed (water referenced). 1000ms. */
    SPEED_THROUGH_WATER = 128259,
    /** Water Depth + transducer offset. 1000ms. */
    WATER_DEPTH = 128267,
    /** Position — Rapid (lat/lon, 32-bit). 100ms cadence. */
    POSITION_RAPID = 129025,
    /** COG / SOG — Rapid. 100ms. */
    COG_SOG = 129026,
    /** GNSS Position Data — high-resolution (64-bit lat/lon, HDOP, satellites). 1000ms. */
    GNSS_POSITION = 129029,
    /** Wind Data — speed + angle, with reference frame. 100ms. */
    WIND_DATA = 130306,
}

// ── Per-PGN payload shapes ────────────────────────────────────────────
//
// All numeric fields are decoded into the most useful unit for a
// sailing yacht UI:
//   - angles in degrees (true / magnetic noted)
//   - speeds in knots
//   - depths in meters
//   - temperatures in Celsius
//   - pressures in hPa
//   - voltages in volts
//
// `null` means the upstream sensor reported the N2K "data not available"
// sentinel for that field. Callers should treat null as "unknown" rather
// than 0.

export interface N2KVesselHeading {
    pgn: PGN.VESSEL_HEADING;
    sid: number;
    headingDeg: number | null;
    deviationDeg: number | null;
    variationDeg: number | null;
    reference: 'true' | 'magnetic' | 'unknown';
}

export interface N2KAttitude {
    pgn: PGN.ATTITUDE;
    sid: number;
    yawDeg: number | null;
    pitchDeg: number | null;
    rollDeg: number | null;
}

export interface N2KPositionRapid {
    pgn: PGN.POSITION_RAPID;
    latitude: number | null;
    longitude: number | null;
}

export interface N2KCogSog {
    pgn: PGN.COG_SOG;
    sid: number;
    cogReference: 'true' | 'magnetic' | 'unknown';
    cogDeg: number | null;
    sogKts: number | null;
}

export interface N2KWindData {
    pgn: PGN.WIND_DATA;
    sid: number;
    speedKts: number | null;
    angleDeg: number | null;
    /**
     * Reference frame for the angle:
     *  - `apparent`     — relative to vessel heading (most common on instruments)
     *  - `true_north`   — relative to true north (rare)
     *  - `magnetic`     — relative to magnetic north
     *  - `true_boat`    — true wind relative to vessel heading
     *  - `true_water`   — true wind relative to water
     */
    reference: 'apparent' | 'true_north' | 'magnetic' | 'true_boat' | 'true_water' | 'unknown';
}

export interface N2KWaterDepth {
    pgn: PGN.WATER_DEPTH;
    sid: number;
    depthBelowTransducerM: number | null;
    /** Transducer offset; positive values = transducer above keel. */
    offsetM: number | null;
    maxRangeM: number | null;
}

export interface N2KSpeedThroughWater {
    pgn: PGN.SPEED_THROUGH_WATER;
    sid: number;
    stwKts: number | null;
    /** Sometimes also reported here; usually null because COG_SOG covers it. */
    sogKts: number | null;
    sensorType: 'paddle_wheel' | 'pitot' | 'doppler' | 'correlation' | 'electromagnetic' | 'unknown';
}

export interface N2KGnssPosition {
    pgn: PGN.GNSS_POSITION;
    sid: number;
    latitude: number | null;
    longitude: number | null;
    numSatellites: number | null;
    hdop: number | null;
    pdop: number | null;
}

export interface N2KEngineParametersRapid {
    pgn: PGN.ENGINE_PARAMETERS_RAPID;
    instance: number;
    rpm: number | null;
    boostPressureHpa: number | null;
    tiltTrimPct: number | null;
}

export interface N2KEngineParametersDynamic {
    pgn: PGN.ENGINE_PARAMETERS_DYNAMIC;
    instance: number;
    oilPressureHpa: number | null;
    oilTempC: number | null;
    engineTempC: number | null;
    alternatorVolts: number | null;
    fuelRateLph: number | null;
    engineHoursS: number | null;
    coolantPressureHpa: number | null;
    fuelPressureHpa: number | null;
}

/**
 * Discriminated union of every supported PGN payload. Use the `pgn`
 * field to narrow at the call site.
 */
export type N2KMessage =
    | N2KVesselHeading
    | N2KAttitude
    | N2KPositionRapid
    | N2KCogSog
    | N2KWindData
    | N2KWaterDepth
    | N2KSpeedThroughWater
    | N2KGnssPosition
    | N2KEngineParametersRapid
    | N2KEngineParametersDynamic;
