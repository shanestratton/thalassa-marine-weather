import type { ResolvedRoutingPolar } from '../routingPolar';
import type { VesselProfile } from '../../types/vessel';
import { validPolarTable } from '../../utils/polarLearningRule';
import { createPolarSpeedLookup } from '../isochrone/polar';
import { closeHauledDegFor, pointOfSail, type PointOfSail } from '../sailing/pointOfSail';
import {
    simultaneous,
    TRUE,
    usableReading,
    wrapDegrees,
    type InstrumentEvidence,
    type InstrumentReading,
} from './measurements';

export type PropulsionState = 'sail' | 'engine' | 'unknown';
export interface PolarTarget {
    angleDeg: number;
    speedKts: number;
    vmgKts: number;
}
export interface SailingPerformance {
    kind: 'available';
    identity: string;
    observedAt: number;
    windKts: number;
    signedTwaDeg: number;
    windFromTrueDeg: number | null;
    vmgKts: number | null;
    referenceSpeedKts: number | null;
    performancePct: number | null;
    propulsion: PropulsionState;
    target: PolarTarget | null;
    upwind: PolarTarget | null;
    downwind: PolarTarget | null;
    mode: 'upwind' | 'downwind';
    leewayApplied: boolean;
    pointOfSail: PointOfSail | null;
    polarSource: ResolvedRoutingPolar['source'];
    polarLabel: string;
    polarReason: string;
    polarSignature: string;
    routingScale: number;
}
export type PerformanceRefusal =
    | 'not-sailing-boat'
    | 'engine-running'
    | 'wind-unavailable'
    | 'wind-not-simultaneous'
    | 'polar-unavailable'
    | 'wind-outside-polar';
export type SailingPerformanceResult = SailingPerformance | { kind: 'unavailable'; reason: PerformanceRefusal };

/** Targets are model figures; VMG is STW-based, and a sailing percentage requires a known under-sail state. */
export function sailingPerformance(args: {
    evidence: InstrumentEvidence | null | undefined;
    polar: ResolvedRoutingPolar | null | undefined;
    vessel: Pick<VesselProfile, 'type' | 'closeHauledTwa' | 'hullType' | 'riggingType'>;
    propulsion: PropulsionState;
    now: number;
}): SailingPerformanceResult {
    const no = (reason: PerformanceRefusal): SailingPerformanceResult => ({ kind: 'unavailable', reason });
    if (args.vessel.type !== 'sail') return no('not-sailing-boat');
    if (args.propulsion === 'engine') return no('engine-running');
    const evidence = args.evidence;
    if (!evidence || !Number.isFinite(args.now)) return no('wind-unavailable');
    const { tws, twaSigned, twdTrue, headingTrue, stw, leeway } = evidence.readings;
    if (!usableReading(tws, 'knots', args.now, 0, 150)) return no('wind-unavailable');
    const used: InstrumentReading[] = [tws];
    let signedTwa: number;
    let windTrue: number | null = null;
    const haveHeading = usableReading(headingTrue, 'degrees', args.now, 0, 360, 'true');
    const haveDirection = usableReading(twdTrue, 'degrees', args.now, 0, 360, 'true');
    if (usableReading(twaSigned, 'degrees', args.now, -180, 180, 'relative')) {
        signedTwa = twaSigned.value;
        used.push(twaSigned);
        if (haveDirection && simultaneous([tws, twaSigned, twdTrue])) {
            windTrue = wrapDegrees(twdTrue.value);
            used.push(twdTrue);
        } else if (haveHeading && simultaneous([tws, twaSigned, headingTrue])) {
            windTrue = wrapDegrees(headingTrue.value + signedTwa);
            used.push(headingTrue);
        }
    } else if (haveDirection && haveHeading) {
        signedTwa = wrapDegrees(twdTrue.value - headingTrue.value + 180) - 180;
        windTrue = wrapDegrees(twdTrue.value);
        used.push(twdTrue, headingTrue);
    } else return no('wind-unavailable');
    if (!simultaneous(used)) return no('wind-not-simultaneous');
    const resolved = args.polar;
    if (!resolved || !validPolarTable(resolved.polar)) return no('polar-unavailable');
    const polar = resolved.polar;
    if (tws.value < polar.windSpeeds[0] || tws.value > polar.windSpeeds.at(-1)!) return no('wind-outside-polar');
    const speed = createPolarSpeedLookup(polar, tws.value);
    let upwind: PolarTarget | null = null,
        downwind: PolarTarget | null = null;
    // The table is bilinear; an explicit one-degree search supplies honest whole-degree targets.
    for (let angle = Math.ceil(polar.angles[0]); angle <= Math.min(180, polar.angles.at(-1)!); angle++) {
        const knots = speed(angle);
        if (!(knots > 0) || !Number.isFinite(knots)) continue;
        if (angle < 90) {
            const vmg = knots * Math.cos(angle * TRUE);
            if (!upwind || vmg > upwind.vmgKts) upwind = { angleDeg: angle, speedKts: knots, vmgKts: vmg };
        } else if (angle > 90) {
            const vmg = -knots * Math.cos(angle * TRUE);
            if (!downwind || vmg > downwind.vmgKts) downwind = { angleDeg: angle, speedKts: knots, vmgKts: vmg };
        }
    }
    const angle = Math.abs(signedTwa);
    const angleCovered = angle >= polar.angles[0] && angle <= polar.angles.at(-1)!;
    const reference = angleCovered ? speed(angle) : null;
    const water = usableReading(stw, 'knots', args.now, 0, 100, 'water') && simultaneous([...used, stw]) ? stw : null;
    if (water) used.push(water);
    const correction =
        usableReading(leeway, 'degrees', args.now, -20, 20, 'relative') && simultaneous([...used, leeway])
            ? leeway
            : null;
    if (correction) used.push(correction);
    const mode = angle <= 90 ? 'upwind' : 'downwind';
    return {
        kind: 'available',
        identity: evidence.identity,
        observedAt: Math.min(...used.map((value) => value.at)),
        windKts: tws.value,
        signedTwaDeg: signedTwa,
        windFromTrueDeg: windTrue,
        vmgKts: water ? water.value * Math.cos((signedTwa - (correction?.value ?? 0)) * TRUE) : null,
        referenceSpeedKts: reference !== null && reference > 0 ? reference : null,
        performancePct:
            args.propulsion === 'sail' && water && reference !== null && reference > 0
                ? (water.value / reference) * 100
                : null,
        propulsion: args.propulsion,
        target: mode === 'upwind' ? upwind : downwind,
        upwind,
        downwind,
        mode,
        leewayApplied: correction !== null,
        pointOfSail:
            args.propulsion === 'sail'
                ? pointOfSail({
                      windFromDeg: signedTwa,
                      sogKts: water?.value,
                      closeHauledDeg: closeHauledDegFor(args.vessel),
                  })
                : null,
        polarSource: resolved.source,
        polarLabel: resolved.label,
        polarReason: resolved.reason,
        polarSignature: resolved.signature,
        routingScale: resolved.routingScale ?? 1,
    };
}
