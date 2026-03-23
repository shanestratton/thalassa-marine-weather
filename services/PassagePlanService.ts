/**
 * PassagePlanService — Checks if the current user has an active passage plan
 * and returns their per-child-card permissions.
 *
 * Uses localStorage for offline caching + Supabase for authoritative state.
 * The passage owner always sees all cards.
 */

import { supabase } from './supabase';
import { type CrewPermissions, DEFAULT_PERMISSIONS, getMyMemberships } from './CrewService';
import { createLogger } from '../utils/createLogger';

const log = createLogger('PassagePlanService');

const CACHE_KEY = 'thalassa_passage_status';

/** What the UI needs to know about passage access */
export interface PassageStatus {
    /** Whether the user can see the Passage Planning card at all */
    visible: boolean;
    /** Whether the user is the owner/creator of the passage */
    isOwner: boolean;
    /** Per-child-card visibility */
    canViewMeals: boolean;
    canViewChat: boolean;
    canViewRoute: boolean;
    canViewChecklist: boolean;
}

const ALL_VISIBLE: PassageStatus = {
    visible: true,
    isOwner: true,
    canViewMeals: true,
    canViewChat: true,
    canViewRoute: true,
    canViewChecklist: true,
};

const HIDDEN: PassageStatus = {
    visible: false,
    isOwner: false,
    canViewMeals: false,
    canViewChat: false,
    canViewRoute: false,
    canViewChecklist: false,
};

/**
 * Check if the current user has an active passage plan saved locally.
 * This is set when they save a passage via the Route Planner.
 */
export function hasLocalPassagePlan(): boolean {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return false;
        const data = JSON.parse(raw);
        return data?.active === true;
    } catch {
        return false;
    }
}

/**
 * Mark that the current user has saved an active passage plan.
 * Called by PassagePlanSave when a route is saved.
 */
export function setPassagePlanActive(voyageId: string): void {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ active: true, voyageId, timestamp: Date.now() }));
    } catch {
        /* storage full */
    }
}

/** Clear the local passage plan status (e.g., when voyage ends). */
export function clearPassagePlan(): void {
    try {
        localStorage.removeItem(CACHE_KEY);
    } catch {
        /* ignore */
    }
}

/**
 * Get the full passage status for the current user.
 *
 * Priority:
 * 1. If user has a local saved passage → they're the owner → all visible
 * 2. If user has an accepted crew membership with passage permissions → show permitted cards
 * 3. Otherwise → hidden
 */
export async function getPassageStatus(): Promise<PassageStatus> {
    // 1. Check if owner (saved a passage locally)
    if (hasLocalPassagePlan()) {
        return ALL_VISIBLE;
    }

    // 2. Check crew memberships for passage permissions
    if (!supabase) return getCachedStatus();

    try {
        const memberships = await getMyMemberships();

        // Find any membership that grants passage access
        for (const m of memberships) {
            const perms: CrewPermissions = {
                ...DEFAULT_PERMISSIONS,
                ...(m.permissions || {}),
            };

            if (perms.can_view_passage) {
                const status: PassageStatus = {
                    visible: true,
                    isOwner: false,
                    canViewMeals: perms.can_view_passage_meals,
                    canViewChat: perms.can_view_passage_chat,
                    canViewRoute: perms.can_view_passage_route,
                    canViewChecklist: perms.can_view_passage_checklist,
                };

                // Cache for offline use
                cacheStatus(status);
                return status;
            }
        }

        // No passage access
        cacheStatus(HIDDEN);
        return HIDDEN;
    } catch (e) {
        log.warn('Failed to check passage status, using cache:', e);
        return getCachedStatus();
    }
}

/** Synchronous check — uses cached status from localStorage. */
export function getPassageStatusSync(): PassageStatus {
    if (hasLocalPassagePlan()) return ALL_VISIBLE;
    return getCachedStatus();
}

// ── Cache helpers ────────────────────────────────────────────────

const STATUS_CACHE_KEY = 'thalassa_passage_perms_cache';

function cacheStatus(status: PassageStatus): void {
    try {
        localStorage.setItem(STATUS_CACHE_KEY, JSON.stringify(status));
    } catch {
        /* full */
    }
}

function getCachedStatus(): PassageStatus {
    try {
        const raw = localStorage.getItem(STATUS_CACHE_KEY);
        if (raw) return JSON.parse(raw);
    } catch {
        /* corrupted */
    }
    return HIDDEN;
}
