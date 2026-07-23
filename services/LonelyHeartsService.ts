/**
 * Crew & Dating Service — Split Architecture
 *
 * Two separate tables:
 * - sailor_crew_profiles: Find Crew listings (seeking crew / seeking berth)
 * - sailor_dating_profiles: Lonely Hearts dating profiles
 *
 * Both use the same likes/matches system (sailor_likes).
 * Uses existing DM infrastructure for matched conversations.
 */

import { createLogger } from '../utils/createLogger';
import { supabase } from './supabase';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, type AuthIdentityScope } from './authIdentityScope';
const log = createLogger('CrewFinder');

// --- TABLES ---
const CREW_PROFILES_TABLE = 'sailor_crew_profiles';
const DATING_PROFILES_TABLE = 'sailor_dating_profiles';
const LIKES_TABLE = 'sailor_likes';
const CHAT_PROFILES_TABLE = 'chat_profiles';
const BLOCKS_TABLE = 'sailor_blocks';
const REPORTS_TABLE = 'sailor_reports';

/** Raw Supabase row — typed loosely since we normalize immediately */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseRow = Record<string, any>;

// ═══════════════════════════════════════════════════
// TYPES — CREW (Find Crew)
// ═══════════════════════════════════════════════════

export type ListingType = 'seeking_crew' | 'seeking_berth';

export interface CrewProfile {
    user_id: string;
    listing_type: ListingType | null;
    first_name: string | null;
    gender: string | null;
    age_range: string | null;
    has_partner: boolean;
    partner_details: string | null;
    skills: string[];
    sailing_experience: string | null;
    sailing_region: string | null;
    available_from: string | null;
    available_to: string | null;
    bio: string | null;
    vibe: string[];
    languages: string[];
    smoking: string | null;
    drinking: string | null;
    pets: string | null;
    interests: string[];
    last_active: string | null;
    is_verified: boolean;
    location_city: string | null;
    location_state: string | null;
    location_country: string | null;
    photo_url: string | null;
    photos: string[];
    created_at: string;
    updated_at: string;
}

export interface CrewCard {
    user_id: string;
    // From chat_profiles
    display_name: string;
    avatar_url: string | null;
    vessel_name: string | null;
    home_port: string | null;
    // From crew profile
    listing_type: ListingType | null;
    first_name: string | null;
    photo_url: string | null;
    gender: string | null;
    age_range: string | null;
    has_partner: boolean;
    partner_details: string | null;
    skills: string[];
    sailing_experience: string | null;
    sailing_region: string | null;
    available_from: string | null;
    available_to: string | null;
    bio: string | null;
    vibe: string[];
    languages: string[];
    smoking: string | null;
    drinking: string | null;
    pets: string | null;
    interests: string[];
    last_active: string | null;
    is_verified: boolean;
    location_city: string | null;
    location_state: string | null;
    location_country: string | null;
    photos: string[];
}

// ═══════════════════════════════════════════════════
// TYPES — DATING (Lonely Hearts)
// ═══════════════════════════════════════════════════

export interface DatingProfile {
    user_id: string;
    first_name: string | null;
    gender: string | null;
    age_range: string | null;
    bio: string | null;
    interests: string[];
    seeking: string | null;
    location_text: string | null;
    sailing_experience: string | null;
    sailing_region: string | null;
    photos: string[];
    // Legacy column names (for reading old data)
    dating_first_name?: string | null;
    bio_dating?: string | null;
    dating_photos?: string[];
    created_at: string;
    updated_at: string;
}

export interface DatingCard {
    user_id: string;
    display_name: string;
    avatar_url: string | null;
    vessel_name: string | null;
    home_port: string | null;
    first_name: string | null;
    photos: string[];
    gender: string | null;
    age_range: string | null;
    bio: string | null;
    interests: string[];
    seeking: string | null;
    location_text: string | null;
    sailing_experience: string | null;
    sailing_region: string | null;
}

// Legacy aliases for backward compat
export type SailorDatingProfile = DatingProfile;
export type SailorCard = DatingCard;

export interface SailorMatch {
    user_id: string;
    display_name: string;
    dating_first_name: string | null;
    dating_photos: string[];
    avatar_url: string | null;
    vessel_name: string | null;
    home_port: string | null;
    interests: string[];
    vibe: string[];
    languages: string[];
    smoking: string | null;
    drinking: string | null;
    pets: string | null;
    sailing_experience: string | null;
    matched_at: string;
}

// ═══════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════

export const SKILL_OPTIONS = [
    '🍳 Cooking',
    '🧹 Cleaning',
    '👁️ Watch Keeping',
    '🧭 Navigation',
    '⚙️ Diesel Engines',
    '⚡ Electrical',
    '🪡 Sail Repair',
    '🏥 First Aid',
    '⛵ Rigging',
    '🐟 Fishing',
    '🤿 Diving',
    '📻 Radio/Comms',
    '🧰 Maintenance',
    '🎣 Provisioning',
    '📐 Passage Planning',
];

export const GENDER_OPTIONS = ['Male', 'Female'];

export const AGE_RANGES = ['18-25', '26-35', '36-45', '46-55', '56-65', '65+'];

export const EXPERIENCE_LEVELS = [
    'Just Got My Sea Legs',
    'Weekend Warrior',
    'Coastal Cruiser',
    'Liveaboard',
    'Bluewater Veteran',
    'Salty Dog 🧂',
];

export const LISTING_TYPES: { key: ListingType; label: string; icon: string }[] = [
    { key: 'seeking_crew', label: 'A Captain', icon: '⚓' },
    { key: 'seeking_berth', label: 'Crew', icon: '🧭' },
];

export const VIBE_OPTIONS = [
    '🌴 Cruisy',
    '⚡ Adventurous',
    '🏁 Competitive Racer',
    '🏠 Liveaboard Life',
    '🌅 Sundowner Vibes',
    '🧭 Explorer',
    '🎉 Social Butterfly',
    '🧘 Zen Sailor',
];

export const LANGUAGE_OPTIONS = [
    '🇬🇧 English',
    '🇫🇷 French',
    '🇪🇸 Spanish',
    '🇮🇹 Italian',
    '🇩🇪 German',
    '🇵🇹 Portuguese',
    '🇬🇷 Greek',
    '🇭🇷 Croatian',
];

export const SMOKING_OPTIONS = ['Non-Smoker', 'Social Smoker', 'Smoker'];
export const DRINKING_OPTIONS = ['Non-Drinker', 'Social Drinker', 'Regular'];
export const PET_OPTIONS = ['No Pets', '🐕 Dog Aboard', '🐈 Cat Aboard', '🐕🐈 Both'];

export const SUPER_LIKE_DAILY_LIMIT = 1;

export const INTEREST_OPTIONS = [
    '⛵ Sailing',
    '🌍 Exploring New Places',
    '🐟 Fishing',
    '🤿 Diving',
    '🏝️ Island Hopping',
    '🏄 Surfing',
    '🤿 Snorkelling',
    '🎯 Racing',
    '🪸 Reef Exploring',
    '🏊 Swimming',
    '🔧 Boat Work',
    '🧭 Trekking',
    '🍽️ Fine Dining',
    '☕ Coffee',
    '🍳 Cooking',
    '🍷 Wine Time',
    '🍹 Cocktails',
    '🍺 Craft Beer',
    '🌮 Street Food',
    '🎸 Live Music',
    '🎵 Music',
    '🎬 Movies / TV',
    '💃 Dancing',
    '📺 Binge Watching',
    '📸 Photography',
    '🎨 Art',
    '🎪 Festivals',
    '📖 Reading',
    '🎮 Gaming',
    '🌅 Sunsets',
    '🥾 Hiking',
    '🚶 Walking',
    '🏕️ Camping',
    '🏔️ Adventure',
    '🗺️ Travel',
    '🧗 Rock Climbing',
    '🪂 Skydiving',
    '🏍️ Motorbikes',
    '🚴 Cycling',
    '🚗 Weekend Getaways',
    '🧘 Yoga',
    '🏋️ Gym',
    '🌿 Nature',
    '🧘 Meditation',
    '💻 Coding',
    '🤖 AI',
    '🐕 Dogs',
    '🐈 Cats',
];

export const SEEKING_OPTIONS = ['Crew Mate', 'Partner', 'Adventure Buddy', 'Someone to Sail With', 'Open to Anything'];

// --- SEARCH FILTERS ---

export interface CrewSearchFilters {
    listing_type?: ListingType;
    skills?: string[];
    experience?: string;
    region?: string;
    gender?: string;
    age_ranges?: string[];
    location_country?: string;
    location_state?: string;
    location_city?: string;
}

// ═══════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════

class LonelyHeartsServiceClass {
    private async getAuthenticatedOwner(scope: AuthIdentityScope): Promise<string | null> {
        if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope)) return null;
        try {
            const {
                data: { user },
                error,
            } = await supabase.auth.getUser();
            if (error || !isAuthIdentityScopeCurrent(scope) || user?.id !== scope.userId) return null;
            return scope.userId;
        } catch (error) {
            if (isAuthIdentityScopeCurrent(scope)) log.warn('Authenticated-user check failed:', error);
            return null;
        }
    }

    private cloneUpdates<T extends object>(updates: T): T {
        return Object.fromEntries(
            Object.entries(updates).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]),
        ) as T;
    }

    private normalizeTargetId(targetId: string): string | null {
        if (typeof targetId !== 'string') return null;
        const normalized = targetId.trim();
        return normalized && normalized.length <= 128 ? normalized : null;
    }

    async init(): Promise<void> {
        if (!supabase) return;
        const scope = getAuthIdentityScope();
        const ownerId = await this.getAuthenticatedOwner(scope);
        if (ownerId && isAuthIdentityScopeCurrent(scope)) log.info('Auth verified:', ownerId.slice(0, 8));
    }

    // ─── CREW PROFILES (Find Crew) ─────────────────

    /** Get crew profile for a user */
    async getCrewProfile(userId?: string): Promise<CrewProfile | null> {
        if (!supabase) return null;
        const scope = getAuthIdentityScope();
        const hasExplicitTarget = userId !== undefined;
        const explicitTarget = hasExplicitTarget ? this.normalizeTargetId(userId) : null;
        if (hasExplicitTarget && !explicitTarget) return null;
        const ownerId = scope.userId ? await this.getAuthenticatedOwner(scope) : null;
        if (!isAuthIdentityScopeCurrent(scope)) return null;
        if (scope.userId && !ownerId) return null;
        const targetId = explicitTarget || ownerId;
        if (!targetId) return null;

        const { data } = await supabase.from(CREW_PROFILES_TABLE).select('*').eq('user_id', targetId).single();

        if (!isAuthIdentityScopeCurrent(scope) || data?.user_id !== targetId) return null;
        if (data) return this.normalizeCrewProfile(data);
        return null;
    }

    private normalizeCrewProfile(data: SupabaseRow): CrewProfile {
        return {
            user_id: data.user_id,
            listing_type: data.listing_type || null,
            first_name: data.first_name || null,
            gender: data.gender || null,
            age_range: data.age_range || null,
            has_partner: data.has_partner || false,
            partner_details: data.partner_details || null,
            skills: [...(data.skills || [])],
            sailing_experience: data.sailing_experience || null,
            sailing_region: data.sailing_region || null,
            available_from: data.available_from || null,
            available_to: data.available_to || null,
            bio: data.bio || null,
            vibe: [...(data.vibe || [])],
            languages: [...(data.languages || [])],
            smoking: data.smoking || null,
            drinking: data.drinking || null,
            pets: data.pets || null,
            interests: [...(data.interests || [])],
            last_active: data.last_active || null,
            is_verified: data.is_verified || false,
            location_city: data.location_city || null,
            location_state: data.location_state || null,
            location_country: data.location_country || null,
            photo_url: data.photo_url || null,
            photos: [...(data.photos || [])],
            created_at: data.created_at,
            updated_at: data.updated_at,
        };
    }

    /** Update crew profile (upsert) */
    async updateCrewProfile(
        updates: Partial<Omit<CrewProfile, 'user_id' | 'created_at' | 'updated_at'>>,
    ): Promise<boolean> {
        const scope = getAuthIdentityScope();
        const updatesSnapshot = this.cloneUpdates(updates);
        const ownerId = await this.getAuthenticatedOwner(scope);
        if (!ownerId || !isAuthIdentityScopeCurrent(scope)) return false;
        return this.updateCrewProfileForScope(scope, ownerId, updatesSnapshot);
    }

    private async updateCrewProfileForScope(
        scope: AuthIdentityScope,
        ownerId: string,
        updates: Partial<Omit<CrewProfile, 'user_id' | 'created_at' | 'updated_at'>>,
    ): Promise<boolean> {
        if (!supabase || !isAuthIdentityScopeCurrent(scope)) return false;
        const { error } = await supabase.from(CREW_PROFILES_TABLE).upsert(
            {
                ...updates,
                user_id: ownerId,
                updated_at: new Date().toISOString(),
            },
            { onConflict: 'user_id' },
        );

        return !error && isAuthIdentityScopeCurrent(scope);
    }

    /** Upload a crew photo (single) */
    async uploadCrewPhoto(file: File): Promise<{ success: boolean; url?: string; error?: string }> {
        if (!supabase) return { success: false, error: 'Not authenticated' };
        const scope = getAuthIdentityScope();
        const ownerId = await this.getAuthenticatedOwner(scope);
        if (!ownerId || !isAuthIdentityScopeCurrent(scope)) {
            return { success: false, error: 'Not authenticated' };
        }
        const fileSnapshot = file;

        try {
            const { compressImage, moderatePhoto } = await import('./ProfilePhotoService');
            if (!isAuthIdentityScopeCurrent(scope)) return { success: false, error: 'Account changed' };
            const blob = await compressImage(fileSnapshot);
            if (!isAuthIdentityScopeCurrent(scope)) return { success: false, error: 'Account changed' };

            const modResult = await moderatePhoto(blob);
            if (!isAuthIdentityScopeCurrent(scope)) return { success: false, error: 'Account changed' };
            if (modResult.verdict !== 'approved') {
                return { success: false, error: modResult.reason };
            }

            const path = `crew/${ownerId}/${Date.now()}.jpg`;
            const { error: uploadError } = await supabase.storage
                .from('chat-avatars')
                .upload(path, blob, { contentType: 'image/jpeg', upsert: true });
            if (!isAuthIdentityScopeCurrent(scope)) return { success: false, error: 'Account changed' };
            if (uploadError) return { success: false, error: uploadError.message };

            const { data: urlData } = supabase.storage.from('chat-avatars').getPublicUrl(path);
            if (!isAuthIdentityScopeCurrent(scope)) return { success: false, error: 'Account changed' };

            const url = urlData.publicUrl;
            const updated = await this.updateCrewProfileForScope(scope, ownerId, { photo_url: url });
            if (!updated || !isAuthIdentityScopeCurrent(scope)) {
                return { success: false, error: 'Account changed' };
            }
            return { success: true, url };
        } catch (err: unknown) {
            if (!isAuthIdentityScopeCurrent(scope)) return { success: false, error: 'Account changed' };
            return { success: false, error: err instanceof Error ? err.message : 'Upload failed' };
        }
    }

    /** Remove crew photo */
    async removeCrewPhoto(): Promise<boolean> {
        const scope = getAuthIdentityScope();
        const ownerId = await this.getAuthenticatedOwner(scope);
        if (!ownerId || !isAuthIdentityScopeCurrent(scope)) return false;
        return this.updateCrewProfileForScope(scope, ownerId, { photo_url: null });
    }

    /** Delete entire crew profile (remove listing from board) */
    async deleteCrewProfile(): Promise<boolean> {
        if (!supabase) return false;
        const scope = getAuthIdentityScope();
        const ownerId = await this.getAuthenticatedOwner(scope);
        if (!ownerId || !isAuthIdentityScopeCurrent(scope)) return false;

        const { error } = await supabase.from(CREW_PROFILES_TABLE).delete().eq('user_id', ownerId);

        return !error && isAuthIdentityScopeCurrent(scope);
    }

    // ─── DATING PROFILES (Lonely Hearts) ────────────

    /** Get dating profile for a user */
    async getDatingProfile(userId?: string): Promise<DatingProfile | null> {
        if (!supabase) return null;
        const scope = getAuthIdentityScope();
        const hasExplicitTarget = userId !== undefined;
        const explicitTarget = hasExplicitTarget ? this.normalizeTargetId(userId) : null;
        if (hasExplicitTarget && !explicitTarget) return null;
        const ownerId = scope.userId ? await this.getAuthenticatedOwner(scope) : null;
        if (!isAuthIdentityScopeCurrent(scope)) return null;
        if (scope.userId && !ownerId) return null;
        const targetId = explicitTarget || ownerId;
        if (!targetId) return null;
        return this.getDatingProfileForScope(scope, targetId);
    }

    private async getDatingProfileForScope(scope: AuthIdentityScope, targetId: string): Promise<DatingProfile | null> {
        if (!supabase || !isAuthIdentityScopeCurrent(scope)) return null;
        const { data } = await supabase.from(DATING_PROFILES_TABLE).select('*').eq('user_id', targetId).single();

        if (!isAuthIdentityScopeCurrent(scope) || data?.user_id !== targetId) return null;
        if (data) return this.normalizeDatingProfile(data);
        return null;
    }

    private normalizeDatingProfile(data: SupabaseRow): DatingProfile {
        return {
            user_id: data.user_id,
            first_name: data.first_name || data.dating_first_name || null,
            gender: data.gender || null,
            age_range: data.age_range || null,
            bio: data.bio || data.bio_dating || null,
            interests: [...(data.interests || [])],
            seeking: data.seeking || null,
            location_text: data.location_text || null,
            sailing_experience: data.sailing_experience || null,
            sailing_region: data.sailing_region || null,
            photos: [...(data.photos || data.dating_photos || [])],
            created_at: data.created_at,
            updated_at: data.updated_at,
        };
    }

    /** Update dating profile (upsert) */
    async updateDatingProfile(
        updates: Partial<Omit<DatingProfile, 'user_id' | 'created_at' | 'updated_at'>>,
    ): Promise<boolean> {
        const scope = getAuthIdentityScope();
        const updatesSnapshot = this.cloneUpdates(updates);
        const ownerId = await this.getAuthenticatedOwner(scope);
        if (!ownerId || !isAuthIdentityScopeCurrent(scope)) return false;
        return this.updateDatingProfileForScope(scope, ownerId, updatesSnapshot);
    }

    private async updateDatingProfileForScope(
        scope: AuthIdentityScope,
        ownerId: string,
        updates: Partial<Omit<DatingProfile, 'user_id' | 'created_at' | 'updated_at'>>,
    ): Promise<boolean> {
        if (!supabase || !isAuthIdentityScopeCurrent(scope)) return false;
        const { error } = await supabase.from(DATING_PROFILES_TABLE).upsert(
            {
                ...updates,
                user_id: ownerId,
                updated_at: new Date().toISOString(),
            },
            { onConflict: 'user_id' },
        );

        return !error && isAuthIdentityScopeCurrent(scope);
    }

    /** Upload a dating photo at a given position (0-5) */
    async uploadDatingPhoto(
        file: File,
        position: number = 0,
    ): Promise<{ success: boolean; url?: string; error?: string }> {
        if (!supabase) return { success: false, error: 'Not authenticated' };
        const scope = getAuthIdentityScope();
        const ownerId = await this.getAuthenticatedOwner(scope);
        if (!ownerId || !isAuthIdentityScopeCurrent(scope)) {
            return { success: false, error: 'Not authenticated' };
        }
        const photoPosition = Math.trunc(position);
        if (photoPosition !== position || photoPosition < 0 || photoPosition > 5) {
            return { success: false, error: 'Invalid photo position (0-5)' };
        }
        const fileSnapshot = file;

        try {
            const { compressImage, moderatePhoto } = await import('./ProfilePhotoService');
            if (!isAuthIdentityScopeCurrent(scope)) return { success: false, error: 'Account changed' };
            const blob = await compressImage(fileSnapshot);
            if (!isAuthIdentityScopeCurrent(scope)) return { success: false, error: 'Account changed' };

            const modResult = await moderatePhoto(blob);
            if (!isAuthIdentityScopeCurrent(scope)) return { success: false, error: 'Account changed' };
            if (modResult.verdict !== 'approved') {
                return { success: false, error: modResult.reason };
            }

            const path = `dating/${ownerId}/${photoPosition}_${Date.now()}.jpg`;
            const { error: uploadError } = await supabase.storage
                .from('chat-avatars')
                .upload(path, blob, { contentType: 'image/jpeg', upsert: true });
            if (!isAuthIdentityScopeCurrent(scope)) return { success: false, error: 'Account changed' };
            if (uploadError) return { success: false, error: uploadError.message };

            const { data: urlData } = supabase.storage.from('chat-avatars').getPublicUrl(path);
            if (!isAuthIdentityScopeCurrent(scope)) return { success: false, error: 'Account changed' };
            const url = urlData.publicUrl;

            // Update photos array in dating profile
            const profile = await this.getDatingProfileForScope(scope, ownerId);
            if (!profile || !isAuthIdentityScopeCurrent(scope)) {
                return { success: false, error: 'Profile unavailable' };
            }
            const photos = [...profile.photos];
            while (photos.length <= photoPosition) photos.push('');
            photos[photoPosition] = url;

            const updated = await this.updateDatingProfileForScope(scope, ownerId, { photos });
            if (!updated || !isAuthIdentityScopeCurrent(scope)) {
                return { success: false, error: 'Account changed' };
            }
            return { success: true, url };
        } catch (err: unknown) {
            if (!isAuthIdentityScopeCurrent(scope)) return { success: false, error: 'Account changed' };
            return { success: false, error: err instanceof Error ? err.message : 'Upload failed' };
        }
    }

    /** Remove a dating photo at given position */
    async removeDatingPhoto(position: number): Promise<boolean> {
        if (!supabase) return false;
        const scope = getAuthIdentityScope();
        const ownerId = await this.getAuthenticatedOwner(scope);
        if (!ownerId || !isAuthIdentityScopeCurrent(scope)) return false;
        const photoPosition = Math.trunc(position);
        if (photoPosition !== position || photoPosition < 0) return false;
        const profile = await this.getDatingProfileForScope(scope, ownerId);
        if (!profile || !isAuthIdentityScopeCurrent(scope)) return false;

        const photos = [...(profile.photos || [])];
        if (photoPosition < photos.length) {
            photos.splice(photoPosition, 1);
            return this.updateDatingProfileForScope(scope, ownerId, { photos });
        }
        return false;
    }

    // ─── BROWSE CREW LISTINGS ────────────────────────

    /**
     * Get crew listings (Find Crew) with optional filters.
     * Joins chat_profiles with crew profiles.
     */
    async getCrewListings(filters: CrewSearchFilters = {}, limit = 30): Promise<CrewCard[]> {
        if (!supabase) return [];
        const scope = getAuthIdentityScope();
        const filterSnapshot: CrewSearchFilters = {
            ...filters,
            skills: filters.skills ? [...filters.skills] : undefined,
            age_ranges: filters.age_ranges ? [...filters.age_ranges] : undefined,
        };
        const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.trunc(limit))) : 30;
        const ownerId = await this.getAuthenticatedOwner(scope);
        if (!ownerId || !isAuthIdentityScopeCurrent(scope)) return [];
        const blockedIds = new Set(await this.getBlockedUserIdsForScope(scope, ownerId));
        if (!isAuthIdentityScopeCurrent(scope)) return [];

        // 1. Get opted-in profiles (looking_for_love = true)
        const { data: rawChatProfiles } = await supabase
            .from(CHAT_PROFILES_TABLE)
            .select('user_id, display_name, avatar_url, vessel_name, home_port')
            .eq('looking_for_love', true)
            .neq('user_id', ownerId)
            .limit(100);

        if (!isAuthIdentityScopeCurrent(scope)) return [];
        const chatProfiles = (rawChatProfiles || []).filter(
            (profile: SupabaseRow) =>
                typeof profile.user_id === 'string' && profile.user_id !== ownerId && !blockedIds.has(profile.user_id),
        );
        if (!chatProfiles || chatProfiles.length === 0) return [];

        // 2. Fetch crew profiles for these users
        const userIds = chatProfiles.map((p: Record<string, string>) => p.user_id);
        let query = supabase.from(CREW_PROFILES_TABLE).select('*').in('user_id', userIds);

        if (filterSnapshot.listing_type) {
            query = query.eq('listing_type', filterSnapshot.listing_type);
        }

        const { data: crewProfiles } = await query;
        if (!isAuthIdentityScopeCurrent(scope)) return [];

        const crewMap = new Map<string, SupabaseRow>();
        const requestedIds = new Set(userIds);
        if (crewProfiles) {
            for (const cp of crewProfiles) {
                if (requestedIds.has(cp.user_id) && cp.user_id !== ownerId && !blockedIds.has(cp.user_id)) {
                    crewMap.set(cp.user_id, cp);
                }
            }
        }

        // 3. Build cards with filters
        const chatMap = new Map<string, SupabaseRow>();
        for (const cp of chatProfiles) {
            chatMap.set(cp.user_id, cp);
        }

        const cards: CrewCard[] = [];
        for (const [userId, crew] of crewMap) {
            const chat = chatMap.get(userId);
            if (!chat) continue;

            const card = this.buildCrewCard(chat, crew);

            // Client-side filters
            if (filterSnapshot.skills && filterSnapshot.skills.length > 0) {
                const hasMatch = filterSnapshot.skills.some((s) => (card.skills || []).includes(s));
                if (!hasMatch) continue;
            }
            if (filterSnapshot.experience && card.sailing_experience !== filterSnapshot.experience) continue;
            if (
                filterSnapshot.region &&
                card.sailing_region &&
                !card.sailing_region.toLowerCase().includes(filterSnapshot.region.toLowerCase())
            )
                continue;
            if (filterSnapshot.gender && card.gender !== filterSnapshot.gender) continue;
            if (
                filterSnapshot.age_ranges &&
                filterSnapshot.age_ranges.length > 0 &&
                !filterSnapshot.age_ranges.includes(card.age_range || '')
            )
                continue;
            if (
                filterSnapshot.location_country &&
                (!card.location_country ||
                    !card.location_country.toLowerCase().includes(filterSnapshot.location_country.toLowerCase()))
            )
                continue;
            if (
                filterSnapshot.location_state &&
                (!card.location_state ||
                    !card.location_state.toLowerCase().includes(filterSnapshot.location_state.toLowerCase()))
            )
                continue;
            if (
                filterSnapshot.location_city &&
                (!card.location_city ||
                    !card.location_city.toLowerCase().includes(filterSnapshot.location_city.toLowerCase()))
            )
                continue;

            cards.push(card);
        }

        // Include chat profiles without crew profiles (legacy)
        if (!filterSnapshot.listing_type && !filterSnapshot.skills?.length && !filterSnapshot.experience) {
            for (const cp of chatProfiles) {
                if (!crewMap.has(cp.user_id)) {
                    cards.push(this.buildCrewCard(cp, null));
                }
            }
        }

        // Include crew-only profiles (e.g. seed profiles without chat_profiles)
        const chatUserIds = new Set(chatProfiles.map((p: Record<string, string>) => p.user_id));
        let crewOnlyQuery = supabase.from(CREW_PROFILES_TABLE).select('*').neq('user_id', ownerId).limit(100);

        if (filterSnapshot.listing_type) {
            crewOnlyQuery = crewOnlyQuery.eq('listing_type', filterSnapshot.listing_type);
        }

        const { data: crewOnlyProfiles } = await crewOnlyQuery;
        if (!isAuthIdentityScopeCurrent(scope)) return [];
        if (crewOnlyProfiles) {
            for (const cp of crewOnlyProfiles) {
                if (
                    typeof cp.user_id !== 'string' ||
                    cp.user_id === ownerId ||
                    blockedIds.has(cp.user_id) ||
                    chatUserIds.has(cp.user_id)
                )
                    continue;
                const card = this.buildCrewCard(null, cp);
                if (filterSnapshot.skills && filterSnapshot.skills.length > 0) {
                    if (!filterSnapshot.skills.some((s) => (card.skills || []).includes(s))) continue;
                }
                if (filterSnapshot.experience && card.sailing_experience !== filterSnapshot.experience) continue;
                if (filterSnapshot.gender && card.gender !== filterSnapshot.gender) continue;
                if (
                    filterSnapshot.age_ranges &&
                    filterSnapshot.age_ranges.length > 0 &&
                    !filterSnapshot.age_ranges.includes(card.age_range || '')
                )
                    continue;
                cards.push(card);
            }
        }

        return isAuthIdentityScopeCurrent(scope) ? cards.slice(0, safeLimit) : [];
    }

    /** Legacy browse method */
    async getProfilesToBrowse(limit = 20): Promise<CrewCard[]> {
        return this.getCrewListings({}, limit);
    }

    private buildCrewCard(chatProfile: SupabaseRow | null, crewProfile: SupabaseRow | null): CrewCard {
        const cp = crewProfile || {};
        const chat = chatProfile || {};
        return {
            user_id: chat.user_id || cp.user_id,
            display_name: chat.display_name || cp.first_name || 'Anonymous Sailor',
            avatar_url: chat.avatar_url || cp.photo_url || null,
            vessel_name: chat.vessel_name || null,
            home_port:
                chat.home_port || (cp.location_city ? `${cp.location_city}, ${cp.location_country || ''}` : null),
            listing_type: cp.listing_type || null,
            first_name: cp.first_name || null,
            photo_url: cp.photo_url || null,
            gender: cp.gender || null,
            age_range: cp.age_range || null,
            has_partner: cp.has_partner || false,
            partner_details: cp.partner_details || null,
            skills: [...(cp.skills || [])],
            sailing_experience: cp.sailing_experience || null,
            sailing_region: cp.sailing_region || null,
            available_from: cp.available_from || null,
            available_to: cp.available_to || null,
            bio: cp.bio || null,
            vibe: [...(cp.vibe || [])],
            languages: [...(cp.languages || [])],
            smoking: cp.smoking || null,
            drinking: cp.drinking || null,
            pets: cp.pets || null,
            interests: [...(cp.interests || [])],
            last_active: cp.last_active || null,
            is_verified: cp.is_verified || false,
            location_city: cp.location_city || null,
            location_state: cp.location_state || null,
            location_country: cp.location_country || null,
            photos: [...(cp.photos || cp.dating_photos || [])],
        };
    }

    // ─── BROWSE DATING PROFILES ──────────────────────

    /** Get dating profiles to swipe on (Lonely Hearts) */
    async getDatingProfilesToBrowse(limit = 20): Promise<DatingCard[]> {
        if (!supabase) return [];
        const scope = getAuthIdentityScope();
        const ownerId = await this.getAuthenticatedOwner(scope);
        if (!ownerId || !isAuthIdentityScopeCurrent(scope)) return [];
        const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.trunc(limit))) : 20;
        const blockedIds = new Set(await this.getBlockedUserIdsForScope(scope, ownerId));
        if (!isAuthIdentityScopeCurrent(scope)) return [];

        const { data: rawChatProfiles } = await supabase
            .from(CHAT_PROFILES_TABLE)
            .select('user_id, display_name, avatar_url, vessel_name, home_port')
            .eq('looking_for_love', true)
            .neq('user_id', ownerId)
            .limit(100);

        if (!isAuthIdentityScopeCurrent(scope)) return [];
        const chatProfiles = (rawChatProfiles || []).filter(
            (profile: SupabaseRow) =>
                typeof profile.user_id === 'string' && profile.user_id !== ownerId && !blockedIds.has(profile.user_id),
        );
        if (chatProfiles.length === 0) return [];

        const userIds = chatProfiles.map((p: Record<string, string>) => p.user_id);
        const { data: datingProfiles } = await supabase.from(DATING_PROFILES_TABLE).select('*').in('user_id', userIds);
        if (!isAuthIdentityScopeCurrent(scope)) return [];

        const datingMap = new Map<string, SupabaseRow>();
        const requestedIds = new Set(userIds);
        if (datingProfiles) {
            for (const dp of datingProfiles) {
                if (requestedIds.has(dp.user_id) && dp.user_id !== ownerId && !blockedIds.has(dp.user_id)) {
                    datingMap.set(dp.user_id, dp);
                }
            }
        }

        const cards: DatingCard[] = [];
        for (const cp of chatProfiles) {
            const dp = datingMap.get(cp.user_id) ?? null;
            cards.push(this.buildDatingCard(cp, dp));
        }

        return isAuthIdentityScopeCurrent(scope) ? cards.slice(0, safeLimit) : [];
    }

    private buildDatingCard(chatProfile: SupabaseRow, datingProfile: SupabaseRow | null): DatingCard {
        const dp = datingProfile || {};
        return {
            user_id: chatProfile.user_id,
            display_name: chatProfile.display_name || 'Anonymous Sailor',
            avatar_url: chatProfile.avatar_url,
            vessel_name: chatProfile.vessel_name,
            home_port: chatProfile.home_port,
            first_name: dp.first_name || dp.dating_first_name || null,
            photos: [...(dp.photos || dp.dating_photos || [])],
            gender: dp.gender || null,
            age_range: dp.age_range || null,
            bio: dp.bio || dp.bio_dating || null,
            interests: [...(dp.interests || [])],
            seeking: dp.seeking || null,
            location_text: dp.location_text || null,
            sailing_experience: dp.sailing_experience || null,
            sailing_region: dp.sailing_region || null,
        };
    }

    // ─── LIKES & MATCHES ────────────────────────────

    /** Record a like or pass */
    async recordLike(targetId: string, isLike: boolean): Promise<{ matched: boolean }> {
        const scope = getAuthIdentityScope();
        const ownerId = await this.getAuthenticatedOwner(scope);
        const target = this.normalizeTargetId(targetId);
        if (!ownerId || !target || target === ownerId || !isAuthIdentityScopeCurrent(scope)) {
            return { matched: false };
        }
        return this.recordLikeForScope(scope, ownerId, target, Boolean(isLike));
    }

    private async recordLikeForScope(
        scope: AuthIdentityScope,
        ownerId: string,
        targetId: string,
        isLike: boolean,
    ): Promise<{ matched: boolean }> {
        if (!supabase || !isAuthIdentityScopeCurrent(scope)) return { matched: false };
        const { error } = await supabase.from(LIKES_TABLE).upsert(
            {
                liker_id: ownerId,
                liked_id: targetId,
                is_like: isLike,
            },
            { onConflict: 'liker_id,liked_id' },
        );

        if (error || !isAuthIdentityScopeCurrent(scope)) return { matched: false };

        if (isLike) {
            const matched = await this.checkMutualMatchForScope(scope, ownerId, targetId);
            return { matched: isAuthIdentityScopeCurrent(scope) && matched };
        }
        return { matched: false };
    }

    /** Check if both users liked each other */
    async checkMutualMatch(targetId: string): Promise<boolean> {
        const scope = getAuthIdentityScope();
        const ownerId = await this.getAuthenticatedOwner(scope);
        const target = this.normalizeTargetId(targetId);
        if (!ownerId || !target || target === ownerId || !isAuthIdentityScopeCurrent(scope)) return false;
        return this.checkMutualMatchForScope(scope, ownerId, target);
    }

    private async checkMutualMatchForScope(
        scope: AuthIdentityScope,
        ownerId: string,
        targetId: string,
    ): Promise<boolean> {
        if (!supabase || !isAuthIdentityScopeCurrent(scope)) return false;
        const { data } = await supabase
            .from(LIKES_TABLE)
            .select('id')
            .eq('liker_id', targetId)
            .eq('liked_id', ownerId)
            .eq('is_like', true)
            .single();

        return isAuthIdentityScopeCurrent(scope) && !!data;
    }

    /** Get all mutual matches */
    async getMatches(): Promise<SailorMatch[]> {
        if (!supabase) return [];
        const scope = getAuthIdentityScope();
        const ownerId = await this.getAuthenticatedOwner(scope);
        if (!ownerId || !isAuthIdentityScopeCurrent(scope)) return [];
        const blockedIds = new Set(await this.getBlockedUserIdsForScope(scope, ownerId));
        if (!isAuthIdentityScopeCurrent(scope)) return [];

        const { data: myLikes } = await supabase
            .from(LIKES_TABLE)
            .select('liked_id, created_at')
            .eq('liker_id', ownerId)
            .eq('is_like', true);

        if (!isAuthIdentityScopeCurrent(scope)) return [];
        if (!myLikes || myLikes.length === 0) return [];

        const likedIds = [
            ...new Set(
                myLikes
                    .map((like: { liked_id: string }) => like.liked_id)
                    .filter(
                        (likedId: unknown): likedId is string =>
                            typeof likedId === 'string' && likedId !== ownerId && !blockedIds.has(likedId),
                    ),
            ),
        ];
        if (likedIds.length === 0) return [];
        const { data: theirLikes } = await supabase
            .from(LIKES_TABLE)
            .select('liker_id, created_at')
            .in('liker_id', likedIds)
            .eq('liked_id', ownerId)
            .eq('is_like', true);

        if (!isAuthIdentityScopeCurrent(scope)) return [];
        if (!theirLikes || theirLikes.length === 0) return [];

        const likedIdSet = new Set(likedIds);
        const mutualIds = new Set<string>();
        const matchDates = new Map<string, string>();
        for (const tl of theirLikes) {
            if (
                typeof tl.liker_id === 'string' &&
                likedIdSet.has(tl.liker_id) &&
                tl.liker_id !== ownerId &&
                !blockedIds.has(tl.liker_id)
            ) {
                mutualIds.add(tl.liker_id);
                matchDates.set(tl.liker_id, tl.created_at);
            }
        }
        if (mutualIds.size === 0) return [];

        const { data: profiles } = await supabase
            .from(CHAT_PROFILES_TABLE)
            .select('user_id, display_name, avatar_url, vessel_name, home_port')
            .in('user_id', Array.from(mutualIds));

        if (!isAuthIdentityScopeCurrent(scope)) return [];
        if (!profiles) return [];

        // Fetch dating profiles for first names + photos
        const { data: datingProfiles } = await supabase
            .from(DATING_PROFILES_TABLE)
            .select('user_id, first_name, dating_first_name, photos, dating_photos')
            .in('user_id', Array.from(mutualIds));
        if (!isAuthIdentityScopeCurrent(scope)) return [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const datingMap = new Map<string, any>();
        if (datingProfiles) {
            for (const dp of datingProfiles) datingMap.set(dp.user_id, dp);
        }

        // Also fetch crew profiles for interests (Round 2)
        const { data: crewProfiles } = await supabase
            .from(CREW_PROFILES_TABLE)
            .select('user_id, interests, vibe, languages, smoking, drinking, pets, sailing_experience')
            .in('user_id', Array.from(mutualIds));
        if (!isAuthIdentityScopeCurrent(scope)) return [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const crewMap = new Map<string, any>();
        if (crewProfiles) {
            for (const cp of crewProfiles) crewMap.set(cp.user_id, cp);
        }

        const matches = profiles
            .filter(
                (profile: Record<string, unknown>) =>
                    typeof profile.user_id === 'string' && mutualIds.has(profile.user_id),
            )
            .map((p: Record<string, unknown>) => {
                const uid = p.user_id as string;
                const dp = datingMap.get(uid);
                const cp = crewMap.get(uid);
                return {
                    user_id: uid,
                    display_name: (p.display_name as string) || 'Anonymous Sailor',
                    dating_first_name: dp?.first_name || dp?.dating_first_name || null,
                    dating_photos: [...(dp?.photos || dp?.dating_photos || [])],
                    avatar_url: p.avatar_url as string | null,
                    vessel_name: p.vessel_name as string | null,
                    home_port: p.home_port as string | null,
                    interests: [...(cp?.interests || [])],
                    vibe: [...(cp?.vibe || [])],
                    languages: [...(cp?.languages || [])],
                    smoking: cp?.smoking || null,
                    drinking: cp?.drinking || null,
                    pets: cp?.pets || null,
                    sailing_experience: cp?.sailing_experience || null,
                    matched_at: matchDates.get(uid) || '',
                } as SailorMatch;
            })
            .sort(
                (a: SailorMatch, b: SailorMatch) => new Date(b.matched_at).getTime() - new Date(a.matched_at).getTime(),
            );
        return isAuthIdentityScopeCurrent(scope) ? matches : [];
    }

    /** Count of unviewed matches (for badge) */
    async getMatchCount(): Promise<number> {
        const scope = getAuthIdentityScope();
        const matches = await this.getMatches();
        return isAuthIdentityScopeCurrent(scope) ? matches.length : 0;
    }

    // ─── BLOCK & REPORT ─────────────────────────────

    /** Block a user (hides them from your browse) */
    async blockUser(targetId: string): Promise<boolean> {
        if (!supabase) return false;
        const scope = getAuthIdentityScope();
        const ownerId = await this.getAuthenticatedOwner(scope);
        const target = this.normalizeTargetId(targetId);
        if (!ownerId || !target || target === ownerId || !isAuthIdentityScopeCurrent(scope)) return false;
        const { error } = await supabase
            .from(BLOCKS_TABLE)
            .upsert({ blocker_id: ownerId, blocked_id: target }, { onConflict: 'blocker_id,blocked_id' });
        return !error && isAuthIdentityScopeCurrent(scope);
    }

    /** Unblock a user */
    async unblockUser(targetId: string): Promise<boolean> {
        if (!supabase) return false;
        const scope = getAuthIdentityScope();
        const ownerId = await this.getAuthenticatedOwner(scope);
        const target = this.normalizeTargetId(targetId);
        if (!ownerId || !target || target === ownerId || !isAuthIdentityScopeCurrent(scope)) return false;
        const { error } = await supabase.from(BLOCKS_TABLE).delete().eq('blocker_id', ownerId).eq('blocked_id', target);
        return !error && isAuthIdentityScopeCurrent(scope);
    }

    /** Get IDs of users this person has blocked */
    async getBlockedUserIds(): Promise<string[]> {
        const scope = getAuthIdentityScope();
        const ownerId = await this.getAuthenticatedOwner(scope);
        if (!ownerId || !isAuthIdentityScopeCurrent(scope)) return [];
        return this.getBlockedUserIdsForScope(scope, ownerId);
    }

    private async getBlockedUserIdsForScope(scope: AuthIdentityScope, ownerId: string): Promise<string[]> {
        if (!supabase || !isAuthIdentityScopeCurrent(scope)) return [];
        const { data } = await supabase.from(BLOCKS_TABLE).select('blocked_id').eq('blocker_id', ownerId);
        if (!isAuthIdentityScopeCurrent(scope)) return [];
        return [
            ...new Set(
                (data || [])
                    .map((row: Record<string, unknown>) => row.blocked_id)
                    .filter((blockedId: unknown): blockedId is string => typeof blockedId === 'string'),
            ),
        ];
    }

    /** Report a user */
    async reportUser(targetId: string, reason: string): Promise<boolean> {
        if (!supabase) return false;
        const scope = getAuthIdentityScope();
        const ownerId = await this.getAuthenticatedOwner(scope);
        const target = this.normalizeTargetId(targetId);
        const reasonSnapshot = reason.trim().slice(0, 2000);
        if (!ownerId || !target || target === ownerId || !reasonSnapshot || !isAuthIdentityScopeCurrent(scope)) {
            return false;
        }
        const { error } = await supabase.from(REPORTS_TABLE).insert({
            reporter_id: ownerId,
            reported_id: target,
            reason: reasonSnapshot,
            created_at: new Date().toISOString(),
        });
        return !error && isAuthIdentityScopeCurrent(scope);
    }

    // ─── SUPER LIKE ─────────────────────────────────

    /** Record a super like with an optional message */
    async recordSuperLike(targetId: string, message: string): Promise<{ matched: boolean }> {
        if (!supabase) return { matched: false };
        const scope = getAuthIdentityScope();
        const ownerId = await this.getAuthenticatedOwner(scope);
        const target = this.normalizeTargetId(targetId);
        const messageSnapshot = message.trim().slice(0, 1000);
        if (!ownerId || !target || target === ownerId || !messageSnapshot || !isAuthIdentityScopeCurrent(scope)) {
            return { matched: false };
        }

        // Record the like first
        const result = await this.recordLikeForScope(scope, ownerId, target, true);
        if (!isAuthIdentityScopeCurrent(scope)) return { matched: false };

        // Store the super-like message
        const { error } = await supabase
            .from(LIKES_TABLE)
            .update({ super_like_message: messageSnapshot })
            .eq('liker_id', ownerId)
            .eq('liked_id', target);

        return !error && isAuthIdentityScopeCurrent(scope) ? result : { matched: false };
    }

    /** Check if user has used their daily super like */
    async hasSuperLikedToday(): Promise<boolean> {
        if (!supabase) return true;
        const scope = getAuthIdentityScope();
        const ownerId = await this.getAuthenticatedOwner(scope);
        if (!ownerId || !isAuthIdentityScopeCurrent(scope)) return true;
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const { data } = await supabase
            .from(LIKES_TABLE)
            .select('id')
            .eq('liker_id', ownerId)
            .not('super_like_message', 'is', null)
            .gte('created_at', today.toISOString());

        return isAuthIdentityScopeCurrent(scope) && (data?.length || 0) >= SUPER_LIKE_DAILY_LIMIT;
    }

    // ─── LAST ACTIVE ────────────────────────────────

    /** Update the current user's last_active timestamp */
    async updateLastActive(): Promise<void> {
        if (!supabase) return;
        const scope = getAuthIdentityScope();
        const ownerId = await this.getAuthenticatedOwner(scope);
        if (!ownerId || !isAuthIdentityScopeCurrent(scope)) return;
        await supabase
            .from(CREW_PROFILES_TABLE)
            .update({ last_active: new Date().toISOString() })
            .eq('user_id', ownerId);
        if (!isAuthIdentityScopeCurrent(scope)) return;
    }
}

// Singleton
export const LonelyHeartsService = new LonelyHeartsServiceClass();
