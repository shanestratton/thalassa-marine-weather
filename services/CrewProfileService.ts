/**
 * CrewProfileService — Digital Sea-Bag management.
 *
 * Handles crew passport data, emergency contacts, and dietary info.
 * Auto-populates GlobalClearanceEngine crew manifest for customs.
 */

import { supabase } from './supabase';
import { atomicLocalTransaction, generateUUID, getAll, getLocalDatabaseIdentity } from './vessel/LocalDatabase';
import type { CrewManifestEntry } from '../utils/globalClearanceEngine';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, type AuthIdentityScope } from './authIdentityScope';

// ── Types ──────────────────────────────────────────────────────────────────

export interface CrewProfile {
    id: string;
    user_id: string;
    full_name: string;
    nationality: string;
    date_of_birth: string | null;
    passport_number: string | null;
    passport_expiry: string | null;
    passport_country: string | null;
    emergency_name: string | null;
    emergency_phone: string | null;
    emergency_relation: string | null;
    medical_notes: string | null;
    dietary_notes: string | null;
    sailing_experience: 'novice' | 'competent' | 'experienced' | 'professional';
    profile_photo_url: string | null;
    created_at: string;
    updated_at: string;
}

const TABLE = 'crew_profiles';

function localIdentityMatches(identity: AuthIdentityScope): boolean {
    if (!isAuthIdentityScopeCurrent(identity)) return false;
    try {
        return getLocalDatabaseIdentity() === identity.userId;
    } catch {
        return false;
    }
}

async function verifyAuthenticatedOwner(identity: AuthIdentityScope): Promise<string | null> {
    if (!supabase || !identity.userId || !isAuthIdentityScopeCurrent(identity)) return null;
    const {
        data: { user },
        error,
    } = await supabase.auth.getUser();
    if (error || user?.id !== identity.userId || !isAuthIdentityScopeCurrent(identity)) return null;
    return identity.userId;
}

// ── CRUD ───────────────────────────────────────────────────────────────────

export async function saveProfile(
    profile: Partial<CrewProfile> & { full_name: string; nationality: string },
): Promise<CrewProfile | null> {
    const identity = getAuthIdentityScope();
    if (!supabase) {
        if (!localIdentityMatches(identity)) return null;
        // Offline: save locally
        const now = new Date().toISOString();
        const record: CrewProfile = {
            id: generateUUID(),
            user_id: identity.userId || '',
            full_name: profile.full_name,
            nationality: profile.nationality,
            date_of_birth: profile.date_of_birth || null,
            passport_number: profile.passport_number || null,
            passport_expiry: profile.passport_expiry || null,
            passport_country: profile.passport_country || null,
            emergency_name: profile.emergency_name || null,
            emergency_phone: profile.emergency_phone || null,
            emergency_relation: profile.emergency_relation || null,
            medical_notes: profile.medical_notes || null,
            dietary_notes: profile.dietary_notes || null,
            sailing_experience: profile.sailing_experience || 'novice',
            profile_photo_url: profile.profile_photo_url || null,
            created_at: now,
            updated_at: now,
        };
        try {
            const saved = await atomicLocalTransaction((transaction) => transaction.insert(TABLE, record));
            return isAuthIdentityScopeCurrent(identity) ? saved : null;
        } catch {
            return null;
        }
    }

    const ownerId = await verifyAuthenticatedOwner(identity);
    if (!ownerId) return null;

    const { data, error } = await supabase
        .from('crew_profiles')
        .upsert(
            {
                ...profile,
                user_id: ownerId,
                updated_at: new Date().toISOString(),
            },
            { onConflict: 'user_id' },
        )
        .select()
        .single();

    if (error || !isAuthIdentityScopeCurrent(identity)) return null;
    return data as CrewProfile;
}

export async function getMyProfile(): Promise<CrewProfile | null> {
    const identity = getAuthIdentityScope();
    if (!supabase) {
        if (!localIdentityMatches(identity)) return null;
        const profiles = getAll<CrewProfile>(TABLE);
        const ownerId = identity.userId || '';
        return (
            profiles.find(
                (profile) =>
                    profile.user_id === ownerId ||
                    // Pre-isolation records used an empty owner. They are safe
                    // only inside the already verified account-scoped file.
                    (!!identity.userId && !profile.user_id),
            ) || null
        );
    }

    const ownerId = await verifyAuthenticatedOwner(identity);
    if (!ownerId) return null;

    const { data } = await supabase.from('crew_profiles').select('*').eq('user_id', ownerId).maybeSingle();
    if (!isAuthIdentityScopeCurrent(identity)) return null;

    return (data as CrewProfile) || null;
}

export async function updateProfile(id: string, updates: Partial<CrewProfile>): Promise<CrewProfile | null> {
    const identity = getAuthIdentityScope();
    const safeUpdates = { ...updates };
    delete safeUpdates.id;
    delete safeUpdates.user_id;
    delete safeUpdates.created_at;

    if (!supabase) {
        if (!localIdentityMatches(identity)) return null;
        try {
            const updated = await atomicLocalTransaction((transaction) => {
                const existing = transaction.getById<CrewProfile>(TABLE, id);
                const ownerId = identity.userId || '';
                const isScopedLegacy = !!identity.userId && !existing?.user_id;
                if (!existing || (existing.user_id !== ownerId && !isScopedLegacy)) return null;
                return transaction.update<CrewProfile>(TABLE, id, {
                    ...safeUpdates,
                    // Bind a safely scoped legacy record on its first update.
                    user_id: ownerId,
                });
            });
            return isAuthIdentityScopeCurrent(identity) ? updated : null;
        } catch {
            return null;
        }
    }

    const ownerId = await verifyAuthenticatedOwner(identity);
    if (!ownerId) return null;
    const { data, error } = await supabase
        .from(TABLE)
        .update(safeUpdates)
        .eq('id', id)
        .eq('user_id', ownerId)
        .select()
        .maybeSingle();
    if (error || !isAuthIdentityScopeCurrent(identity)) return null;
    return (data as CrewProfile) || null;
}

// ── Customs Integration ────────────────────────────────────────────────────

/**
 * Get all crew profiles formatted for GlobalClearanceEngine manifest.
 * Auto-populates the Customs PDF crew table.
 */
export async function getCrewManifestForClearance(): Promise<CrewManifestEntry[]> {
    const identity = getAuthIdentityScope();
    let profiles: CrewProfile[] = [];

    if (supabase) {
        // Crew visible through vessel membership is deliberately shared data,
        // so RLS defines the result set rather than narrowing it to the caller.
        // We still bind the request and its result to the initiating account.
        const ownerId = await verifyAuthenticatedOwner(identity);
        if (!ownerId) return [];
        // Fetch all crew profiles visible to the current user
        const { data } = await supabase.from('crew_profiles').select('*').order('full_name');
        if (!isAuthIdentityScopeCurrent(identity)) return [];
        profiles = (data as CrewProfile[]) || [];
    }

    // Fallback to local
    if (profiles.length === 0) {
        if (!localIdentityMatches(identity)) return [];
        profiles = getAll<CrewProfile>(TABLE);
    }

    return profiles.map((p) => ({
        name: p.full_name,
        nationality: p.nationality,
        passport_number: p.passport_number || undefined,
        role: p.sailing_experience === 'professional' ? 'Skipper' : 'Crew',
        date_of_birth: p.date_of_birth || undefined,
    }));
}

/**
 * Get crew dietary summary (for galley planning).
 */
export function getCrewDietarySummary(): { name: string; dietary: string }[] {
    const identity = getAuthIdentityScope();
    if (!localIdentityMatches(identity)) return [];
    const profiles = getAll<CrewProfile>(TABLE);
    return profiles
        .filter((p) => p.dietary_notes)
        .map((p) => ({
            name: p.full_name,
            dietary: p.dietary_notes!,
        }));
}
