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
import { supabase } from './supabase';
import { createLogger } from '../utils/logger';

const log = createLogger('Push');

class PushNotificationServiceClass {
    private deviceToken: string | null = null;
    private initialized = false;
    private userId: string | null = null;
    private tokenListeners: Array<(token: string) => void> = [];

    // Callback for handling notification taps (set by UI layer)
    onNotificationTap: ((data: Record<string, unknown>) => void) | null = null;

    /**
     * Initialize push notifications.
     * Call this early in the app lifecycle (e.g., AuthContext on login).
     */
    async initialize(): Promise<void> {
        if (this.initialized) return;
        if (!Capacitor.isNativePlatform()) return;

        try {
            // Listen for registration success
            await PushNotifications.addListener('registration', (token) => {
                log.info('APNs token received');
                this.deviceToken = token.value;
                this.tokenListeners.forEach(l => l(token.value));

                // Auto-save to Supabase if we have a user
                if (this.userId) {
                    this.saveTokenToSupabase().catch(() => { /* best effort */ });
                }
            });

            // Listen for registration errors
            await PushNotifications.addListener('registrationError', (error) => {
                log.warn('Push registration error:', error);
            });

            // Listen for incoming notifications (foreground)
            await PushNotifications.addListener('pushNotificationReceived', (notification) => {
                log.info('Push received (foreground):', notification.title);
                // Foreground notifications are suppressed by default on iOS.
                // The app is already open, so we don't need to show a banner.
                // Could trigger an in-app toast here if desired.
            });

            // Listen for notification taps (user opened notification from lock screen / notification center)
            await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
                log.info('Push tapped:', action.notification?.data);
                if (this.onNotificationTap && action.notification?.data) {
                    this.onNotificationTap(action.notification.data as Record<string, unknown>);
                }
            });

            this.initialized = true;
            log.info('Push notifications initialized');
        } catch (error) {
            log.warn('Push init failed (best-effort):', error);
        }
    }

    /**
     * Request permission and register for push notifications.
     * Returns the device token or null if denied/failed.
     * Also saves the token to Supabase for the current user.
     */
    async requestPermissionAndRegister(): Promise<string | null> {
        if (!Capacitor.isNativePlatform()) return null;

        try {
            // Check current permission status
            const status = await PushNotifications.checkPermissions();

            if (status.receive === 'prompt' || status.receive === 'prompt-with-rationale') {
                const result = await PushNotifications.requestPermissions();
                if (result.receive !== 'granted') {
                    log.info('Push permission denied by user');
                    return null;
                }
            } else if (status.receive !== 'granted') {
                log.info('Push permission not granted:', status.receive);
                return null;
            }

            // Register with APNs
            await PushNotifications.register();

            // Wait for token if not already received
            if (this.deviceToken) {
                await this.saveTokenToSupabase();
                return this.deviceToken;
            }

            return new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    log.warn('Push token timeout (10s)');
                    resolve(null);
                }, 10000);

                this.tokenListeners.push(async (token) => {
                    clearTimeout(timeout);
                    await this.saveTokenToSupabase();
                    resolve(token);
                });
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
        this.userId = userId;
        if (this.deviceToken) {
            await this.saveTokenToSupabase();
        }
    }

    /**
     * Clear user association. Called on logout.
     * Removes the device token from Supabase.
     */
    async clearUser(): Promise<void> {
        if (this.userId && this.deviceToken && supabase) {
            try {
                await supabase.from('push_device_tokens').delete().match({
                    user_id: this.userId,
                    device_token: this.deviceToken,
                });
                log.info('Push token removed from Supabase');
            } catch {
                /* best effort */
            }
        }
        this.userId = null;
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
        } catch {
            return false;
        }
    }

    // ---- PRIVATE ----

    /** Save current token + user to Supabase push_device_tokens table */
    private async saveTokenToSupabase(): Promise<void> {
        if (!supabase || !this.userId || !this.deviceToken) return;

        try {
            const { error } = await supabase.from('push_device_tokens').upsert({
                user_id: this.userId,
                device_token: this.deviceToken,
                platform: 'ios',
                updated_at: new Date().toISOString(),
            }, {
                onConflict: 'user_id,device_token',
            });

            if (error) {
                log.warn('Failed to save push token:', error.message);
            } else {
                log.info('Push token saved to Supabase');
            }
        } catch (err) {
            log.warn('Push token save error:', err);
        }
    }
}

export const PushNotificationService = new PushNotificationServiceClass();
