/**
 * CrewService — Manages crew sharing for Vessel Hub.
 *
 * Handles the full crew lifecycle:
 * - Captain: invite crew by email, set register permissions, revoke access
 * - Crew: view pending invites, accept/decline, leave shared vessel
 *
 * All data flows through Supabase `vessel_crew` table with RLS enforcement.
 * Crew can only access registers explicitly shared with them.
 */

import { supabase } from './supabase';

// ── Types ──────────────────────────────────────────────────────

/** Registers that can be shared with crew */
export type SharedRegister = 'inventory' | 'equipment' | 'maintenance' | 'documents';

export const ALL_REGISTERS: SharedRegister[] = ['inventory', 'equipment', 'maintenance', 'documents'];

export const REGISTER_LABELS: Record<SharedRegister, string> = {
    inventory: 'Inventory',
    equipment: 'Equipment',
    maintenance: 'R&M',
    documents: 'Documents',
};

export const REGISTER_ICONS: Record<SharedRegister, string> = {
    inventory: '📦',
    equipment: '⚙️',
    maintenance: '🔧',
    documents: '📄',
};

export type CrewInviteStatus = 'pending' | 'accepted' | 'declined';

export interface CrewMember {
    id: string;
    owner_id: string;
    crew_user_id: string;
    crew_email: string;
    owner_email: string;
    shared_registers: SharedRegister[];
    status: CrewInviteStatus;
    role: string;
    created_at: string;
    updated_at: string;
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
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return null;

        const { data, error } = await supabase.rpc('lookup_user_by_email', {
            lookup_email: email.toLowerCase().trim(),
        });

        if (error) {
            console.error('[CrewService] Lookup failed:', error.message);
            return null;
        }

        return data as { found: boolean; user_id?: string; email?: string; reason?: string };
    } catch (e) {
        console.error('[CrewService] Lookup error:', e);
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
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return { success: false, error: 'Not authenticated' };

        // Look up the crew member
        const lookup = await lookupUserByEmail(crewEmail);
        if (!lookup?.found) {
            return {
                success: false,
                error: lookup?.reason === 'self'
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
        const { error: insertError } = await supabase
            .from('vessel_crew')
            .insert({
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
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return [];

        const { data, error } = await supabase
            .from('vessel_crew')
            .select('*')
            .eq('owner_id', user.id)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('[CrewService] getMyCrew error:', error.message);
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
export async function updateCrewPermissions(
    crewId: string,
    registers: SharedRegister[],
): Promise<boolean> {
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
        const { error } = await supabase
            .from('vessel_crew')
            .delete()
            .eq('id', crewId);

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
        const { data: { user } } = await supabase.auth.getUser();
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
        const { data: { user } } = await supabase.auth.getUser();
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
        const { error } = await supabase
            .from('vessel_crew')
            .delete()
            .eq('id', membershipId);

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
        const { data: { user } } = await supabase.auth.getUser();
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
        const { data: { user } } = await supabase.auth.getUser();
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
