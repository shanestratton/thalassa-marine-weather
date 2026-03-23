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

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../services/supabase';
import {
    type CrewPermissions,
    type CrewRole,
    DEFAULT_PERMISSIONS,
    ROLE_DEFAULT_PERMISSIONS,
} from '../services/CrewService';

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

const CACHE_KEY = 'thalassa_permissions';

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

// ── Hook ───────────────────────────────────────────────────────────────────

export function usePermissions(): PermissionsState {
    const [state, setState] = useState<PermissionsState>(() => {
        // Load from cache for instant offline display
        try {
            const raw = localStorage.getItem(CACHE_KEY);
            if (raw) return JSON.parse(raw);
        } catch {
            /* ignore */
        }
        // Default to skipper if no cache (owner's device)
        return { ...SKIPPER_PERMISSIONS, loaded: false };
    });

    const fetchPermissions = useCallback(async () => {
        if (!supabase) {
            // Offline — use cached
            return;
        }

        const {
            data: { user },
        } = await supabase.auth.getUser();
        if (!user) return;

        // Check if user is the vessel owner (skipper)
        const { data: vessel } = await supabase.from('vessel_identity').select('user_id').limit(1).maybeSingle();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (vessel && (vessel as any).user_id === user.id) {
            setState(SKIPPER_PERMISSIONS);
            try {
                localStorage.setItem(CACHE_KEY, JSON.stringify(SKIPPER_PERMISSIONS));
            } catch {
                /* full */
            }
            return;
        }

        // Fetch crew record
        const { data: crew } = await supabase
            .from('vessel_crew')
            .select('role, permissions')
            .eq('crew_user_id', user.id)
            .eq('status', 'accepted')
            .limit(1)
            .maybeSingle();

        if (!crew) {
            // Not a crew member — restrict to punter defaults
            const punterState = expandPermissions('punter', DEFAULT_PERMISSIONS);
            setState(punterState);
            return;
        }

        const role = ((crew as { role?: string }).role || 'deckhand') as CrewRole;
        const perms = {
            ...ROLE_DEFAULT_PERMISSIONS[role],
            ...((crew as { permissions?: Partial<CrewPermissions> }).permissions || {}),
        };

        const permState = expandPermissions(role, perms);
        setState(permState);

        try {
            localStorage.setItem(CACHE_KEY, JSON.stringify(permState));
        } catch {
            /* full */
        }
    }, []);

    useEffect(() => {
        fetchPermissions();
    }, [fetchPermissions]);

    return state;
}

/**
 * Check a specific permission (for use outside React components).
 */
export function checkPermission(key: keyof CrewPermissions): boolean {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return true; // Default to allowed if no cache (owner)
        const state: PermissionsState = JSON.parse(raw);
        if (state.isSkipper) return true;
        return state.permissions[key] ?? false;
    } catch {
        return true; // Fail open
    }
}
