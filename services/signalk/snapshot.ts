import type { RemoteInstrumentSnapshot } from '../NmeaStore';
import type { EngineTelemetry } from '../instruments/engineTelemetry';
import { signalkRecord, signalKExpectedUnit } from '../../pi-cache/src/signalkProtocol';
const KTS = 1.9438444924406,
    DEG = 180 / Math.PI;
/** A source-dated self document becomes gauges; no phone/GPS/receipt-clock fallback. */
export function directSignalKSnapshot(
    doc: Record<string, unknown>,
    identity: string,
    now = Date.now(),
    meterIdentity?: string,
): RemoteInstrumentSnapshot {
    const clocked: Record<string, number> = {};
    const leaf = (path: string): { value: unknown; at: number; source: string } | null => {
        let node: unknown = doc;
        for (const key of path.split('.')) node = signalkRecord(node)?.[key];
        const v = signalkRecord(node),
            at = typeof v?.timestamp === 'string' ? Date.parse(v.timestamp) : NaN;
        const unit = signalkRecord(v?.meta)?.units;
        if (unit !== undefined && unit !== signalKExpectedUnit(path)) return null;
        return v &&
            Number.isSafeInteger(at) &&
            at > 0 &&
            at <= now + 1000 &&
            now - at <= 13000 &&
            typeof v.$source === 'string'
            ? { value: v.value, at, source: v.$source }
            : null;
    };
    const num = (path: string, key: string, low: number, high: number, factor = 1, offset = 0): number | null => {
        const v = leaf(path);
        if (!v || typeof v.value !== 'number' || !Number.isFinite(v.value) || v.value < low || v.value > high)
            return null;
        clocked[key] = v.at;
        return v.value * factor + offset;
    };
    const angle = (path: string, key: string, signed = false) => {
        const n = num(path, key, signed ? -Math.PI : 0, signed ? Math.PI : 2 * Math.PI, DEG);
        return n === null ? null : signed ? n : n % 360;
    };
    const pos = leaf('navigation.position'),
        p = signalkRecord(pos?.value);
    const positionGood =
        p &&
        typeof p.latitude === 'number' &&
        typeof p.longitude === 'number' &&
        Number.isFinite(p.latitude) &&
        Number.isFinite(p.longitude) &&
        Math.abs(p.latitude) <= 90 &&
        Math.abs(p.longitude) <= 180;
    if (positionGood && pos) {
        clocked.latitude = pos.at;
        clocked.longitude = pos.at;
    }
    const attitude = leaf('navigation.attitude'),
        a = signalkRecord(attitude?.value);
    const attitudeValue = (key: 'roll' | 'pitch') => {
        const v = a?.[key];
        if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > Math.PI || !attitude) return null;
        clocked[key === 'roll' ? 'heel' : 'pitch'] = attitude.at;
        return v * DEG;
    };
    let depthM = num('environment.depth.belowKeel', 'depth', -20, 12000);
    let depthReference: RemoteInstrumentSnapshot['depthReference'] = 'below-keel';
    const depth = signalkRecord(signalkRecord(doc.environment)?.depth);
    const hasKeelSetting = depth && ('belowKeel' in depth || 'transducerToKeel' in depth);
    if (depthM === null) {
        depthM = num('environment.depth.belowTransducer', 'depth', 0, 12000);
        depthReference = 'below-transducer';
    }
    if (depthM === null && !hasKeelSetting) {
        depthM = num('environment.depth.belowSurface', 'depth', 0, 12000);
        depthReference = 'below-waterline';
    }
    const engines = Object.keys(signalkRecord(doc.propulsion) ?? {}).filter(
        (id) => /^[A-Za-z0-9_-]{1,40}$/.test(id) && !['constructor', 'prototype', '__proto__'].includes(id),
    );
    const rpms = engines
        .map((id) => ({ id, value: num(`propulsion.${id}.revolutions`, `rpm:${id}`, 0, 250, 60) }))
        .filter((r): r is { id: string; value: number } => r.value !== null);
    const peak = rpms.sort((x, y) => y.value - x.value)[0];
    if (peak) clocked.rpm = clocked[`rpm:${peak.id}`];
    let engineTelemetry: EngineTelemetry | undefined;
    if (engines.length === 1 && peak) {
        engineTelemetry = { engineId: peak.id };
        for (const [key, path, low, high, factor, offset] of [
            ['runTime', 'runTime', 0, 3_153_600_000, 1, 0],
            ['coolant', 'coolantTemperature', 213.15, 473.15, 1, -273.15],
            ['oilPressure', 'oilPressure', 0, 5_000_000, 0.001, 0],
        ] as const) {
            const value = num(`propulsion.${peak.id}.${path}`, `engine:${key}`, low, high, factor, offset);
            if (value !== null) engineTelemetry[key] = { value, at: clocked[`engine:${key}`] };
        }
    }
    const snapshot: RemoteInstrumentSnapshot = {
        source: 'device',
        via: 'signalk',
        deviceLabel: 'Direct Signal K · read only',
        reportedAt: now,
        windHistoryIdentity: identity,
        ...(meterIdentity ? { meterIdentity } : {}),
        lat: positionGood ? (p.latitude as number) : null,
        lon: positionGood ? (p.longitude as number) : null,
        ...(positionGood && pos ? { positionSampleAt: pos.at } : {}),
        sogKts: num('navigation.speedOverGround', 'sog', 0, 150, KTS),
        cogDeg: angle('navigation.courseOverGroundTrue', 'cog'),
        stwKts: num('navigation.speedThroughWater', 'stw', 0, 150, KTS),
        headingDeg: angle('navigation.headingTrue', 'heading'),
        headingTrueDeg: angle('navigation.headingTrue', 'headingTrue'),
        twsKts: num('environment.wind.speedTrue', 'tws', 0, 150, KTS),
        twaDeg: angle('environment.wind.angleTrueWater', 'twaSigned', true),
        twdDeg: angle('environment.wind.directionTrue', 'twdTrue'),
        awsKts: num('environment.wind.speedApparent', 'aws', 0, 150, KTS),
        awaDeg: angle('environment.wind.angleApparent', 'awa', true),
        depthM,
        depthReference,
        heelDeg: attitudeValue('roll'),
        pitchDeg: attitudeValue('pitch'),
        waterTempC: num('environment.water.temperature', 'waterTemp', 213.15, 333.15, 1, -273.15),
        rudderDeg: angle('steering.rudderAngle', 'rudder', true),
        rpm: peak?.value ?? null,
        voltageV: null,
        ...(peak
            ? {
                  rpmAtMs: clocked.rpm,
                  rpmEngineCount: engines.length,
                  ...(engines.length === 1 ? { rpmEngineId: peak.id } : {}),
              }
            : {}),
        ...(engineTelemetry ? { engineTelemetry } : {}),
        leewayDeg: angle('navigation.leewayAngle', 'leeway', true),
    };
    snapshot.leewaySource = clocked.leeway ? 'Direct Signal K measured signed leeway' : undefined;
    snapshot.headingTrueAt = clocked.headingTrue;
    snapshot.windSampleAt = clocked.tws;
    snapshot.twdSampleAt = clocked.twdTrue;
    snapshot.windSampleSource = leaf('environment.wind.speedTrue')?.source;
    snapshot.measurementTimes = {
        sog: clocked.sog,
        cogTrue: clocked.cog,
        stw: clocked.stw,
        headingTrue: clocked.headingTrue,
        tws: clocked.tws,
        twaSigned: clocked.twaSigned,
        twdTrue: clocked.twdTrue,
        rpm: clocked.rpm,
        heel: clocked.heel,
        leeway: clocked.leeway,
        position: pos?.at,
    };
    snapshot.gaugeTimes = {
        tws: clocked.tws,
        twa: clocked.twaSigned,
        twaSigned: clocked.twaSigned,
        twd: clocked.twdTrue,
        heel: clocked.heel,
        pitch: clocked.pitch,
        aws: clocked.aws,
        awa: clocked.awa,
        stw: clocked.stw,
        heading: clocked.heading,
        depth: clocked.depth,
        sog: clocked.sog,
        cog: clocked.cog,
        waterTemp: clocked.waterTemp,
        rudder: clocked.rudder,
        rpm: clocked.rpm,
        latitude: clocked.latitude,
        longitude: clocked.longitude,
    };
    return snapshot;
}
