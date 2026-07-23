/**
 * PushNotificationService — Manages APNs device token registration & storage
 *
 * Handles:
 * - Requesting push notification permissions
 * - Registering for remote notifications
 * - Storing device token in Supabase `push_device_tokens` (user-scoped)
 * - Listening for foreground notifications
 * - Deep-link handling on notification tap
 */

import { PushNotifications } from '@capacitor/push-notifications';
import { Capacitor } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import { supabase } from './supabase';
import { createLogger } from '../utils/createLogger';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, type AuthIdentityScope } from './authIdentityScope';

const log = createLogger('Push');

export type ForegroundPushNotification = {
    title?: string;
    body?: string;
    data?: Record<string, unknown>;
};

export type PushNotificationHandlers = Readonly<{
    onForegroundPush: (notification: ForegroundPushNotification) => void;
    onNotificationTap: (data: Record<string, unknown>) => void;
}>;

type ScopedCallback<T> = Readonly<{
    scope: AuthIdentityScope;
    callback: (value: T) => void;
}>;

type TokenWaiter = {
    readonly scope: AuthIdentityScope;
    readonly finish: (token: string | null) => void;
};

type RegistrationAttempt = Readonly<{
    scope: AuthIdentityScope;
}>;

class PushNotificationServiceClass {
    private deviceToken: string | null = null;
    private initialized = false;
    private initializing: Promise<void> | null = null;
    private userId: string | null = null;
    private ownerScope: AuthIdentityScope | null = null;
    private associationTail: Promise<void> = Promise.resolve();
    private tokenWaiters = new Set<TokenWaiter>();
    private registrationAttempts: RegistrationAttempt[] = [];
    private nativeListeners: PluginListenerHandle[] = [];
    private initGeneration = 0;
    private foregroundBinding: ScopedCallback<ForegroundPushNotification> | null = null;
    private tapBinding: ScopedCallback<Record<string, unknown>> | null = null;

    /**
     * UI callbacks are bound to the exact auth generation in which they were
     * installed. The UI layer must reinstall them when AuthIdentityScope
     * changes; an A callback is deliberately inert after a switch to B.
     *
     * @deprecated Use bindNotificationHandlers with an explicitly captured
     * AuthIdentityScope. This compatibility property cannot prove the caller's
     * originating scope if assigned from a stale async continuation.
     */
    get onNotificationTap(): ((data: Record<string, unknown>) => void) | null {
        return this.tapBinding?.callback ?? null;
    }

    set onNotificationTap(callback: ((data: Record<string, unknown>) => void) | null) {
        this.tapBinding = callback
            ? Object.freeze({
                  scope: getAuthIdentityScope(),
                  callback,
              })
            : null;
    }

    /**
     * @deprecated Use bindNotificationHandlers.
     */
    get onForegroundPush(): ((notification: ForegroundPushNotification) => void) | null {
        return this.foregroundBinding?.callback ?? null;
    }

    set onForegroundPush(callback: ((notification: ForegroundPushNotification) => void) | null) {
        this.foregroundBinding = callback
            ? Object.freeze({
                  scope: getAuthIdentityScope(),
                  callback,
              })
            : null;
    }

    /**
     * Install UI handlers for one immutable auth generation. Cleanup compares
     * binding object identity, so a delayed A cleanup cannot remove B's newer
     * handlers.
     */
    bindNotificationHandlers(scope: AuthIdentityScope, handlers: PushNotificationHandlers): () => void {
        if (!this.isOwnedScope(scope)) return () => undefined;

        const foregroundBinding: ScopedCallback<ForegroundPushNotification> = Object.freeze({
            scope,
            callback: handlers.onForegroundPush,
        });
        const tapBinding: ScopedCallback<Record<string, unknown>> = Object.freeze({
            scope,
            callback: handlers.onNotificationTap,
        });
        this.foregroundBinding = foregroundBinding;
        this.tapBinding = tapBinding;

        return () => {
            if (this.foregroundBinding === foregroundBinding) this.foregroundBinding = null;
            if (this.tapBinding === tapBinding) this.tapBinding = null;
        };
    }

    /**
     * Initialize push notifications.
     * Call this early in the app lifecycle (e.g., AuthContext on login).
     */
    async initialize(): Promise<void> {
        if (this.initialized) return;
        if (!Capacitor.isNativePlatform()) return;
        if (this.initializing) return this.initializing;

        const generation = ++this.initGeneration;
        this.initializing = (async () => {
            const installed: PluginListenerHandle[] = [];
            try {
                // Listen for registration success
                installed.push(
                    await PushNotifications.addListener('registration', (token) => {
                        const eventScope = getAuthIdentityScope();
                        const tokenValue = token.value;
                        if (!this.isValidDeviceToken(tokenValue)) return;

                        // Capacitor's native callback has no request id. Consume
                        // register() attempts in order and quarantine a token
                        // callback initiated in A if it arrives after B became
                        // current. Unsolicited APNs token rotations have no
                        // queued attempt and bind to the current exact scope.
                        const attempt = this.registrationAttempts.shift();
                        if (attempt && !this.isExactScope(attempt.scope, eventScope)) {
                            return;
                        }
                        if (!this.isOwnedScope(eventScope)) return;

                        const previousToken = this.deviceToken;
                        this.deviceToken = tokenValue;
                        log.info('APNs token received');

                        let deliveredToWaiter = false;
                        for (const waiter of [...this.tokenWaiters]) {
                            if (this.isExactScope(waiter.scope, eventScope)) {
                                deliveredToWaiter = true;
                                waiter.finish(tokenValue);
                            }
                        }

                        if (deliveredToWaiter) return;
                        void this.enqueueAssociation(async () => {
                            const associated = await this.claimTokenAssociation(eventScope, tokenValue);
                            if (
                                associated &&
                                previousToken &&
                                previousToken !== tokenValue &&
                                this.isOwnedScope(eventScope)
                            ) {
                                await this.releaseTokenAssociation(eventScope, previousToken);
                            }
                        }).catch((error) => {
                            log.warn('Push token association failed:', this.errorMessage(error));
                        });
                    }),
                );

                // Listen for registration errors
                installed.push(
                    await PushNotifications.addListener('registrationError', (error) => {
                        log.warn('Push registration error:', error);
                        const failedAttempt = this.registrationAttempts.shift();
                        if (!failedAttempt) return;
                        for (const waiter of [...this.tokenWaiters]) {
                            if (this.isExactScope(waiter.scope, failedAttempt.scope)) waiter.finish(null);
                        }
                    }),
                );

                // Listen for incoming notifications (foreground)
                installed.push(
                    await PushNotifications.addListener('pushNotificationReceived', (notification) => {
                        const eventScope = getAuthIdentityScope();
                        const binding = this.foregroundBinding;
                        if (
                            !binding ||
                            !this.isOwnedScope(eventScope) ||
                            !this.isExactScope(binding.scope, eventScope)
                        ) {
                            return;
                        }

                        log.info('Push received (foreground):', notification.title);
                        const data = notification.data
                            ? Object.freeze({ ...(notification.data as Record<string, unknown>) })
                            : undefined;
                        binding.callback(
                            Object.freeze({
                                title: notification.title ?? undefined,
                                body: notification.body ?? undefined,
                                data,
                            }),
                        );
                    }),
                );

                // Listen for notification taps (user opened notification from lock screen / notification center)
                installed.push(
                    await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
                        const eventScope = getAuthIdentityScope();
                        const binding = this.tapBinding;
                        const data = action.notification?.data as Record<string, unknown> | undefined;
                        if (
                            !binding ||
                            !data ||
                            !this.isOwnedScope(eventScope) ||
                            !this.isExactScope(binding.scope, eventScope)
                        ) {
                            return;
                        }

                        log.info('Push tapped:', data);
                        binding.callback(Object.freeze({ ...data }));
                    }),
                );

                // dispose() may have run while an addListener promise was
                // pending. Never publish handles from the obsolete attempt.
                if (generation !== this.initGeneration) {
                    await this.removeNativeListeners(installed);
                    return;
                }

                this.nativeListeners = installed;
                this.initialized = true;
                log.info('Push notifications initialized');
            } catch (error) {
                await this.removeNativeListeners(installed);
                log.warn('Push init failed (best-effort):', error);
            } finally {
                if (generation === this.initGeneration) {
                    this.initializing = null;
                }
            }
        })();
        return this.initializing;
    }

    /**
     * Tear down physical native listeners and pending token timers.
     * The app normally keeps this singleton alive for its full process
     * lifetime; this exists for explicit app teardown and deterministic tests.
     */
    async dispose(): Promise<void> {
        ++this.initGeneration;
        this.initialized = false;
        this.cancelTokenWaiters();
        this.registrationAttempts = [];
        const pendingInitialization = this.initializing;
        const listeners = this.nativeListeners;
        this.nativeListeners = [];
        await pendingInitialization;
        await this.removeNativeListeners(listeners);
        this.initializing = null;
    }

    /**
     * Request permission and register for push notifications.
     * Returns the device token or null if denied/failed.
     * Also saves the token to Supabase for the current user.
     */
    async requestPermissionAndRegister(): Promise<string | null> {
        if (!Capacitor.isNativePlatform()) return null;
        const requestScope = getAuthIdentityScope();
        if (!this.isOwnedScope(requestScope)) return null;
        const requestIsCurrent = () => this.isOwnedScope(requestScope);

        try {
            await this.initialize();
            if (!requestIsCurrent()) return null;

            // Check current permission status
            const status = await PushNotifications.checkPermissions();
            if (!requestIsCurrent()) return null;

            if (status.receive === 'prompt' || status.receive === 'prompt-with-rationale') {
                const result = await PushNotifications.requestPermissions();
                if (!requestIsCurrent() || result.receive !== 'granted') {
                    log.info('Push permission denied by user');
                    return null;
                }
            } else if (status.receive !== 'granted') {
                log.info('Push permission not granted:', status.receive);
                return null;
            }

            // Register with APNs
            const registrationAttempt = Object.freeze({ scope: requestScope });
            this.registrationAttempts.push(registrationAttempt);
            try {
                await PushNotifications.register();
            } catch (error) {
                const attemptIndex = this.registrationAttempts.indexOf(registrationAttempt);
                if (attemptIndex >= 0) this.registrationAttempts.splice(attemptIndex, 1);
                throw error;
            }
            if (!requestIsCurrent()) {
                const attemptIndex = this.registrationAttempts.indexOf(registrationAttempt);
                if (attemptIndex >= 0) this.registrationAttempts.splice(attemptIndex, 1);
                return null;
            }

            // Wait for token if not already received
            if (this.deviceToken) {
                const attemptIndex = this.registrationAttempts.indexOf(registrationAttempt);
                if (attemptIndex >= 0) this.registrationAttempts.splice(attemptIndex, 1);
                const token = this.deviceToken;
                const associated = await this.enqueueAssociation(() => this.claimTokenAssociation(requestScope, token));
                return associated && requestIsCurrent() ? token : null;
            }

            return new Promise((resolve) => {
                let settled = false;
                const finish = (value: string | null) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timeout);
                    this.tokenWaiters.delete(waiter);
                    const attemptIndex = this.registrationAttempts.indexOf(registrationAttempt);
                    if (attemptIndex >= 0) this.registrationAttempts.splice(attemptIndex, 1);
                    resolve(value);
                };
                const timeout = setTimeout(() => {
                    log.warn('Push token timeout (10s)');
                    finish(null);
                }, 10000);
                const waiter: TokenWaiter = Object.freeze({
                    scope: requestScope,
                    finish: (token) => {
                        if (!token || !requestIsCurrent()) {
                            finish(null);
                            return;
                        }
                        void this.enqueueAssociation(() => this.claimTokenAssociation(requestScope, token))
                            .then((associated) => finish(associated && requestIsCurrent() ? token : null))
                            .catch((error) => {
                                log.warn('Push token association failed:', this.errorMessage(error));
                                finish(null);
                            });
                    },
                });
                if (!requestIsCurrent()) {
                    finish(null);
                    return;
                }
                this.tokenWaiters.add(waiter);
            });
        } catch (error) {
            log.warn('Push registration failed:', error);
            return null;
        }
    }

    /**
     * Set the current user ID. Called on login.
     * Automatically saves any existing token to Supabase.
     */
    async setUser(userId: string): Promise<void> {
        const normalizedUserId = userId.trim();
        if (!normalizedUserId) return this.clearUser();
        const scope = getAuthIdentityScope();
        if (scope.userId !== normalizedUserId || !isAuthIdentityScopeCurrent(scope)) {
            throw new Error('Push user must match the current auth identity scope');
        }

        const token = this.deviceToken;
        this.userId = normalizedUserId;
        this.ownerScope = scope;
        this.cancelTokenWaitersExcept(scope);
        this.cancelRegistrationAttemptsExcept(scope);

        // The server RPC atomically transfers this exact opaque token to the
        // authenticated owner. It does not rely on deleting A under B's RLS
        // session, which silently left duplicate A+B associations.
        if (token) {
            const associated = await this.enqueueAssociation(() => this.claimTokenAssociation(scope, token));
            if (!associated && this.isOwnedScope(scope)) {
                throw new Error('Push token association was not accepted for the current user');
            }
        }
    }

    /**
     * Clear user association. Called on logout.
     * Removes the device token from Supabase.
     */
    async clearUser(): Promise<void> {
        const previousScope = this.ownerScope;
        const token = this.deviceToken;
        this.userId = null;
        this.ownerScope = null;
        this.foregroundBinding = null;
        this.tapBinding = null;
        this.cancelTokenWaiters();
        this.registrationAttempts = [];

        const releasePromise =
            previousScope?.userId && token
                ? this.enqueueAssociation(() => this.releaseTokenAssociation(previousScope, token))
                : null;
        const unregisterPromise = Capacitor.isNativePlatform()
            ? PushNotifications.unregister().then(
                  () => true,
                  (error) => {
                      log.warn('Native push unregister failed:', this.errorMessage(error));
                      return false;
                  },
              )
            : Promise.resolve(true);
        const deliveredCleanupPromise = Capacitor.isNativePlatform()
            ? PushNotifications.removeAllDeliveredNotifications().catch((error) => {
                  log.warn('Delivered notification cleanup failed:', this.errorMessage(error));
              })
            : Promise.resolve();

        const [releaseResult, nativeUnregistered] = await Promise.all([
            releasePromise
                ? releasePromise.then(
                      (released) => released,
                      (error) => {
                          log.warn('Push token release failed:', this.errorMessage(error));
                          return false;
                      },
                  )
                : Promise.resolve(false),
            unregisterPromise,
            deliveredCleanupPromise,
        ]);

        if (nativeUnregistered) this.deviceToken = null;

        // On native, either the exact server association must be gone or the
        // OS registration must be invalidated. The latter is essential after
        // a cold start where this process never observed the historic token.
        if (Capacitor.isNativePlatform() && previousScope?.userId && !releaseResult && !nativeUnregistered) {
            throw new Error('Push identity could not be isolated for logout');
        }
        if (!Capacitor.isNativePlatform() && releasePromise && !releaseResult) {
            throw new Error('Push token association could not be released');
        }
    }

    /** Get the current device token (null if not registered) */
    getToken(): string | null {
        return this.deviceToken;
    }

    /** Check if push notifications are supported and permitted */
    async isAvailable(): Promise<boolean> {
        if (!Capacitor.isNativePlatform()) return false;
        try {
            const status = await PushNotifications.checkPermissions();
            return status.receive === 'granted';
        } catch (e) {
            log.warn('[PushNotification]', e);
            return false;
        }
    }

    /**
     * Clear badge count — call when app enters foreground.
     * Resets the iOS badge to 0 and marks pending notifications as "read" in DB.
     *
     * Guard against the "capacitorDidRegisterForRemoteNotifications not called"
     * spam: if the app doesn't have the Push Notifications capability enabled
     * in the Apple Developer portal, every clearBadge() call fails with that
     * message. It fires on every foreground transition, and until entitlements
     * are set up there's nothing useful we can log about it — it just buries
     * real warnings. Skip cleanly when there's no token.
     */
    async clearBadge(): Promise<void> {
        if (!Capacitor.isNativePlatform()) return;
        // No token = either permission not granted or capability missing.
        // Either way, the native removeAllDeliveredNotifications call will
        // throw the same useless error every time; short-circuit.
        if (!this.deviceToken) return;
        const scope = getAuthIdentityScope();
        if (!this.isOwnedScope(scope)) return;

        try {
            if (!(await this.verifyRemoteOwner(scope)) || !this.isOwnedScope(scope)) return;

            // Reset iOS badge to 0
            await PushNotifications.removeAllDeliveredNotifications();
            if (!this.isOwnedScope(scope)) return;

            // Clear pending count in database
            if (supabase) {
                const args = Object.freeze({ p_expected_user_id: scope.userId });
                const { data, error } = await supabase.rpc('clear_push_badge_for_identity', args);
                if (error) throw error;
                if (data !== true) throw new Error('Badge clear identity was rejected');
            }
            log.info('Badge cleared');
        } catch (e) {
            log.warn('Badge clear failed:', e);
        }
    }

    // ---- PRIVATE ----

    private enqueueAssociation<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.associationTail.then(operation);
        this.associationTail = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    private isExactScope(left: AuthIdentityScope, right: AuthIdentityScope): boolean {
        return left.key === right.key && left.generation === right.generation;
    }

    private isOwnedScope(scope: AuthIdentityScope): boolean {
        return (
            !!scope.userId &&
            this.userId === scope.userId &&
            !!this.ownerScope &&
            this.isExactScope(this.ownerScope, scope) &&
            isAuthIdentityScopeCurrent(scope)
        );
    }

    private async verifyRemoteOwner(scope: AuthIdentityScope, requireCurrentScope = true): Promise<boolean> {
        if (!supabase || !scope.userId) return false;
        if (requireCurrentScope && !this.isOwnedScope(scope)) return false;
        const { data, error } = await supabase.auth.getUser();
        if (error) throw error;
        return data.user?.id === scope.userId && (!requireCurrentScope || this.isOwnedScope(scope));
    }

    private async claimTokenAssociation(scope: AuthIdentityScope, deviceToken: string): Promise<boolean> {
        if (!supabase || !this.isOwnedScope(scope) || this.deviceToken !== deviceToken) return false;
        if (!(await this.verifyRemoteOwner(scope)) || !this.isOwnedScope(scope)) return false;

        const args = Object.freeze({
            p_expected_user_id: scope.userId,
            p_device_token: deviceToken,
            p_platform: Capacitor.getPlatform(),
        });
        const { data, error } = await supabase.rpc('claim_push_device_token', args);
        if (error) throw error;
        if (data !== true) return false;
        log.info('Push token associated with current Supabase user');
        return true;
    }

    private async releaseTokenAssociation(scope: AuthIdentityScope, deviceToken: string): Promise<boolean> {
        if (!supabase || !scope.userId) return false;
        // Logout fences AuthIdentityScope before this cleanup, so the captured
        // previous owner is intentionally allowed here. The RPC still proves
        // that the live remote session is exactly that owner.
        if (!(await this.verifyRemoteOwner(scope, false))) return false;

        const args = Object.freeze({
            p_expected_user_id: scope.userId,
            p_device_token: deviceToken,
        });
        const { data, error } = await supabase.rpc('release_push_device_token', args);
        if (error) throw error;
        if (data !== true) return false;
        log.info('Push token removed from Supabase');
        return true;
    }

    private cancelTokenWaiters(): void {
        for (const waiter of [...this.tokenWaiters]) waiter.finish(null);
    }

    private cancelTokenWaitersExcept(scope: AuthIdentityScope): void {
        for (const waiter of [...this.tokenWaiters]) {
            if (!this.isExactScope(waiter.scope, scope)) waiter.finish(null);
        }
    }

    private cancelRegistrationAttemptsExcept(scope: AuthIdentityScope): void {
        this.registrationAttempts = this.registrationAttempts.filter((attempt) =>
            this.isExactScope(attempt.scope, scope),
        );
    }

    private async removeNativeListeners(listeners: PluginListenerHandle[]): Promise<void> {
        await Promise.allSettled(listeners.map((listener) => listener.remove()));
    }

    private errorMessage(error: unknown): string {
        if (error instanceof Error) return error.message;
        if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
            return error.message;
        }
        return String(error);
    }

    private isValidDeviceToken(value: unknown): value is string {
        if (typeof value !== 'string' || value.length < 16 || value.length > 4096 || /\s/u.test(value)) return false;
        for (let index = 0; index < value.length; index += 1) {
            const code = value.charCodeAt(index);
            if (code <= 31 || code === 127) return false;
        }
        return true;
    }
}

export const PushNotificationService = new PushNotificationServiceClass();
