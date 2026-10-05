/**
 * crewFloatPlanDetails — an invitee's own name, phone and age, shared with
 * their skipper for the float plan (Shane 2026-10-04: "the invitee needs to
 * use the name and phone number and age from the vessel profile in settings
 * for the float plan").
 *
 * The crew member's app writes their OWN row of public.crew_float_plan_details
 * (migration 20261004120000) from their Settings → Vessel Profile. RLS lets
 * the skippers they are accepted crew for read it, and nobody else: other crew
 * never see it. loadFloatPlanCrew reads it on the skipper's side.
 *
 * Written when the Crew & Float Plan page shows the boat ('view': only the
 * fields this device has, never a clear, so a device whose Settings have not
 * arrived yet cannot wipe what another device shared) and after an edit in
 * Settings ('edit': every field, and nothing left removes the row). Once per
 * change per session. Quiet before the push: a missing table is remembered
 * for the session, never an error.
 */
import { supabase } from '../supabase';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../authIdentityScope';
import { listCrewVessels } from '../vessel/sharedBinders';
import { isNotPushedYet, type FloatPlanSelfDetails } from './floatPlanPeople';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('crewFloatPlanDetails');

/**
 * shared / cleared: the server has them now. unchanged: it already had them
 * this session. empty: nothing to share from a look. skipped: not crew, or
 * signed out. unavailable: the server does not take them yet. failed: try
 * again later.
 */
export type ShareFloatPlanDetailsResult =
    | 'shared'
    | 'cleared'
    | 'unchanged'
    | 'empty'
    | 'skipped'
    | 'unavailable'
    | 'failed';

let unavailable = false;
let lastShared = '';

/** True once this session has learnt the server does not take the details yet. */
export function floatPlanDetailsUnavailable(): boolean {
    return unavailable;
}

/**
 * Share this account's own details (floatPlanSelfDetails of its own vessel
 * profile) with every skipper it is accepted crew for: one row, read by each
 * skipper through RLS. Never throws.
 */
export async function shareMyFloatPlanDetails(
    details: FloatPlanSelfDetails,
    { from = 'view' }: { from?: 'view' | 'edit' } = {},
): Promise<ShareFloatPlanDetailsResult> {
    const scope = getAuthIdentityScope();
    const userId = scope.userId;
    const boats = listCrewVessels();
    if (!supabase || !userId || boats.length === 0) return 'skipped';
    if (unavailable) return 'unavailable';
    const empty = !details.name && !details.phone && !details.age;
    if (empty && from === 'view') return 'empty';
    // A new acceptance (a re-invite after leaving) writes again: leaving removes the row.
    const key = JSON.stringify([
        scope.key,
        from,
        boats.map((boat) => `${boat.ownerId}@${boat.lastAcceptedAt}`),
        details,
    ]);
    if (key === lastShared) return 'unchanged';
    const row =
        from === 'edit'
            ? { user_id: userId, full_name: details.name, phone: details.phone, age: details.age }
            : {
                  user_id: userId,
                  ...(details.name ? { full_name: details.name } : {}),
                  ...(details.phone ? { phone: details.phone } : {}),
                  ...(details.age ? { age: details.age } : {}),
              };
    try {
        const table = supabase.from('crew_float_plan_details');
        const { error } = empty
            ? await table.delete().eq('user_id', userId)
            : await table.upsert(row, { onConflict: 'user_id' });
        if (!isAuthIdentityScopeCurrent(scope)) return 'skipped';
        if (error) {
            if (isNotPushedYet(error)) {
                unavailable = true;
                return 'unavailable';
            }
            log.warn('Float plan details could not be shared:', error.message);
            return 'failed';
        }
        lastShared = key;
        return empty ? 'cleared' : 'shared';
    } catch (error) {
        log.warn('Float plan details could not be shared:', error);
        return 'failed';
    }
}
