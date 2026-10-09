/**
 * CrewService — Manages crew sharing for Vessel Hub.
 *
 * Handles the full crew lifecycle:
 * - Captain: generate manifest codes, set JSONB permissions, revoke access
 * - Crew: redeem codes, accept/decline, leave shared vessel
 *
 * All data flows through Supabase `vessel_crew` + `manifest_invites` tables
 * with RLS enforcement. Crew access controlled by JSONB permissions object.
 */

import { supabase } from './supabase';

import { createLogger } from '../utils/createLogger';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, type AuthIdentityScope } from './authIdentityScope';
import { getDeviceId } from './skipperDevice';

const log = createLogger('CrewService');

interface ScopedUser {
    id: string;
    email?: string | null;
}

function captureAuthenticatedScope(): AuthIdentityScope | null {
    const scope = getAuthIdentityScope();
    return scope.userId && isAuthIdentityScopeCurrent(scope) ? scope : null;
}

function identityStillOwns(scope: AuthIdentityScope, userId: string = scope.userId ?? ''): boolean {
    return Boolean(userId) && scope.userId === userId && isAuthIdentityScopeCurrent(scope);
}

/**
 * Supabase auth is mutable process state. Every operation captures the
 * synchronous application identity first, then verifies that Supabase still
 * represents that exact user before issuing an owner-filtered query.
 */
async function getScopedUser(scope: AuthIdentityScope): Promise<ScopedUser | null> {
    if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope)) return null;
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user || !identityStillOwns(scope, user.id)) return null;
    return user;
}

// ── Types ──────────────────────────────────────────────────────

/** Registers that can be shared with crew */
export type SharedRegister =
    | 'stores'
    | 'equipment'
    | 'maintenance'
    | 'documents'
    | 'galley'
    /** The live Instrument Panel off the Pi — invite-only (Shane 2026-09-07). */
    | 'instruments'
    | 'passage_meals'
    | 'passage_chat'
    | 'passage_route'
    | 'passage_checklist';

/** Vessel-level registers (Ship's Office) */
export const VESSEL_REGISTERS: SharedRegister[] = [
    'stores',
    'equipment',
    'maintenance',
    'documents',
    'galley',
    'instruments',
];

/** Passage Planning child card registers */
export const PASSAGE_REGISTERS: SharedRegister[] = [
    'passage_meals',
    'passage_chat',
    'passage_route',
    'passage_checklist',
];

/**
 * Registers offered in the "+ Invite Crew" modal — seven shareable
 * access levels surfaced at invite time. Instruments first: Shane
 * 2026-09-07, "when we invite a crew member, we need a toggle that says
 * share instrument panel" — the live panel is invite-only, off unless
 * this is ticked, and the vessel_telemetry read policy checks it.
 * Galley added 2026-10-03 (Shane: "can we share the galley as well with
 * invitees (as an option)"): off unless ticked; ticked, the crew member
 * sees and uses the skipper's Galley (recipes, and the meal plans and
 * grocery list kept with no passage) in place of their own. Meal planning
 * for a passage is still the Departure Brief's Meal Planner share.
 * Checklist added so crew can be granted access to the passage readiness
 * checks at invite time.
 */
export const INVITE_REGISTERS: SharedRegister[] = [
    'instruments',
    'stores',
    'equipment',
    'maintenance',
    'documents',
    'galley',
    'passage_checklist',
];

/**
 * Shared with every crew member, always, with no tick box: Crew Chat (Shane
 * 2026-10-02, "we dont need a tick box claude, it should be the default").
 * Invites and roster edits add these whatever was ticked, and the access
 * editor doesn't offer them.
 */
export const ALWAYS_SHARED_REGISTERS: SharedRegister[] = ['passage_chat'];

/** The registers as ticked, plus the ones every crew member always gets. */
export function withAlwaysSharedRegisters(registers: SharedRegister[]): SharedRegister[] {
    return [...registers, ...ALWAYS_SHARED_REGISTERS.filter((register) => !registers.includes(register))];
}

/** All registers combined */
export const ALL_REGISTERS: SharedRegister[] = [...VESSEL_REGISTERS, ...PASSAGE_REGISTERS];

export const REGISTER_LABELS: Record<SharedRegister, string> = {
    stores: "Ship's Stores",
    equipment: 'Equipment',
    maintenance: 'R&M',
    documents: 'Documents',
    galley: 'Galley & Meals',
    instruments: 'Instrument Panel',
    passage_meals: 'Meal Planner',
    passage_chat: 'Group Chat',
    passage_route: 'Passage Route',
    // The passage readiness checks (watch briefed, customs cleared, nav
    // acknowledged), not the Checklists binder, which is never shared
    // (126-B4). 'Passage readiness', not the Crew page's 'Readiness checks':
    // the crew-code caution reads "On a code, <label> covers every one of
    // your passages".
    passage_checklist: 'Passage readiness',
};

/**
 * One short line under a register's tick, where sharing it holds back part
 * of it (126-B4). Documents: the ship_documents read policy keeps 'Crew
 * Visas/IDs' papers for the skipper alone (20261010110000), so crew never see
 * one another's passports. Drawn under the register grid and linked to the
 * tick by aria-describedby, so no chip grows.
 */
export const REGISTER_NOTES: Partial<Record<SharedRegister, string>> = {
    documents: 'Crew IDs stay with you',
};

export const REGISTER_ICONS: Record<SharedRegister, string> = {
    stores: '📦',
    equipment: '⚙️',
    maintenance: '🔧',
    documents: '📄',
    galley: '🍳',
    instruments: '🧭',
    passage_meals: '🍽️',
    passage_chat: '💬',
    passage_route: '🗺️',
    passage_checklist: '✅',
};

/** Granular JSONB permissions (synced to vessel_crew.permissions) */
export interface CrewPermissions {
    can_view_stores: boolean;
    can_edit_stores: boolean;
    can_view_galley: boolean;
    can_view_nav: boolean;
    can_view_weather: boolean;
    can_edit_log: boolean;
    /** The live Instrument Panel (vessel_telemetry) — the skipper's explicit share. */
    can_view_instruments: boolean;
    /**
     * The Galley tick itself (2026-10-03). redeem_manifest_invite shares the
     * skipper's galley from this key, not from can_view_galley: every role
     * preset but punter says can_view_galley true, so a code minted by an
     * older build carries it without anyone ticking Galley. Only
     * syncPassagePermissions writes it, from the tick.
     */
    share_galley?: boolean;
    // Passage Planning child card permissions
    can_view_passage: boolean;
    can_view_passage_meals: boolean;
    can_view_passage_chat: boolean;
    can_view_passage_route: boolean;
    can_view_passage_checklist: boolean;
}

export const DEFAULT_PERMISSIONS: CrewPermissions = {
    can_view_stores: false,
    can_edit_stores: false,
    can_view_galley: false,
    can_view_nav: false,
    can_view_weather: false,
    can_edit_log: false,
    can_view_instruments: false,
    can_view_passage: false,
    can_view_passage_meals: false,
    can_view_passage_chat: false,
    can_view_passage_route: false,
    can_view_passage_checklist: false,
};

/**
 * Keep the legacy/shared-register selector and the canonical JSONB passage
 * flags in sync. Existing vessel-level permission flags are preserved; only
 * the four one-to-one passage flags, their parent gate, the Instrument
 * Panel share and the Galley share are derived here.
 *
 * can_view_galley and share_galley follow the Galley tick (2026-10-03), as
 * the stores flags follow the Stores tick: a crew code carries no
 * shared_registers, and redeem_manifest_invite rebuilds 'galley' from
 * share_galley (20261003100000), so a role preset that said true shares no
 * galley nobody ticked.
 */
export function syncPassagePermissions(
    registers: SharedRegister[],
    current: Partial<CrewPermissions> = DEFAULT_PERMISSIONS,
): CrewPermissions {
    const canViewMeals = registers.includes('passage_meals');
    const canViewChat = registers.includes('passage_chat');
    const canViewRoute = registers.includes('passage_route');
    const canViewChecklist = registers.includes('passage_checklist');

    return {
        ...DEFAULT_PERMISSIONS,
        ...current,
        can_view_passage: canViewMeals || canViewChat || canViewRoute || canViewChecklist,
        can_view_instruments: registers.includes('instruments'),
        can_view_galley: registers.includes('galley'),
        share_galley: registers.includes('galley'),
        can_view_passage_meals: canViewMeals,
        can_view_passage_chat: canViewChat,
        can_view_passage_route: canViewRoute,
        can_view_passage_checklist: canViewChecklist,
    };
}

export type CrewRole = 'co-skipper' | 'navigator' | 'deckhand' | 'punter';

export const ROLE_DEFAULT_PERMISSIONS: Record<CrewRole, CrewPermissions> = {
    'co-skipper': {
        can_view_stores: true,
        can_edit_stores: true,
        can_view_galley: true,
        can_view_nav: true,
        can_view_weather: true,
        can_edit_log: true,
        can_view_instruments: true,
        can_view_passage: true,
        can_view_passage_meals: true,
        can_view_passage_chat: true,
        can_view_passage_route: true,
        can_view_passage_checklist: true,
    },
    navigator: {
        can_view_stores: true,
        can_edit_stores: false,
        can_view_galley: true,
        can_view_nav: true,
        can_view_weather: true,
        can_edit_log: true,
        can_view_instruments: false,
        can_view_passage: true,
        can_view_passage_meals: false,
        can_view_passage_chat: true,
        can_view_passage_route: true,
        can_view_passage_checklist: true,
    },
    deckhand: {
        can_view_stores: true,
        can_edit_stores: false,
        can_view_galley: true,
        can_view_nav: false,
        can_view_weather: false,
        can_edit_log: false,
        can_view_instruments: false,
        can_view_passage: true,
        can_view_passage_meals: true,
        can_view_passage_chat: true,
        can_view_passage_route: false,
        can_view_passage_checklist: true,
    },
    punter: {
        can_view_stores: false,
        can_edit_stores: false,
        can_view_galley: false,
        can_view_nav: false,
        can_view_weather: false,
        can_edit_log: false,
        can_view_instruments: false,
        can_view_passage: false,
        can_view_passage_meals: false,
        can_view_passage_chat: false,
        can_view_passage_route: false,
        can_view_passage_checklist: false,
    },
};

/**
 * The permissions an invite grants for a chosen role plus the registers the
 * skipper ticked. The role preset is the base; the ticked registers decide
 * the passage flags and the Instrument Panel share on top of it.
 *
 * Shane 2026-09-08 (vessel claim/release decision): a delivery or relief
 * skipper is invited as a co-skipper rather than handed the boat, so the
 * invite has to carry the role's preset instead of the all-false default it
 * wrote before. The design text spelled this as
 * `{...ROLE_DEFAULT_PERMISSIONS[role], ...syncPassagePermissions(registers)}`,
 * but syncPassagePermissions returns EVERY flag (all-false base), so that
 * spread would erase the preset — the code here keeps the preset as the base.
 * The Instrument Panel stays "off unless ticked" for every role, including
 * co-skipper, because the toggle is the explicit share (Shane 2026-09-07).
 *
 * Ship's Stores is the one register whose server gate reads the JSONB flag,
 * not shared_registers (can_access_vessel_register, 20260723100000:305-328:
 * `can_view_stores OR can_edit_stores`). So the flags follow the tick
 * (storesPermissions): a ticked Stores register raises can_view_stores, or a
 * punter invited with Stores ticked gets a row that says 'stores' in
 * shared_registers and is refused at the table; an unticked one shares no
 * stores, whatever the role preset says (2026-10-02, shared binders: a
 * deckhand invited without Stores could still read the skipper's stores).
 * The redeem RPC derives 'stores' from the same flag, so the crew code agrees.
 */
export function crewInvitePermissions(role: CrewRole, registers: SharedRegister[]): CrewPermissions {
    const preset = ROLE_DEFAULT_PERMISSIONS[role];
    return syncPassagePermissions(registers, {
        ...preset,
        ...storesPermissions(role, registers, preset),
    });
}

/**
 * The two stores flags from the Stores tick. Edit is only ever kept (from the
 * row as it stands) or granted by the role's preset, never invented: a
 * navigator or deckhand ticked for Stores can look, a co-skipper can edit.
 */
export function storesPermissions(
    role: CrewRole | string | null | undefined,
    registers: SharedRegister[],
    current: Partial<CrewPermissions> = DEFAULT_PERMISSIONS,
): Pick<CrewPermissions, 'can_view_stores' | 'can_edit_stores'> {
    const ticked = registers.includes('stores');
    const preset = role && role in ROLE_DEFAULT_PERMISSIONS ? ROLE_DEFAULT_PERMISSIONS[role as CrewRole] : undefined;
    return {
        can_view_stores: ticked,
        can_edit_stores: ticked && (current.can_edit_stores === true || preset?.can_edit_stores === true),
    };
}

export type CrewInviteStatus = 'pending' | 'accepted' | 'declined';

export interface CrewMember {
    id: string;
    owner_id: string;
    crew_user_id: string;
    crew_email: string;
    owner_email: string;
    shared_registers: SharedRegister[];
    permissions: CrewPermissions;
    status: CrewInviteStatus;
    role: CrewRole;
    /** The voyage this crew member belongs to (null = legacy/global) */
    voyage_id: string | null;
    created_at: string;
    updated_at: string;
}

export interface ManifestInvite {
    id: string;
    owner_id: string;
    invite_code: string;
    email?: string;
    role: CrewRole;
    permissions: CrewPermissions;
    status: 'pending' | 'accepted' | 'expired' | 'revoked';
    accepted_by?: string;
    accepted_at?: string;
    device_id?: string;
    expires_at: string;
    created_at: string;
}

// ── Captain Operations ─────────────────────────────────────────

/**
 * Look up a user by email via database function (SECURITY DEFINER).
 * No Edge Function deployment needed — queries auth.users server-side.
 */
async function lookupUserByEmailForScope(
    email: string,
    scope: AuthIdentityScope,
): Promise<{
    found: boolean;
    user_id?: string;
    email?: string;
    reason?: string;
} | null> {
    if (!supabase) return null;

    try {
        const user = await getScopedUser(scope);
        if (!user) return null;

        const { data, error } = await supabase.rpc('lookup_user_by_email', {
            lookup_email: email.toLowerCase().trim(),
        });
        if (!identityStillOwns(scope, user.id)) return null;

        if (error) {
            log.error('[CrewService] Lookup failed:', error.message);
            return null;
        }

        return data as { found: boolean; user_id?: string; email?: string; reason?: string };
    } catch (e) {
        log.error('[CrewService] Lookup error:', e);
        return null;
    }
}

export async function lookupUserByEmail(email: string): Promise<{
    found: boolean;
    user_id?: string;
    email?: string;
    reason?: string;
} | null> {
    const scope = captureAuthenticatedScope();
    return scope ? lookupUserByEmailForScope(email, scope) : null;
}

/**
 * Invite a crew member by email with specific register permissions.
 * Creates a pending invite that the crew member must accept.
 *
 * `role` defaults to deckhand so every existing three-argument caller is
 * unchanged. The role picker (2026-09-08) passes co-skipper for a relief or
 * delivery skipper — the invite path is the ONLY way onto someone else's
 * hull, so the role has to travel with it.
 */
export async function inviteCrew(
    crewEmail: string,
    registers: SharedRegister[],
    voyageId?: string,
    role: CrewRole = 'deckhand',
): Promise<{ success: boolean; error?: string }> {
    registers = withAlwaysSharedRegisters(registers);
    if (!supabase) return { success: false, error: 'Not connected' };
    const scope = captureAuthenticatedScope();
    if (!scope) return { success: false, error: 'Not authenticated' };

    try {
        const user = await getScopedUser(scope);
        if (!user) return { success: false, error: 'Not authenticated' };

        // Look up the crew member
        const lookup = await lookupUserByEmailForScope(crewEmail, scope);
        if (!identityStillOwns(scope, user.id)) {
            return { success: false, error: 'Account changed while sending the invite' };
        }
        if (!lookup?.found) {
            return {
                success: false,
                error:
                    lookup?.reason === 'self'
                        ? "You can't invite yourself!"
                        : 'User not found. They need to sign up first.',
            };
        }

        // Check if already invited (scope to voyage if provided)
        let existingQuery = supabase
            .from('vessel_crew')
            .select('id, status, permissions')
            .eq('owner_id', user.id)
            .eq('crew_user_id', lookup.user_id!);
        existingQuery = voyageId ? existingQuery.eq('voyage_id', voyageId) : existingQuery.is('voyage_id', null);
        const { data: existing } = await existingQuery.maybeSingle();
        if (!identityStillOwns(scope, user.id)) {
            return { success: false, error: 'Account changed while sending the invite' };
        }

        if (existing) {
            if (existing.status === 'accepted') {
                return { success: false, error: 'This person is already on your crew.' };
            }
            if (existing.status === 'pending') {
                return { success: false, error: 'An invite is already pending for this person.' };
            }
            // If declined, allow re-invite by updating. A re-invite is a fresh
            // offer, so it carries the role chosen NOW and that role's preset
            // (not the declined row's old flags) — otherwise picking co-skipper
            // for someone who once declined would silently stay deckhand.
            const { error: updateError } = await supabase
                .from('vessel_crew')
                .update({
                    status: 'pending',
                    shared_registers: registers,
                    permissions: crewInvitePermissions(role, registers),
                    role,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', existing.id)
                .eq('owner_id', user.id);

            if (updateError || !identityStillOwns(scope, user.id)) {
                return {
                    success: false,
                    error: updateError?.message || 'Account changed while sending the invite',
                };
            }
            return { success: true };
        }

        if (!identityStillOwns(scope, user.id)) {
            return { success: false, error: 'Account changed while sending the invite' };
        }
        // Create new invite
        const { error: insertError } = await supabase.from('vessel_crew').insert({
            owner_id: user.id,
            crew_user_id: lookup.user_id,
            crew_email: crewEmail.toLowerCase().trim(),
            owner_email: user.email || '',
            shared_registers: registers,
            permissions: crewInvitePermissions(role, registers),
            status: 'pending',
            role,
            ...(voyageId ? { voyage_id: voyageId } : {}),
        });

        if (insertError || !identityStillOwns(scope, user.id)) {
            return {
                success: false,
                error: insertError?.message || 'Account changed while sending the invite',
            };
        }
        return { success: true };
    } catch (e) {
        return { success: false, error: String(e) };
    }
}

/**
 * Get all crew members (as captain — shows people you've shared with).
 * If voyageId is provided, only returns crew for that specific passage.
 */
export async function getMyCrew(voyageId?: string): Promise<CrewMember[]> {
    if (!supabase) return [];
    const scope = captureAuthenticatedScope();
    if (!scope) return [];

    try {
        const user = await getScopedUser(scope);
        if (!user) return [];

        let query = supabase
            .from('vessel_crew')
            .select('*')
            .eq('owner_id', user.id)
            .order('created_at', { ascending: false });

        if (voyageId) {
            query = query.eq('voyage_id', voyageId);
        }

        const { data, error } = await query;

        if (error) {
            log.error('[CrewService] getMyCrew error:', error.message);
            return [];
        }

        return identityStillOwns(scope, user.id) ? ((data || []) as CrewMember[]) : [];
    } catch (e) {
        return [];
    }
}

/**
 * Update which registers are shared with a specific crew member.
 */
export async function updateCrewPermissions(crewId: string, registers: SharedRegister[]): Promise<boolean> {
    registers = withAlwaysSharedRegisters(registers);
    if (!supabase) return false;
    const scope = captureAuthenticatedScope();
    if (!scope) return false;

    try {
        const user = await getScopedUser(scope);
        if (!user) return false;
        const { data: member, error: readError } = await supabase
            .from('vessel_crew')
            .select('permissions, role')
            .eq('id', crewId)
            .eq('owner_id', user.id)
            .maybeSingle();
        if (readError || !member || !identityStillOwns(scope, user.id)) return false;

        const { error } = await supabase
            .from('vessel_crew')
            .update({
                shared_registers: registers,
                // Unticking Stores really unshares it: the stores gate reads
                // these flags, not shared_registers (storesPermissions).
                permissions: syncPassagePermissions(registers, {
                    ...(member?.permissions ?? {}),
                    ...storesPermissions(member?.role, registers, member?.permissions ?? {}),
                }),
                updated_at: new Date().toISOString(),
            })
            .eq('id', crewId)
            .eq('owner_id', user.id);

        return !error && identityStillOwns(scope, user.id);
    } catch (e) {
        return false;
    }
}

/**
 * Remove a crew member (captain revokes access).
 */
export async function removeCrew(crewId: string): Promise<boolean> {
    if (!supabase) return false;
    const scope = captureAuthenticatedScope();
    if (!scope) return false;

    try {
        const user = await getScopedUser(scope);
        if (!user) return false;
        const { error } = await supabase.from('vessel_crew').delete().eq('id', crewId).eq('owner_id', user.id);

        return !error && identityStillOwns(scope, user.id);
    } catch (e) {
        return false;
    }
}

// ── Crew Member Operations ─────────────────────────────────────

/**
 * Get all pending invites for the current user (as crew).
 */
export async function getMyInvites(): Promise<CrewMember[]> {
    if (!supabase) return [];
    const scope = captureAuthenticatedScope();
    if (!scope) return [];

    try {
        const user = await getScopedUser(scope);
        if (!user) return [];

        const { data, error } = await supabase
            .from('vessel_crew')
            .select('*')
            .eq('crew_user_id', user.id)
            .eq('status', 'pending')
            .order('created_at', { ascending: false });

        if (error) return [];
        return identityStillOwns(scope, user.id) ? ((data || []) as CrewMember[]) : [];
    } catch (e) {
        return [];
    }
}

/**
 * Get all active crew memberships for the current user (accepted invites).
 */
export async function getMyMemberships(): Promise<CrewMember[]> {
    if (!supabase) return [];
    const scope = captureAuthenticatedScope();
    if (!scope) return [];

    try {
        const user = await getScopedUser(scope);
        if (!user) return [];

        const { data, error } = await supabase
            .from('vessel_crew')
            .select('*')
            .eq('crew_user_id', user.id)
            .eq('status', 'accepted')
            .order('created_at', { ascending: false });

        if (error) return [];
        return identityStillOwns(scope, user.id) ? ((data || []) as CrewMember[]) : [];
    } catch (e) {
        return [];
    }
}

/**
 * Accept a crew invite.
 */
export async function acceptInvite(inviteId: string): Promise<boolean> {
    if (!supabase) return false;
    const scope = captureAuthenticatedScope();
    if (!scope) return false;

    try {
        const user = await getScopedUser(scope);
        if (!user) return false;
        // Get invite details first (need captain's user_id + crew user_id)
        const { data: invite, error: lookupError } = await supabase
            .from('vessel_crew')
            .select('owner_id, crew_user_id')
            .eq('id', inviteId)
            .eq('crew_user_id', user.id)
            .single();
        if (!invite) {
            log.warn(`acceptInvite: invite not found for this account (${lookupError?.message ?? 'no row'})`);
            return false;
        }
        if (!identityStillOwns(scope, user.id)) return false;

        // 2026-10-02 field bug: every accept failed in the database (the
        // bridge trigger's helper had gone missing) and this returned false
        // with no trace, so the Accept button just did nothing. Log the real
        // reason, and count an update that changed no row as a failure.
        const { data: updated, error } = await supabase
            .from('vessel_crew')
            .update({
                status: 'accepted',
                updated_at: new Date().toISOString(),
            })
            .eq('id', inviteId)
            .eq('crew_user_id', user.id)
            .eq('status', 'pending')
            .select('id');

        if (error) {
            log.warn(`acceptInvite failed: ${error.message}`);
            return false;
        }
        if (!updated || updated.length === 0) {
            log.warn('acceptInvite: no pending invite was updated (already answered or withdrawn)');
            return false;
        }
        if (!identityStillOwns(scope, user.id)) return false;

        // Fire-and-forget: add crew to captain's voyage channels
        if (invite?.owner_id && invite?.crew_user_id) {
            import('./ChatService').then(({ ChatService }) => {
                if (!identityStillOwns(scope, user.id)) return;
                ChatService.addCrewToVoyageChannels(invite.owner_id, invite.crew_user_id).catch(() => {
                    /* best effort */
                });
            });
        }

        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Decline a crew invite.
 */
export async function declineInvite(inviteId: string): Promise<boolean> {
    if (!supabase) return false;
    const scope = captureAuthenticatedScope();
    if (!scope) return false;

    try {
        const user = await getScopedUser(scope);
        if (!user) return false;
        const { data: updated, error } = await supabase
            .from('vessel_crew')
            .update({
                status: 'declined',
                updated_at: new Date().toISOString(),
            })
            .eq('id', inviteId)
            .eq('crew_user_id', user.id)
            .eq('status', 'pending')
            .select('id');

        if (error) {
            log.warn(`declineInvite failed: ${error.message}`);
            return false;
        }
        if (!updated || updated.length === 0) {
            log.warn('declineInvite: no pending invite was updated (already answered or withdrawn)');
            return false;
        }
        return identityStillOwns(scope, user.id);
    } catch (e) {
        return false;
    }
}

/**
 * Leave a shared vessel (crew member removes themselves).
 */
export async function leaveVessel(membershipId: string): Promise<boolean> {
    if (!supabase) return false;
    const scope = captureAuthenticatedScope();
    if (!scope) return false;

    try {
        const user = await getScopedUser(scope);
        if (!user) return false;
        const { error } = await supabase
            .from('vessel_crew')
            .delete()
            .eq('id', membershipId)
            .eq('crew_user_id', user.id)
            .eq('status', 'accepted');

        return !error && identityStillOwns(scope, user.id);
    } catch (e) {
        return false;
    }
}

/**
 * Disband the entire crew group — removes ALL crew members belonging to the current user.
 * If voyageId is provided, only removes crew for that specific passage.
 * Also clears the local passage plan status.
 */
export async function disbandGroup(voyageId?: string): Promise<{ success: boolean; removedCount: number }> {
    if (!supabase) return { success: false, removedCount: 0 };
    const scope = captureAuthenticatedScope();
    if (!scope) return { success: false, removedCount: 0 };

    try {
        const user = await getScopedUser(scope);
        if (!user) return { success: false, removedCount: 0 };

        // Get count first for reporting
        let countQuery = supabase.from('vessel_crew').select('id').eq('owner_id', user.id);
        if (voyageId) countQuery = countQuery.eq('voyage_id', voyageId);
        const { data: members } = await countQuery;
        if (!identityStillOwns(scope, user.id)) return { success: false, removedCount: 0 };

        const count = members?.length || 0;

        // Delete crew
        let deleteQuery = supabase.from('vessel_crew').delete().eq('owner_id', user.id);
        if (voyageId) deleteQuery = deleteQuery.eq('voyage_id', voyageId);
        const { error } = await deleteQuery;

        if (error || !identityStillOwns(scope, user.id)) return { success: false, removedCount: 0 };

        // Clear passage plan status
        try {
            const { clearPassagePlan } = await import('./PassagePlanService');
            if (identityStillOwns(scope, user.id)) clearPassagePlan();
        } catch {
            /* non-critical */
        }

        return identityStillOwns(scope, user.id)
            ? { success: true, removedCount: count }
            : { success: false, removedCount: 0 };
    } catch (e) {
        return { success: false, removedCount: 0 };
    }
}

// ── Utilities ──────────────────────────────────────────────────

/**
 * Get a count of pending invites for badge display.
 */
export async function getPendingInviteCount(): Promise<number> {
    if (!supabase) return 0;
    const scope = captureAuthenticatedScope();
    if (!scope) return 0;

    try {
        const user = await getScopedUser(scope);
        if (!user) return 0;

        const { count, error } = await supabase
            .from('vessel_crew')
            .select('*', { count: 'exact', head: true })
            .eq('crew_user_id', user.id)
            .eq('status', 'pending');

        if (error || !identityStillOwns(scope, user.id)) return 0;
        return count || 0;
    } catch (e) {
        return 0;
    }
}

// ── Manifest Code System ───────────────────────────────────────

/**
 * Generate a 6-character alphanumeric manifest code (XX-9999 format).
 * e.g., "TX-5501", "NZ-8842", "AU-3317"
 */
function generateManifestCode(): string {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // No I/O (confusable)
    const random = new Uint32Array(3);
    crypto.getRandomValues(random);
    const l1 = letters[random[0] % letters.length];
    const l2 = letters[random[1] % letters.length];
    const num = 1000 + (random[2] % 9000);
    return `${l1}${l2}-${num}`;
}

// Manifest code locking uses the app's ONE per-install device id
// (services/skipperDevice.ts). This file used to mint its own under the same
// storage key, so whichever module ran first decided the id's shape — harmless
// while nothing compared ids across modules, wrong once the followed-route
// link and the recording-device stamp started naming devices (2026-09-08).

/**
 * Create a manifest invite code (Skipper action).
 */
export async function createManifestInvite(
    role: CrewRole,
    permissions?: Partial<CrewPermissions>,
    email?: string,
): Promise<{ success: boolean; code?: string; error?: string }> {
    if (!supabase) return { success: false, error: 'Not connected' };
    const scope = captureAuthenticatedScope();
    if (!scope) return { success: false, error: 'Not authenticated' };

    try {
        const user = await getScopedUser(scope);
        if (!user) return { success: false, error: 'Not authenticated' };

        const perms: CrewPermissions = {
            ...ROLE_DEFAULT_PERMISSIONS[role],
            ...(permissions || {}),
        };

        // The code is a bearer credential. Generate it cryptographically and
        // retry the actual unique insert rather than enumerating other users'
        // invite rows to check for collisions.
        for (let attempt = 0; attempt < 5; attempt++) {
            if (!identityStillOwns(scope, user.id)) {
                return { success: false, error: 'Account changed while creating the invite' };
            }
            const code = generateManifestCode();
            const { error } = await supabase.from('manifest_invites').insert({
                owner_id: user.id,
                invite_code: code,
                email: email?.toLowerCase().trim() || null,
                role,
                permissions: perms,
                status: 'pending',
            });

            if (!error) {
                return identityStillOwns(scope, user.id)
                    ? { success: true, code }
                    : { success: false, error: 'Account changed while creating the invite' };
            }
            if (error.code !== '23505') {
                return { success: false, error: error.message };
            }
        }
        return { success: false, error: 'Could not generate a unique code. Please try again.' };
    } catch (e) {
        return { success: false, error: String(e) };
    }
}

/**
 * Redeem a manifest code (Crew action).
 * Links the current user + device to the vessel.
 */
export async function redeemManifestCode(
    code: string,
): Promise<{ success: boolean; error?: string; vesselName?: string }> {
    if (!supabase) return { success: false, error: 'Not connected' };
    const scope = captureAuthenticatedScope();
    if (!scope) return { success: false, error: 'Not authenticated' };

    try {
        const user = await getScopedUser(scope);
        if (!user) return { success: false, error: 'Not authenticated' };

        const { data, error } = await supabase.rpc('redeem_manifest_invite', {
            p_code: code.toUpperCase().trim(),
            p_device_id: getDeviceId(),
        });
        if (!identityStillOwns(scope, user.id)) {
            return { success: false, error: 'Account changed while joining the vessel' };
        }
        if (error) return { success: false, error: error.message };

        const result = data as {
            success?: boolean;
            error?: string;
            vessel_name?: string;
        } | null;
        if (!result?.success) {
            return { success: false, error: result?.error || 'Invalid or expired code.' };
        }
        return {
            success: true,
            vesselName: result.vessel_name || 'Vessel',
        };
    } catch (e) {
        return { success: false, error: String(e) };
    }
}

/**
 * Get all manifest invites created by the current user (Skipper view).
 */
export async function getMyManifestInvites(): Promise<ManifestInvite[]> {
    if (!supabase) return [];
    const scope = captureAuthenticatedScope();
    if (!scope) return [];

    try {
        const user = await getScopedUser(scope);
        if (!user) return [];

        const { data, error } = await supabase
            .from('manifest_invites')
            .select('*')
            .eq('owner_id', user.id)
            .order('created_at', { ascending: false });

        if (error) return [];
        return identityStillOwns(scope, user.id) ? ((data || []) as ManifestInvite[]) : [];
    } catch {
        return [];
    }
}

/**
 * Revoke a manifest invite (Skipper action).
 */
export async function revokeManifestInvite(inviteId: string): Promise<boolean> {
    if (!supabase) return false;
    const scope = captureAuthenticatedScope();
    if (!scope) return false;

    try {
        const user = await getScopedUser(scope);
        if (!user) return false;
        const { error } = await supabase
            .from('manifest_invites')
            .update({ status: 'revoked' })
            .eq('id', inviteId)
            .eq('owner_id', user.id);

        return !error && identityStillOwns(scope, user.id);
    } catch {
        return false;
    }
}
