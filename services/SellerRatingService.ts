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
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from './authIdentityScope';

import { createLogger } from '../utils/createLogger';

const log = createLogger('SellerRatingService');

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

function identityStillOwns(scope: AuthIdentityScope, ownerId: string | null = scope.userId): boolean {
    return isAuthIdentityScopeCurrent(scope) && scope.userId === ownerId;
}

async function remoteIdentityMatches(scope: AuthIdentityScope): Promise<boolean> {
    if (!supabase || !isAuthIdentityScopeCurrent(scope)) return false;
    try {
        const {
            data: { user },
            error,
        } = await supabase.auth.getUser();
        if (!isAuthIdentityScopeCurrent(scope)) return false;
        if (!scope.userId) return !user;
        return !error && user?.id === scope.userId;
    } catch {
        return false;
    }
}

// --- SERVICE ---

class SellerRatingServiceClass {
    private userId: string | null = getAuthIdentityScope().userId;

    constructor() {
        subscribeAuthIdentityScope((next) => {
            // Rating ownership changes immediately with the auth fence; no
            // promise from the previous account may leave its user id behind.
            this.userId = next.userId;
        });
    }

    async initialize(): Promise<void> {
        const scope = getAuthIdentityScope();
        this.userId = scope.userId;
        if (!supabase) return;

        const matches = await remoteIdentityMatches(scope);
        if (!isAuthIdentityScopeCurrent(scope)) return;
        this.userId = matches ? scope.userId : null;
    }

    getCurrentUserId(): string | null {
        return this.userId === getAuthIdentityScope().userId ? this.userId : null;
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
        const scope = getAuthIdentityScope();
        if (!(await remoteIdentityMatches(scope))) return empty;

        const { data, error } = await supabase
            .from(RATINGS_TABLE)
            .select('*')
            .eq('seller_id', sellerId)
            .order('created_at', { ascending: false })
            .limit(20);

        if (!isAuthIdentityScopeCurrent(scope) || error || !data || data.length === 0) return empty;

        const totalStars = data.reduce((sum, r) => sum + r.stars, 0);

        if (!isAuthIdentityScopeCurrent(scope)) return empty;
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
        if (!supabase) return false;
        const scope = getAuthIdentityScope();
        const buyerId = scope.userId;
        if (!buyerId || !(await remoteIdentityMatches(scope))) return false;

        const { data } = await supabase
            .from(RATINGS_TABLE)
            .select('id')
            .eq('listing_id', listingId)
            .eq('buyer_id', buyerId)
            .limit(1);

        return identityStillOwns(scope, buyerId) && (data?.length || 0) > 0;
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
        comment?: string,
    ): Promise<SellerRating | null> {
        if (!supabase) return null;
        const scope = getAuthIdentityScope();
        const buyerId = scope.userId;
        if (!buyerId || buyerId === sellerId || !(await remoteIdentityMatches(scope))) return null;

        const clampedStars = Math.max(1, Math.min(5, Math.round(stars)));

        const { data, error } = await supabase
            .from(RATINGS_TABLE)
            .insert({
                listing_id: listingId,
                seller_id: sellerId,
                buyer_id: buyerId,
                stars: clampedStars,
                comment: comment?.trim() || null,
            })
            .select()
            .single();

        if (!identityStillOwns(scope, buyerId)) return null;
        if (error) {
            log.error('[SellerRating] Rate failed:', error.message);
            return null;
        }

        return data;
    }

    /**
     * Delete own rating (if buyer changes mind).
     */
    async deleteRating(ratingId: string): Promise<boolean> {
        if (!supabase) return false;
        const scope = getAuthIdentityScope();
        const buyerId = scope.userId;
        if (!buyerId || !(await remoteIdentityMatches(scope))) return false;

        const { error } = await supabase.from(RATINGS_TABLE).delete().eq('id', ratingId).eq('buyer_id', buyerId); // RLS: can only delete own

        return identityStillOwns(scope, buyerId) && !error;
    }
}

// Export singleton
export const SellerRatingService = new SellerRatingServiceClass();
