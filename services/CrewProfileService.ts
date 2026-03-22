/**
 * CrewProfileService — Digital Sea-Bag management.
 *
 * Handles crew passport data, emergency contacts, and dietary info.
 * Auto-populates GlobalClearanceEngine crew manifest for customs.
 */

import { supabase } from './supabase';
import { getAll, insertLocal, updateLocal, generateUUID } from './vessel/LocalDatabase';
import type { CrewManifestEntry } from '../utils/globalClearanceEngine';

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

// ── CRUD ───────────────────────────────────────────────────────────────────

export async function saveProfile(
    profile: Partial<CrewProfile> & { full_name: string; nationality: string },
): Promise<CrewProfile | null> {
    if (!supabase) {
        // Offline: save locally
        const now = new Date().toISOString();
        const record: CrewProfile = {
            id: generateUUID(),
            user_id: '',
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
        return insertLocal(TABLE, record);
    }

    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;

    const { data, error } = await supabase
        .from('crew_profiles')
        .upsert(
            {
                user_id: user.id,
                ...profile,
                updated_at: new Date().toISOString(),
            },
            { onConflict: 'user_id' },
        )
        .select()
        .single();

    if (error) return null;
    return data as CrewProfile;
}

export async function getMyProfile(): Promise<CrewProfile | null> {
    if (!supabase) {
        const profiles = getAll<CrewProfile>(TABLE);
        return profiles[0] || null;
    }

    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;

    const { data } = await supabase.from('crew_profiles').select('*').eq('user_id', user.id).maybeSingle();

    return (data as CrewProfile) || null;
}

export async function updateProfile(id: string, updates: Partial<CrewProfile>): Promise<CrewProfile | null> {
    return updateLocal<CrewProfile>(TABLE, id, updates as Partial<CrewProfile>);
}

// ── Customs Integration ────────────────────────────────────────────────────

/**
 * Get all crew profiles formatted for GlobalClearanceEngine manifest.
 * Auto-populates the Customs PDF crew table.
 */
export async function getCrewManifestForClearance(): Promise<CrewManifestEntry[]> {
    let profiles: CrewProfile[] = [];

    if (supabase) {
        // Fetch all crew profiles visible to the current user
        const { data } = await supabase.from('crew_profiles').select('*').order('full_name');
        profiles = (data as CrewProfile[]) || [];
    }

    // Fallback to local
    if (profiles.length === 0) {
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
    const profiles = getAll<CrewProfile>(TABLE);
    return profiles
        .filter((p) => p.dietary_notes)
        .map((p) => ({
            name: p.full_name,
            dietary: p.dietary_notes!,
        }));
}
