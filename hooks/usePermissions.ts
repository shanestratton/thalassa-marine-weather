/**
 * usePermissions — Role-Based Access Control hook.
 *
 * Reads vessel_crew.permissions JSONB + role to determine what
 * the current user can see/do. The "Punter Filter":
 *
 *  Skipper:     Everything (stores, costs, passport data, weather master)
 *  Chef:        Galley, Stores, Shopping Lists
 *  Crew/Punter: Private Conflab + Report Position only
 *
 * Enforces access locally even when 200nm offshore.
 */

import { useState, useEffect } from 'react';
import { supabase } from '../services/supabase';
import {
    type CrewPermissions,
    type CrewRole,
    DEFAULT_PERMISSIONS,
    ROLE_DEFAULT_PERMISSIONS,
} from '../services/CrewService';
import { useAuthStore } from '../stores/authStore';

// ── Types ──────────────────────────────────────────────────────────────────

export interface PermissionsState {
    loaded: boolean;
    isSkipper: boolean;
    role: CrewRole | 'skipper';
    permissions: CrewPermissions;
    // Convenience booleans
    canViewStores: boolean;
    canEditStores: boolean;
    canViewGalley: boolean;
    canViewNav: boolean;
    canViewWeather: boolean;
    canEditLog: boolean;
    canViewCosts: boolean;
    canViewPassports: boolean;
    canManageCrew: boolean;
}

const CACHE_KEY_PREFIX = 'thalassa_permissions';
const CACHE_VERSION = 1;

interface PermissionCacheEntry {
    version: typeof CACHE_VERSION;
    userId: string;
    role: CrewRole | 'skipper';
    permissions: CrewPermissions;
}

interface ScopedPermissionsState {
    userId: string | null;
    state: PermissionsState;
}

// ── Skipper: full access ──────────────────────────────────────────────────

const SKIPPER_PERMISSIONS: PermissionsState = {
    loaded: true,
    isSkipper: true,
    role: 'skipper',
    permissions: {
        can_view_stores: true,
        can_edit_stores: true,
        can_view_galley: true,
        can_view_nav: true,
        can_view_weather: true,
        can_edit_log: true,
        can_view_passage: true,
        can_view_passage_meals: true,
        can_view_passage_chat: true,
        can_view_passage_route: true,
        can_view_passage_checklist: true,
    },
    canViewStores: true,
    canEditStores: true,
    canViewGalley: true,
    canViewNav: true,
    canViewWeather: true,
    canEditLog: true,
    canViewCosts: true,
    canViewPassports: true,
    canManageCrew: true,
};

// ── Role → expanded permissions ───────────────────────────────────────────

function expandPermissions(role: CrewRole | 'skipper', perms: CrewPermissions): PermissionsState {
    if (role === 'skipper') return SKIPPER_PERMISSIONS;

    return {
        loaded: true,
        isSkipper: false,
        role,
        permissions: perms,
        canViewStores: perms.can_view_stores,
        canEditStores: perms.can_edit_stores,
        canViewGalley: perms.can_view_galley,
        canViewNav: perms.can_view_nav,
        canViewWeather: perms.can_view_weather,
        canEditLog: perms.can_edit_log,
        // Chef sees costs, co-skipper sees passports
        canViewCosts: role === 'co-skipper' || perms.can_edit_stores,
        canViewPassports: role === 'co-skipper',
        canManageCrew: false,
    };
}

const RESTRICTED_PERMISSIONS = expandPermissions('punter', DEFAULT_PERMISSIONS);
const LOADING_PERMISSIONS: PermissionsState = {
    ...RESTRICTED_PERMISSIONS,
    loaded: false,
};

const CREW_ROLES: ReadonlySet<CrewRole | 'skipper'> = new Set([
    'skipper',
    'co-skipper',
    'navigator',
    'deckhand',
    'punter',
]);
const PERMISSION_KEYS = Object.keys(DEFAULT_PERMISSIONS) as (keyof CrewPermissions)[];

function cacheKey(userId: string): string {
    return `${CACHE_KEY_PREFIX}:${userId}`;
}

function isPermissionCacheEntry(value: unknown, expectedUserId: string): value is PermissionCacheEntry {
    if (!value || typeof value !== 'object') return false;

    const entry = value as Partial<PermissionCacheEntry>;
    if (
        entry.version !== CACHE_VERSION ||
        entry.userId !== expectedUserId ||
        typeof entry.role !== 'string' ||
        !CREW_ROLES.has(entry.role as CrewRole | 'skipper') ||
        !entry.permissions ||
        typeof entry.permissions !== 'object'
    ) {
        return false;
    }

    return PERMISSION_KEYS.every((key) => typeof entry.permissions?.[key] === 'boolean');
}

function readCachedPermissions(userId: string): PermissionsState | null {
    try {
        const key = cacheKey(userId);
        const raw = localStorage.getItem(key);
        if (!raw) return null;

        const parsed: unknown = JSON.parse(raw);
        if (!isPermissionCacheEntry(parsed, userId)) {
            localStorage.removeItem(key);
            return null;
        }
        return expandPermissions(parsed.role, parsed.permissions);
    } catch {
        return null;
    }
}

function writeCachedPermissions(userId: string, state: PermissionsState): void {
    const entry: PermissionCacheEntry = {
        version: CACHE_VERSION,
        userId,
        role: state.role,
        permissions: state.permissions,
    };
    try {
        localStorage.setItem(cacheKey(userId), JSON.stringify(entry));
    } catch {
        /* storage full or unavailable */
    }
}

function mergeCrewPermissions(role: CrewRole, value: unknown): CrewPermissions {
    const overrides =
        value && typeof value === 'object' ? (value as Partial<Record<keyof CrewPermissions, unknown>>) : {};
    const defaults = ROLE_DEFAULT_PERMISSIONS[role];

    return Object.fromEntries(
        PERMISSION_KEYS.map((key) => [key, typeof overrides[key] === 'boolean' ? overrides[key] : defaults[key]]),
    ) as unknown as CrewPermissions;
}

// ── Hook ───────────────────────────────────────────────────────────────────

export function usePermissions(): PermissionsState {
    const currentUserId = useAuthStore((auth) => auth.user?.id ?? null);
    const authChecked = useAuthStore((auth) => auth.authChecked);
    const [scopedState, setScopedState] = useState<ScopedPermissionsState>(() => {
        const cached = currentUserId ? readCachedPermissions(currentUserId) : null;
        return {
            userId: currentUserId,
            state: cached ?? LOADING_PERMISSIONS,
        };
    });

    useEffect(() => {
        let cancelled = false;

        if (!currentUserId) {
            setScopedState({
                userId: null,
                state: authChecked ? RESTRICTED_PERMISSIONS : LOADING_PERMISSIONS,
            });
            return;
        }

        const cached = readCachedPermissions(currentUserId);
        setScopedState({
            userId: currentUserId,
            state: cached ?? LOADING_PERMISSIONS,
        });

        if (!supabase) return;

        const commit = (state: PermissionsState) => {
            if (cancelled) return;
            setScopedState({ userId: currentUserId, state });
            writeCachedPermissions(currentUserId, state);
        };

        void (async () => {
            try {
                const {
                    data: { user },
                    error: authError,
                } = await supabase.auth.getUser();
                if (authError || user?.id !== currentUserId || cancelled) return;

                // Scope owner detection to the authenticated account. Reading
                // an arbitrary first vessel could grant skipper rights from a
                // previous account or another locally cached vessel.
                const { data: vessel, error: vesselError } = await supabase
                    .from('vessel_identity')
                    .select('user_id')
                    .eq('user_id', currentUserId)
                    .limit(1)
                    .maybeSingle();
                if (vesselError || cancelled) return;

                if ((vessel as { user_id?: string } | null)?.user_id === currentUserId) {
                    commit(SKIPPER_PERMISSIONS);
                    return;
                }

                const { data: crew, error: crewError } = await supabase
                    .from('vessel_crew')
                    .select('role, permissions')
                    .eq('crew_user_id', currentUserId)
                    .eq('status', 'accepted')
                    .limit(1)
                    .maybeSingle();
                if (crewError || cancelled) return;

                if (!crew) {
                    commit(RESTRICTED_PERMISSIONS);
                    return;
                }

                const rawRole = (crew as { role?: string }).role;
                const role: CrewRole =
                    rawRole && CREW_ROLES.has(rawRole as CrewRole) && rawRole !== 'skipper'
                        ? (rawRole as CrewRole)
                        : 'deckhand';
                const perms = mergeCrewPermissions(role, (crew as { permissions?: unknown }).permissions);
                commit(expandPermissions(role, perms));
            } catch {
                // Offline or temporarily unavailable: retain only this
                // authenticated account's validated cache.
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [authChecked, currentUserId]);

    // Effects run after paint. Never expose account A's state during the
    // render in which Zustand has already switched to account B.
    return scopedState.userId === currentUserId ? scopedState.state : LOADING_PERMISSIONS;
}

/**
 * Check a specific permission (for use outside React components).
 */
export function checkPermission(key: keyof CrewPermissions): boolean {
    const userId = useAuthStore.getState().user?.id;
    if (!userId) return false;

    const state = readCachedPermissions(userId);
    if (!state) return false;
    return state.isSkipper || state.permissions[key] === true;
}
