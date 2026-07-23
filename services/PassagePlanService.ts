/**
 * PassagePlanService — Multi-passage aware.
 *
 * Tracks which draft voyage is currently selected and returns
 * per-child-card permissions for the Passage Planning card.
 *
 * Uses localStorage for the selected voyage and Supabase for authoritative
 * owner/crew membership checks. Permission grants are deliberately not cached:
 * stale grants must never survive an account switch or failed verification.
 */

import { supabase } from './supabase';
import { type CrewMember, type CrewPermissions, DEFAULT_PERMISSIONS, getMyMemberships } from './CrewService';
import { type Voyage } from './VoyageService';
import { createLogger } from '../utils/createLogger';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    type AuthIdentityScope,
} from './authIdentityScope';

const log = createLogger('PassagePlanService');

// ── Constants ───────────────────────────────────────────────────
const SELECTED_PASSAGE_KEY = 'thalassa_selected_passage';

function selectedPassageStorageKey(scope: AuthIdentityScope = getAuthIdentityScope()): string {
    return authScopedStorageKey(SELECTED_PASSAGE_KEY, scope);
}

function identityStillOwns(scope: AuthIdentityScope, userId: string): boolean {
    return isAuthIdentityScopeCurrent(scope) && scope.userId === userId;
}

// ── Types ───────────────────────────────────────────────────────

/** What the UI needs to know about passage access */
export interface PassageStatus {
    /** Whether the user can see the Passage Planning card at all */
    visible: boolean;
    /** The selected voyage ID (null if none selected) */
    voyageId: string | null;
    /** Authoritative owner of the selected voyage. */
    ownerUserId: string | null;
    /** Whether the user is the owner/creator of the passage */
    isOwner: boolean;
    /** Whether this user may mutate this owner's Ship's Stores register. */
    canEditStores: boolean;
    /** Per-child-card visibility */
    canViewMeals: boolean;
    canViewChat: boolean;
    canViewRoute: boolean;
    canViewChecklist: boolean;
}

export interface AuthorizedSharedVoyage {
    voyage: Voyage;
    ownerEmail: string;
}

export interface AuthorizedSharedVoyagesResult {
    voyages: AuthorizedSharedVoyage[];
    /**
     * False means at least one ownership lookup failed. Callers must not use
     * an incomplete result to "heal" (replace or clear) an existing passage.
     */
    complete: boolean;
}

const ALL_VISIBLE = (voyageId: string, ownerUserId: string): PassageStatus => ({
    visible: true,
    voyageId,
    ownerUserId,
    isOwner: true,
    canEditStores: true,
    canViewMeals: true,
    canViewChat: true,
    canViewRoute: true,
    canViewChecklist: true,
});

const permissionsFor = (membership: CrewMember): CrewPermissions => ({
    ...DEFAULT_PERMISSIONS,
    ...(membership.permissions || {}),
});

/**
 * Fail-closed passage access. Components should use this while the async
 * ownership/membership check is in flight instead of inferring ownership from
 * a locally selected voyage ID.
 */
export const NO_PASSAGE_ACCESS: PassageStatus = {
    visible: false,
    voyageId: null,
    ownerUserId: null,
    isOwner: false,
    canEditStores: false,
    canViewMeals: false,
    canViewChat: false,
    canViewRoute: false,
    canViewChecklist: false,
};

// ── Active Passage Selection ────────────────────────────────────

/** Set the currently selected passage (called from Welcome Aboard dropdown). */
export function setActivePassage(voyageId: string): void {
    try {
        localStorage.setItem(selectedPassageStorageKey(), voyageId);
    } catch {
        /* storage full */
    }
    // Dispatch event so ChatPage can react.
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('thalassa:passage-changed', { detail: { voyageId } }));
    }
}

/** Get the currently selected passage ID (synchronous). */
export function getActivePassageId(): string | null {
    try {
        return localStorage.getItem(selectedPassageStorageKey()) || null;
    } catch {
        return null;
    }
}

/** Clear the selected passage (e.g., voyage completed or disbanded). */
export function clearPassagePlan(): void {
    try {
        localStorage.removeItem(selectedPassageStorageKey());
    } catch {
        /* ignore */
    }
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('thalassa:passage-changed', { detail: { voyageId: null } }));
    }
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
export async function getPassageStatus(selectedVoyageId: string | null = getActivePassageId()): Promise<PassageStatus> {
    if (!selectedVoyageId || !supabase) return NO_PASSAGE_ACCESS;
    const identity = getAuthIdentityScope();

    try {
        const {
            data: { user },
        } = await supabase.auth.getUser();
        if (!user || !identityStillOwns(identity, user.id)) return NO_PASSAGE_ACCESS;

        // The voyage row is authoritative for ownership. A membership row
        // cannot grant access until this lookup succeeds because both scoped
        // and legacy grants must agree with the voyage's actual owner.
        const { data: voyage, error } = await supabase
            .from('voyages')
            .select('user_id')
            .eq('id', selectedVoyageId)
            .maybeSingle();
        if (error || !voyage?.user_id || !identityStillOwns(identity, user.id)) return NO_PASSAGE_ACCESS;

        if (voyage.user_id === user.id) {
            return ALL_VISIBLE(selectedVoyageId, voyage.user_id);
        }

        return checkCrewMemberships(selectedVoyageId, voyage.user_id, user.id, identity);
    } catch (e) {
        log.warn('Failed to verify passage ownership:', e);
        return NO_PASSAGE_ACCESS;
    }
}

/** Check if user has passage access via crew membership. */
async function checkCrewMemberships(
    selectedVoyageId: string,
    selectedVoyageOwnerId: string,
    currentUserId: string,
    identity: AuthIdentityScope,
): Promise<PassageStatus> {
    if (!supabase || !identityStillOwns(identity, currentUserId)) return NO_PASSAGE_ACCESS;

    try {
        const memberships = await getMyMemberships();
        if (!identityStillOwns(identity, currentUserId)) return NO_PASSAGE_ACCESS;
        const applicableMemberships = memberships.filter(
            (membership) =>
                membership.status === 'accepted' &&
                membership.crew_user_id === currentUserId &&
                membership.owner_id === selectedVoyageOwnerId &&
                (membership.voyage_id === selectedVoyageId || membership.voyage_id === null),
        );
        const grants = applicableMemberships.map(permissionsFor).filter((permissions) => permissions.can_view_passage);
        if (grants.length === 0) return NO_PASSAGE_ACCESS;

        // Multiple valid rows can coexist during the legacy→scoped rollout.
        // Match the database's EXISTS policies by unioning their child grants.
        return {
            visible: true,
            voyageId: selectedVoyageId,
            ownerUserId: selectedVoyageOwnerId,
            isOwner: false,
            canEditStores: applicableMemberships.some((membership) => permissionsFor(membership).can_edit_stores),
            canViewMeals: grants.some((permissions) => permissions.can_view_passage_meals),
            canViewChat: grants.some((permissions) => permissions.can_view_passage_chat),
            canViewRoute: grants.some((permissions) => permissions.can_view_passage_route),
            canViewChecklist: grants.some((permissions) => permissions.can_view_passage_checklist),
        };
    } catch (e) {
        // Permission failures must not resurrect a grant cached by a previous
        // session/account on the same device.
        log.warn('Failed to verify passage status:', e);
        return NO_PASSAGE_ACCESS;
    }
}

/**
 * Resolve every shared passage the supplied accepted memberships authorize.
 *
 * Scoped memberships resolve only their exact voyage. Legacy memberships
 * resolve the owner's planning/active voyages. Every returned row is checked
 * against the voyage's real `user_id`; malformed or stale grants are ignored.
 */
export async function getAuthorizedSharedVoyages(): Promise<AuthorizedSharedVoyagesResult> {
    if (!supabase) return { voyages: [], complete: false };
    const identity = getAuthIdentityScope();

    try {
        const {
            data: { user },
        } = await supabase.auth.getUser();
        if (!user || !identityStillOwns(identity, user.id)) return { voyages: [], complete: false };

        // Query directly instead of accepting CrewService's convenience
        // result: that API intentionally returns [] on network/RLS errors,
        // which is fine for a roster empty state but unsafe for orphan
        // healing. Here an error must remain distinguishable from "no
        // memberships" so a transient outage cannot clear a valid passage.
        const { data: membershipRows, error: membershipError } = await supabase
            .from('vessel_crew')
            .select('*')
            .eq('crew_user_id', user.id)
            .eq('status', 'accepted');
        if (membershipError || !identityStillOwns(identity, user.id)) {
            return { voyages: [], complete: false };
        }

        const memberships = ((membershipRows || []) as CrewMember[]).filter(
            (membership) =>
                membership.status === 'accepted' && membership.crew_user_id === user.id && Boolean(membership.owner_id),
        );
        const passageMemberships = memberships.filter((membership) => {
            const permissions = permissionsFor(membership);
            return permissions.can_view_passage;
        });

        if (passageMemberships.length === 0) {
            return { voyages: [], complete: true };
        }

        const scopedIds = [
            ...new Set(
                passageMemberships
                    .map((membership) => membership.voyage_id)
                    .filter((voyageId): voyageId is string => Boolean(voyageId)),
            ),
        ];
        const legacyOwnerIds = [
            ...new Set(
                passageMemberships
                    .filter((membership) => membership.voyage_id === null)
                    .map((membership) => membership.owner_id),
            ),
        ];

        const resolvedRows: Voyage[] = [];
        let complete = true;

        if (scopedIds.length > 0) {
            const { data, error } = await supabase.from('voyages').select('*').in('id', scopedIds);
            if (!identityStillOwns(identity, user.id)) return { voyages: [], complete: false };
            if (error) complete = false;
            else resolvedRows.push(...((data || []) as Voyage[]));
        }

        if (legacyOwnerIds.length > 0) {
            const { data, error } = await supabase
                .from('voyages')
                .select('*')
                .in('user_id', legacyOwnerIds)
                .in('status', ['planning', 'active']);
            if (!identityStillOwns(identity, user.id)) return { voyages: [], complete: false };
            if (error) complete = false;
            else resolvedRows.push(...((data || []) as Voyage[]));
        }

        const deduped = new Map<string, AuthorizedSharedVoyage>();
        for (const voyage of resolvedRows) {
            const applicableMemberships = memberships.filter(
                (candidate) =>
                    candidate.owner_id === voyage.user_id &&
                    (candidate.voyage_id === voyage.id || candidate.voyage_id === null),
            );
            const membership = applicableMemberships.find((candidate) => permissionsFor(candidate).can_view_passage);
            if (!membership || voyage.user_id === user.id) continue;

            deduped.set(voyage.id, {
                voyage,
                ownerEmail: membership.owner_email,
            });
        }

        return identityStillOwns(identity, user.id)
            ? { voyages: [...deduped.values()], complete }
            : { voyages: [], complete: false };
    } catch (e) {
        log.warn('Failed to resolve shared passages:', e);
        return { voyages: [], complete: false };
    }
}

/** Synchronous checks cannot establish identity/ownership, so fail closed. */
export function getPassageStatusSync(): PassageStatus {
    return NO_PASSAGE_ACCESS;
}
