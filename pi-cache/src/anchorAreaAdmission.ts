import type { AnchorWatchAssignment, VesselFix } from './anchorBroadcaster.js';
import { distanceMetres, fixIsCurrent } from './anchorBroadcaster.js';
import { assignmentSafeArea } from './anchorZoneContract.js';
import { anchorSafeZoneContains, sameAnchorSafeArea } from './anchorSafeZone.js';

export interface AreaReviewDeps {
    now: () => number;
    revision: () => string;
    dragging: () => boolean;
    paired: () => boolean;
    enrolled: () => Promise<boolean>;
    readFix: () => Promise<VesselFix | null>;
}
export type AreaReview = { ok: true; unchanged: boolean; revision: string } | { ok: false; error: string };
/** No watch is modified here. The caller rechecks the returned revision immediately before synchronous adoption. */
export async function reviewAnchorAreaChange(
    assignment: AnchorWatchAssignment,
    previous: AnchorWatchAssignment | null,
    expectedRevision: unknown,
    deps: AreaReviewDeps,
): Promise<AreaReview> {
    const revision = deps.revision(),
        area = assignmentSafeArea(assignment),
        old = previous && assignmentSafeArea(previous);
    if (assignment.safeZone === undefined && !old) return { ok: true, unchanged: false, revision };
    if (
        previous &&
        sameAnchorSafeArea(area, old) &&
        previous.sessionCode === assignment.sessionCode &&
        previous.safeAreaRevision === assignment.safeAreaRevision &&
        previous.safeAreaVesselId === assignment.safeAreaVesselId
    )
        return { ok: true, unchanged: true, revision };
    const refuse = (error: string): AreaReview => ({ ok: false, error });
    if (expectedRevision !== revision) return refuse('The Pi watch revision changed. Review the area again.');
    if (!deps.paired() || !(await deps.enrolled()))
        return refuse('An enrolled device on this paired Pi must confirm an area change.');
    if (deps.dragging()) return refuse('The Pi drag alarm is active. A boundary edit cannot silence it.');
    let fix: VesselFix | null;
    try {
        fix = await deps.readFix();
    } catch {
        fix = null;
    }
    const now = deps.now();
    if (
        !fix ||
        !fixIsCurrent(fix, now) ||
        now - fix.timestamp > 30_000 ||
        fix.timestamp > now + 5_000 ||
        distanceMetres(assignment.anchorLat, assignment.anchorLon, fix.latitude, fix.longitude) >
            assignment.swingRadius ||
        (area?.zone && anchorSafeZoneContains(area.zone, area.frame, fix) !== true)
    )
        return refuse('A fresh boat fix must be inside the proposed safe area and circle.');
    if (!(await deps.enrolled()) || !deps.paired() || deps.revision() !== revision || deps.dragging())
        return refuse('The paired watch changed while reviewing the area. Try again.');
    return { ok: true, unchanged: false, revision };
}
