/**
 * crewCardNames — what the skipper's crew cards call each accepted crew
 * member (Shane 2026-10-06, the Crew & Float Plan page's new look: "the
 * person's NAME ... where the app knows them").
 *
 * In order: the name the crew member shared for the float plan from their own
 * Settings (crew_float_plan_details.full_name, which RLS shows only to the
 * skippers they are accepted crew for), else their byline on the skipper's
 * boat (boat_members, written when they accepted). Only the NAME is read:
 * never a phone or an age, so nothing else of theirs reaches this page. A
 * pending invite has neither, and its card keeps the email.
 *
 * The last names this device read are kept per account (authScopedStorageKey,
 * swept by account deletion) so the cards paint their names at once; the read
 * refreshes them. A failed read keeps what was known; only an answer changes
 * it.
 */
import { supabase } from '../supabase';
import { authScopedStorageKey, isAuthIdentityScopeCurrent, type AuthIdentityScope } from '../authIdentityScope';
import { activeOwnedBoatId } from '../../components/crewManagement/activeOwnedBoat';
import { renderCrewDisplayName, type CrewNameParts } from '../floatPlanCrew';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('crewCardNames');

const NAMES_KEY = 'thalassa_crew_card_names_v1';
/** A skipper's crew is a handful; never keep or read without a bound. */
export const MAX_CREW_CARD_NAMES = 40;
const MAX_NAME_LENGTH = 80;

export type CrewCardNames = Readonly<Record<string, string>>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanName(value: unknown): string {
    return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_LENGTH) : '';
}

function parseNames(value: unknown): Record<string, string> {
    if (!isRecord(value)) return {};
    const names: Record<string, string> = {};
    for (const [userId, name] of Object.entries(value).slice(0, MAX_CREW_CARD_NAMES)) {
        const clean = cleanName(name);
        if (userId && clean) names[userId] = clean;
    }
    return names;
}

/** The names this device last read for this account's crew, or {}. Never throws. */
export function readCrewCardNames(scope: AuthIdentityScope): CrewCardNames {
    if (!scope.userId) return {};
    try {
        if (typeof localStorage === 'undefined') return {};
        const raw = localStorage.getItem(authScopedStorageKey(NAMES_KEY, scope));
        if (!raw) return {};
        const value: unknown = JSON.parse(raw);
        if (!isRecord(value) || value.version !== 1 || value.userId !== scope.userId) return {};
        return parseNames(value.names);
    } catch {
        return {};
    }
}

function rememberCrewCardNames(scope: AuthIdentityScope, names: CrewCardNames): void {
    if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) return;
    try {
        if (typeof localStorage === 'undefined') return;
        const key = authScopedStorageKey(NAMES_KEY, scope);
        if (Object.keys(names).length === 0) {
            localStorage.removeItem(key);
            return;
        }
        const next = JSON.stringify({ version: 1, userId: scope.userId, names });
        if (localStorage.getItem(key) !== next) localStorage.setItem(key, next);
    } catch {
        /* storage unavailable: the cards still show this visit's names */
    }
}

/**
 * Read the names of these accepted crew members (by crew_user_id). Null when
 * there is no answer (no backend, an identity change mid-flight, both reads
 * failing): the caller keeps what it had.
 */
export async function loadCrewCardNames(
    scope: AuthIdentityScope,
    crewUserIds: readonly string[],
): Promise<CrewCardNames | null> {
    if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope)) return null;
    const ids = [...new Set(crewUserIds.filter((id) => typeof id === 'string' && id.length > 0))].slice(
        0,
        MAX_CREW_CARD_NAMES,
    );
    if (ids.length === 0) {
        rememberCrewCardNames(scope, {});
        return {};
    }
    const client = supabase;
    try {
        const boatId = await activeOwnedBoatId(scope);
        if (!isAuthIdentityScopeCurrent(scope)) return null;
        const [shared, bylines] = await Promise.all([
            client.from('crew_float_plan_details').select('user_id, full_name').in('user_id', ids),
            boatId
                ? client
                      .from('boat_members')
                      .select('user_id, prefix, first_name, last_name, nickname')
                      .eq('boat_id', boatId)
                      .in('user_id', ids)
                : Promise.resolve({ data: [], error: null }),
        ]);
        if (!isAuthIdentityScopeCurrent(scope)) return null;
        // Before the 20261004120000 push the shared table is missing; the
        // bylines still answer. Both failing is no answer at all.
        if (shared.error && bylines.error) {
            log.warn('crew names could not be read', bylines.error.message);
            return null;
        }
        // One read failing is a partial answer: what it would have said stays
        // as this device last knew it.
        const names: Record<string, string> = {};
        if (shared.error || bylines.error) {
            const prior = readCrewCardNames(scope);
            for (const id of ids) if (prior[id]) names[id] = prior[id];
        }
        for (const row of (bylines.data ?? []) as Array<CrewNameParts & { user_id?: unknown }>) {
            if (typeof row?.user_id !== 'string' || !ids.includes(row.user_id)) continue;
            const name = cleanName(renderCrewDisplayName(row));
            if (name) names[row.user_id] = name;
        }
        // Their own name wins over the byline the skipper's boat holds.
        for (const row of (shared.data ?? []) as Array<{ user_id?: unknown; full_name?: unknown }>) {
            if (typeof row?.user_id !== 'string' || !ids.includes(row.user_id)) continue;
            const name = cleanName(row.full_name);
            if (name) names[row.user_id] = name;
        }
        rememberCrewCardNames(scope, names);
        return names;
    } catch (error) {
        log.warn('crew names could not be read', error);
        return null;
    }
}
