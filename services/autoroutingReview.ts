import type { AutoroutingTrialRoute } from '../types/autorouting';
import { AUTOROUTING_TRIAL_MAX_POINTS } from '../types/autorouting';
import { gradeLegs, type GradeLeg } from './traceGrading';
import { pointInBbox, type TraceIssue, type TraceLegVerdict, type TracePoint, type TracerContext } from './routeTracer';
import type { AutoroutingReviewBasis } from './autoroutingProposalEvidence';
import { displayWaypointLegRange, type TrialDisplayWaypoint } from './autoroutingDisplayWaypoints';

export interface TrialLegReview {
    verdict: TraceLegVerdict;
    incomplete: boolean;
}
export interface TrialRouteReview {
    phase: 'checking' | 'complete' | 'stopped' | 'stale' | 'error';
    legs: Array<TrialLegReview | null>;
    /** Exact inputs and chart registry checked; never a navigation release. */
    basis?: AutoroutingReviewBasis;
}

type TrialTrackIssue = TraceIssue & { chartTrack: NonNullable<TraceIssue['chartTrack']> };

export interface TrialChartTrackAdvisory {
    id: string;
    label: string;
    kind: TrialTrackIssue['chartTrack']['kind'];
    maxOffsetM: number;
    /** Zero-based indices into review.legs, compressed only for presentation. */
    legRanges: Array<{ first: number; last: number }>;
    /** Keep a locator for each affected leg, including across waypoint pages. */
    legs: Array<{ index: number; spot: TracePoint }>;
    worst: { index: number; spot: TracePoint };
}

/** Only explicit chart-track cautions may move into the grouped trial view.
 * Missing metadata/locations, dangers, depth and mark issues stay on their leg. */
export function isTrialTrackAdvisory(issue: TraceIssue): issue is TrialTrackIssue {
    const track = issue.chartTrack;
    const spot = issue.mark ?? issue.at;
    return !!(
        issue.severity === 'caution' &&
        track?.id &&
        (track.kind === 'leading-line' || track.kind === 'recommended-track') &&
        Number.isFinite(track.offsetM) &&
        track.offsetM >= 0 &&
        spot &&
        Number.isFinite(spot.lat) &&
        Number.isFinite(spot.lon)
    );
}

/** Group presentation only: never remove or alter the source leg verdicts.
 * Same-text warnings on distinct chart features must remain distinct groups. */
export function trialChartTrackAdvisories(review: TrialRouteReview | null): TrialChartTrackAdvisory[] {
    const groups = new Map<string, TrialChartTrackAdvisory>();
    review?.legs.forEach((leg, index) => {
        for (const issue of leg?.verdict.issues ?? []) {
            if (!isTrialTrackAdvisory(issue)) continue;
            const track = issue.chartTrack;
            const spot = (issue.mark ?? issue.at)!;
            const key = `${track.kind}:${track.id}`;
            let group = groups.get(key);
            if (!group) {
                group = {
                    id: key,
                    label: track.label,
                    kind: track.kind,
                    maxOffsetM: track.offsetM,
                    legRanges: [],
                    legs: [],
                    worst: { index, spot },
                };
                groups.set(key, group);
            }
            if (track.offsetM > group.maxOffsetM) {
                group.maxOffsetM = track.offsetM;
                group.worst = { index, spot };
            }
            // Long provider segments can contain several grading subsegments.
            // They are still one leg in the waypoint list and range label.
            if (group.legs.at(-1)?.index === index) continue;
            group.legs.push({ index, spot });
            const range = group.legRanges.at(-1);
            if (range && range.last + 1 === index) range.last = index;
            else group.legRanges.push({ first: index, last: index });
        }
    });
    return [...groups.values()];
}

export const TRIAL_REVIEW_BATCH_SIZE = 64;
const unchecked = (message: string): TrialLegReview => ({
    incomplete: true,
    verdict: {
        grade: 'caution',
        issues: [{ severity: 'caution', message }],
        minDepthM: null,
        minAt: null,
        needsTide: false,
        nudge: null,
        nudgeTo: null,
    },
});

/** Same leg checker as manual plotting, without its persisted draft/verdicts,
 * release acknowledgements, or route-store writes. Never simplifies geometry.
 * Bounded batches avoid quadratic clustering and yield on dense provider lines.
 * Only one grid is retained, and never after this disposable review finishes. */
export async function reviewAutoroutingProposal(
    route: AutoroutingTrialRoute,
    draftM: number,
    signal: AbortSignal,
    onProgress: (review: TrialRouteReview) => void,
    options: { draftAssumed?: boolean } = {},
): Promise<TrialRouteReview> {
    const draftAssumed = options.draftAssumed ?? route.vesselProfile?.draftStatus !== 'measured';
    const points = route.coordinates.map(([lon, lat]) => ({ lat, lon }));
    if (points.length < 2 || points.length > AUTOROUTING_TRIAL_MAX_POINTS || !Number.isFinite(draftM) || draftM <= 0)
        throw new Error('Invalid proposal or vessel draft for chart checks.');
    const legs: TrialRouteReview['legs'] = Array.from({ length: points.length - 1 }, () => null);
    let held: TracerContext | null = null;
    const snapshot = (phase: TrialRouteReview['phase']): TrialRouteReview => ({ phase, legs: [...legs] });
    const publish = () => {
        if (!signal.aborted) onProgress(snapshot('checking'));
    };
    for (let offset = 0; offset < legs.length; offset += TRIAL_REVIEW_BATCH_SIZE) {
        if (signal.aborted) return snapshot('stopped');
        const batch: GradeLeg[] = [];
        const indices = new Map<string, number>();
        for (let i = offset; i < Math.min(offset + TRIAL_REVIEW_BATCH_SIZE, legs.length); i++) {
            const a = points[i],
                b = points[i + 1];
            // The manual checker's local projection is not an antimeridian or
            // polar checker. Do not feed it a planet-wide bbox or a false pass.
            if (
                ![a.lat, a.lon, b.lat, b.lon].every(Number.isFinite) ||
                Math.abs(a.lat) > 80 ||
                Math.abs(b.lat) > 80 ||
                Math.abs(a.lon) > 180 ||
                Math.abs(b.lon) > 180 ||
                Math.abs(a.lon - b.lon) > 180 ||
                (a.lat === b.lat && a.lon === b.lon)
            ) {
                legs[i] = unchecked('This segment cannot be checked — inspect coordinates independently.');
                continue;
            }
            const key = `trial:${i}${i === legs.length - 1 ? '|last' : ''}`;
            indices.set(key, i);
            batch.push({ a, b, key });
        }
        const result = await gradeLegs(batch, {
            draftM,
            draftAssumed,
            chartedDepthOnly: true,
            clusterSpanM: 24_000,
            superseded: () => signal.aborted,
            ctxFromLru: (pts) => (held?.grid && pts.every((p) => pointInBbox(p, held!.bbox)) ? held : null),
            holdCtx: (ctx) => {
                held = ctx;
            },
            onLeg: (key, verdict, volatile) => {
                if (signal.aborted) return;
                const index = indices.get(key);
                if (index === undefined) return;
                const incomplete = volatile || verdict.minDepthM === null;
                // Even a mistakenly optimistic upstream status cannot make a
                // missing-depth or failed-marker result look green here.
                legs[index] = {
                    incomplete,
                    verdict:
                        incomplete && verdict.grade === 'clear'
                            ? {
                                  ...verdict,
                                  grade: 'caution',
                                  issues: [
                                      ...verdict.issues,
                                      {
                                          severity: 'caution',
                                          message: 'Checks incomplete — inspect charts and markers.',
                                      },
                                  ],
                              }
                            : verdict,
                };
            },
            onClusterDone: publish,
        });
        if (signal.aborted || result.superseded) return snapshot('stopped');
        for (let i = offset; i < Math.min(offset + TRIAL_REVIEW_BATCH_SIZE, legs.length); i++)
            legs[i] ??= unchecked('No check result for this segment — retry chart checks.');
        publish();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    held = null;
    return snapshot(signal.aborted ? 'stopped' : 'complete');
}

export const TRIAL_GRADE_COLORS = { clear: '#10b981', caution: '#fbbf24', danger: '#f87171', unchecked: '#94a3b8' };

/** The arriving display leg may cover many original checked segments. Never
 * let a clear final segment hide danger or an unfinished check earlier in it. */
export function trialDisplayWaypointGrade(
    review: TrialRouteReview | null,
    range: { first: number; last: number } | null,
): keyof typeof TRIAL_GRADE_COLORS {
    if (!range) return 'unchecked';
    let caution = false;
    let uncheckedSegment = false;
    for (let index = range.first; index <= range.last; index++) {
        const leg = review?.legs[index];
        if (!leg) {
            uncheckedSegment = true;
            continue;
        }
        if (leg.verdict.grade === 'danger' || leg.verdict.issues.some((issue) => issue.severity === 'danger'))
            return 'danger';
        if (
            leg.incomplete ||
            leg.verdict.grade === 'caution' ||
            leg.verdict.needsTide ||
            leg.verdict.minDepthM == null ||
            !Number.isFinite(leg.verdict.minDepthM) ||
            leg.verdict.issues.some((issue) => issue.severity === 'caution')
        )
            caution = true;
    }
    return caution
        ? 'caution'
        : uncheckedSegment || review?.phase === 'stale' || review?.phase === 'error'
          ? 'unchecked'
          : 'clear';
}

/** Paint every exact provider segment. Sparse numbered GPU markers are only
 * a presentation layer; neither the underlying line nor its checks are thinned.
 * Omission of displayWaypoints retains the legacy dense marker representation. */
export function trialReviewFeatures(
    coordinates: AutoroutingTrialRoute['coordinates'],
    review: TrialRouteReview | null,
    displayWaypoints?: readonly TrialDisplayWaypoint[],
): GeoJSON.FeatureCollection {
    const features: GeoJSON.Feature[] = [];
    for (let i = 0; i < coordinates.length; i++) {
        const leg = i > 0 ? review?.legs[i - 1] : null;
        const color = leg ? TRIAL_GRADE_COLORS[leg.verdict.grade] : TRIAL_GRADE_COLORS.unchecked;
        if (!displayWaypoints)
            features.push({
                type: 'Feature',
                properties: { number: i + 1, color },
                geometry: { type: 'Point', coordinates: coordinates[i] },
            });
        if (i > 0)
            features.push({
                type: 'Feature',
                properties: { leg: i - 1, color },
                geometry: { type: 'LineString', coordinates: [coordinates[i - 1], coordinates[i]] },
            });
    }
    displayWaypoints?.forEach((waypoint, index) => {
        features.push({
            type: 'Feature',
            properties: {
                number: index + 1,
                color: TRIAL_GRADE_COLORS[
                    trialDisplayWaypointGrade(review, displayWaypointLegRange(displayWaypoints, index))
                ],
            },
            geometry: { type: 'Point', coordinates: waypoint.coordinates },
        });
    });
    return { type: 'FeatureCollection', features };
}

/**
 * Where a route note applies, for the notes list (2026-10-02): a note about a
 * pin names its leg; everything else is about the whole route. The notes are
 * the proposal's own words (saved with it), so this reads them rather than
 * changing what they are.
 */
export function routeNoteWhere(note: string, waypointCount: number): string {
    const last = Math.max(2, waypointCount);
    if (/\bdeparture\b/i.test(note) && !/\bdestination\b/i.test(note)) return 'Leg 1→2';
    if (/\bdestination\b/i.test(note) && !/\bdeparture\b/i.test(note)) return `Leg ${last - 1}→${last}`;
    return 'Whole route';
}
