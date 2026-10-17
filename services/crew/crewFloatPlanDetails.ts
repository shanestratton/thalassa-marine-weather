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
 *
 * Their date of birth since 129-14 (Shane 2026-10-14: "can we change punters
 * age for date of birth"), with the age it gives today, which a skipper
 * still on 128 reads. The write merges: an upsert sets only the columns it
 * names, so it names date_of_birth only when this device has one, or when
 * this device cleared it ('edit' with clearDateOfBirth). A 128 phone, or a
 * 129 phone with an age typed before 129, never names it, and a date of
 * birth another device shared stays. Before the 129 migration the column is
 * missing (held: supabase/held-migrations): the share writes the age-only
 * row it wrote before, and stops naming the column (./dateOfBirthColumn).
 */
import { supabase } from '../supabase';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../authIdentityScope';
import { listCrewVessels } from '../vessel/sharedBinders';
import { isNotPushedYet, type FloatPlanSelfDetails } from './floatPlanPeople';
import { dateOfBirthColumnAbsent, isDateOfBirthColumnMissing, noteDateOfBirthColumnAbsent } from './dateOfBirthColumn';
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
    {
        from = 'view',
        clearDateOfBirth = false,
    }: {
        from?: 'view' | 'edit';
        /** 'edit' only: this device cleared a date of birth it had, so the server's goes too. */
        clearDateOfBirth?: boolean;
    } = {},
): Promise<ShareFloatPlanDetailsResult> {
    const scope = getAuthIdentityScope();
    const userId = scope.userId;
    const boats = listCrewVessels();
    if (!supabase || !userId || boats.length === 0) return 'skipped';
    if (unavailable) return 'unavailable';
    const dateOfBirth = details.dateOfBirth || null;
    const empty = !details.name && !details.phone && !details.age && !dateOfBirth;
    if (empty && from === 'view') return 'empty';
    // A new acceptance (a re-invite after leaving) writes again: leaving removes the row.
    const key = JSON.stringify([
        scope.key,
        from,
        boats.map((boat) => `${boat.ownerId}@${boat.lastAcceptedAt}`),
        details,
        clearDateOfBirth,
    ]);
    if (key === lastShared) return 'unchanged';
    const birth = dateOfBirth || (from === 'edit' && clearDateOfBirth) ? { date_of_birth: dateOfBirth } : undefined;
    const ageOnly =
        from === 'edit'
            ? { user_id: userId, full_name: details.name, phone: details.phone, age: details.age }
            : {
                  user_id: userId,
                  ...(details.name ? { full_name: details.name } : {}),
                  ...(details.phone ? { phone: details.phone } : {}),
                  ...(details.age ? { age: details.age } : {}),
              };
    // Without the date of birth, nothing: a date of birth alone, while the server has no column for it.
    const nothingButBirth = !details.name && !details.phone && !details.age;
    const db = supabase;
    const table = () => db.from('crew_float_plan_details');
    try {
        const withBirth = Boolean(birth) && !dateOfBirthColumnAbsent();
        if (!empty && !withBirth && nothingButBirth) return 'empty';
        let { error } = empty
            ? await table().delete().eq('user_id', userId)
            : await table().upsert(withBirth ? { ...ageOnly, ...birth } : ageOnly, { onConflict: 'user_id' });
        if (!isAuthIdentityScopeCurrent(scope)) return 'skipped';
        if (error && withBirth && isDateOfBirthColumnMissing(error)) {
            // Before the 129 migration: the row it wrote before, and no more tries this hour.
            noteDateOfBirthColumnAbsent();
            if (nothingButBirth) return 'empty';
            ({ error } = await table().upsert(ageOnly, { onConflict: 'user_id' }));
            if (!isAuthIdentityScopeCurrent(scope)) return 'skipped';
        }
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
