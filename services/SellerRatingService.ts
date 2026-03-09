/**
 * SellerRatingService — Seller reputation system for Thalassa Marketplace
 *
 * Features:
 * - 1-5 star ratings with optional comment
 * - One rating per buyer per transaction (listing)
 * - Aggregate seller score (avg + count)
 * - Supabase-backed with localStorage fallback
 */

import { supabase } from './supabase';

// --- TYPES ---

export interface SellerRating {
    id: string;
    listing_id: string;
    seller_id: string;
    buyer_id: string;
    stars: number; // 1-5
    comment: string | null;
    created_at: string;
}

export interface SellerReputation {
    seller_id: string;
    avg_stars: number;
    total_ratings: number;
    recent_ratings: SellerRating[];
}

// --- CONFIG ---
const RATINGS_TABLE = 'marketplace_ratings';

// --- SERVICE ---

class SellerRatingServiceClass {
    private userId: string | null = null;

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
     * Get a seller's aggregated reputation.
     */
    async getSellerReputation(sellerId: string): Promise<SellerReputation> {
        const empty: SellerReputation = {
            seller_id: sellerId,
            avg_stars: 0,
            total_ratings: 0,
            recent_ratings: [],
        };

        if (!supabase) return empty;

        const { data, error } = await supabase
            .from(RATINGS_TABLE)
            .select('*')
            .eq('seller_id', sellerId)
            .order('created_at', { ascending: false })
            .limit(20);

        if (error || !data || data.length === 0) return empty;

        const totalStars = data.reduce((sum, r) => sum + r.stars, 0);

        return {
            seller_id: sellerId,
            avg_stars: Math.round((totalStars / data.length) * 10) / 10,
            total_ratings: data.length,
            recent_ratings: data,
        };
    }

    /**
     * Check if the current user has already rated a specific listing.
     */
    async hasRated(listingId: string): Promise<boolean> {
        if (!supabase || !this.userId) return false;

        const { data } = await supabase
            .from(RATINGS_TABLE)
            .select('id')
            .eq('listing_id', listingId)
            .eq('buyer_id', this.userId)
            .limit(1);

        return (data?.length || 0) > 0;
    }

    // ────────────────────────── MUTATIONS ──────────────────────────

    /**
     * Submit a rating for a seller on a specific listing.
     * One rating per buyer per listing (enforced by DB unique constraint).
     */
    async rateSeller(
        listingId: string,
        sellerId: string,
        stars: number,
        comment?: string
    ): Promise<SellerRating | null> {
        if (!supabase || !this.userId) return null;
        if (this.userId === sellerId) return null; // Can't rate yourself

        const clampedStars = Math.max(1, Math.min(5, Math.round(stars)));

        const { data, error } = await supabase
            .from(RATINGS_TABLE)
            .insert({
                listing_id: listingId,
                seller_id: sellerId,
                buyer_id: this.userId,
                stars: clampedStars,
                comment: comment?.trim() || null,
            })
            .select()
            .single();

        if (error) {
            console.error('[SellerRating] Rate failed:', error.message);
            return null;
        }

        return data;
    }

    /**
     * Delete own rating (if buyer changes mind).
     */
    async deleteRating(ratingId: string): Promise<boolean> {
        if (!supabase || !this.userId) return false;

        const { error } = await supabase
            .from(RATINGS_TABLE)
            .delete()
            .eq('id', ratingId)
            .eq('buyer_id', this.userId); // RLS: can only delete own

        return !error;
    }
}

// Export singleton
export const SellerRatingService = new SellerRatingServiceClass();
