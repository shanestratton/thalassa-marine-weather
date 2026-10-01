import type { AutoroutingTrialRoute } from '../types/autorouting';
import { dangerWithoutChartedDepth } from '../components/map/inshoreRouteState';
import type { TrialRouteReview } from './autoroutingReview';
import { saveTrace, type SavedTrace, type TracePoint } from './routeTracer';
import { getRegistryFingerprint } from './enc/EncCellMetadata';
import { isAuthIdentityScopeCurrent, type AuthIdentityScope } from './authIdentityScope';
import {
    autoroutingProposalGeometryKey,
    normaliseAutoroutingProposalEvidence,
    type SavedAutoroutingProposalEvidence,
} from './autoroutingProposalEvidence';
import type { PushResult } from './savedRoutesSync';

export interface ReviewedProposalSaveInput {
    name: string;
    route: AutoroutingTrialRoute;
    review: TrialRouteReview | null;
    currentDraftM: number;
    currentDraftAssumed: boolean;
    acknowledgedPlannedOnly: boolean;
}

/** Eligibility is not clearance. Complete missing-depth/caution results may
 * be retained as a planned-only record; known danger/tide dependencies may not. */
export function evaluateAutoroutingProposalSave(
    route: AutoroutingTrialRoute,
    review: TrialRouteReview | null,
    currentDraftM: number,
    currentDraftAssumed: boolean,
): { eligible: boolean; reason: string } {
    const deny = (reason: string) => ({ eligible: false, reason });
    // Thalassa's router is Auto's only provider since 2026-10-01.
    if (route.provider !== 'Thalassa') return deny('The proposal origin is not recognised.');
    if (route.localEdit !== undefined)
        return deny("This edited route has not been rechecked by Thalassa's router and cannot be saved. Recalculate.");
    // The line was routed but its safety classifications did not arrive intact
    // (the planner's dashed 'unverified' line): never a saved plan.
    if (
        !route.engine ||
        !Array.isArray(route.engine.stateMask) ||
        route.engine.stateMask.length !== route.coordinates.length - 1
    )
        return deny('Route shown, verification incomplete. Recalculate before saving.');
    // Review fix-ups (2026-10-01). Land the route crosses away from a pin's
    // own edge: Auto refuses such a route, so this only holds the line.
    if ((route.engine.hardLandAwayM ?? 0) > 0)
        return deny('This route crosses charted land. It cannot be saved. Nothing was saved.');
    // Red with no charted depth behind it — land, water no chart vouches for,
    // a charted hazard's buffer: nothing on the chart says the boat floats
    // there, whatever the independent review graded it.
    if ((dangerWithoutChartedDepth(route.engine) ?? [0]).length > 0)
        return deny(
            'Part of this route is drawn red with no charted depth behind it (land, uncharted water or a charted hazard). It cannot be saved.',
        );
    // The satellite land check did not run (offline: its cache is in memory
    // only). Shown with its caveat; saved only once it has been checked.
    if (route.engine.backstop !== 'verified')
        return deny('The satellite land check has not run for this route (offline). Recalculate online before saving.');
    if (!review || review.phase !== 'complete') return deny('Finish current chart checks before saving.');
    const key = autoroutingProposalGeometryKey(route.coordinates);
    const basis = review.basis;
    if (!key || !basis || basis.geometryKey !== key || basis.proposalId !== route.id)
        return deny('The proposal changed. Recheck these exact waypoints before saving.');
    if (
        basis.draftM !== currentDraftM ||
        basis.draftAssumed !== currentDraftAssumed ||
        basis.vesselProfileKey !== JSON.stringify(route.vesselProfile ?? null)
    )
        return deny('The vessel profile changed. Recheck before saving.');
    if (basis.registryFingerprint !== getRegistryFingerprint()) return deny('Charts changed. Recheck before saving.');
    if (!Number.isFinite(Date.parse(basis.checkedAt))) return deny('The review completion time is missing. Recheck.');
    if (review.legs.length !== route.coordinates.length - 1 || ![...review.legs].every(Boolean))
        return deny('Every proposal leg needs a completed check before saving.');
    if (
        review.legs.some(
            (leg) =>
                leg!.verdict.grade === 'danger' ||
                leg!.verdict.needsTide ||
                leg!.verdict.issues.some((issue) => issue.severity === 'danger'),
        )
    )
        return deny('Local danger or required tidal clearance remains unresolved. Recheck before saving.');
    return {
        eligible: true,
        reason: 'Save a planned route only. Checks and cautions are historical, not permission to navigate.',
    };
}

/** Fully validate and detach planned-only evidence without writing any route.
 * A multi-leg caller can preflight every proposal before one atomic save. */
export function prepareReviewedAutoroutingProposal(
    input: ReviewedProposalSaveInput,
    expectedScope: AuthIdentityScope,
): { name: string; points: TracePoint[]; proposalEvidence: SavedAutoroutingProposalEvidence } {
    if (!expectedScope.userId || !isAuthIdentityScopeCurrent(expectedScope))
        throw new Error('Your account changed. Reopen the proposal before saving.');
    const name = input.name.trim();
    if (!name || name.length > 120) throw new Error('Enter a route name between 1 and 120 characters.');
    if (!input.acknowledgedPlannedOnly) throw new Error('Acknowledge the planned-only limitations before saving.');
    const { route, review } = input;
    const eligibility = evaluateAutoroutingProposalSave(route, review, input.currentDraftM, input.currentDraftAssumed);
    if (!eligibility.eligible) throw new Error(eligibility.reason);
    const points = route.coordinates.map(([lon, lat]) => ({ lat, lon }));
    const candidate = {
        version: 1,
        // The router's disclosure (masks, runs) stays in memory: the warnings
        // already carry what the route must say.
        origin: 'thalassa-inshore',
        proposalId: route.id,
        providerCreatedAt: route.createdAt,
        savedAt: new Date().toISOString(),
        plannedOnlyAcknowledged: true,
        basis: review!.basis!,
        warnings: route.warnings,
        legs: review!.legs.map((leg) => ({
            grade: leg!.verdict.grade,
            incomplete: leg!.incomplete,
            minDepthM: leg!.verdict.minDepthM,
            minAt: leg!.verdict.minAt,
            issues: leg!.verdict.issues.map(({ severity, message, at, mark, chartTrack }) => ({
                severity,
                message,
                ...(at ? { at } : {}),
                ...(mark ? { mark } : {}),
                ...(chartTrack ? { chartTrack } : {}),
            })),
        })),
    };
    const evidence: SavedAutoroutingProposalEvidence | null = normaliseAutoroutingProposalEvidence(candidate, points);
    if (!evidence)
        throw new Error(
            'The complete proposal evidence is invalid or exceeds the 1 MiB save limit. Nothing was saved.',
        );
    if (!isAuthIdentityScopeCurrent(expectedScope)) throw new Error('Your account changed. Nothing was saved.');
    return { name, points, proposalEvidence: evidence };
}

/** Explicit new canonical row, not a voyage, trip append, verification, export,
 * public share or activation. No await can cross the last identity/check fence. */
export function saveReviewedAutoroutingProposal(
    input: ReviewedProposalSaveInput,
    expectedScope: AuthIdentityScope,
): { trace: SavedTrace; cloud: Promise<PushResult> } {
    const prepared = prepareReviewedAutoroutingProposal(input, expectedScope);
    const result = saveTrace(prepared.name, prepared.points, { proposalEvidence: prepared.proposalEvidence });
    if (!result.persisted) throw new Error('Device storage could not retain the complete proposal. Nothing was saved.');
    return { trace: result.trace, cloud: result.cloud };
}
