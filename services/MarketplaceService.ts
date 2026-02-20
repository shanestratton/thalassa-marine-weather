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

// --- CONFIG ---
const LISTINGS_TABLE = 'marketplace_listings';
const MESSAGES_TABLE = 'marketplace_messages';
const PROFILES_TABLE = 'chat_profiles';
const IMAGES_BUCKET = 'marketplace-images';
const MAX_LISTING_IMAGES = 4;
const MAX_IMAGE_PX = 1200;

// --- TYPES ---

export type ListingCategory = 'Electronics' | 'Sails' | 'Rigging' | 'Hardware' | 'Safety' | 'Misc';
export type ListingCondition = 'New' | 'Like New' | 'Used - Good' | 'Used - Fair' | 'Needs Repair';
export type ListingStatus = 'available' | 'pending' | 'sold';

export const LISTING_CATEGORIES: ListingCategory[] = ['Electronics', 'Sails', 'Rigging', 'Hardware', 'Safety', 'Misc'];
export const LISTING_CONDITIONS: ListingCondition[] = ['New', 'Like New', 'Used - Good', 'Used - Fair', 'Needs Repair'];

export const CATEGORY_ICONS: Record<ListingCategory, string> = {
    'Electronics': '📡',
    'Sails': '⛵',
    'Rigging': '🔗',
    'Hardware': '🔩',
    'Safety': '🛟',
    'Misc': '📦',
};

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
    created_at: string;
    updated_at: string;
    distance_nm?: number; // Only present on geo-filtered results
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
}

// --- SERVICE ---

class MarketplaceServiceClass {
    private feedSubscription: RealtimeChannel | null = null;
    private userId: string | null = null;

    /**
     * Initialize — resolve current user
     */
    async initialize(): Promise<void> {
        if (!supabase) return;
        const { data: { user } } = await supabase.auth.getUser();
        this.userId = user?.id || null;
    }

    getCurrentUserId(): string | null {
        return this.userId;
    }

    // ────────────────────────── QUERIES ──────────────────────────

    /**
     * Get paginated listings, optionally filtered by category.
     * Returns listings enriched with seller profile data.
     */
    async getListings(
        category?: ListingCategory | null,
        limit = 30,
        offset = 0
    ): Promise<MarketplaceListing[]> {
        if (!supabase) return [];

        let query = supabase
            .from(LISTINGS_TABLE)
            .select('*')
            .eq('status', 'available')
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (category) {
            query = query.eq('category', category);
        }

        const { data, error } = await query;
        if (error || !data) return [];

        return this.enrichWithProfiles(data);
    }

    /**
     * Get listings within a radius using PostGIS RPC.
     */
    async getListingsNearby(
        lat: number,
        lon: number,
        radiusNm = 50,
        category?: ListingCategory | null
    ): Promise<MarketplaceListing[]> {
        if (!supabase) return [];

        const { data, error } = await supabase.rpc('get_listings_within_radius', {
            user_lat: lat,
            user_lon: lon,
            radius_nm: radiusNm,
            filter_category: category || null,
            result_limit: 50,
        });

        if (error || !data) return [];

        return this.enrichWithProfiles(data);
    }

    /**
     * Get a single listing by ID.
     */
    async getListing(id: string): Promise<MarketplaceListing | null> {
        if (!supabase) return null;

        const { data } = await supabase
            .from(LISTINGS_TABLE)
            .select('*')
            .eq('id', id)
            .single();

        if (!data) return null;

        const enriched = await this.enrichWithProfiles([data]);
        return enriched[0] || null;
    }

    /**
     * Get listings by the current user (my listings).
     */
    async getMyListings(): Promise<MarketplaceListing[]> {
        if (!supabase || !this.userId) return [];

        const { data } = await supabase
            .from(LISTINGS_TABLE)
            .select('*')
            .eq('seller_id', this.userId)
            .order('created_at', { ascending: false });

        if (!data) return [];
        return this.enrichWithProfiles(data);
    }

    // ────────────────────────── MUTATIONS ──────────────────────────

    /**
     * Create a new listing with image uploads.
     */
    async createListing(input: CreateListingInput): Promise<MarketplaceListing | null> {
        if (!supabase || !this.userId) return null;

        // Upload images first
        const imageUrls: string[] = [];
        if (input.images && input.images.length > 0) {
            const toUpload = input.images.slice(0, MAX_LISTING_IMAGES);
            for (const file of toUpload) {
                const url = await this.uploadImage(file);
                if (url) imageUrls.push(url);
            }
        }

        // Build PostGIS point if coordinates provided
        const locationValue = (input.latitude != null && input.longitude != null)
            ? `SRID=4326;POINT(${input.longitude} ${input.latitude})`
            : null;

        const { data, error } = await supabase
            .from(LISTINGS_TABLE)
            .insert({
                seller_id: this.userId,
                title: input.title,
                description: input.description || null,
                price: input.price,
                currency: input.currency || 'AUD',
                category: input.category,
                condition: input.condition,
                images: imageUrls,
                location: locationValue,
                location_name: input.location_name || null,
                status: 'available',
            })
            .select()
            .single();

        if (error || !data) {
            console.error('[Marketplace] Create failed:', error?.message);
            return null;
        }

        const enriched = await this.enrichWithProfiles([data]);
        return enriched[0] || null;
    }

    /**
     * Update a listing (only own listings allowed by RLS).
     */
    async updateListing(
        id: string,
        updates: Partial<Pick<MarketplaceListing, 'title' | 'description' | 'price' | 'currency' | 'category' | 'condition' | 'status' | 'location_name'>>
    ): Promise<boolean> {
        if (!supabase) return false;

        const { error } = await supabase
            .from(LISTINGS_TABLE)
            .update(updates)
            .eq('id', id);

        return !error;
    }

    /**
     * Mark a listing as sold.
     */
    async markSold(id: string): Promise<boolean> {
        return this.updateListing(id, { status: 'sold' });
    }

    /**
     * Delete a listing (RLS enforced to own listings).
     */
    async deleteListing(id: string): Promise<boolean> {
        if (!supabase) return false;

        const { error } = await supabase
            .from(LISTINGS_TABLE)
            .delete()
            .eq('id', id);

        return !error;
    }

    // ────────────────────────── IMAGES ──────────────────────────

    /**
     * Upload a single listing image. Returns the public URL.
     */
    async uploadImage(file: File): Promise<string | null> {
        if (!supabase || !this.userId) return null;

        try {
            // Compress to reasonable listing photo size
            const compressed = await compressImage(file);
            const fileName = `${this.userId}/listing-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`;

            const { error: uploadError } = await supabase.storage
                .from(IMAGES_BUCKET)
                .upload(fileName, compressed, {
                    contentType: 'image/jpeg',
                    upsert: false,
                });

            if (uploadError) {
                console.error('[Marketplace] Image upload failed:', uploadError.message);
                return null;
            }

            const { data: urlData } = supabase.storage
                .from(IMAGES_BUCKET)
                .getPublicUrl(fileName);

            return urlData?.publicUrl || null;
        } catch (e) {
            console.error('[Marketplace] Image upload error:', e);
            return null;
        }
    }

    // ────────────────────────── REALTIME ──────────────────────────

    /**
     * Subscribe to new/updated listings in realtime.
     * Returns an unsubscribe function.
     */
    subscribeToFeed(onListing: (listing: MarketplaceListing) => void): () => void {
        if (!supabase) return () => { };

        // Clean up existing subscription
        this.unsubscribeFeed();

        this.feedSubscription = supabase
            .channel('marketplace-feed')
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: LISTINGS_TABLE,
                },
                async (payload) => {
                    if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
                        const enriched = await this.enrichWithProfiles([payload.new]);
                        if (enriched[0]) onListing(enriched[0]);
                    }
                }
            )
            .subscribe();

        return () => this.unsubscribeFeed();
    }

    /**
     * Unsubscribe from the feed.
     */
    unsubscribeFeed(): void {
        if (this.feedSubscription) {
            supabase?.removeChannel(this.feedSubscription);
            this.feedSubscription = null;
        }
    }

    // ────────────────────────── HELPERS ──────────────────────────

    /**
     * Enrich listing rows with seller profile data (display name, avatar, vessel).
     */
    private async enrichWithProfiles(rows: any[]): Promise<MarketplaceListing[]> {
        if (!supabase || rows.length === 0) return [];

        const sellerIds = [...new Set(rows.map(r => r.seller_id).filter(Boolean))];

        // Batch fetch seller profiles
        let profileMap = new Map<string, { display_name: string; avatar_url: string | null; vessel_name: string | null }>();

        if (sellerIds.length > 0) {
            const { data: profiles } = await supabase
                .from(PROFILES_TABLE)
                .select('user_id, display_name, avatar_url, vessel_name')
                .in('user_id', sellerIds);

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

        return rows.map(r => ({
            id: r.id,
            seller_id: r.seller_id,
            title: r.title,
            description: r.description,
            price: parseFloat(r.price),
            currency: r.currency || 'AUD',
            category: r.category,
            condition: r.condition,
            images: r.images || [],
            location_name: r.location_name,
            status: r.status,
            created_at: r.created_at,
            updated_at: r.updated_at,
            distance_nm: r.distance_nm != null ? Math.round(r.distance_nm * 10) / 10 : undefined,
            seller_name: profileMap.get(r.seller_id)?.display_name || 'Unknown Sailor',
            seller_avatar: profileMap.get(r.seller_id)?.avatar_url || null,
            seller_vessel: profileMap.get(r.seller_id)?.vessel_name || null,
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
