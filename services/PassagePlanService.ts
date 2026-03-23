/**
 * PassagePlanService — Multi-passage aware.
 *
 * Tracks which draft voyage is currently selected and returns
 * per-child-card permissions for the Passage Planning card.
 *
 * Uses localStorage for the selected voyage + offline caching,
 * and Supabase for crew membership checks.
 */

import { supabase } from './supabase';
import { type CrewPermissions, DEFAULT_PERMISSIONS, getMyMemberships } from './CrewService';
import { createLogger } from '../utils/createLogger';

const log = createLogger('PassagePlanService');

// ── Constants ───────────────────────────────────────────────────
const SELECTED_PASSAGE_KEY = 'thalassa_selected_passage';
const STATUS_CACHE_KEY = 'thalassa_passage_perms_cache';

// ── Types ───────────────────────────────────────────────────────

/** What the UI needs to know about passage access */
export interface PassageStatus {
    /** Whether the user can see the Passage Planning card at all */
    visible: boolean;
    /** The selected voyage ID (null if none selected) */
    voyageId: string | null;
    /** Whether the user is the owner/creator of the passage */
    isOwner: boolean;
    /** Per-child-card visibility */
    canViewMeals: boolean;
    canViewChat: boolean;
    canViewRoute: boolean;
    canViewChecklist: boolean;
}

const ALL_VISIBLE = (voyageId: string): PassageStatus => ({
    visible: true,
    voyageId,
    isOwner: true,
    canViewMeals: true,
    canViewChat: true,
    canViewRoute: true,
    canViewChecklist: true,
});

const HIDDEN: PassageStatus = {
    visible: false,
    voyageId: null,
    isOwner: false,
    canViewMeals: false,
    canViewChat: false,
    canViewRoute: false,
    canViewChecklist: false,
};

// ── Active Passage Selection ────────────────────────────────────

/** Set the currently selected passage (called from Welcome Aboard dropdown). */
export function setActivePassage(voyageId: string): void {
    try {
        localStorage.setItem(SELECTED_PASSAGE_KEY, voyageId);
    } catch {
        /* storage full */
    }
    // Dispatch event so ChatPage can react
    window.dispatchEvent(new CustomEvent('thalassa:passage-changed', { detail: { voyageId } }));
}

/** Get the currently selected passage ID (synchronous). */
export function getActivePassageId(): string | null {
    try {
        return localStorage.getItem(SELECTED_PASSAGE_KEY) || null;
    } catch {
        return null;
    }
}

/** Clear the selected passage (e.g., voyage completed or disbanded). */
export function clearPassagePlan(): void {
    try {
        localStorage.removeItem(SELECTED_PASSAGE_KEY);
        localStorage.removeItem(STATUS_CACHE_KEY);
    } catch {
        /* ignore */
    }
    window.dispatchEvent(new CustomEvent('thalassa:passage-changed', { detail: { voyageId: null } }));
}

// ── Backward compat aliases ─────────────────────────────────────
/** @deprecated Use setActivePassage instead */
export function setPassagePlanActive(voyageId: string): void {
    setActivePassage(voyageId);
}

/** @deprecated Use getActivePassageId instead */
export function hasLocalPassagePlan(): boolean {
    return !!getActivePassageId();
}

// ── Passage Status ──────────────────────────────────────────────

/**
 * Get the full passage status for the current user.
 *
 * Priority:
 * 1. If user has a selected passage and owns that voyage → all visible
 * 2. If user has accepted crew membership with passage permissions → show permitted cards
 * 3. Otherwise → hidden
 */
export async function getPassageStatus(): Promise<PassageStatus> {
    const voyageId = getActivePassageId();

    // No passage selected → hidden
    if (!voyageId) {
        // Still check crew memberships — they might be invited to someone else's passage
        return checkCrewMemberships();
    }

    // Check if user owns this voyage
    if (supabase) {
        try {
            const {
                data: { user },
            } = await supabase.auth.getUser();
            if (user) {
                const { data } = await supabase.from('voyages').select('user_id').eq('id', voyageId).maybeSingle();

                if (data?.user_id === user.id) {
                    const status = ALL_VISIBLE(voyageId);
                    cacheStatus(status);
                    return status;
                }
            }
        } catch (e) {
            log.warn('Failed to check voyage ownership:', e);
        }
    }

    // Check crew memberships
    return checkCrewMemberships();
}

/** Check if user has passage access via crew membership. */
async function checkCrewMemberships(): Promise<PassageStatus> {
    if (!supabase) return getCachedStatus();

    try {
        const memberships = await getMyMemberships();

        for (const m of memberships) {
            const perms: CrewPermissions = {
                ...DEFAULT_PERMISSIONS,
                ...(m.permissions || {}),
            };

            if (perms.can_view_passage) {
                const status: PassageStatus = {
                    visible: true,
                    voyageId: m.voyage_id || null,
                    isOwner: false,
                    canViewMeals: perms.can_view_passage_meals,
                    canViewChat: perms.can_view_passage_chat,
                    canViewRoute: perms.can_view_passage_route,
                    canViewChecklist: perms.can_view_passage_checklist,
                };

                cacheStatus(status);
                return status;
            }
        }

        cacheStatus(HIDDEN);
        return HIDDEN;
    } catch (e) {
        log.warn('Failed to check passage status, using cache:', e);
        return getCachedStatus();
    }
}

/** Synchronous check — uses localStorage cache. */
export function getPassageStatusSync(): PassageStatus {
    const voyageId = getActivePassageId();
    if (voyageId) {
        // Assume owner if they selected it locally (async will verify)
        return ALL_VISIBLE(voyageId);
    }
    return getCachedStatus();
}

// ── Cache helpers ────────────────────────────────────────────────

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
