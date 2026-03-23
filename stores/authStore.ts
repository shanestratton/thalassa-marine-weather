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
    logout: () => Promise<void>;
}

export const useAuthStore = create<AuthState>()((set) => ({
    user: null,
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
        useAuthStore.setState({ user: u });
        if (u) {
            PushNotificationService.setUser(u.id);
            PushNotificationService.requestPermissionAndRegister();
            setSentryUser({ id: u.id, email: u.email });
        }
    });

    supabase.auth.onAuthStateChange((_event, session) => {
        const u = session?.user ?? null;
        useAuthStore.setState({ user: u });
        if (u) {
            PushNotificationService.setUser(u.id);
            PushNotificationService.requestPermissionAndRegister();
            setSentryUser({ id: u.id, email: u.email });
        } else {
            PushNotificationService.clearUser();
            setSentryUser(null);
        }
    });
}

initAuth();
