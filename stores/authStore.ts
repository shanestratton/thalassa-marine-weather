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
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { initLocalDatabase } from '../services/vessel/LocalDatabase';

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
        const previousUser = useAuthStore.getState().user;
        const previousUserId = previousUser?.id ?? null;
        // Hide/fence account-scoped offline state as soon as logout starts.
        setAuthIdentityScope(null);
        set({ user: null });
        setSentryUser(null);

        const restorePreviousSession = async () => {
            if (!previousUser || !previousUserId) return;
            setAuthIdentityScope(previousUserId);
            await Promise.allSettled([
                initLocalDatabase(previousUserId),
                PushNotificationService.setUser(previousUserId),
            ]);
            setSentryUser({ id: previousUserId, email: previousUser.email });
            set({ user: previousUser });
        };

        const isolationResults = await Promise.allSettled([
            PushNotificationService.clearUser(),
            initLocalDatabase(null),
        ]);
        for (const result of isolationResults) {
            if (result.status === 'rejected') {
                console.error('[Auth] Logout isolation cleanup failed:', result.reason);
            }
        }
        const pushIsolation = isolationResults[0];
        if (pushIsolation.status === 'rejected') {
            // Do not complete logout when both the server release and native
            // unregister failed: the signed-out device could keep receiving
            // the previous account's private notifications.
            await restorePreviousSession();
            throw pushIsolation.reason;
        }

        try {
            const { error } = await supabase.auth.signOut();
            if (error) throw error;
        } catch (error) {
            // The session remains active when signOut fails. Re-establish every
            // owner-bound subsystem before making the old user visible again.
            await restorePreviousSession();
            throw error;
        }
    },
}));

// ── Initialize auth listener ──────────────────────────────────────
function initAuth() {
    if (!supabase) {
        setAuthIdentityScope(null);
        void initLocalDatabase(null)
            .catch((error) => {
                console.error('[Auth] Could not initialize browse-mode storage:', error);
            })
            .finally(() => {
                useAuthStore.setState({ user: null, authChecked: true });
            });
        return;
    }

    PushNotificationService.initialize();

    let transitionVersion = 0;
    let authEventSeen = false;
    const applyAuthIdentity = (u: User | null) => {
        const version = ++transitionVersion;
        // Offline services must fence the old account synchronously before the
        // new user becomes observable in React or any async storage switch.
        setAuthIdentityScope(u?.id ?? null);
        // initLocalDatabase blocks old-scope reads synchronously, before the
        // auth state becomes visible to React.
        const identityReady = initLocalDatabase(u?.id ?? null);
        useAuthStore.setState({ user: u });
        if (u) {
            void PushNotificationService.setUser(u.id).catch((error) => {
                console.error('[Auth] Could not bind push notifications to the current user:', error);
            });
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
        void identityReady
            .catch((error) => {
                console.error('[Auth] Could not switch local database identity:', error);
            })
            .finally(() => {
                if (version === transitionVersion) {
                    useAuthStore.setState({ authChecked: true });
                }
            });
    };

    supabase.auth
        .getSession()
        .then(({ data: { session } }) => {
            if (!authEventSeen) applyAuthIdentity(session?.user ?? null);
        })
        .catch((error) => {
            console.error('[Auth] Initial session check failed:', error);
            if (!authEventSeen) applyAuthIdentity(null);
        });

    supabase.auth.onAuthStateChange((_event, session) => {
        authEventSeen = true;
        const u = session?.user ?? null;
        applyAuthIdentity(u);
        if (!u) {
            void PushNotificationService.clearUser().catch((error) => {
                console.error('[Auth] Could not release the previous push notification identity:', error);
            });
            setSentryUser(null);
        }
    });
}

initAuth();
