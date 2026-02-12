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

import { supabase } from './supabase';

// --- TABLES ---
const CREW_PROFILES_TABLE = 'sailor_crew_profiles';
const DATING_PROFILES_TABLE = 'sailor_dating_profiles';
const LIKES_TABLE = 'sailor_likes';
const CHAT_PROFILES_TABLE = 'chat_profiles';

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
    photo_url: string | null;
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
    matched_at: string;
}

// ═══════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════

export const SKILL_OPTIONS = [
    '🍳 Cooking', '🧹 Cleaning', '👁️ Watch Keeping', '🧭 Navigation',
    '⚙️ Diesel Engines', '⚡ Electrical', '🪡 Sail Repair', '🏥 First Aid',
    '⛵ Rigging', '🐟 Fishing', '🤿 Diving', '📻 Radio/Comms',
    '🧰 Maintenance', '🎣 Provisioning', '📐 Passage Planning',
];

export const GENDER_OPTIONS = ['Male', 'Female', 'Non-binary', 'Prefer not to say'];

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
    { key: 'seeking_crew', label: 'Want Crew', icon: '🚢' },
    { key: 'seeking_berth', label: 'I am Crew', icon: '🙋' },
];

export const INTEREST_OPTIONS = [
    '⛵ Sailing', '🐟 Fishing', '🤿 Diving', '🏄 Surfing',
    '🍳 Cooking', '🌅 Sunsets', '📖 Reading', '🎵 Music',
    '🏔️ Adventure', '📸 Photography', '🍺 Beers', '🧘 Yoga',
    '🏊 Swimming', '🌊 Surfing', '🗺️ Travel', '🔧 Boat Work',
    '🎯 Racing', '🐕 Dogs', '🐈 Cats', '🌿 Nature',
];

export const SEEKING_OPTIONS = [
    'Crew Mate', 'Partner', 'Adventure Buddy',
    'Someone to Sail With', 'Open to Anything',
];

// --- SEARCH FILTERS ---

export interface CrewSearchFilters {
    listing_type?: ListingType;
    skills?: string[];
    experience?: string;
    region?: string;
    gender?: string;
}

// ═══════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════

class LonelyHeartsServiceClass {
    private currentUserId: string | null = null;

    async init(): Promise<void> {
        if (!supabase) return;
        const { data: { user } } = await supabase.auth.getUser();
        this.currentUserId = user?.id || null;
    }

    // ─── CREW PROFILES (Find Crew) ─────────────────

    /** Get crew profile for a user */
    async getCrewProfile(userId?: string): Promise<CrewProfile | null> {
        if (!supabase) return null;
        const targetId = userId || this.currentUserId;
        if (!targetId) return null;

        const { data } = await supabase
            .from(CREW_PROFILES_TABLE)
            .select('*')
            .eq('user_id', targetId)
            .single();

        if (data) return this.normalizeCrewProfile(data);
        return null;
    }

    private normalizeCrewProfile(data: any): CrewProfile {
        return {
            user_id: data.user_id,
            listing_type: data.listing_type || null,
            first_name: data.first_name || null,
            gender: data.gender || null,
            age_range: data.age_range || null,
            has_partner: data.has_partner || false,
            partner_details: data.partner_details || null,
            skills: data.skills || [],
            sailing_experience: data.sailing_experience || null,
            sailing_region: data.sailing_region || null,
            available_from: data.available_from || null,
            available_to: data.available_to || null,
            bio: data.bio || null,
            photo_url: data.photo_url || null,
            created_at: data.created_at,
            updated_at: data.updated_at,
        };
    }

    /** Update crew profile (upsert) */
    async updateCrewProfile(updates: Partial<Omit<CrewProfile, 'user_id' | 'created_at' | 'updated_at'>>): Promise<boolean> {
        if (!supabase || !this.currentUserId) return false;

        const { error } = await supabase
            .from(CREW_PROFILES_TABLE)
            .upsert({
                user_id: this.currentUserId,
                ...updates,
                updated_at: new Date().toISOString(),
            }, { onConflict: 'user_id' });

        return !error;
    }

    /** Upload a crew photo (single) */
    async uploadCrewPhoto(file: File): Promise<{ success: boolean; url?: string; error?: string }> {
        if (!supabase || !this.currentUserId) return { success: false, error: 'Not authenticated' };

        try {
            const { compressImage, moderatePhoto } = await import('./ProfilePhotoService');
            const blob = await compressImage(file);

            const modResult = await moderatePhoto(blob);
            if (modResult.verdict === 'rejected') {
                return { success: false, error: modResult.reason };
            }

            const path = `crew/${this.currentUserId}/${Date.now()}.webp`;
            const { error: uploadError } = await supabase.storage
                .from('chat-avatars')
                .upload(path, blob, { contentType: 'image/webp', upsert: true });
            if (uploadError) return { success: false, error: uploadError.message };

            const { data: urlData } = supabase.storage
                .from('chat-avatars')
                .getPublicUrl(path);

            const url = urlData.publicUrl;
            await this.updateCrewProfile({ photo_url: url });
            return { success: true, url };
        } catch (err: any) {
            return { success: false, error: err.message || 'Upload failed' };
        }
    }

    /** Remove crew photo */
    async removeCrewPhoto(): Promise<boolean> {
        return this.updateCrewProfile({ photo_url: null });
    }

    // ─── DATING PROFILES (Lonely Hearts) ────────────

    /** Get dating profile for a user */
    async getDatingProfile(userId?: string): Promise<DatingProfile | null> {
        if (!supabase) return null;
        const targetId = userId || this.currentUserId;
        if (!targetId) return null;

        const { data } = await supabase
            .from(DATING_PROFILES_TABLE)
            .select('*')
            .eq('user_id', targetId)
            .single();

        if (data) return this.normalizeDatingProfile(data);
        return null;
    }

    private normalizeDatingProfile(data: any): DatingProfile {
        return {
            user_id: data.user_id,
            first_name: data.first_name || data.dating_first_name || null,
            gender: data.gender || null,
            age_range: data.age_range || null,
            bio: data.bio || data.bio_dating || null,
            interests: data.interests || [],
            seeking: data.seeking || null,
            location_text: data.location_text || null,
            sailing_experience: data.sailing_experience || null,
            sailing_region: data.sailing_region || null,
            photos: data.photos || data.dating_photos || [],
            created_at: data.created_at,
            updated_at: data.updated_at,
        };
    }

    /** Update dating profile (upsert) */
    async updateDatingProfile(updates: Partial<Omit<DatingProfile, 'user_id' | 'created_at' | 'updated_at'>>): Promise<boolean> {
        if (!supabase || !this.currentUserId) return false;

        const { error } = await supabase
            .from(DATING_PROFILES_TABLE)
            .upsert({
                user_id: this.currentUserId,
                ...updates,
                updated_at: new Date().toISOString(),
            }, { onConflict: 'user_id' });

        return !error;
    }

    /** Upload a dating photo at a given position (0-5) */
    async uploadDatingPhoto(file: File, position: number = 0): Promise<{ success: boolean; url?: string; error?: string }> {
        if (!supabase || !this.currentUserId) return { success: false, error: 'Not authenticated' };
        if (position < 0 || position > 5) return { success: false, error: 'Invalid photo position (0-5)' };

        try {
            const { compressImage, moderatePhoto } = await import('./ProfilePhotoService');
            const blob = await compressImage(file);

            const modResult = await moderatePhoto(blob);
            if (modResult.verdict === 'rejected') {
                return { success: false, error: modResult.reason };
            }

            const path = `dating/${this.currentUserId}/${position}_${Date.now()}.webp`;
            const { error: uploadError } = await supabase.storage
                .from('chat-avatars')
                .upload(path, blob, { contentType: 'image/webp', upsert: true });
            if (uploadError) return { success: false, error: uploadError.message };

            const { data: urlData } = supabase.storage
                .from('chat-avatars')
                .getPublicUrl(path);
            const url = urlData.publicUrl;

            // Update photos array in dating profile
            const profile = await this.getDatingProfile();
            const photos = profile?.photos || [];
            while (photos.length <= position) photos.push('');
            photos[position] = url;

            await this.updateDatingProfile({ photos });
            return { success: true, url };
        } catch (err: any) {
            return { success: false, error: err.message || 'Upload failed' };
        }
    }

    /** Remove a dating photo at given position */
    async removeDatingPhoto(position: number): Promise<boolean> {
        if (!supabase || !this.currentUserId) return false;
        const profile = await this.getDatingProfile();
        if (!profile) return false;

        const photos = [...(profile.photos || [])];
        if (position >= 0 && position < photos.length) {
            photos.splice(position, 1);
            return this.updateDatingProfile({ photos });
        }
        return false;
    }

    // ─── BROWSE CREW LISTINGS ────────────────────────

    /**
     * Get crew listings (Find Crew) with optional filters.
     * Joins chat_profiles with crew profiles.
     */
    async getCrewListings(filters: CrewSearchFilters = {}, limit = 30): Promise<CrewCard[]> {
        if (!supabase || !this.currentUserId) return [];

        // 1. Get opted-in profiles (looking_for_love = true)
        const { data: chatProfiles } = await supabase
            .from(CHAT_PROFILES_TABLE)
            .select('user_id, display_name, avatar_url, vessel_name, home_port')
            .eq('looking_for_love', true)
            .neq('user_id', this.currentUserId)
            .limit(100);

        if (!chatProfiles || chatProfiles.length === 0) return [];

        // 2. Fetch crew profiles for these users
        const userIds = chatProfiles.map((p: any) => p.user_id);
        let query = supabase
            .from(CREW_PROFILES_TABLE)
            .select('*')
            .in('user_id', userIds);

        if (filters.listing_type) {
            query = query.eq('listing_type', filters.listing_type);
        }

        const { data: crewProfiles } = await query;

        const crewMap = new Map<string, any>();
        if (crewProfiles) {
            for (const cp of crewProfiles) {
                crewMap.set(cp.user_id, cp);
            }
        }

        // 3. Build cards with filters
        const chatMap = new Map<string, any>();
        for (const cp of chatProfiles) {
            chatMap.set(cp.user_id, cp);
        }

        let cards: CrewCard[] = [];
        for (const [userId, crew] of crewMap) {
            const chat = chatMap.get(userId);
            if (!chat) continue;

            const card = this.buildCrewCard(chat, crew);

            // Client-side filters
            if (filters.skills && filters.skills.length > 0) {
                const hasMatch = filters.skills.some(s => (card.skills || []).includes(s));
                if (!hasMatch) continue;
            }
            if (filters.experience && card.sailing_experience !== filters.experience) continue;
            if (filters.region && card.sailing_region && !card.sailing_region.toLowerCase().includes(filters.region.toLowerCase())) continue;
            if (filters.gender && card.gender !== filters.gender) continue;

            cards.push(card);
        }

        // Include chat profiles without crew profiles (legacy)
        if (!filters.listing_type && !filters.skills?.length && !filters.experience) {
            for (const cp of chatProfiles) {
                if (!crewMap.has(cp.user_id)) {
                    cards.push(this.buildCrewCard(cp, null));
                }
            }
        }

        return cards.slice(0, limit);
    }

    /** Legacy browse method */
    async getProfilesToBrowse(limit = 20): Promise<CrewCard[]> {
        return this.getCrewListings({}, limit);
    }

    private buildCrewCard(chatProfile: any, crewProfile: any): CrewCard {
        const cp = crewProfile || {};
        return {
            user_id: chatProfile.user_id,
            display_name: chatProfile.display_name || 'Anonymous Sailor',
            avatar_url: chatProfile.avatar_url,
            vessel_name: chatProfile.vessel_name,
            home_port: chatProfile.home_port,
            listing_type: cp.listing_type || null,
            first_name: cp.first_name || null,
            photo_url: cp.photo_url || null,
            gender: cp.gender || null,
            age_range: cp.age_range || null,
            has_partner: cp.has_partner || false,
            partner_details: cp.partner_details || null,
            skills: cp.skills || [],
            sailing_experience: cp.sailing_experience || null,
            sailing_region: cp.sailing_region || null,
            available_from: cp.available_from || null,
            available_to: cp.available_to || null,
            bio: cp.bio || null,
        };
    }

    // ─── BROWSE DATING PROFILES ──────────────────────

    /** Get dating profiles to swipe on (Lonely Hearts) */
    async getDatingProfilesToBrowse(limit = 20): Promise<DatingCard[]> {
        if (!supabase || !this.currentUserId) return [];

        const { data: chatProfiles } = await supabase
            .from(CHAT_PROFILES_TABLE)
            .select('user_id, display_name, avatar_url, vessel_name, home_port')
            .eq('looking_for_love', true)
            .neq('user_id', this.currentUserId)
            .limit(100);

        if (!chatProfiles || chatProfiles.length === 0) return [];

        const userIds = chatProfiles.map((p: any) => p.user_id);
        const { data: datingProfiles } = await supabase
            .from(DATING_PROFILES_TABLE)
            .select('*')
            .in('user_id', userIds);

        const datingMap = new Map<string, any>();
        if (datingProfiles) {
            for (const dp of datingProfiles) {
                datingMap.set(dp.user_id, dp);
            }
        }

        let cards: DatingCard[] = [];
        for (const cp of chatProfiles) {
            const dp = datingMap.get(cp.user_id);
            cards.push(this.buildDatingCard(cp, dp));
        }

        return cards.slice(0, limit);
    }

    private buildDatingCard(chatProfile: any, datingProfile: any): DatingCard {
        const dp = datingProfile || {};
        return {
            user_id: chatProfile.user_id,
            display_name: chatProfile.display_name || 'Anonymous Sailor',
            avatar_url: chatProfile.avatar_url,
            vessel_name: chatProfile.vessel_name,
            home_port: chatProfile.home_port,
            first_name: dp.first_name || dp.dating_first_name || null,
            photos: dp.photos || dp.dating_photos || [],
            gender: dp.gender || null,
            age_range: dp.age_range || null,
            bio: dp.bio || dp.bio_dating || null,
            interests: dp.interests || [],
            seeking: dp.seeking || null,
            location_text: dp.location_text || null,
            sailing_experience: dp.sailing_experience || null,
            sailing_region: dp.sailing_region || null,
        };
    }

    // ─── LIKES & MATCHES ────────────────────────────

    /** Record a like or pass */
    async recordLike(targetId: string, isLike: boolean): Promise<{ matched: boolean }> {
        if (!supabase || !this.currentUserId) return { matched: false };

        const { error } = await supabase
            .from(LIKES_TABLE)
            .upsert({
                liker_id: this.currentUserId,
                liked_id: targetId,
                is_like: isLike,
            }, { onConflict: 'liker_id,liked_id' });

        if (error) return { matched: false };

        if (isLike) {
            return { matched: await this.checkMutualMatch(targetId) };
        }
        return { matched: false };
    }

    /** Check if both users liked each other */
    async checkMutualMatch(targetId: string): Promise<boolean> {
        if (!supabase || !this.currentUserId) return false;

        const { data } = await supabase
            .from(LIKES_TABLE)
            .select('id')
            .eq('liker_id', targetId)
            .eq('liked_id', this.currentUserId)
            .eq('is_like', true)
            .single();

        return !!data;
    }

    /** Get all mutual matches */
    async getMatches(): Promise<SailorMatch[]> {
        if (!supabase || !this.currentUserId) return [];

        const { data: myLikes } = await supabase
            .from(LIKES_TABLE)
            .select('liked_id, created_at')
            .eq('liker_id', this.currentUserId)
            .eq('is_like', true);

        if (!myLikes || myLikes.length === 0) return [];

        const likedIds = myLikes.map((l: { liked_id: string }) => l.liked_id);
        const { data: theirLikes } = await supabase
            .from(LIKES_TABLE)
            .select('liker_id, created_at')
            .in('liker_id', likedIds)
            .eq('liked_id', this.currentUserId)
            .eq('is_like', true);

        if (!theirLikes || theirLikes.length === 0) return [];

        const mutualIds = new Set(theirLikes.map((l: { liker_id: string }) => l.liker_id));
        const matchDates = new Map<string, string>();
        for (const tl of theirLikes) {
            matchDates.set(tl.liker_id, tl.created_at);
        }

        const { data: profiles } = await supabase
            .from(CHAT_PROFILES_TABLE)
            .select('user_id, display_name, avatar_url, vessel_name, home_port')
            .in('user_id', Array.from(mutualIds));

        if (!profiles) return [];

        // Fetch dating profiles for first names + photos
        const { data: datingProfiles } = await supabase
            .from(DATING_PROFILES_TABLE)
            .select('user_id, first_name, dating_first_name, photos, dating_photos')
            .in('user_id', Array.from(mutualIds));
        const datingMap = new Map<string, any>();
        if (datingProfiles) {
            for (const dp of datingProfiles) datingMap.set(dp.user_id, dp);
        }

        return profiles.map((p: any) => {
            const dp = datingMap.get(p.user_id);
            return {
                user_id: p.user_id,
                display_name: p.display_name || 'Anonymous Sailor',
                dating_first_name: dp?.first_name || dp?.dating_first_name || null,
                dating_photos: dp?.photos || dp?.dating_photos || [],
                avatar_url: p.avatar_url,
                vessel_name: p.vessel_name,
                home_port: p.home_port,
                matched_at: matchDates.get(p.user_id) || '',
            };
        }).sort((a: SailorMatch, b: SailorMatch) =>
            new Date(b.matched_at).getTime() - new Date(a.matched_at).getTime()
        );
    }

    /** Count of unviewed matches (for badge) */
    async getMatchCount(): Promise<number> {
        const matches = await this.getMatches();
        return matches.length;
    }
}

// Singleton
export const LonelyHeartsService = new LonelyHeartsServiceClass();
