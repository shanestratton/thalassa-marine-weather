import type { Feature, Geometry } from 'geojson';
import type { InstrumentEvidence } from '../instruments/measurements';
import { usableReading } from '../instruments/measurements';
import { haversineNm, initialBearing, projectPosition } from '../isochrone/geodesy';
export interface RulerFix {
    lat: number;
    lon: number;
    at: number;
    identity: string;
    source: string;
    headingTrue: number | null;
    headingAt: number | null;
}
export interface BoatRuler {
    bearingTrue: number;
    rangeNm: number;
    identity: string;
}
export function qualifiedRulerFix(
    evidence: InstrumentEvidence | undefined,
    now: number,
    ownerKey: string,
): RulerFix | null {
    const p = evidence?.position;
    if (
        !evidence ||
        !ownerKey ||
        ownerKey.length > 512 ||
        !['gateway', 'lan'].includes(evidence.via) ||
        !evidence.identity ||
        evidence.identity.length > 512 ||
        !p ||
        !Number.isFinite(p.lat) ||
        !Number.isFinite(p.lon) ||
        Math.abs(p.lat) > 85 ||
        Math.abs(p.lon) > 180 ||
        !Number.isSafeInteger(p.at) ||
        p.at <= 0 ||
        p.at > now ||
        now - p.at > 13000
    )
        return null;
    const heading = evidence.readings.headingTrue;
    const qualified =
        usableReading(heading, 'degrees', now, 0, 360, 'true') &&
        heading.at <= now &&
        Math.abs(heading.at - p.at) <= 6000;
    return {
        ...p,
        identity: `${ownerKey}:${evidence.identity}:${evidence.via}`,
        source: evidence.via === 'lan' ? 'paired Pi boat receiver' : 'boat gateway',
        headingTrue: qualified ? heading.value : null,
        headingAt: qualified ? heading.at : null,
    };
}
function fresh(fix: RulerFix, now: number): boolean {
    return (
        Number.isFinite(now) &&
        Number.isSafeInteger(fix.at) &&
        fix.at > 0 &&
        fix.at <= now &&
        now - fix.at <= 13000 &&
        Number.isFinite(fix.lat) &&
        Math.abs(fix.lat) <= 85 &&
        Number.isFinite(fix.lon) &&
        Math.abs(fix.lon) <= 180
    );
}
export function boatRulerTo(fix: RulerFix, target: { lat: number; lon: number }, now = Date.now()): BoatRuler {
    if (!fresh(fix, now)) throw Error('Fresh boat position unavailable. The ruler was not set.');
    if (
        !Number.isFinite(target.lat) ||
        !Number.isFinite(target.lon) ||
        Math.abs(target.lat) > 85 ||
        Math.abs(target.lon) > 180
    )
        throw Error('Choose a valid chart point.');
    const rangeNm = haversineNm(fix.lat, fix.lon, target.lat, target.lon);
    if (rangeNm < 0.005 || rangeNm > 50) throw Error('Choose a range from 0.005 to 50 NM.');
    if (Math.abs(fix.lat) + rangeNm / 60 > 85)
        throw Error('This range ring exceeds the chart projection near the pole.');
    return { bearingTrue: initialBearing(fix.lat, fix.lon, target.lat, target.lon), rangeNm, identity: fix.identity };
}
/** Fixed true EBL/range follows the current boat; no heading or phone-position substitution. */
export function boatRulerData(
    ruler: BoatRuler | null,
    fix: RulerFix | null,
    now = Date.now(),
): { features: Feature<Geometry>[]; relative: number | null } | null {
    if (
        !ruler ||
        !fix ||
        ruler.identity !== fix.identity ||
        !fresh(fix, now) ||
        !Number.isFinite(ruler.rangeNm) ||
        ruler.rangeNm < 0.005 ||
        ruler.rangeNm > 50 ||
        !Number.isFinite(ruler.bearingTrue) ||
        ruler.bearingTrue < 0 ||
        ruler.bearingTrue >= 360 ||
        Math.abs(fix.lat) + ruler.rangeNm / 60 > 85
    )
        return null;
    const end = projectPosition(fix.lat, fix.lon, ruler.bearingTrue, ruler.rangeNm);
    const ring = Array.from({ length: 97 }, (_, i) => {
        const p = projectPosition(fix.lat, fix.lon, ((i % 96) * 360) / 96, ruler.rangeNm);
        return [p.lon + 360 * Math.round((fix.lon - p.lon) / 360), p.lat];
    });
    return {
        features: [
            {
                type: 'Feature',
                properties: { kind: 'ebl' },
                geometry: {
                    type: 'LineString',
                    coordinates: [
                        [fix.lon, fix.lat],
                        [end.lon + 360 * Math.round((fix.lon - end.lon) / 360), end.lat],
                    ],
                },
            },
            { type: 'Feature', properties: { kind: 'vrm' }, geometry: { type: 'LineString', coordinates: ring } },
        ],
        relative:
            fix.headingTrue === null ||
            !Number.isFinite(fix.headingTrue) ||
            fix.headingTrue < 0 ||
            fix.headingTrue > 360 ||
            fix.headingAt === null ||
            !Number.isSafeInteger(fix.headingAt) ||
            fix.headingAt > now ||
            now - fix.headingAt > 13000 ||
            Math.abs(fix.headingAt - fix.at) > 6000
                ? null
                : ((ruler.bearingTrue - fix.headingTrue + 540) % 360) - 180,
    };
}
