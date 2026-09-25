import { getAuthIdentityScope, isAuthIdentityScopeCurrent, type AuthIdentityScope } from './authIdentityScope';
import { ShipLogService } from './ShipLogService';
import type { VoyageSummary } from './shiplog/VoyageSummary';
import { supabase } from './supabase';
import { withDeadline } from '../utils/deadline';
import { applyVoyageArchiveIntentOverlay, filterVoyageTombstonedEntries } from './shiplog/OfflineQueue';

/** Frozen when the editor opens; never move a note to a newly selected hull. */
export interface DiaryTripContext {
    scope: AuthIdentityScope;
    boatId: string | null;
    originalVoyageId: string | null;
    entryId?: string;
}

export interface DiaryTripChoice {
    voyageId: string;
    label: string;
}

export async function captureDiaryTripContext(): Promise<DiaryTripContext> {
    const scope = getAuthIdentityScope();
    const [boatId, voyageId] = await Promise.all([
        ShipLogService.resolveActiveBoatId(),
        ShipLogService.resolveActiveVoyageId(),
    ]);
    if (!isAuthIdentityScopeCurrent(scope)) throw new Error('The diary account changed. Please reopen the entry.');
    return { scope, boatId: boatId ?? null, originalVoyageId: voyageId ?? null };
}

function isActualTrip(summary: VoyageSummary): boolean {
    return (
        summary.voyageId !== 'default_voyage' &&
        !summary.isPlannedRoute &&
        !summary.isImported &&
        summary.entryCount > 1 &&
        summary.totalDistanceNM > 0 &&
        (summary.landFraction == null || summary.landFraction < 0.5)
    );
}

/** Do not infer a boat for legacy rows, or accept a voyage shared by two hulls. */
async function hasUnambiguousBoat(context: DiaryTripContext, voyageId: string): Promise<boolean> {
    if (
        !supabase ||
        !context.scope.userId ||
        !context.boatId ||
        !/^[0-9a-f-]{36}$/i.test(context.boatId) ||
        !isAuthIdentityScopeCurrent(context.scope)
    )
        return false;
    const base = () =>
        supabase!
            .from('ship_logs')
            .select('user_id,voyage_id,boat_id')
            .eq('user_id', context.scope.userId!)
            .eq('voyage_id', voyageId);
    const [matching, ambiguous] = await withDeadline(
        Promise.all([
            base().eq('boat_id', context.boatId).or('archived.is.null,archived.eq.false').limit(1),
            base().or(`boat_id.is.null,boat_id.neq.${context.boatId}`).limit(1),
        ]),
        6_000,
        'Trip verification',
    );
    const row = matching.data?.[0];
    const visible = await applyVoyageArchiveIntentOverlay(
        await filterVoyageTombstonedEntries([{ voyageId, archived: false }], context.scope),
        context.scope,
    );
    return (
        visible.length === 1 &&
        !visible[0].archived &&
        isAuthIdentityScopeCurrent(context.scope) &&
        !matching.error &&
        !ambiguous.error &&
        Array.isArray(ambiguous.data) &&
        ambiguous.data.length === 0 &&
        row?.user_id === context.scope.userId &&
        row?.voyage_id === voyageId &&
        row?.boat_id === context.boatId
    );
}

export async function loadDiaryTripChoices(context: DiaryTripContext): Promise<DiaryTripChoice[]> {
    if (!context.boatId || !context.scope.userId || !isAuthIdentityScopeCurrent(context.scope)) return [];
    const summaries = (await withDeadline(ShipLogService.getVoyageSummaries(), 6_000, 'Recent trips'))
        .filter(isActualTrip)
        .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
        .slice(0, 12);
    if (!isAuthIdentityScopeCurrent(context.scope)) return [];
    const candidates = await Promise.all(
        summaries.map(async (summary): Promise<DiaryTripChoice | null> => {
            if (!(await hasUnambiguousBoat(context, summary.voyageId))) return null;
            const date = new Date(summary.startedAt).toLocaleDateString('en-AU', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
            });
            return { voyageId: summary.voyageId, label: `${date} · ${summary.totalDistanceNM.toFixed(1)} nm` };
        }),
    );
    return isAuthIdentityScopeCurrent(context.scope)
        ? candidates.filter((choice): choice is DiaryTripChoice => choice !== null).slice(0, 8)
        : [];
}

/** Called again at the durable write boundary, not just when filling the menu. */
export async function validateDiaryTripSelection(context: DiaryTripContext, voyageId: string | null): Promise<void> {
    const fail = () => new Error('That trip is no longer available for this vessel. Choose another trip or No trip.');
    if (!isAuthIdentityScopeCurrent(context.scope)) throw fail();
    if (!context.entryId) {
        const currentBoatId = (await ShipLogService.resolveActiveBoatId()) ?? null;
        if (currentBoatId !== context.boatId || !isAuthIdentityScopeCurrent(context.scope)) throw fail();
    }
    // Existing/active association and deliberate No trip work offline. A newly
    // chosen historic track requires a current owner-and-vessel check online.
    if (voyageId === null || voyageId === context.originalVoyageId) return;
    const summaries = await withDeadline(ShipLogService.getVoyageSummaries(), 6_000, 'Trip verification');
    if (
        !isAuthIdentityScopeCurrent(context.scope) ||
        !summaries.some((summary) => summary.voyageId === voyageId && isActualTrip(summary)) ||
        !(await hasUnambiguousBoat(context, voyageId))
    )
        throw fail();
}
