import type { CurrentField2D } from './env/EnvFields';

export interface ForecastSteering {
    headingDeg: number | null;
    adjustmentDeg: number | null;
    currentKn: number;
    stwKn: number;
    setDeg: number;
    sampledAtMs: number;
    model: 'CMEMS' | 'RTOFS';
    runMs: number;
    generation: string;
    components: 'ocean' | 'ocean+tide';
}

/** A forecast vector triangle, never the live measured-current CTS. No leeway guess. */
export function forecastSteeringAt(
    field: CurrentField2D | null,
    point: { lat: number; lon: number },
    timeMs: number,
    courseDeg: number,
    stwKn: number,
): ForecastSteering | null {
    const source = field?.forecast;
    if (
        !source ||
        !['CMEMS', 'RTOFS'].includes(source.model) ||
        !['ocean', 'ocean+tide'].includes(source.components) ||
        !['CMEMS_HOURLY', 'RTOFS_FORECAST'].includes(field!.provenance) ||
        (source.model === 'CMEMS' ? field!.provenance !== 'CMEMS_HOURLY' : field!.provenance !== 'RTOFS_FORECAST') ||
        !source.generation ||
        !Number.isFinite(source.runMs) ||
        source.runMs > timeMs ||
        ![point.lat, point.lon, timeMs, courseDeg, stwKn].every(Number.isFinite) ||
        Math.abs(point.lat) > 90 ||
        Math.abs(point.lon) > 180 ||
        stwKn <= 0
    )
        return null;
    const vector = field!.currentAt(point.lat, point.lon, timeMs);
    if (!vector || ![vector.u, vector.v].every(Number.isFinite)) return null;
    const theta = (courseDeg * Math.PI) / 180;
    const along = vector.u * Math.sin(theta) + vector.v * Math.cos(theta);
    const across = vector.u * Math.cos(theta) - vector.v * Math.sin(theta);
    const stw = stwKn / 1.9438444924406;
    const canHold = Math.abs(across) < stw && along + Math.sqrt(Math.max(0, stw * stw - across * across)) > 0;
    const adjustmentDeg = canHold ? (Math.asin(-across / stw) * 180) / Math.PI : null;
    return {
        headingDeg: adjustmentDeg === null ? null : (((courseDeg + adjustmentDeg) % 360) + 360) % 360,
        adjustmentDeg,
        currentKn: Math.hypot(vector.u, vector.v) * 1.9438444924406,
        stwKn,
        setDeg: ((Math.atan2(vector.u, vector.v) * 180) / Math.PI + 360) % 360,
        sampledAtMs: timeMs,
        ...source,
    };
}

export function forecastSteeringText(value: ForecastSteering | null): string {
    if (!value) return 'Forecast steer unavailable';
    if (value.headingDeg === null) return 'Forecast current: planned speed cannot hold this course';
    const degrees = Math.abs(value.adjustmentDeg!);
    const set =
        degrees < 0.5
            ? 'no cross-course set'
            : `current sets ${Math.round(degrees)}° to ${value.adjustmentDeg! < 0 ? 'starboard' : 'port'}`;
    return `Forecast steer ${String(Math.round(value.headingDeg) % 360).padStart(3, '0')}°T at ${value.stwKn.toFixed(1)} kn STW · ${set}`;
}
