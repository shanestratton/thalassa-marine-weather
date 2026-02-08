/**
 * BackgroundLocationService - TypeScript wrapper for native iOS background location
 * 
 * This service bridges JavaScript to the native iOS BackgroundLocation plugin,
 * enabling 15-minute GPS tracking even when the app is backgrounded.
 * 
 * IMPORTANT: Background location significantly increases battery usage.
 * iOS will display a blue status bar while background tracking is active.
 */

import { registerPlugin, PluginListenerHandle } from '@capacitor/core';

// Plugin interface for TypeScript
interface BackgroundLocationPlugin {
    startBackgroundLocation(): Promise<{
        started: boolean;
        needsAlwaysPermission?: boolean;
        pendingPermission?: boolean;
    }>;
    stopBackgroundLocation(): Promise<{ stopped: boolean }>;
    getStatus(): Promise<{
        isTracking: boolean;
        authorizationStatus: 'authorizedAlways' | 'authorizedWhenInUse' | 'denied' | 'restricted' | 'notDetermined' | 'unknown';
        canTrackInBackground: boolean;
    }>;
    requestAlwaysPermission(): Promise<{ requested: boolean }>;
    addListener(
        eventName: 'locationUpdate',
        listenerFunc: (data: LocationUpdate) => void
    ): Promise<PluginListenerHandle>;
    addListener(
        eventName: 'locationError',
        listenerFunc: (data: { error: string }) => void
    ): Promise<PluginListenerHandle>;
    addListener(
        eventName: 'authorizationChange',
        listenerFunc: (data: { status: string; canTrackInBackground: boolean }) => void
    ): Promise<PluginListenerHandle>;
}

export interface LocationUpdate {
    latitude: number;
    longitude: number;
    accuracy: number;
    altitude: number;
    heading: number;
    speed: number;
    timestamp: string;
}

// Register the plugin (will be undefined on non-iOS or when not installed)
const BackgroundLocation = registerPlugin<BackgroundLocationPlugin>('BackgroundLocation');

// Track listeners for cleanup
let locationUpdateHandler: PluginListenerHandle | null = null;

class BackgroundLocationServiceClass {
    private onLocationUpdate: ((location: LocationUpdate) => void) | null = null;

    /**
     * Check if background location is available (iOS only)
     */
    isAvailable(): boolean {
        return typeof BackgroundLocation !== 'undefined';
    }

    /**
     * Get current status of background location tracking
     */
    async getStatus() {
        if (!this.isAvailable()) {
            return {
                isTracking: false,
                authorizationStatus: 'unknown' as const,
                canTrackInBackground: false
            };
        }

        try {
            return await BackgroundLocation.getStatus();
        } catch (error) {
            return {
                isTracking: false,
                authorizationStatus: 'unknown' as const,
                canTrackInBackground: false
            };
        }
    }

    /**
     * Request "Always" location permission (required for background tracking)
     */
    async requestAlwaysPermission(): Promise<boolean> {
        if (!this.isAvailable()) {
            return false;
        }

        try {
            const result = await BackgroundLocation.requestAlwaysPermission();
            return result.requested;
        } catch (error) {
            return false;
        }
    }

    /**
     * Start background location tracking
     * @param onUpdate Callback function when a new location is received (every 15 minutes)
     */
    async start(onUpdate: (location: LocationUpdate) => void): Promise<boolean> {
        if (!this.isAvailable()) {
            return false;
        }

        try {
            // Store callback
            this.onLocationUpdate = onUpdate;

            // Set up listener for location updates
            if (locationUpdateHandler) {
                await locationUpdateHandler.remove();
            }

            locationUpdateHandler = await BackgroundLocation.addListener('locationUpdate', (data) => {
                if (this.onLocationUpdate) {
                    this.onLocationUpdate(data);
                }
            });

            // Also listen for authorization changes
            await BackgroundLocation.addListener('authorizationChange', (data) => {
            });

            // Start tracking
            const result = await BackgroundLocation.startBackgroundLocation();

            if (result.needsAlwaysPermission) {
                // User will need to grant permission in settings
                return false;
            }

            if (result.pendingPermission) {
                return false;
            }

            return result.started;
        } catch (error) {
            return false;
        }
    }

    /**
     * Stop background location tracking
     */
    async stop(): Promise<boolean> {
        if (!this.isAvailable()) {
            return true;
        }

        try {
            // Remove listener
            if (locationUpdateHandler) {
                await locationUpdateHandler.remove();
                locationUpdateHandler = null;
            }

            this.onLocationUpdate = null;

            // Stop native tracking
            const result = await BackgroundLocation.stopBackgroundLocation();
            return result.stopped;
        } catch (error) {
            return false;
        }
    }
}

// Export singleton
export const BackgroundLocationService = new BackgroundLocationServiceClass();
