import type { AutoroutingTrialRoute } from '../types/autorouting';
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
    if (route.provider !== 'SevenCs') return deny('The proposal origin is not recognised.');
    if (route.localEdit !== undefined)
        return deny(
            'This locally edited trial has not been rechecked by SevenCs and cannot be saved. Recalculate a fresh proposal.',
        );
    if (route.providerCheck?.status === 'unsafe' || route.providerCheck?.findings.some((f) => f.severity === 'danger'))
        return deny('The provider reported danger. Resolve it before saving this proposal.');
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
        origin: 'sevencs-trial',
        proposalId: route.id,
        providerCreatedAt: route.createdAt,
        savedAt: new Date().toISOString(),
        plannedOnlyAcknowledged: true,
        basis: review!.basis!,
        warnings: route.warnings,
        ...(route.providerCheck ? { providerCheck: route.providerCheck } : {}),
        ...(route.canalDeparture ? { canalHandoverIndex: route.canalDeparture.handoverIndex } : {}),
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
