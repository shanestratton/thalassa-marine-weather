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
const CREW_INTRO_REQUESTS_TABLE = 'crew_intro_requests';
const CREW_LIST_BLOCKS_TABLE = 'dm_blocks';

/** Raw Supabase row — typed loosely since we normalize immediately */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseRow = Record<string, any>;

// ═══════════════════════════════════════════════════
// TYPES — CREW (Find Crew)
// ═══════════════════════════════════════════════════

export type ListingType = 'seeking_crew' | 'seeking_berth';
export const CREW_LIST_INTENTS = ['find_crew', 'find_skipper'] as const;
export type CrewListIntent = (typeof CREW_LIST_INTENTS)[number];
export type CrewListVisibility = 'private' | 'visible';
export type CrewApprovalStatus = 'draft' | 'pending' | 'approved' | 'rejected' | 'suspended';
export type CrewVerificationStatus = 'unverified' | 'pending' | 'verified' | 'rejected';
export type CrewIntroRequestStatus = 'pending' | 'accepted' | 'declined' | 'withdrawn';
export type CrewIntroResponse = Extract<CrewIntroRequestStatus, 'accepted' | 'declined'>;

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
    /** Explicit beta opt-in. Existing Crew Finder rows remain private by default. */
    community_enabled: boolean;
    crew_intents: CrewListIntent[];
    crew_list_visibility: CrewListVisibility;
    approval_status: CrewApprovalStatus;
    verification_status: CrewVerificationStatus;
    review_requested_at: string | null;
    reviewed_at: string | null;
    reviewed_by: string | null;
    created_at: string;
    updated_at: string;
}

/** The ordinary profile editor can never set review or publishing state. */
export type CrewProfileUpdate = Partial<
    Omit<
        CrewProfile,
        | 'user_id'
        | 'created_at'
        | 'updated_at'
        | 'is_verified'
        | 'community_enabled'
        | 'crew_intents'
        | 'crew_list_visibility'
        | 'approval_status'
        | 'verification_status'
        | 'review_requested_at'
        | 'reviewed_at'
        | 'reviewed_by'
    >
>;

export interface CrewListState {
    community_enabled: boolean;
    crew_intents: CrewListIntent[];
    crew_list_visibility: CrewListVisibility;
    approval_status: CrewApprovalStatus;
    verification_status: CrewVerificationStatus;
    review_requested_at: string | null;
    reviewed_at: string | null;
}

export interface CrewListStateUpdate {
    community_enabled?: boolean;
    crew_intents?: CrewListIntent[];
    crew_list_visibility?: CrewListVisibility;
}

type CrewProfileOwnerUpdate = CrewProfileUpdate &
    Partial<Pick<CrewProfile, 'community_enabled' | 'crew_intents' | 'crew_list_visibility'>>;

export interface CrewIntroRequest {
    id: string;
    sender_id: string;
    recipient_id: string;
    message: string;
    status: CrewIntroRequestStatus;
    created_at: string;
    responded_at: string | null;
    withdrawn_at: string | null;
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
    crew_intents: CrewListIntent[];
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

    private normalizeCrewIntents(value: unknown): CrewListIntent[] | null {
        if (!Array.isArray(value)) return null;
        const intents: CrewListIntent[] = [];
        for (const intent of value) {
            if (typeof intent !== 'string' || !CREW_LIST_INTENTS.includes(intent as CrewListIntent)) return null;
            if (!intents.includes(intent as CrewListIntent)) intents.push(intent as CrewListIntent);
        }
        return intents;
    }

    private normalizeCrewApprovalStatus(value: unknown): CrewApprovalStatus {
        return ['draft', 'pending', 'approved', 'rejected', 'suspended'].includes(value as string)
            ? (value as CrewApprovalStatus)
            : 'draft';
    }

    private normalizeCrewVerificationStatus(value: unknown): CrewVerificationStatus {
        return ['unverified', 'pending', 'verified', 'rejected'].includes(value as string)
            ? (value as CrewVerificationStatus)
            : 'unverified';
    }

    private normalizeCrewIntroStatus(value: unknown): CrewIntroRequestStatus | null {
        return ['pending', 'accepted', 'declined', 'withdrawn'].includes(value as string)
            ? (value as CrewIntroRequestStatus)
            : null;
    }

    private crewListStateFromProfile(profile: CrewProfile): CrewListState {
        return {
            community_enabled: profile.community_enabled,
            crew_intents: [...profile.crew_intents],
            crew_list_visibility: profile.crew_list_visibility,
            approval_status: profile.approval_status,
            verification_status: profile.verification_status,
            review_requested_at: profile.review_requested_at,
            reviewed_at: profile.reviewed_at,
        };
    }

    private sanitizeCrewProfileUpdates(updates: CrewProfileUpdate): CrewProfileUpdate {
        const blockedKeys = new Set([
            'user_id',
            'created_at',
            'updated_at',
            'is_verified',
            'community_enabled',
            'crew_intents',
            'crew_list_visibility',
            'approval_status',
            'verification_status',
            'review_requested_at',
            'reviewed_at',
            'reviewed_by',
        ]);
        return Object.fromEntries(
            Object.entries(this.cloneUpdates(updates)).filter(([key]) => !blockedKeys.has(key)),
        ) as CrewProfileUpdate;
    }

    private normalizeCrewIntroMessage(message: unknown): string | null {
        if (message === undefined || message === null) return '';
        if (typeof message !== 'string') return null;
        const normalized = message.trim();
        const hasControlCharacter = ['\n', '\r', '\t', String.fromCharCode(0), String.fromCharCode(127)].some(
            (character) => normalized.includes(character),
        );
        if (normalized.length > 500 || hasControlCharacter) return null;

        const containsEmail = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(normalized);
        const containsUrl =
            /(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|edu|gov|io|co|app|dev|me|au|nz|uk|us|ca)\b/i.test(
                normalized,
            );
        const containsPhone = /(?:\+?\d[\d\s().-]*){7,}/.test(normalized);
        return containsEmail || containsUrl || containsPhone ? null : normalized;
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

        return this.getCrewProfileForScope(scope, targetId);
    }

    private async getCrewProfileForScope(scope: AuthIdentityScope, targetId: string): Promise<CrewProfile | null> {
        if (!supabase || !isAuthIdentityScopeCurrent(scope)) return null;

        const { data } = await supabase.from(CREW_PROFILES_TABLE).select('*').eq('user_id', targetId).single();

        if (!isAuthIdentityScopeCurrent(scope) || data?.user_id !== targetId) return null;
        if (data) return this.normalizeCrewProfile(data);
        return null;
    }

    private normalizeCrewProfile(data: SupabaseRow): CrewProfile {
        const crewIntents = this.normalizeCrewIntents(data.crew_intents) || [];
        const approvalStatus = this.normalizeCrewApprovalStatus(data.approval_status);
        const verificationStatus = this.normalizeCrewVerificationStatus(data.verification_status);
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
            // The legacy flag is retained for old UI data only. New Crew List
            // cards trust the server-controlled verification lifecycle.
            is_verified: verificationStatus === 'verified',
            location_city: data.location_city || null,
            location_state: data.location_state || null,
            location_country: data.location_country || null,
            photo_url: data.photo_url || null,
            photos: [...(data.photos || [])],
            community_enabled: data.community_enabled === true,
            crew_intents: crewIntents,
            crew_list_visibility: data.crew_list_visibility === 'visible' ? 'visible' : 'private',
            approval_status: approvalStatus,
            verification_status: verificationStatus,
            review_requested_at: data.review_requested_at || null,
            reviewed_at: data.reviewed_at || null,
            reviewed_by: data.reviewed_by || null,
            created_at: data.created_at,
            updated_at: data.updated_at,
        };
    }

    /** Update crew profile (upsert) */
    async updateCrewProfile(updates: CrewProfileUpdate): Promise<boolean> {
        const scope = getAuthIdentityScope();
        const updatesSnapshot = this.sanitizeCrewProfileUpdates(updates);
        const ownerId = await this.getAuthenticatedOwner(scope);
        if (!ownerId || !isAuthIdentityScopeCurrent(scope)) return false;
        const intent =
            updatesSnapshot.listing_type === 'seeking_crew'
                ? 'find_crew'
                : updatesSnapshot.listing_type === 'seeking_berth'
                  ? 'find_skipper'
                  : null;
        return this.updateCrewProfileForScope(scope, ownerId, {
            ...updatesSnapshot,
            ...(intent ? { crew_intents: [intent] } : {}),
        });
    }

    private async updateCrewProfileForScope(
        scope: AuthIdentityScope,
        ownerId: string,
        updates: CrewProfileOwnerUpdate,
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

    /** Read the signed-in sailor's Crew List opt-in and review state. */
    async getCrewListState(): Promise<CrewListState | null> {
        const profile = await this.getCrewProfile();
        return profile ? this.crewListStateFromProfile(profile) : null;
    }

    /**
     * Update the owner-controlled Crew List switches. Review and verification
     * state intentionally have their own submit/review methods below.
     */
    async updateCrewListState(update: CrewListStateUpdate): Promise<boolean> {
        const scope = getAuthIdentityScope();
        const ownerId = await this.getAuthenticatedOwner(scope);
        if (!ownerId || !isAuthIdentityScopeCurrent(scope)) return false;

        if (update.community_enabled !== undefined && typeof update.community_enabled !== 'boolean') return false;
        if (
            update.crew_list_visibility !== undefined &&
            update.crew_list_visibility !== 'private' &&
            update.crew_list_visibility !== 'visible'
        ) {
            return false;
        }
        let crewIntents: CrewListIntent[] | undefined;
        if (update.crew_intents !== undefined) {
            if (!Array.isArray(update.crew_intents)) return false;
            crewIntents = this.normalizeCrewIntents([...update.crew_intents]);
        }
        if (update.crew_intents !== undefined && !crewIntents) return false;

        const updates: CrewProfileOwnerUpdate = {
            ...(update.community_enabled === undefined ? {} : { community_enabled: update.community_enabled }),
            ...(crewIntents === undefined ? {} : { crew_intents: crewIntents }),
            ...(update.crew_list_visibility === undefined ? {} : { crew_list_visibility: update.crew_list_visibility }),
        };
        if (update.community_enabled === false) updates.crew_list_visibility = 'private';
        if (Object.keys(updates).length === 0) return false;

        return this.updateCrewProfileForScope(scope, ownerId, updates);
    }

    /** Submit a complete, private profile for administrator verification. */
    async submitCrewProfileForReview(): Promise<boolean> {
        if (!supabase) return false;
        const scope = getAuthIdentityScope();
        const ownerId = await this.getAuthenticatedOwner(scope);
        if (!ownerId || !isAuthIdentityScopeCurrent(scope)) return false;

        const profile = await this.getCrewProfileForScope(scope, ownerId);
        if (
            !profile ||
            !profile.community_enabled ||
            profile.crew_intents.length === 0 ||
            !profile.photo_url?.trim() ||
            !isAuthIdentityScopeCurrent(scope)
        ) {
            return false;
        }

        const { error } = await supabase
            .from(CREW_PROFILES_TABLE)
            .update({
                approval_status: 'pending',
                verification_status: 'pending',
                crew_list_visibility: 'private',
                review_requested_at: new Date().toISOString(),
                reviewed_at: null,
                reviewed_by: null,
            })
            .eq('user_id', ownerId);

        return !error && isAuthIdentityScopeCurrent(scope);
    }

    /** Admin-only queue. RLS returns no profiles to non-administrators. */
    async getPendingCrewProfileReviews(limit = 100): Promise<CrewProfile[]> {
        if (!supabase) return [];
        const scope = getAuthIdentityScope();
        const ownerId = await this.getAuthenticatedOwner(scope);
        if (!ownerId || !isAuthIdentityScopeCurrent(scope)) return [];
        const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.trunc(limit))) : 100;
        const { data } = await supabase
            .from(CREW_PROFILES_TABLE)
            .select('*')
            .eq('community_enabled', true)
            .eq('approval_status', 'pending')
            .eq('verification_status', 'pending')
            .limit(safeLimit);

        if (!isAuthIdentityScopeCurrent(scope)) return [];
        return (data || []).map((profile: SupabaseRow) => this.normalizeCrewProfile(profile));
    }

    /** Admin-only review RPC; users cannot self-approve through profile updates. */
    async reviewCrewProfile(
        targetId: string,
        decision: Extract<CrewApprovalStatus, 'approved' | 'rejected'>,
    ): Promise<boolean> {
        if (!supabase) return false;
        const scope = getAuthIdentityScope();
        const ownerId = await this.getAuthenticatedOwner(scope);
        const target = this.normalizeTargetId(targetId);
        if (
            !ownerId ||
            !target ||
            target === ownerId ||
            (decision !== 'approved' && decision !== 'rejected') ||
            !isAuthIdentityScopeCurrent(scope)
        ) {
            return false;
        }

        const { data, error } = await supabase.rpc('review_crew_profile', {
            p_profile_user_id: target,
            p_decision: decision,
        });
        return !error && data === true && isAuthIdentityScopeCurrent(scope);
    }

    /** Block a Crew List profile using the canonical direct-message block table. */
    async blockCrewListUser(targetId: string): Promise<boolean> {
        if (!supabase) return false;
        const scope = getAuthIdentityScope();
        const ownerId = await this.getAuthenticatedOwner(scope);
        const target = this.normalizeTargetId(targetId);
        if (!ownerId || !target || target === ownerId || !isAuthIdentityScopeCurrent(scope)) return false;
        const { error } = await supabase
            .from(CREW_LIST_BLOCKS_TABLE)
            .upsert({ blocker_id: ownerId, blocked_id: target }, { onConflict: 'blocker_id,blocked_id' });
        return !error && isAuthIdentityScopeCurrent(scope);
    }

    /** Remove a Crew List block without affecting legacy Crew Finder blocks. */
    async unblockCrewListUser(targetId: string): Promise<boolean> {
        if (!supabase) return false;
        const scope = getAuthIdentityScope();
        const ownerId = await this.getAuthenticatedOwner(scope);
        const target = this.normalizeTargetId(targetId);
        if (!ownerId || !target || target === ownerId || !isAuthIdentityScopeCurrent(scope)) return false;
        const { error } = await supabase
            .from(CREW_LIST_BLOCKS_TABLE)
            .delete()
            .eq('blocker_id', ownerId)
            .eq('blocked_id', target);
        return !error && isAuthIdentityScopeCurrent(scope);
    }

    /** Read the signed-in sailor's canonical Crew List block set. */
    async getCrewListBlockedUserIds(): Promise<string[]> {
        const scope = getAuthIdentityScope();
        const ownerId = await this.getAuthenticatedOwner(scope);
        if (!ownerId || !isAuthIdentityScopeCurrent(scope)) return [];
        return this.getCrewListBlockedUserIdsForScope(scope, ownerId);
    }

    private async getCrewListBlockedUserIdsForScope(scope: AuthIdentityScope, ownerId: string): Promise<string[]> {
        if (!supabase || !isAuthIdentityScopeCurrent(scope)) return [];
        const { data } = await supabase.from(CREW_LIST_BLOCKS_TABLE).select('blocked_id').eq('blocker_id', ownerId);
        if (!isAuthIdentityScopeCurrent(scope)) return [];
        return [
            ...new Set(
                (data || [])
                    .map((row: Record<string, unknown>) => row.blocked_id)
                    .filter((blockedId: unknown): blockedId is string => typeof blockedId === 'string'),
            ),
        ];
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
     * Discovery is driven solely by the safety-gated Crew List profile.
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
        const blockedIds = new Set(await this.getCrewListBlockedUserIdsForScope(scope, ownerId));
        if (!isAuthIdentityScopeCurrent(scope)) return [];

        // Keep the client filter aligned with RLS. The repeated predicates are
        // deliberate: they make the safe discovery contract obvious even in a
        // mocked or service-role environment where RLS is not applied.
        let query = supabase
            .from(CREW_PROFILES_TABLE)
            .select('*')
            .eq('community_enabled', true)
            .eq('crew_list_visibility', 'visible')
            .eq('approval_status', 'approved')
            .eq('verification_status', 'verified')
            .neq('user_id', ownerId)
            .limit(100);

        if (filterSnapshot.listing_type) {
            query = query.eq('listing_type', filterSnapshot.listing_type);
        }

        const { data: crewProfiles } = await query;
        if (!isAuthIdentityScopeCurrent(scope)) return [];

        const cards: CrewCard[] = [];
        for (const crew of crewProfiles || []) {
            if (
                typeof crew.user_id !== 'string' ||
                crew.user_id === ownerId ||
                blockedIds.has(crew.user_id) ||
                crew.community_enabled !== true ||
                crew.crew_list_visibility !== 'visible' ||
                crew.approval_status !== 'approved' ||
                crew.verification_status !== 'verified'
            ) {
                continue;
            }
            const card = this.buildCrewCard(null, crew);
            if (this.matchesCrewFilters(card, filterSnapshot)) cards.push(card);
        }

        return isAuthIdentityScopeCurrent(scope) ? cards.slice(0, safeLimit) : [];
    }

    private matchesCrewFilters(card: CrewCard, filters: CrewSearchFilters): boolean {
        if (filters.skills?.length && !filters.skills.some((skill) => card.skills.includes(skill))) return false;
        if (filters.experience && card.sailing_experience !== filters.experience) return false;
        if (
            filters.region &&
            (!card.sailing_region || !card.sailing_region.toLowerCase().includes(filters.region.toLowerCase()))
        ) {
            return false;
        }
        if (filters.gender && card.gender !== filters.gender) return false;
        if (filters.age_ranges?.length && !filters.age_ranges.includes(card.age_range || '')) return false;
        if (
            filters.location_country &&
            (!card.location_country ||
                !card.location_country.toLowerCase().includes(filters.location_country.toLowerCase()))
        ) {
            return false;
        }
        if (
            filters.location_state &&
            (!card.location_state || !card.location_state.toLowerCase().includes(filters.location_state.toLowerCase()))
        ) {
            return false;
        }
        if (
            filters.location_city &&
            (!card.location_city || !card.location_city.toLowerCase().includes(filters.location_city.toLowerCase()))
        ) {
            return false;
        }
        return true;
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
            crew_intents: this.normalizeCrewIntents(cp.crew_intents) || [],
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
            is_verified: cp.verification_status === 'verified',
            location_city: cp.location_city || null,
            location_state: cp.location_state || null,
            location_country: cp.location_country || null,
            photos: [...(cp.photos || cp.dating_photos || [])],
        };
    }

    // ─── CREW LIST INTRODUCTIONS ──────────────────────

    private normalizeCrewIntroRequest(data: SupabaseRow): CrewIntroRequest | null {
        const status = this.normalizeCrewIntroStatus(data.status);
        if (
            !status ||
            typeof data.id !== 'string' ||
            typeof data.sender_id !== 'string' ||
            typeof data.recipient_id !== 'string' ||
            typeof data.message !== 'string' ||
            typeof data.created_at !== 'string'
        ) {
            return null;
        }
        return {
            id: data.id,
            sender_id: data.sender_id,
            recipient_id: data.recipient_id,
            message: data.message,
            status,
            created_at: data.created_at,
            responded_at: typeof data.responded_at === 'string' ? data.responded_at : null,
            withdrawn_at: typeof data.withdrawn_at === 'string' ? data.withdrawn_at : null,
        };
    }

    /** Send one short, in-app-only introduction to a discoverable Crew List profile. */
    async sendCrewIntroRequest(recipientId: string, message?: string): Promise<CrewIntroRequest | null> {
        if (!supabase) return null;
        const scope = getAuthIdentityScope();
        const ownerId = await this.getAuthenticatedOwner(scope);
        const recipient = this.normalizeTargetId(recipientId);
        const note = this.normalizeCrewIntroMessage(message);
        if (!ownerId || !recipient || recipient === ownerId || note === null || !isAuthIdentityScopeCurrent(scope)) {
            return null;
        }

        const { data, error } = await supabase
            .from(CREW_INTRO_REQUESTS_TABLE)
            .insert({ sender_id: ownerId, recipient_id: recipient, message: note })
            .select('*')
            .single();
        if (error || !isAuthIdentityScopeCurrent(scope)) return null;
        const request = data ? this.normalizeCrewIntroRequest(data) : null;
        return request?.sender_id === ownerId && request.recipient_id === recipient ? request : null;
    }

    /** Return only introductions where the current sailor is the sender or recipient. */
    async getCrewIntroRequests(limit = 100): Promise<CrewIntroRequest[]> {
        if (!supabase) return [];
        const scope = getAuthIdentityScope();
        const ownerId = await this.getAuthenticatedOwner(scope);
        if (!ownerId || !isAuthIdentityScopeCurrent(scope)) return [];
        const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.trunc(limit))) : 100;
        const { data } = await supabase
            .from(CREW_INTRO_REQUESTS_TABLE)
            .select('*')
            .or(`sender_id.eq.${ownerId},recipient_id.eq.${ownerId}`)
            .limit(safeLimit);
        if (!isAuthIdentityScopeCurrent(scope)) return [];

        return (data || [])
            .map((request: SupabaseRow) => this.normalizeCrewIntroRequest(request))
            .filter(
                (request: CrewIntroRequest | null): request is CrewIntroRequest =>
                    !!request && (request.sender_id === ownerId || request.recipient_id === ownerId),
            )
            .sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime());
    }

    /** A recipient may accept or decline a pending introduction. */
    async respondToCrewIntroRequest(requestId: string, response: CrewIntroResponse): Promise<boolean> {
        if (!supabase) return false;
        const scope = getAuthIdentityScope();
        const ownerId = await this.getAuthenticatedOwner(scope);
        const request = this.normalizeTargetId(requestId);
        if (
            !ownerId ||
            !request ||
            (response !== 'accepted' && response !== 'declined') ||
            !isAuthIdentityScopeCurrent(scope)
        ) {
            return false;
        }

        const { data, error } = await supabase
            .from(CREW_INTRO_REQUESTS_TABLE)
            .update({ status: response })
            .eq('id', request)
            .eq('recipient_id', ownerId)
            .select('id')
            .single();
        return !error && data?.id === request && isAuthIdentityScopeCurrent(scope);
    }

    /** A sender may withdraw their own pending introduction; it remains auditable. */
    async withdrawCrewIntroRequest(requestId: string): Promise<boolean> {
        if (!supabase) return false;
        const scope = getAuthIdentityScope();
        const ownerId = await this.getAuthenticatedOwner(scope);
        const request = this.normalizeTargetId(requestId);
        if (!ownerId || !request || !isAuthIdentityScopeCurrent(scope)) return false;

        const { data, error } = await supabase
            .from(CREW_INTRO_REQUESTS_TABLE)
            .update({ status: 'withdrawn' })
            .eq('id', request)
            .eq('sender_id', ownerId)
            .select('id')
            .single();
        return !error && data?.id === request && isAuthIdentityScopeCurrent(scope);
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
