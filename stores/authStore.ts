/**
 * Auth Store — Zustand replacement for AuthContext.
 *
 * Manages Supabase user state, push notification registration,
 * and Sentry user tracking. Initializes on module load.
 */

import { create } from 'zustand';
import type { User } from '@supabase/supabase-js';
import { supabase } from '../services/supabase';
import { PushNotificationService } from '../services/PushNotificationService';
import { setUser as setSentryUser } from '../services/sentry';

interface AuthState {
    user: User | null;
    /**
     * Has the initial session check completed? Distinguishes "still
     * loading on cold boot" from "definitely not signed in" so the
     * AuthGate doesn't flash the SignInScreen for a frame on every
     * cold start while supabase.auth.getSession resolves.
     */
    authChecked: boolean;
    logout: () => Promise<void>;
}

export const useAuthStore = create<AuthState>()((set) => ({
    user: null,
    authChecked: false,
    logout: async () => {
        if (!supabase) return;
        await PushNotificationService.clearUser();
        setSentryUser(null);
        await supabase.auth.signOut();
        set({ user: null });
    },
}));

// ── Initialize auth listener ──────────────────────────────────────
function initAuth() {
    if (!supabase) return;

    PushNotificationService.initialize();

    supabase.auth.getSession().then(({ data: { session } }) => {
        const u = session?.user ?? null;
        useAuthStore.setState({ user: u, authChecked: true });
        if (u) {
            PushNotificationService.setUser(u.id);
            // No auto requestPermissionAndRegister() at boot — that
            // was the second iOS prompt sailors saw on first launch
            // ("Thalassa would like to send you notifications"). Push
            // is now deferred to point-of-need: AnchorWatchSyncService
            // calls requestPermissionAndRegister() the first time the
            // user starts anchor watch with cloud sync, and any other
            // feature that needs push can do the same. Sign-in does
            // not need the prompt.
            setSentryUser({ id: u.id, email: u.email });
        }
    });

    supabase.auth.onAuthStateChange((_event, session) => {
        const u = session?.user ?? null;
        useAuthStore.setState({ user: u });
        if (u) {
            PushNotificationService.setUser(u.id);
            setSentryUser({ id: u.id, email: u.email });
        } else {
            PushNotificationService.clearUser();
            setSentryUser(null);
        }
    });
}

initAuth();
