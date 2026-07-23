/**
 * MarketplaceService — Thalassa Gear Exchange
 *
 * Full CRUD for marketplace listings with:
 * - Supabase Realtime for live feed updates
 * - PostGIS RPC for geo-filtered search (within X nm)
 * - Image upload to Supabase Storage
 * - Seller profile enrichment
 */

import { supabase } from './supabase';
import { compressImage } from './ProfilePhotoService';
import type { RealtimeChannel } from '@supabase/supabase-js';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from './authIdentityScope';

import { createLogger } from '../utils/createLogger';

const log = createLogger('MarketplaceService');

// --- CONFIG ---
const LISTINGS_TABLE = 'marketplace_listings';
const PUBLIC_LISTINGS_VIEW = 'marketplace_listings_public';
const _MESSAGES_TABLE = 'marketplace_messages';
const PROFILES_TABLE = 'chat_profiles';
const IMAGES_BUCKET = 'marketplace-images';
const MAX_LISTING_IMAGES = 20;
const _MAX_IMAGE_PX = 1200;

function identityStillOwns(scope: AuthIdentityScope, ownerId: string | null = scope.userId): boolean {
    return isAuthIdentityScopeCurrent(scope) && scope.userId === ownerId;
}

/**
 * The process-local identity fence changes before React account state. Confirm
 * that Supabase is using the same account before issuing any remote operation;
 * otherwise a session-transition window could run an A-scoped action with B's
 * token (or vice versa).
 */
async function remoteIdentityMatches(scope: AuthIdentityScope): Promise<boolean> {
    if (!supabase || !isAuthIdentityScopeCurrent(scope)) return false;
    try {
        const {
            data: { user },
            error,
        } = await supabase.auth.getUser();
        if (!isAuthIdentityScopeCurrent(scope)) return false;
        // Supabase may report AuthSessionMissing for a legitimate anonymous
        // browser. None still exactly matches the anonymous fence.
        if (!scope.userId) return !user;
        return !error && user?.id === scope.userId;
    } catch {
        return false;
    }
}

// --- TYPES ---

export type ListingCategory =
    | 'Boats'
    | 'Outboards'
    | 'Electronics'
    | 'Sails'
    | 'Rigging'
    | 'Hardware'
    | 'Safety'
    | 'Misc';
export type ListingCondition = 'New' | 'Like New' | 'Used - Good' | 'Used - Fair' | 'Needs Repair';
export type ListingStatus = 'available' | 'pending' | 'sold';

export const LISTING_CATEGORIES: ListingCategory[] = [
    'Boats',
    'Electronics',
    'Hardware',
    'Misc',
    'Outboards',
    'Rigging',
    'Safety',
    'Sails',
];
export const LISTING_CONDITIONS: ListingCondition[] = ['New', 'Like New', 'Used - Good', 'Used - Fair', 'Needs Repair'];

export const CATEGORY_ICONS: Record<ListingCategory, string> = {
    Boats: '⛵',
    Outboards: '🚤',
    Electronics: '📡',
    Sails: '🪂',
    Rigging: '🔗',
    Hardware: '🔩',
    Safety: '🛱',
    Misc: '📦',
};

// ── Boat-specific types ──

export type HullMaterial = 'Fibreglass' | 'Aluminium' | 'Steel' | 'Timber' | 'Carbon' | 'Ferro' | 'Other';
export type EngineType = 'Inboard' | 'Outboard' | 'Sail Only' | 'Jet';
export type FuelType = 'Diesel' | 'Petrol' | 'Electric' | 'Hybrid';

export const HULL_MATERIALS: HullMaterial[] = [
    'Fibreglass',
    'Aluminium',
    'Steel',
    'Timber',
    'Carbon',
    'Ferro',
    'Other',
];
export const ENGINE_TYPES: EngineType[] = ['Inboard', 'Outboard', 'Sail Only', 'Jet'];
export const FUEL_TYPES: FuelType[] = ['Diesel', 'Petrol', 'Electric', 'Hybrid'];

export const BOAT_FEATURES = [
    'Autopilot',
    'Watermaker',
    'Solar Panels',
    'Wind Generator',
    'Davits',
    'Tender',
    'Bow Thruster',
    'Air Conditioning',
    'Generator',
    'Inverter',
    'Radar',
    'AIS',
    'Chartplotter',
    'Windlass',
    'Bimini',
    'Dodger',
    'Dinghy',
    'Liferaft',
    'EPIRB',
    'Spinnaker',
    'Furler',
    'Lazy Jacks',
    'Shore Power',
    'Holding Tank',
    'Watermaker',
    'SSB Radio',
    'Satellite Phone',
] as const;

export interface BoatDetails {
    make?: string; // e.g. "Beneteau"
    model?: string; // e.g. "Oceanis 40.1"
    year?: number; // e.g. 2019
    loa_ft?: number; // Length overall in feet
    beam_ft?: number; // Beam in feet
    draft_ft?: number; // Draft in feet
    hull_material?: HullMaterial;
    engine_type?: EngineType;
    engine_make?: string; // e.g. "Yanmar"
    engine_hp?: number; // Horsepower
    engine_hours?: number; // Hours on engine
    fuel_type?: FuelType;
    berths?: number;
    cabins?: number;
    heads?: number;
    rego_state?: string; // Registration state
    rego_number?: string; // Registration number
    surveyed?: boolean; // Recently surveyed?
    features?: string[]; // Tag chips: Autopilot, Watermaker, etc.
    price_reduced?: boolean; // Price has been reduced
    original_price?: number; // Original price before reduction
}

export interface MarketplaceListing {
    id: string;
    seller_id: string;
    title: string;
    description: string | null;
    price: number;
    currency: string;
    category: ListingCategory;
    condition: ListingCondition;
    images: string[];
    location_name: string | null;
    status: ListingStatus;
    sold_at: string | null;
    created_at: string;
    updated_at: string;
    distance_nm?: number; // Only present on geo-filtered results
    boat_details?: BoatDetails | null; // Boat-specific fields (category=Boats)
    // Seller profile (joined)
    seller_name?: string;
    seller_avatar?: string | null;
    seller_vessel?: string | null;
}

export interface CreateListingInput {
    title: string;
    description?: string;
    price: number;
    currency?: string;
    category: ListingCategory;
    condition: ListingCondition;
    images?: File[];
    latitude?: number;
    longitude?: number;
    location_name?: string;
    boat_details?: BoatDetails;
}

// --- SERVICE ---

class MarketplaceServiceClass {
    private feedSubscription: RealtimeChannel | null = null;
    private feedCallback: ((listing: MarketplaceListing) => void) | null = null;
    private feedScope: AuthIdentityScope | null = null;
    private userId: string | null = getAuthIdentityScope().userId;

    constructor() {
        subscribeAuthIdentityScope((next) => {
            // Hide the previous owner synchronously. Rebind the public feed so
            // even an already-queued callback retains the generation it began
            // under and cannot publish an A result into B's screen.
            this.userId = next.userId;
            const callback = this.feedCallback;
            this.removeFeedChannel();
            if (callback) this.startFeed(next, callback);
        });
    }

    /**
     * Initialize — resolve current user
     */
    async initialize(): Promise<void> {
        const scope = getAuthIdentityScope();
        this.userId = scope.userId;
        if (!supabase) return;

        const matches = await remoteIdentityMatches(scope);
        if (!isAuthIdentityScopeCurrent(scope)) return;
        // Fail closed if the synchronous fence and Supabase session disagree.
        this.userId = matches ? scope.userId : null;
    }

    getCurrentUserId(): string | null {
        return this.userId === getAuthIdentityScope().userId ? this.userId : null;
    }

    // ────────────────────────── QUERIES ──────────────────────────

    /**
     * Get paginated listings, optionally filtered by category.
     * Returns listings enriched with seller profile data.
     */
    async getListings(category?: ListingCategory | null, limit = 30, offset = 0): Promise<MarketplaceListing[]> {
        if (!supabase) return [];
        const scope = getAuthIdentityScope();
        if (!(await remoteIdentityMatches(scope))) return [];

        let query = supabase
            .from(PUBLIC_LISTINGS_VIEW)
            .select('*')
            .eq('status', 'available')
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (category) {
            query = query.eq('category', category);
        }

        const { data, error } = await query;
        if (!isAuthIdentityScopeCurrent(scope) || error || !data) return [];

        // Also fetch recently-sold listings (48h) to show SOLD overlay
        let soldListings: Record<string, unknown>[] = [];
        const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
        let soldQuery = supabase
            .from(PUBLIC_LISTINGS_VIEW)
            .select('*')
            .eq('status', 'sold')
            .gte('sold_at', twoDaysAgo)
            .order('sold_at', { ascending: false })
            .limit(10);
        if (category) soldQuery = soldQuery.eq('category', category);
        const { data: soldData } = await soldQuery;
        if (!isAuthIdentityScopeCurrent(scope)) return [];
        if (soldData) soldListings = soldData;

        return this.enrichWithProfiles([...data, ...soldListings], scope);
    }

    /**
     * Get listings within a radius using PostGIS RPC.
     */
    async getListingsNearby(
        lat: number,
        lon: number,
        radiusNm = 50,
        category?: ListingCategory | null,
    ): Promise<MarketplaceListing[]> {
        if (!supabase) return [];
        const scope = getAuthIdentityScope();
        if (!(await remoteIdentityMatches(scope))) return [];

        const { data, error } = await supabase.rpc('get_listings_within_radius', {
            user_lat: lat,
            user_lon: lon,
            radius_nm: radiusNm,
            filter_category: category || null,
            result_limit: 50,
        });

        if (!isAuthIdentityScopeCurrent(scope) || error || !data) return [];

        return this.enrichWithProfiles(data, scope);
    }

    /**
     * Get a single listing by ID.
     */
    async getListing(id: string): Promise<MarketplaceListing | null> {
        if (!supabase) return null;
        const scope = getAuthIdentityScope();
        if (!(await remoteIdentityMatches(scope))) return null;

        const { data } = await supabase.from(PUBLIC_LISTINGS_VIEW).select('*').eq('id', id).single();

        if (!isAuthIdentityScopeCurrent(scope) || !data) return null;

        const enriched = await this.enrichWithProfiles([data], scope);
        return enriched[0] || null;
    }

    /**
     * Get listings by the current user (my listings).
     */
    async getMyListings(): Promise<MarketplaceListing[]> {
        if (!supabase) return [];
        const scope = getAuthIdentityScope();
        const ownerId = scope.userId;
        if (!ownerId || !(await remoteIdentityMatches(scope))) return [];

        const { data } = await supabase
            .from(LISTINGS_TABLE)
            .select('*')
            .eq('seller_id', ownerId)
            .order('created_at', { ascending: false });

        if (!identityStillOwns(scope, ownerId) || !data) return [];
        return this.enrichWithProfiles(data, scope);
    }

    // ────────────────────────── MUTATIONS ──────────────────────────

    /**
     * Create a new listing with image uploads.
     */
    async createListing(input: CreateListingInput): Promise<MarketplaceListing | null> {
        if (!supabase) return null;
        const scope = getAuthIdentityScope();
        const ownerId = scope.userId;
        if (!ownerId || !(await remoteIdentityMatches(scope))) return null;

        // Upload images first
        const imageUrls: string[] = [];
        if (input.images && input.images.length > 0) {
            const toUpload = input.images.slice(0, MAX_LISTING_IMAGES);
            for (const file of toUpload) {
                const url = await this.uploadImageForOwner(file, scope, ownerId);
                if (!identityStillOwns(scope, ownerId)) return null;
                if (url) imageUrls.push(url);
            }
        }

        // Image compression/upload can take several seconds. Re-confirm the
        // remote session immediately before the listing write.
        if (!identityStillOwns(scope, ownerId) || !(await remoteIdentityMatches(scope))) return null;

        // Build PostGIS point if coordinates provided
        const locationValue =
            input.latitude != null && input.longitude != null
                ? `SRID=4326;POINT(${input.longitude} ${input.latitude})`
                : null;

        const { data, error } = await supabase
            .from(LISTINGS_TABLE)
            .insert({
                seller_id: ownerId,
                title: input.title,
                description: input.description || null,
                price: input.price,
                currency: input.currency || 'AUD',
                category: input.category,
                condition: input.condition,
                images: imageUrls,
                location: locationValue,
                location_name: input.location_name || null,
                boat_details: input.boat_details || null,
                status: 'available',
            })
            .select()
            .single();

        if (!identityStillOwns(scope, ownerId)) return null;
        if (error || !data) {
            log.error('[Marketplace] Create failed:', error?.message);
            return null;
        }

        const enriched = await this.enrichWithProfiles([data], scope);
        return enriched[0] || null;
    }

    /**
     * Update a listing (only own listings allowed by RLS).
     */
    async updateListing(
        id: string,
        updates: Partial<
            Pick<
                MarketplaceListing,
                'title' | 'description' | 'price' | 'currency' | 'category' | 'condition' | 'status' | 'location_name'
            >
        >,
    ): Promise<boolean> {
        if (!supabase) return false;
        const scope = getAuthIdentityScope();
        const ownerId = scope.userId;
        if (!ownerId || !(await remoteIdentityMatches(scope))) return false;

        const { error } = await supabase.from(LISTINGS_TABLE).update(updates).eq('id', id).eq('seller_id', ownerId);

        return identityStillOwns(scope, ownerId) && !error;
    }

    /**
     * Mark a listing as sold.
     */
    async markSold(id: string): Promise<boolean> {
        if (!supabase) return false;
        const scope = getAuthIdentityScope();
        const ownerId = scope.userId;
        if (!ownerId || !(await remoteIdentityMatches(scope))) return false;
        const { error } = await supabase
            .from(LISTINGS_TABLE)
            .update({ status: 'sold', sold_at: new Date().toISOString() })
            .eq('id', id)
            .eq('seller_id', ownerId);
        return identityStillOwns(scope, ownerId) && !error;
    }

    /**
     * Delete a listing (RLS enforced to own listings).
     */
    async deleteListing(id: string): Promise<boolean> {
        if (!supabase) return false;
        const scope = getAuthIdentityScope();
        const ownerId = scope.userId;
        if (!ownerId || !(await remoteIdentityMatches(scope))) return false;

        const { error } = await supabase.from(LISTINGS_TABLE).delete().eq('id', id).eq('seller_id', ownerId);

        return identityStillOwns(scope, ownerId) && !error;
    }

    // ────────────────────────── IMAGES ──────────────────────────

    /**
     * Upload a single listing image. Returns the public URL.
     */
    async uploadImage(file: File): Promise<string | null> {
        if (!supabase) return null;
        const scope = getAuthIdentityScope();
        const ownerId = scope.userId;
        if (!ownerId) return null;
        return this.uploadImageForOwner(file, scope, ownerId);
    }

    private async uploadImageForOwner(file: File, scope: AuthIdentityScope, ownerId: string): Promise<string | null> {
        const client = supabase;
        if (!client) return null;
        try {
            // Compress to reasonable listing photo size
            const compressed = await compressImage(file);
            if (!identityStillOwns(scope, ownerId) || !(await remoteIdentityMatches(scope))) return null;
            const fileName = `${ownerId}/listing-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`;

            const { error: uploadError } = await client.storage.from(IMAGES_BUCKET).upload(fileName, compressed, {
                contentType: 'image/jpeg',
                upsert: false,
            });

            if (uploadError) {
                log.error('[Marketplace] Image upload failed:', uploadError.message);
                return null;
            }
            if (!identityStillOwns(scope, ownerId)) return null;

            const { data: urlData } = client.storage.from(IMAGES_BUCKET).getPublicUrl(fileName);

            return urlData?.publicUrl || null;
        } catch (e) {
            log.error('[Marketplace] Image upload error:', e);
            return null;
        }
    }

    // ────────────────────────── REALTIME ──────────────────────────

    /**
     * Subscribe to new/updated listings in realtime.
     * Returns an unsubscribe function.
     */
    subscribeToFeed(onListing: (listing: MarketplaceListing) => void): () => void {
        if (!supabase) return () => {};

        // Clean up existing subscription
        this.unsubscribeFeed();
        this.feedCallback = onListing;
        this.startFeed(getAuthIdentityScope(), onListing);

        return () => {
            if (this.feedCallback === onListing) this.unsubscribeFeed();
        };
    }

    private startFeed(scope: AuthIdentityScope, onListing: (listing: MarketplaceListing) => void): void {
        if (!supabase || !isAuthIdentityScopeCurrent(scope)) return;
        this.feedScope = scope;
        this.feedSubscription = supabase
            .channel(`marketplace-feed-${scope.generation}`)
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: LISTINGS_TABLE,
                },
                async (payload) => {
                    if (!isAuthIdentityScopeCurrent(scope) || this.feedScope !== scope) return;
                    if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
                        if (!(await remoteIdentityMatches(scope))) return;
                        const enriched = await this.enrichWithProfiles([payload.new], scope);
                        if (enriched[0] && isAuthIdentityScopeCurrent(scope) && this.feedScope === scope) {
                            onListing(enriched[0]);
                        }
                    }
                },
            )
            .subscribe();
    }

    /**
     * Unsubscribe from the feed.
     */
    unsubscribeFeed(): void {
        this.feedCallback = null;
        this.removeFeedChannel();
    }

    private removeFeedChannel(): void {
        if (this.feedSubscription) {
            supabase?.removeChannel(this.feedSubscription);
            this.feedSubscription = null;
        }
        this.feedScope = null;
    }

    // ────────────────────────── HELPERS ──────────────────────────

    /**
     * Enrich listing rows with seller profile data (display name, avatar, vessel).
     */
    private async enrichWithProfiles(
        rows: Record<string, unknown>[],
        scope: AuthIdentityScope,
    ): Promise<MarketplaceListing[]> {
        if (!supabase || rows.length === 0 || !isAuthIdentityScopeCurrent(scope)) return [];

        const sellerIds = [...new Set(rows.map((r) => r.seller_id).filter(Boolean))];

        // Batch fetch seller profiles
        const profileMap = new Map<
            string,
            { display_name: string; avatar_url: string | null; vessel_name: string | null }
        >();

        if (sellerIds.length > 0) {
            const { data: profiles } = await supabase
                .from(PROFILES_TABLE)
                .select('user_id, display_name, avatar_url, vessel_name')
                .in('user_id', sellerIds);

            if (!isAuthIdentityScopeCurrent(scope)) return [];
            if (profiles) {
                for (const p of profiles) {
                    profileMap.set(p.user_id, {
                        display_name: p.display_name || 'Unknown Sailor',
                        avatar_url: p.avatar_url,
                        vessel_name: p.vessel_name,
                    });
                }
            }
        }

        return rows.map((r) => ({
            id: r.id as string,
            seller_id: r.seller_id as string,
            title: r.title as string,
            description: r.description as string | null,
            price: parseFloat(String(r.price)),
            currency: (r.currency as string) || 'AUD',
            category: r.category as ListingCategory,
            condition: r.condition as ListingCondition,
            images: (r.images as string[]) || [],
            location_name: r.location_name as string | null,
            status: r.status as ListingStatus,
            sold_at: (r.sold_at as string) || null,
            created_at: r.created_at as string,
            updated_at: r.updated_at as string,
            distance_nm: r.distance_nm != null ? Math.round(Number(r.distance_nm) * 10) / 10 : undefined,
            boat_details: (r.boat_details as BoatDetails) || null,
            seller_name: profileMap.get(r.seller_id as string)?.display_name || 'Unknown Sailor',
            seller_avatar: profileMap.get(r.seller_id as string)?.avatar_url || null,
            seller_vessel: profileMap.get(r.seller_id as string)?.vessel_name || null,
        }));
    }

    /**
     * Clean up all subscriptions.
     */
    destroy(): void {
        this.unsubscribeFeed();
    }
}

// Export singleton
export const MarketplaceService = new MarketplaceServiceClass();
