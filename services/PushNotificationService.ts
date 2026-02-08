/**
 * PushNotificationService — Manages APNs device token registration
 * 
 * Handles:
 * - Requesting push notification permissions
 * - Registering for remote notifications
 * - Storing the device token for Shore Watch alarm pushes
 */

import { PushNotifications } from '@capacitor/push-notifications';
import { Capacitor } from '@capacitor/core';

class PushNotificationServiceClass {
    private deviceToken: string | null = null;
    private initialized = false;
    private tokenListeners: Array<(token: string) => void> = [];

    /**
     * Initialize push notifications.
     * Call this early in the app lifecycle (e.g., App.tsx useEffect).
     */
    async initialize(): Promise<void> {
        if (this.initialized) return;
        if (!Capacitor.isNativePlatform()) {
            return;
        }

        try {
            // Listen for registration success
            await PushNotifications.addListener('registration', (token) => {
                this.deviceToken = token.value;
                this.tokenListeners.forEach(l => l(token.value));
            });

            // Listen for registration errors
            await PushNotifications.addListener('registrationError', (error) => {
            });

            // Listen for incoming notifications (foreground)
            await PushNotifications.addListener('pushNotificationReceived', (notification) => {
                // Could trigger in-app alarm UI here
            });

            // Listen for notification taps (user opened notification)
            await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
                // Could navigate to anchor watch page here
            });

            this.initialized = true;
        } catch (error) {
        }
    }

    /**
     * Request permission and register for push notifications.
     * Returns the device token or null if denied/failed.
     */
    async requestPermissionAndRegister(): Promise<string | null> {
        if (!Capacitor.isNativePlatform()) return null;

        try {
            // Check current permission status
            const status = await PushNotifications.checkPermissions();

            if (status.receive === 'prompt' || status.receive === 'prompt-with-rationale') {
                const result = await PushNotifications.requestPermissions();
                if (result.receive !== 'granted') {
                    return null;
                }
            } else if (status.receive !== 'granted') {
                return null;
            }

            // Register with APNs
            await PushNotifications.register();

            // Wait for token if not already received
            if (this.deviceToken) return this.deviceToken;

            return new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    resolve(null);
                }, 10000);

                this.tokenListeners.push((token) => {
                    clearTimeout(timeout);
                    resolve(token);
                });
            });
        } catch (error) {
            return null;
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
        } catch {
            return false;
        }
    }
}

export const PushNotificationService = new PushNotificationServiceClass();
