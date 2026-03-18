/**
 * SubscriptionManager — Premium / Trial / Paywall Logic
 *
 * The "switch" that controls premium vs free tier access across the app.
 * Reads subscription status from Supabase `profiles` table and caches
 * the result in memory. All feature gates (weather tier, export formats,
 * etc.) should call isPremiumUser() rather than checking Supabase directly.
 *
 * Pricing: $79.99/yr
 * Trial: 14 days from first login
 */

import { supabase } from '../services/supabase';
import { createLogger } from '../utils/logger';

const log = createLogger('SubscriptionManager');

// --- TYPES ---

export type SubscriptionStatus = 'active' | 'trial' | 'expired' | 'free';

export interface SubscriptionInfo {
    status: SubscriptionStatus;
    trialStartDate: string | null;
    subscriptionExpiry: string | null;
    trialRemainingDays: number;
}

// --- CONSTANTS ---

const TRIAL_DURATION_DAYS = 14;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const PRICE_YEARLY = 79.99;

// --- INTERNAL STATE ---

let cachedInfo: SubscriptionInfo | null = null;
let cachedUserId: string | null = null;
let cacheTimestamp = 0;

// --- EVENT SYSTEM ---

type PaywallListener = (info: SubscriptionInfo) => void;
const paywallListeners: PaywallListener[] = [];

/**
 * Register a listener that's called when triggerPaywall() fires.
 * Returns an unsubscribe function.
 */
export function onPaywallTriggered(listener: PaywallListener): () => void {
    paywallListeners.push(listener);
    return () => {
        const idx = paywallListeners.indexOf(listener);
        if (idx >= 0) paywallListeners.splice(idx, 1);
    };
}

// --- CORE API ---

/**
 * Check if the current user has premium access (active subscription or valid trial).
 * Returns false for logged-out users, expired trials, and free accounts.
 */
export async function isPremiumUser(): Promise<boolean> {
    const info = await getSubscriptionStatus();
    return info.status === 'active' || info.status === 'trial';
}

/**
 * Get the number of trial days remaining.
 * Returns 0 if no trial, trial expired, or user has active subscription.
 */
export async function getTrialRemainingDays(): Promise<number> {
    const info = await getSubscriptionStatus();
    return info.trialRemainingDays;
}

/**
 * Get full subscription info for the current user.
 * Uses a 5-minute in-memory cache to avoid hammering Supabase.
 */
export async function getSubscriptionStatus(): Promise<SubscriptionInfo> {
    // No Supabase → free
    if (!supabase) return makeFreeInfo();

    // Get current user
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) return makeFreeInfo();

    // Return cached if fresh and same user
    const now = Date.now();
    if (cachedInfo && cachedUserId === user.id && now - cacheTimestamp < CACHE_TTL_MS) {
        return cachedInfo;
    }

    // Fetch from profiles table
    try {
        const { data, error } = await supabase
            .from('profiles')
            .select('subscription_status, trial_start_date, subscription_expiry')
            .eq('id', user.id)
            .single();

        if (error || !data) {
            log.warn('Failed to fetch profile, defaulting to free', error);
            return makeFreeInfo();
        }

        const info = resolveStatus(data);

        // Cache
        cachedInfo = info;
        cachedUserId = user.id;
        cacheTimestamp = now;

        return info;
    } catch (err) {
        log.error('SubscriptionManager fetch failed', err);
        return makeFreeInfo();
    }
}

/**
 * Force a fresh fetch of subscription status (bypasses cache).
 * Call after purchase confirmation or auth state change.
 */
export async function refreshSubscription(): Promise<void> {
    cachedInfo = null;
    cacheTimestamp = 0;
    await getSubscriptionStatus();
}

/**
 * Trigger the paywall UI. Emits an event that the app layer can listen
 * to and show an upgrade modal / App Store purchase flow.
 */
export function triggerPaywall(): void {
    const info = cachedInfo ?? makeFreeInfo();
    log.info('Paywall triggered', { status: info.status, remaining: info.trialRemainingDays });
    for (const listener of paywallListeners) {
        try {
            listener(info);
        } catch {
            // Don't let a broken listener crash the paywall
        }
    }
}

/**
 * Get the yearly subscription price.
 */
export function getPrice(): number {
    return PRICE_YEARLY;
}

/**
 * Clear cached subscription data (call on logout).
 */
export function clearCache(): void {
    cachedInfo = null;
    cachedUserId = null;
    cacheTimestamp = 0;
}

// --- INTERNAL HELPERS ---

function makeFreeInfo(): SubscriptionInfo {
    return {
        status: 'free',
        trialStartDate: null,
        subscriptionExpiry: null,
        trialRemainingDays: 0,
    };
}

function resolveStatus(profile: {
    subscription_status?: string | null;
    trial_start_date?: string | null;
    subscription_expiry?: string | null;
}): SubscriptionInfo {
    const base = {
        trialStartDate: profile.trial_start_date ?? null,
        subscriptionExpiry: profile.subscription_expiry ?? null,
    };

    // Active paid subscription
    if (profile.subscription_status === 'active') {
        // Check if expired
        if (profile.subscription_expiry) {
            const expiry = new Date(profile.subscription_expiry);
            if (expiry.getTime() < Date.now()) {
                return { ...base, status: 'expired', trialRemainingDays: 0 };
            }
        }
        return { ...base, status: 'active', trialRemainingDays: 0 };
    }

    // Trial
    if (profile.trial_start_date) {
        const trialStart = new Date(profile.trial_start_date);
        const trialEnd = new Date(trialStart.getTime() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000);
        const remaining = Math.max(0, Math.ceil((trialEnd.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));

        if (remaining > 0) {
            return { ...base, status: 'trial', trialRemainingDays: remaining };
        }
        return { ...base, status: 'expired', trialRemainingDays: 0 };
    }

    // No subscription, no trial → free
    return { ...base, status: 'free', trialRemainingDays: 0 };
}
