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
import { bindAppleCredentialUser, clearBoundAppleCredential } from '../services/auth/appleCredentialState';
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
        const authClient = supabase;
        if (!authClient) return;
        // Manual account departure must never strand a physical emergency or
        // anchor monitor under a different identity. This runs before the
        // synchronous auth fence or any remote sign-out mutation.
        const { assertNoActiveSafetyMonitor } = await import('../services/activeSafetyInterlock');
        await assertNoActiveSafetyMonitor('sign out');
        const previousUser = useAuthStore.getState().user;
        const previousUserId = previousUser?.id ?? null;
        // Hide/fence account-scoped offline state as soon as logout starts.
        setAuthIdentityScope(null);
        set({ user: null });
        setSentryUser(null);

        const restorePreviousSession = async () => {
            if (!previousUser || !previousUserId) return;
            const previousAppleSubject = appleSubjects(previousUser)[0];
            if (previousAppleSubject) {
                try {
                    await bindAppleCredentialUser(previousAppleSubject);
                } catch (bindingError) {
                    // Do not make a Supabase session visible again when Apple
                    // says its credential is no longer authorized (or the
                    // secure binding cannot be restored). Keep the app fenced.
                    console.error(
                        '[Auth] Could not restore Apple credential monitoring after logout rollback:',
                        bindingError,
                    );
                    await authClient.auth.signOut({ scope: 'local' }).catch(() => undefined);
                    return;
                }
            }
            setAuthIdentityScope(previousUserId);
            await Promise.allSettled([
                initLocalDatabase(previousUserId),
                PushNotificationService.setUser(previousUserId),
            ]);
            setSentryUser({ id: previousUserId });
            set({ user: previousUser });
        };

        const isolationResults = await Promise.allSettled([
            PushNotificationService.clearUser(),
            initLocalDatabase(null),
            clearBoundAppleCredential(),
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
            const { error } = await authClient.auth.signOut();
            if (error) throw error;
        } catch (error) {
            // The session remains active when signOut fails. Re-establish every
            // owner-bound subsystem before making the old user visible again.
            await restorePreviousSession();
            throw error;
        }
    },
}));

let nativeAppleRevocationHandling: Promise<void> | null = null;

function appleSubjects(user: User): string[] {
    return (user.identities ?? [])
        .filter((identity) => identity.provider === 'apple')
        .flatMap((identity) => [identity.identity_data?.sub, identity.identity_data?.provider_id, identity.identity_id])
        .filter((subject): subject is string => typeof subject === 'string' && subject.length > 0);
}

/**
 * Fence a natively-revoked Apple identity without ever mutating a different
 * current account. Remote account deletion is handled independently by the
 * signed Apple server-notification lifecycle; this client response removes
 * the session, push identity, Sentry identity, and active local DB scope.
 */
export function handleNativeAppleCredentialRevocation(appleUserId: string): Promise<void> {
    if (nativeAppleRevocationHandling) return nativeAppleRevocationHandling;

    nativeAppleRevocationHandling = (async () => {
        const currentUser = useAuthStore.getState().user;
        if (!currentUser || !appleSubjects(currentUser).includes(appleUserId)) {
            // A retained event from an earlier logout/account switch must not
            // sign out or delete the currently active identity.
            await clearBoundAppleCredential().catch(() => undefined);
            return;
        }

        setAuthIdentityScope(null);
        useAuthStore.setState({ user: null, authChecked: true });
        setSentryUser(null);

        const results = await Promise.allSettled([
            PushNotificationService.clearUser(),
            clearBoundAppleCredential(),
            supabase?.auth.signOut({ scope: 'local' }) ?? Promise.resolve(),
            initLocalDatabase(null),
        ]);
        for (const result of results) {
            if (result.status === 'rejected') {
                console.error('[Auth] Apple credential-revocation isolation failed:', result.reason);
            }
        }

        // Auth callbacks can run during sign-out. Reassert the terminal local
        // unauthenticated state after every asynchronous subsystem settles.
        setAuthIdentityScope(null);
        setSentryUser(null);
        useAuthStore.setState({ user: null, authChecked: true });
    })().finally(() => {
        nativeAppleRevocationHandling = null;
    });

    return nativeAppleRevocationHandling;
}

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
        const hasAppleIdentity = u?.identities?.some((identity) => identity.provider === 'apple') === true;
        if (!hasAppleIdentity) {
            // Prevent a Keychain binding from an old Apple session from being
            // applied to a later email or different-provider account.
            void clearBoundAppleCredential().catch((error) => {
                console.error('[Auth] Could not clear stale Apple credential binding:', error);
            });
        }
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
            setSentryUser({ id: u.id });
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
