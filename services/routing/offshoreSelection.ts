import type { IsochroneNode } from '../isochrone/types';
import type { RouteHazardReport } from '../enc/EncHazardReportService';
import type { OffshoreCandidate, OffshoreJob } from './offshoreProtocol';
import type { IsochroneEnvironment } from './isochroneEnvironment';
import { verifiedIsochroneRoute } from './verifiedIsochroneRoute';
import { inspectRouteEnvironment } from '../isochrone/routeComfort';
import { summarizeOffshoreResult } from './offshoreJob';
import { knownRouteAreaCaveats } from './routeAreaWords';
import { assertRoutingSourceCurrent } from './routeSourceLifetime';

export interface VerifiedOffshoreCandidate extends Omit<OffshoreCandidate, 'verification'> {
    verification: 'verified-final-geometry';
    hazardReport: RouteHazardReport | null;
}

// Only the exact result issued below carries the reader's weak lifetime proof.
// DTO copies and saved metadata cannot reproduce it; no geometry is retained here.
const sourceProofs = new WeakMap<VerifiedOffshoreCandidate, (() => boolean) | undefined>();
export function assertVerifiedOffshoreSourceCurrent(candidate: VerifiedOffshoreCandidate): void {
    if (!sourceProofs.has(candidate)) assertRoutingSourceCurrent(() => false);
    try {
        assertRoutingSourceCurrent(sourceProofs.get(candidate));
    } catch (error) {
        sourceProofs.delete(candidate);
        throw error;
    }
}

/** This is the only bridge from a public Worker candidate to an exportable passage. */
export async function verifyOffshoreSelection(options: {
    candidate: OffshoreCandidate;
    job: OffshoreJob;
    environment: IsochroneEnvironment;
    cruisingSpeed: number;
    withTerminals: (route: IsochroneNode[]) => IsochroneNode[];
    validate: (route: IsochroneNode[]) => Promise<{
        route: IsochroneNode[];
        verified: boolean;
        reason?: string;
        hazardReport?: RouteHazardReport | null;
        areaCaveats?: readonly string[];
        sourceCurrent?: () => boolean;
    }>;
    isCurrent: () => boolean;
}): Promise<VerifiedOffshoreCandidate> {
    const { candidate, job, environment, isCurrent } = options;
    if (!isCurrent()) throw new Error('Comparison is no longer current.');
    const checked = await options.validate(options.withTerminals(candidate.result.route));
    if (!isCurrent()) throw new Error('Comparison is no longer current.');
    if (!checked.verified) throw new Error(checked.reason ?? 'Chart and land verification did not complete.');
    const sourceCurrent = checked.sourceCurrent;
    assertRoutingSourceCurrent(sourceCurrent);
    const result = verifiedIsochroneRoute(candidate.result, checked.route, job.departureTime, options.cruisingSpeed);
    const inspected = inspectRouteEnvironment(
        result.route,
        environment.waveField,
        environment.exclusionField,
        result.comfort?.usedLimitM ?? job.config.comfortParams?.maxWaveM,
        job.config.comfortVessel,
    );
    if (inspected.rejected) throw new Error('The verified path crosses a wave limit or cyclone exclusion.');
    result.comfort = {
        ...inspected.comfort,
        ...(result.comfort?.relaxedFromM !== undefined
            ? { relaxedFromM: result.comfort.relaxedFromM, usedLimitM: result.comfort.usedLimitM }
            : {}),
    };
    result.environmentNotes = [
        ...environment.notes,
        ...(result.environmentNotes ?? []),
        ...knownRouteAreaCaveats(checked.areaCaveats),
    ].filter((note, index, all) => all.indexOf(note) === index);
    const summary = summarizeOffshoreResult(job, result, isCurrent);
    if (!summary || !isCurrent()) throw new Error('Final route lacks forecast coverage or exceeds wind/gust limits.');
    assertRoutingSourceCurrent(sourceCurrent);
    const selected: VerifiedOffshoreCandidate = {
        ...summary,
        verification: 'verified-final-geometry',
        hazardReport: checked.hazardReport ?? null,
    };
    sourceProofs.set(selected, sourceCurrent);
    return selected;
}
