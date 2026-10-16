import type { RemoteInstrumentSnapshot } from '../NmeaStore';
import type { InstrumentEvidence, InstrumentMeasurementTimes } from './measurements';

/** Build evidence from explicit source clocks only. Receipt/report timestamps never qualify. */
export function remoteInstrumentEvidence(snapshot: RemoteInstrumentSnapshot): InstrumentEvidence {
    const times = snapshot.measurementTimes ?? {};
    const readings: InstrumentEvidence['readings'] = {};
    const add = (
        key: keyof InstrumentEvidence['readings'],
        value: number | null | undefined,
        unit: 'knots' | 'degrees' | 'rpm',
        reference?: 'true' | 'water' | 'ground' | 'relative',
    ) => {
        const at = times[key];
        if (typeof at === 'number')
            readings[key] = { value: value ?? null, at, unit, reference, source: 'Pi Signal K measured leaf' };
    };
    add('sog', snapshot.sogKts, 'knots', 'ground');
    add('cogTrue', snapshot.cogDeg, 'degrees', 'true');
    add('stw', snapshot.stwKts, 'knots', 'water');
    add('headingTrue', snapshot.headingTrueDeg, 'degrees', 'true');
    add('tws', snapshot.twsKts, 'knots');
    add('twaSigned', snapshot.twaDeg, 'degrees', 'relative');
    add('twdTrue', snapshot.twdDeg, 'degrees', 'true');
    add('rpm', snapshot.rpm, 'rpm');
    add('heel', snapshot.heelDeg, 'degrees', 'relative');
    if (snapshot.leewaySource) {
        add('leeway', snapshot.leewayDeg, 'degrees', 'relative');
        if (readings.leeway) readings.leeway.source = snapshot.leewaySource;
    }
    return {
        identity: snapshot.windHistoryIdentity ?? `remote:${snapshot.source}:${snapshot.deviceLabel ?? 'unknown'}`,
        via: snapshot.via ?? 'cloud',
        readings,
        ...(typeof times.position === 'number' &&
        typeof snapshot.lat === 'number' &&
        typeof snapshot.lon === 'number' &&
        Number.isFinite(snapshot.lat) &&
        Number.isFinite(snapshot.lon) &&
        Math.abs(snapshot.lat) <= 90 &&
        Math.abs(snapshot.lon) <= 180
            ? { position: { lat: snapshot.lat, lon: snapshot.lon, at: times.position } }
            : {}),
    };
}

export function evidenceTimes(evidence: InstrumentEvidence | undefined): InstrumentMeasurementTimes {
    return evidence
        ? {
              ...Object.fromEntries(Object.entries(evidence.readings).map(([key, r]) => [key, r!.at])),
              ...(evidence.position ? { position: evidence.position.at } : {}),
          }
        : {};
}
