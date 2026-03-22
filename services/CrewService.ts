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

const log = createLogger('CrewService');

// ── Types ──────────────────────────────────────────────────────

/** Registers that can be shared with crew */
export type SharedRegister = 'stores' | 'equipment' | 'maintenance' | 'documents';

export const ALL_REGISTERS: SharedRegister[] = ['stores', 'equipment', 'maintenance', 'documents'];

export const REGISTER_LABELS: Record<SharedRegister, string> = {
    stores: "Ship's Stores",
    equipment: 'Equipment',
    maintenance: 'R&M',
    documents: 'Documents',
};

export const REGISTER_ICONS: Record<SharedRegister, string> = {
    stores: '📦',
    equipment: '⚙️',
    maintenance: '🔧',
    documents: '📄',
};

/** Granular JSONB permissions (synced to vessel_crew.permissions) */
export interface CrewPermissions {
    can_view_stores: boolean;
    can_edit_stores: boolean;
    can_view_galley: boolean;
    can_view_nav: boolean;
    can_view_weather: boolean;
    can_edit_log: boolean;
}

export const DEFAULT_PERMISSIONS: CrewPermissions = {
    can_view_stores: false,
    can_edit_stores: false,
    can_view_galley: false,
    can_view_nav: false,
    can_view_weather: false,
    can_edit_log: false,
};

export type CrewRole = 'co-skipper' | 'navigator' | 'deckhand' | 'punter';

export const ROLE_DEFAULT_PERMISSIONS: Record<CrewRole, CrewPermissions> = {
    'co-skipper': {
        can_view_stores: true,
        can_edit_stores: true,
        can_view_galley: true,
        can_view_nav: true,
        can_view_weather: true,
        can_edit_log: true,
    },
    navigator: {
        can_view_stores: true,
        can_edit_stores: false,
        can_view_galley: true,
        can_view_nav: true,
        can_view_weather: true,
        can_edit_log: true,
    },
    deckhand: {
        can_view_stores: true,
        can_edit_stores: false,
        can_view_galley: true,
        can_view_nav: false,
        can_view_weather: false,
        can_edit_log: false,
    },
    punter: {
        can_view_stores: false,
        can_edit_stores: false,
        can_view_galley: false,
        can_view_nav: false,
        can_view_weather: false,
        can_edit_log: false,
    },
};

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
export async function lookupUserByEmail(email: string): Promise<{
    found: boolean;
    user_id?: string;
    email?: string;
    reason?: string;
} | null> {
    if (!supabase) return null;

    try {
        const {
            data: { session },
        } = await supabase.auth.getSession();
        if (!session) return null;

        const { data, error } = await supabase.rpc('lookup_user_by_email', {
            lookup_email: email.toLowerCase().trim(),
        });

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

/**
 * Invite a crew member by email with specific register permissions.
 * Creates a pending invite that the crew member must accept.
 */
export async function inviteCrew(
    crewEmail: string,
    registers: SharedRegister[],
): Promise<{ success: boolean; error?: string }> {
    if (!supabase) return { success: false, error: 'Not connected' };

    try {
        // Get current user
        const {
            data: { user },
        } = await supabase.auth.getUser();
        if (!user) return { success: false, error: 'Not authenticated' };

        // Look up the crew member
        const lookup = await lookupUserByEmail(crewEmail);
        if (!lookup?.found) {
            return {
                success: false,
                error:
                    lookup?.reason === 'self'
                        ? "You can't invite yourself!"
                        : 'User not found. They need to sign up first.',
            };
        }

        // Check if already invited
        const { data: existing } = await supabase
            .from('vessel_crew')
            .select('id, status')
            .eq('owner_id', user.id)
            .eq('crew_user_id', lookup.user_id!)
            .single();

        if (existing) {
            if (existing.status === 'accepted') {
                return { success: false, error: 'This person is already on your crew.' };
            }
            if (existing.status === 'pending') {
                return { success: false, error: 'An invite is already pending for this person.' };
            }
            // If declined, allow re-invite by updating
            const { error: updateError } = await supabase
                .from('vessel_crew')
                .update({
                    status: 'pending',
                    shared_registers: registers,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', existing.id);

            if (updateError) return { success: false, error: updateError.message };
            return { success: true };
        }

        // Create new invite
        const { error: insertError } = await supabase.from('vessel_crew').insert({
            owner_id: user.id,
            crew_user_id: lookup.user_id,
            crew_email: crewEmail.toLowerCase().trim(),
            owner_email: user.email || '',
            shared_registers: registers,
            status: 'pending',
            role: 'crew',
        });

        if (insertError) return { success: false, error: insertError.message };
        return { success: true };
    } catch (e) {
        return { success: false, error: String(e) };
    }
}

/**
 * Get all crew members (as captain — shows people you've shared with).
 */
export async function getMyCrew(): Promise<CrewMember[]> {
    if (!supabase) return [];

    try {
        const {
            data: { user },
        } = await supabase.auth.getUser();
        if (!user) return [];

        const { data, error } = await supabase
            .from('vessel_crew')
            .select('*')
            .eq('owner_id', user.id)
            .order('created_at', { ascending: false });

        if (error) {
            log.error('[CrewService] getMyCrew error:', error.message);
            return [];
        }

        return (data || []) as CrewMember[];
    } catch (e) {
        return [];
    }
}

/**
 * Update which registers are shared with a specific crew member.
 */
export async function updateCrewPermissions(crewId: string, registers: SharedRegister[]): Promise<boolean> {
    if (!supabase) return false;

    try {
        const { error } = await supabase
            .from('vessel_crew')
            .update({
                shared_registers: registers,
                updated_at: new Date().toISOString(),
            })
            .eq('id', crewId);

        return !error;
    } catch (e) {
        return false;
    }
}

/**
 * Remove a crew member (captain revokes access).
 */
export async function removeCrew(crewId: string): Promise<boolean> {
    if (!supabase) return false;

    try {
        const { error } = await supabase.from('vessel_crew').delete().eq('id', crewId);

        return !error;
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

    try {
        const {
            data: { user },
        } = await supabase.auth.getUser();
        if (!user) return [];

        const { data, error } = await supabase
            .from('vessel_crew')
            .select('*')
            .eq('crew_user_id', user.id)
            .eq('status', 'pending')
            .order('created_at', { ascending: false });

        if (error) return [];
        return (data || []) as CrewMember[];
    } catch (e) {
        return [];
    }
}

/**
 * Get all active crew memberships for the current user (accepted invites).
 */
export async function getMyMemberships(): Promise<CrewMember[]> {
    if (!supabase) return [];

    try {
        const {
            data: { user },
        } = await supabase.auth.getUser();
        if (!user) return [];

        const { data, error } = await supabase
            .from('vessel_crew')
            .select('*')
            .eq('crew_user_id', user.id)
            .eq('status', 'accepted')
            .order('created_at', { ascending: false });

        if (error) return [];
        return (data || []) as CrewMember[];
    } catch (e) {
        return [];
    }
}

/**
 * Accept a crew invite.
 */
export async function acceptInvite(inviteId: string): Promise<boolean> {
    if (!supabase) return false;

    try {
        const { error } = await supabase
            .from('vessel_crew')
            .update({
                status: 'accepted',
                updated_at: new Date().toISOString(),
            })
            .eq('id', inviteId);

        return !error;
    } catch (e) {
        return false;
    }
}

/**
 * Decline a crew invite.
 */
export async function declineInvite(inviteId: string): Promise<boolean> {
    if (!supabase) return false;

    try {
        const { error } = await supabase
            .from('vessel_crew')
            .update({
                status: 'declined',
                updated_at: new Date().toISOString(),
            })
            .eq('id', inviteId);

        return !error;
    } catch (e) {
        return false;
    }
}

/**
 * Leave a shared vessel (crew member removes themselves).
 */
export async function leaveVessel(membershipId: string): Promise<boolean> {
    if (!supabase) return false;

    try {
        const { error } = await supabase.from('vessel_crew').delete().eq('id', membershipId);

        return !error;
    } catch (e) {
        return false;
    }
}

// ── Utilities ──────────────────────────────────────────────────

/**
 * Check if the current user has a specific register shared by any captain.
 * Returns the captain's user_id if shared, null if not.
 */
export async function getSharedOwnerForRegister(
    register: SharedRegister,
): Promise<{ ownerId: string; ownerEmail: string } | null> {
    if (!supabase) return null;

    try {
        const {
            data: { user },
        } = await supabase.auth.getUser();
        if (!user) return null;

        const { data, error } = await supabase
            .from('vessel_crew')
            .select('owner_id, owner_email')
            .eq('crew_user_id', user.id)
            .eq('status', 'accepted')
            .contains('shared_registers', [register])
            .limit(1)
            .single();

        if (error || !data) return null;
        return { ownerId: data.owner_id, ownerEmail: data.owner_email };
    } catch (e) {
        return null;
    }
}

/**
 * Get a count of pending invites for badge display.
 */
export async function getPendingInviteCount(): Promise<number> {
    if (!supabase) return 0;

    try {
        const {
            data: { user },
        } = await supabase.auth.getUser();
        if (!user) return 0;

        const { count, error } = await supabase
            .from('vessel_crew')
            .select('*', { count: 'exact', head: true })
            .eq('crew_user_id', user.id)
            .eq('status', 'pending');

        if (error) return 0;
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
    const l1 = letters[Math.floor(Math.random() * letters.length)];
    const l2 = letters[Math.floor(Math.random() * letters.length)];
    const num = Math.floor(1000 + Math.random() * 9000); // 4 digits, 1000-9999
    return `${l1}${l2}-${num}`;
}

/**
 * Get the device ID for manifest code locking.
 */
function getDeviceId(): string {
    let id = localStorage.getItem('thalassa_device_id');
    if (!id) {
        id = `dev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        localStorage.setItem('thalassa_device_id', id);
    }
    return id;
}

/**
 * Create a manifest invite code (Skipper action).
 */
export async function createManifestInvite(
    role: CrewRole,
    permissions?: Partial<CrewPermissions>,
    email?: string,
): Promise<{ success: boolean; code?: string; error?: string }> {
    if (!supabase) return { success: false, error: 'Not connected' };

    try {
        const {
            data: { user },
        } = await supabase.auth.getUser();
        if (!user) return { success: false, error: 'Not authenticated' };

        // Generate a unique code (retry if collision)
        let code = generateManifestCode();
        let attempts = 0;
        while (attempts < 5) {
            const { data: existing } = await supabase
                .from('manifest_invites')
                .select('id')
                .eq('invite_code', code)
                .maybeSingle();

            if (!existing) break;
            code = generateManifestCode();
            attempts++;
        }

        const perms: CrewPermissions = {
            ...ROLE_DEFAULT_PERMISSIONS[role],
            ...(permissions || {}),
        };

        const { error } = await supabase.from('manifest_invites').insert({
            owner_id: user.id,
            invite_code: code,
            email: email?.toLowerCase().trim() || null,
            role,
            permissions: perms,
            status: 'pending',
        });

        if (error) return { success: false, error: error.message };
        return { success: true, code };
    } catch (e) {
        return { success: false, error: String(e) };
    }
}

/**
 * Redeem a manifest code (Crew action).
 * Links the current user + device to the vessel.
 */
export async function redeemManifestCode(code: string): Promise<{ success: boolean; error?: string }> {
    if (!supabase) return { success: false, error: 'Not connected' };

    try {
        const {
            data: { user },
        } = await supabase.auth.getUser();
        if (!user) return { success: false, error: 'Not authenticated' };

        // Find the invite
        const { data: invite, error: findError } = await supabase
            .from('manifest_invites')
            .select('*')
            .eq('invite_code', code.toUpperCase().trim())
            .eq('status', 'pending')
            .gt('expires_at', new Date().toISOString())
            .maybeSingle();

        if (findError || !invite) {
            return { success: false, error: 'Invalid or expired code.' };
        }

        // Check it's not the owner trying to redeem their own code
        if (invite.owner_id === user.id) {
            return { success: false, error: "You can't redeem your own code!" };
        }

        // Check if email-restricted and doesn't match
        if (invite.email && invite.email !== user.email?.toLowerCase()) {
            return { success: false, error: 'This code is reserved for a different email.' };
        }

        const deviceId = getDeviceId();

        // Mark invite as accepted
        const { error: updateError } = await supabase
            .from('manifest_invites')
            .update({
                status: 'accepted',
                accepted_by: user.id,
                accepted_at: new Date().toISOString(),
                device_id: deviceId,
            })
            .eq('id', invite.id);

        if (updateError) return { success: false, error: updateError.message };

        // Create the vessel_crew link with JSONB permissions
        const { error: crewError } = await supabase.from('vessel_crew').upsert(
            {
                owner_id: invite.owner_id,
                crew_user_id: user.id,
                crew_email: user.email || '',
                owner_email: '', // Will be populated on next sync
                shared_registers: Object.entries(invite.permissions || {})
                    .filter(([, v]) => v === true)
                    .map(([k]) => k.replace('can_view_', '').replace('can_edit_', ''))
                    .filter((v, i, a) => a.indexOf(v) === i) as SharedRegister[],
                permissions: invite.permissions,
                status: 'accepted',
                role: invite.role,
            },
            { onConflict: 'owner_id,crew_user_id' },
        );

        if (crewError) return { success: false, error: crewError.message };
        return { success: true };
    } catch (e) {
        return { success: false, error: String(e) };
    }
}

/**
 * Get all manifest invites created by the current user (Skipper view).
 */
export async function getMyManifestInvites(): Promise<ManifestInvite[]> {
    if (!supabase) return [];

    try {
        const {
            data: { user },
        } = await supabase.auth.getUser();
        if (!user) return [];

        const { data, error } = await supabase
            .from('manifest_invites')
            .select('*')
            .eq('owner_id', user.id)
            .order('created_at', { ascending: false });

        if (error) return [];
        return (data || []) as ManifestInvite[];
    } catch {
        return [];
    }
}

/**
 * Revoke a manifest invite (Skipper action).
 */
export async function revokeManifestInvite(inviteId: string): Promise<boolean> {
    if (!supabase) return false;

    try {
        const { error } = await supabase.from('manifest_invites').update({ status: 'revoked' }).eq('id', inviteId);

        return !error;
    } catch {
        return false;
    }
}
