/**
 * floatPlanCrew — seed the Float Plan's persons roster from the crew list.
 *
 * Shane, 2026-09-08: "for the float plan, can we scrape the names of crew
 * from the invites. with the option of adding crew and deleting crew."
 *
 * The Float Plan sheet already carries a USCG-style persons roster, but it
 * opened EMPTY every time and the skipper retyped the same names before every
 * passage. The names already exist: `vessel_crew` says who has been invited
 * and who has accepted, and `boat_members` carries the byline parts
 * (prefix, first, "nickname", last) the crew-invite bridge trigger writes on
 * acceptance. This module joins the two into roster seeds.
 *
 * Two lists, on purpose:
 *   - `aboard`  — the skipper, then every ACCEPTED crew member. These become
 *                 roster rows the skipper can edit or delete.
 *   - `invited` — PENDING invitees. These are offered as "Add <name>" chips,
 *                 never pre-listed: an invite that has not been accepted is
 *                 not a person on the boat, and a float plan that claims one
 *                 is would send a coordinator looking for someone at home.
 *
 * Pure helpers (name grammar, role mapping) are separated from the Supabase
 * read so each is unit-testable on its own. Any failure returns null and the
 * sheet stays exactly as it was: empty and editable.
 */

import { supabase } from './supabase';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from './authIdentityScope';
import type { CrewInviteStatus, CrewRole } from './CrewService';
import { activeOwnedBoatId } from '../components/crewManagement/activeOwnedBoat';
import { createLogger } from '../utils/createLogger';
import {
    CREW_ROLE_SENIORITY,
    floatPlanSelfDetails,
    isNotPushedYet,
    mergeAboard,
    type FloatPlanSelfDetails,
} from './crew/floatPlanPeople';
import { sortByCrewRank } from './crew/crewRank';
import { formatPlannedRouteLabel, formatStoredPlannedRouteName } from './shiplog/plannedRouteNaming';

const log = createLogger('floatPlanCrew');

/**
 * Roles a rescue coordinator would recognise, in the order they matter to one.
 * Shared by the Float Plan's roster and the vessel profile's crew rows so the
 * two agree (2026-09-09). Listed in rank order; the order people aboard are
 * listed in is services/crew/crewRank.ts, which reads each of these (and
 * whatever a skipper types instead) at its rank.
 */
export const FLOAT_PLAN_ROLES = [
    'Skipper',
    // The invite picker's second-in-command (2026-10-06): an accepted
    // co-skipper keeps that role on the plan rather than reading "Role…".
    'Co-skipper',
    'First mate',
    'Navigator',
    'Engineer',
    'Cook',
    'Deckhand',
    'Crew',
    'Guest',
    'Child',
] as const;

export type FloatPlanRosterSeed = {
    name: string;
    /** A CREW_ROLES label the sheet's role <select> recognises. */
    role: string;
    source: 'skipper' | 'crew' | 'invite' | 'profile';
    crewUserId?: string | null;
    /**
     * An accepted crew member's own name, phone and age from THEIR Settings,
     * shared for this float plan (crew_float_plan_details, 2026-10-04).
     * `name` is already theirs; `appName` is what the app calls them.
     */
    shared?: FloatPlanSelfDetails & { appName: string };
    /**
     * Accepted crew whose every invite named a passage other than this plan's:
     * that passage's name (or "another passage"), so the sheet can say where
     * they came from rather than list a one-off guest on every later plan
     * without a word (review 2026-10-06). Absent for crew invited for every
     * passage or for this one.
     */
    invitedFor?: string;
};

export interface FloatPlanCrew {
    aboard: FloatPlanRosterSeed[];
    invited: FloatPlanRosterSeed[];
}

/** The four byline parts `boat_members` and onboarding both carry. */
export interface CrewNameParts {
    prefix?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    nickname?: string | null;
}

/** The `vessel_crew` columns this module reads — a slice of CrewMember. */
interface VesselCrewRow {
    id: string;
    crew_user_id: string | null;
    crew_email: string | null;
    status: CrewInviteStatus | string;
    role: CrewRole | string;
    voyage_id: string | null;
}

interface BoatMemberNameRow extends CrewNameParts {
    user_id: string;
}

function clean(value: string | null | undefined): string {
    return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

/**
 * initcap() as Postgres does it, so a fallback name rendered here matches the
 * one the crew-invite bridge trigger writes into boat_members for the same
 * email. Hyphenated words capitalise each half ("anne-marie" → "Anne-Marie").
 */
function titleCaseWord(word: string): string {
    return word
        .split('-')
        .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : part))
        .join('-');
}

/**
 * Render the byline the rest of the app shows for a crew member: prefix, first
 * name, "nickname" in quotes, last name — single-spaced and trimmed (the grammar
 * in supabase/migrations/20260516150000_voyage_log_name_metadata.sql).
 *
 * When there are no name parts at all, fall back to the email's local part with
 * dots and underscores as word breaks, Title Cased: "marta.k" → "Marta K". That
 * is what a pending invitee looks like before acceptance writes a real row.
 * Returns '' when there is nothing at all — the caller decides what an empty
 * name means (for the skipper: an empty row they type into).
 */
export function renderCrewDisplayName(parts: CrewNameParts | null | undefined, fallbackEmail?: string): string {
    const prefix = clean(parts?.prefix);
    const first = clean(parts?.first_name);
    const last = clean(parts?.last_name);
    const nickname = clean(parts?.nickname);
    const rendered = [prefix, first, nickname ? `"${nickname}"` : '', last].filter(Boolean).join(' ');
    if (rendered) return rendered;

    const local = clean(fallbackEmail).split('@')[0] ?? '';
    return local
        .split(/[._+]+/)
        .filter(Boolean)
        .map(titleCaseWord)
        .join(' ');
}

/**
 * The crew-invite role → the Float Plan's CREW_ROLES label. The sheet's role
 * <select> only offers its own list, so an unmapped value would render as
 * "Role…" and lose the information; 'Crew' is the honest default.
 *
 * A co-skipper is 'Co-skipper', the invite picker's own word (Shane
 * 2026-10-06: "captain, first mate and co captain"): reading them as 'First
 * mate' put two First mates on a plan whose profile already names one.
 */
export function crewRoleToFloatPlanRole(role: CrewRole | string): string {
    switch (role) {
        case 'co-skipper':
            return 'Co-skipper';
        case 'navigator':
            return 'Navigator';
        case 'deckhand':
            return 'Deckhand';
        case 'punter':
            return 'Guest';
        default:
            return 'Crew';
    }
}

/**
 * Who belongs on THIS float plan, each person once, de-duplicated by
 * crew_user_id (or, for a pending invite with no account yet, by email).
 *
 * Accepted crew are aboard whatever passage their invite named (Shane
 * 2026-10-06: "we need all 3 people on both devices"). An invite that shares
 * passage access is scoped to the passage selected when it was sent, so the
 * scope says which passage's chat, route and meals they see, not whether they
 * sail: the production invitee was scoped to a passage that had finished,
 * and the planner opens the float plan with no voyage at all, so the old
 * "this voyage only" rule dropped them from every plan. Membership is
 * vessel-level, as the server reads it for the crew's own view of the boat
 * and the shared binders; the sheet says "Added from your crew: … — remove
 * anyone not aboard", and names the passage of anyone invited only for
 * another one, so an over-count is never silent. A person with several rows
 * carries their most senior role, as on their own device.
 *
 * Pending invites stay offers for THIS plan only: global ones and this
 * voyage's, as "Add <name>" chips, never pre-listed.
 */
function partitionCrewRows(
    rows: VesselCrewRow[],
    voyageId: string | null | undefined,
    ownerId: string,
): { accepted: VesselCrewRow[]; pending: VesselCrewRow[]; elsewhere: Map<VesselCrewRow, string> } {
    const accepted: VesselCrewRow[] = [];
    const pending: VesselCrewRow[] = [];
    const seen = new Map<string, number>();
    // Per accepted person: invited for every passage or this one, else the
    // latest other passage their invites named (rows arrive oldest first).
    const here = new Set<string>();
    const lastElsewhere = new Map<string, string>();
    const keyOf = (row: VesselCrewRow): string | null => {
        if (row.crew_user_id) return `user:${row.crew_user_id}`;
        const email = clean(row.crew_email).toLowerCase();
        return email ? `email:${email}` : null;
    };
    const forThisPlan = (row: VesselCrewRow) =>
        row.voyage_id === null || row.voyage_id === undefined || row.voyage_id === voyageId;
    const rank = (row: VesselCrewRow) => CREW_ROLE_SENIORITY[row.role] ?? 0;
    const others = rows.filter((row) => row.crew_user_id !== ownerId);
    // Accepted first, so a person who is both accepted and pending lands
    // aboard rather than in the invite chips.
    for (const row of others) {
        if (row.status !== 'accepted') continue;
        const key = keyOf(row);
        if (!key) continue;
        if (forThisPlan(row)) here.add(key);
        else if (row.voyage_id) lastElsewhere.set(key, row.voyage_id);
        const at = seen.get(key);
        if (at === undefined) {
            seen.set(key, accepted.length);
            accepted.push(row);
        } else if (rank(row) > rank(accepted[at])) {
            accepted[at] = row;
        }
    }
    const elsewhere = new Map<VesselCrewRow, string>();
    for (const [key, at] of seen) {
        const passage = lastElsewhere.get(key);
        if (passage && !here.has(key)) elsewhere.set(accepted[at], passage);
    }
    for (const row of others) {
        if (row.status !== 'pending' || !forThisPlan(row)) continue;
        const key = keyOf(row);
        if (!key || seen.has(key)) continue;
        seen.set(key, -1);
        pending.push(row);
    }
    return { accepted, pending, elsewhere };
}

/** What the sheet calls a passage it cannot name. */
const ANOTHER_PASSAGE = 'another passage';

/**
 * The skipper's own names for the passages crew were invited for, by voyage
 * id, the way the float plan names its own passage. One read; any failure or
 * a passage gone or unnamed leaves it out, and the caller says "another
 * passage". Never fails the float plan: the names are a courtesy.
 */
async function passageNames(
    client: NonNullable<typeof supabase>,
    ownerId: string,
    voyageIds: string[],
): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    try {
        const { data, error } = await client
            .from('voyages')
            .select('id, voyage_name, departure_port, destination_port')
            .eq('user_id', ownerId)
            .in('id', voyageIds);
        if (error) {
            log.warn('float plan crew: passage names read failed', error.message);
            return names;
        }
        for (const row of (data ?? []) as Array<Record<string, unknown>>) {
            if (typeof row?.id !== 'string') continue;
            const text = (value: unknown) => (typeof value === 'string' ? value : null);
            const departure = text(row.departure_port)?.trim();
            const destination = text(row.destination_port)?.trim();
            const name =
                formatStoredPlannedRouteName(text(row.voyage_name)) ??
                (departure || destination ? formatPlannedRouteLabel(departure, destination) : null);
            if (name) names.set(row.id, clean(name).slice(0, 80));
        }
    } catch (error) {
        log.warn('float plan crew: passage names read failed', error);
    }
    return names;
}

/**
 * Load the skipper and crew for a float plan, or null when there is nothing
 * trustworthy to seed from — signed out, no Supabase, an identity change
 * mid-flight, or any query failure. Null means "leave the roster as it is";
 * it never means "nobody aboard".
 *
 * Reads: auth.getUser (identity check + name metadata fallback), the active
 * owned boat, one `vessel_crew` query for the owner, one `boat_members` query
 * with `.in('user_id', ids)` for every name at once. The identity scope is
 * captured first and re-checked after every await, as everywhere else.
 */
export async function loadFloatPlanCrew(voyageId?: string | null): Promise<FloatPlanCrew | null> {
    if (!supabase) return null;
    const scope = getAuthIdentityScope();
    if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) return null;

    try {
        const {
            data: { user },
        } = await supabase.auth.getUser();
        if (!user || user.id !== scope.userId || !isAuthIdentityScopeCurrent(scope)) return null;

        const boatId = await activeOwnedBoatId(scope);
        if (!isAuthIdentityScopeCurrent(scope)) return null;

        const { data: crewData, error: crewError } = await supabase
            .from('vessel_crew')
            .select('id, crew_user_id, crew_email, status, role, voyage_id')
            .eq('owner_id', user.id)
            .order('created_at', { ascending: true });
        if (!isAuthIdentityScopeCurrent(scope)) return null;
        if (crewError) {
            log.warn('float plan crew: vessel_crew read failed', crewError.message);
            return null;
        }

        const { accepted, pending, elsewhere } = partitionCrewRows(
            (crewData ?? []) as VesselCrewRow[],
            voyageId,
            user.id,
        );

        const nameIds = [
            user.id,
            ...accepted.map((row) => row.crew_user_id),
            ...pending.map((row) => row.crew_user_id),
        ].filter((id): id is string => typeof id === 'string' && id.length > 0);

        // One query for every name. boat_members is keyed by (boat_id, user_id)
        // and only exists once there is a boat; without one, names fall back to
        // metadata (skipper) and email (crew) below.
        const names = new Map<string, CrewNameParts>();
        if (boatId && nameIds.length > 0) {
            const { data: memberData, error: memberError } = await supabase
                .from('boat_members')
                .select('user_id, prefix, first_name, last_name, nickname')
                .eq('boat_id', boatId)
                .in('user_id', nameIds);
            if (!isAuthIdentityScopeCurrent(scope)) return null;
            if (memberError) {
                log.warn('float plan crew: boat_members read failed', memberError.message);
                return null;
            }
            for (const row of (memberData ?? []) as BoatMemberNameRow[]) {
                if (row?.user_id) names.set(row.user_id, row);
            }
        }

        // The skipper's own row first. No boat_members row (a boat not yet
        // created, or a legacy owner) → the onboarding metadata. Nothing at all
        // → '' so the row renders empty for the skipper to type into; a
        // placeholder like "Skipper" would be read out loud as a name.
        // boat_members first, then onboarding metadata — including when the
        // boat_members row exists but carries no name parts (a legacy owner row
        // written before the four-box onboarding), which is not a name.
        const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
        const skipperName =
            renderCrewDisplayName(names.get(user.id)) ||
            renderCrewDisplayName({
                prefix: typeof meta.prefix === 'string' ? meta.prefix : null,
                first_name: typeof meta.first_name === 'string' ? meta.first_name : null,
                last_name: typeof meta.last_name === 'string' ? meta.last_name : null,
                nickname: typeof meta.nickname === 'string' ? meta.nickname : null,
            });

        // Accepted crew's own name, phone and age (Shane 2026-10-04: "the
        // invitee needs to use the name and phone number and age from the
        // vessel profile in settings"). RLS shows a skipper only his accepted
        // crew's rows. Optional: before the 20261004120000 push, or on any
        // error, the names above still stand.
        const shared = new Map<string, FloatPlanSelfDetails>();
        const acceptedIds = accepted.map((row) => row.crew_user_id).filter((id): id is string => Boolean(id));
        if (acceptedIds.length > 0) {
            const { data, error } = await supabase
                .from('crew_float_plan_details')
                .select('user_id, full_name, phone, age')
                .in('user_id', acceptedIds);
            if (!isAuthIdentityScopeCurrent(scope)) return null;
            // Before the push the table is missing: quiet, one read per open.
            if (error && !isNotPushedYet(error)) {
                log.warn('float plan crew: shared details read failed', error.message);
            }
            for (const row of (data ?? []) as Array<Record<string, unknown>>) {
                if (typeof row?.user_id !== 'string') continue;
                const own = floatPlanSelfDetails({
                    contactPhone: row.phone as string,
                    crewRoster: [{ name: row.full_name as string, age: row.age as number }],
                });
                if (own.name || own.phone || own.age) shared.set(row.user_id, own);
            }
        }

        // Crew invited only for other passages are still aboard, but the plan
        // says which passage (review 2026-10-06), so a one-off guest on every
        // later plan is never silent.
        const passages =
            elsewhere.size > 0 ? await passageNames(supabase, user.id, [...new Set(elsewhere.values())]) : null;
        if (!isAuthIdentityScopeCurrent(scope)) return null;

        const toSeed = (row: VesselCrewRow, source: 'crew' | 'invite'): FloatPlanRosterSeed => {
            const appName = renderCrewDisplayName(
                row.crew_user_id ? names.get(row.crew_user_id) : undefined,
                row.crew_email ?? undefined,
            );
            const own = source === 'crew' && row.crew_user_id ? shared.get(row.crew_user_id) : undefined;
            const otherPassage = source === 'crew' ? elsewhere.get(row) : undefined;
            return {
                name: own?.name || appName,
                role: crewRoleToFloatPlanRole(row.role),
                source,
                crewUserId: row.crew_user_id ?? null,
                ...(own ? { shared: { ...own, appName } } : {}),
                ...(otherPassage ? { invitedFor: passages?.get(otherPassage) ?? ANOTHER_PASSAGE } : {}),
            };
        };

        return {
            aboard: [
                { name: skipperName, role: 'Skipper', source: 'skipper', crewUserId: user.id },
                ...accepted.map((row) => toSeed(row, 'crew')),
            ],
            // A chip with no name has nothing to add; drop it rather than
            // offer "Add" with a blank label.
            invited: pending.map((row) => toSeed(row, 'invite')).filter((seed) => seed.name.length > 0),
        };
    } catch (error) {
        log.warn('float plan crew load failed', error);
        return null;
    }
}

/**
 * The vessel profile's own people (Shane 2026-09-09) as Float Plan seeds:
 * the rows the skipper typed under "Crew Aboard", named ones only, capped at
 * the crew count, ages carried. These outrank the crew-invite list — they are
 * the skipper's own answer to "who is aboard".
 */
export function rosterSeedsFromVesselProfile(
    vessel:
        | { crewCount?: number; crewRoster?: Array<{ name: string; age?: number; rank?: string }> }
        | null
        | undefined,
): Array<FloatPlanRosterSeed & { age: number | null }> {
    const rows = vessel?.crewRoster ?? [];
    const cap =
        typeof vessel?.crewCount === 'number' && Number.isFinite(vessel.crewCount)
            ? Math.max(1, Math.min(99, Math.round(vessel.crewCount)))
            : rows.length;
    return rows.slice(0, cap).flatMap((row, index) => {
        const name = (row?.name ?? '').trim();
        if (!name) return [];
        const rank = (row.rank ?? '').trim();
        const age = typeof row.age === 'number' && Number.isFinite(row.age) && row.age > 0 ? Math.round(row.age) : null;
        return [{ name, role: rank || (index === 0 ? 'Skipper' : 'Crew'), source: 'profile' as const, age }];
    });
}

/**
 * The vessel profile's people and the accepted crew not already among them
 * (Shane 2026-10-04: the POB "needs to include the invitee as well as the
 * others on board"), each once, an invitee with their own name, phone and age,
 * in rank order (Shane 2026-10-07) — the same sortByCrewRank the crew's own
 * view of the boat uses.
 */
export function mergeProfileWithCrew(
    profile: ReturnType<typeof rosterSeedsFromVesselProfile>,
    aboard: FloatPlanRosterSeed[],
) {
    return sortByCrewRank(
        mergeAboard(
            profile,
            aboard.map((seed) => ({
                appName: seed.shared?.appName ?? seed.name,
                ownName: seed.shared?.name,
                role: seed.role,
                isSkipper: seed.source === 'skipper',
                crewUserId: seed.crewUserId,
                age: seed.shared?.age,
                phone: seed.shared?.phone,
            })),
        ),
    );
}
