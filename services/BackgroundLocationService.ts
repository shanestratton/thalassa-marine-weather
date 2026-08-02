/**
 * BackgroundLocationService - TypeScript wrapper for native iOS background location
 *
 * This service bridges JavaScript to the native iOS BackgroundLocation plugin,
 * enabling 15-minute GPS tracking even when the app is backgrounded.
 *
 * IMPORTANT: Background location significantly increases battery usage.
 * iOS will display a blue status bar while background tracking is active.
 */

import { Capacitor, registerPlugin, PluginListenerHandle } from '@capacitor/core';
import { createLogger } from '../utils/createLogger';

const log = createLogger('BgLocation');

/**
 * Throttled failure logging for the receiver-info bridge. These calls run on
 * a 5 s poll from the header status button, and their failures used to be
 * swallowed whole (`.catch(() => empty)`) — a broken native bridge looked
 * IDENTICAL to "no Bad Elf connected", which is half of "sometimes the app
 * sees it, sometimes it doesn't" being undiagnosable from the field. warn()
 * because log.info is silenced in production builds.
 */
const nativeFailureLastLogged = new Map<string, number>();
function logReceiverInfoFailure(method: string, error: unknown): void {
    const now = Date.now();
    if (now - (nativeFailureLastLogged.get(method) ?? 0) < 60_000) return;
    nativeFailureLastLogged.set(method, now);
    log.warn(`${method} failed — GPS receiver row may show stale or phone-only state`, error);
}

/**
 * Provenance of the most recent location supplied by Core Location.
 *
 * `externalAccessory` is iOS's own answer to "did an accessory produce this
 * position?" It is intentionally separate from the accuracy heuristic used
 * elsewhere in the app: a very accurate iPhone fix is not proof of a Bad Elf
 * (or any other receiver) being connected.
 */
export interface ActiveLocationSource {
    hasLocation: boolean;
    timestampMs: number | null;
    externalAccessory: boolean;
    simulated: boolean;
}

/** Best-effort metadata for an MFi accessory iOS exposes to this app. */
export interface ConnectedExternalAccessory {
    name: string | null;
    manufacturer: string | null;
    modelNumber: string | null;
    firmwareRevision: string | null;
    hardwareRevision: string | null;
}

export interface NativeGpsReceiverInfo {
    source: ActiveLocationSource;
    accessories: ConnectedExternalAccessory[];
}

const EMPTY_ACTIVE_LOCATION_SOURCE: ActiveLocationSource = {
    hasLocation: false,
    timestampMs: null,
    externalAccessory: false,
    simulated: false,
};

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
        authorizationStatus:
            | 'authorizedAlways'
            | 'authorizedWhenInUse'
            | 'denied'
            | 'restricted'
            | 'notDetermined'
            | 'unknown';
        canTrackInBackground: boolean;
    }>;
    requestAlwaysPermission(): Promise<{ requested: boolean }>;
    /** Read the existing Transistorsoft CLLocation cache; never starts GPS. */
    getActiveLocationSource(): Promise<ActiveLocationSource>;
    /** Lists MFi accessories that iOS makes available to the app. */
    getConnectedAccessories(): Promise<{ accessories: ConnectedExternalAccessory[] }>;
    addListener(
        eventName: 'locationUpdate',
        listenerFunc: (data: LocationUpdate) => void,
    ): Promise<PluginListenerHandle>;
    addListener(
        eventName: 'locationError',
        listenerFunc: (data: { error: string }) => void,
    ): Promise<PluginListenerHandle>;
    addListener(
        eventName: 'authorizationChange',
        listenerFunc: (data: { status: string; canTrackInBackground: boolean }) => void,
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
        return Capacitor.isNativePlatform() && typeof BackgroundLocation !== 'undefined';
    }

    /**
     * Read GPS provenance and available MFi accessory metadata without
     * creating a second CLLocationManager or opening a Bluetooth scan.
     *
     * iOS does not universally disclose every paired Bluetooth GPS unit.
     * When it does expose an MFi accessory (for example a Bad Elf), we return
     * its name/model; otherwise the `externalAccessory` source flag still
     * tells the UI whether the current location is accessory-provided.
     */
    async getGpsReceiverInfo(): Promise<NativeGpsReceiverInfo> {
        if (!this.isAvailable()) {
            return { source: EMPTY_ACTIVE_LOCATION_SOURCE, accessories: [] };
        }

        try {
            const [sourceResult, accessoryResult] = await Promise.all([
                BackgroundLocation.getActiveLocationSource().catch((error: unknown) => {
                    logReceiverInfoFailure('getActiveLocationSource', error);
                    return EMPTY_ACTIVE_LOCATION_SOURCE;
                }),
                BackgroundLocation.getConnectedAccessories().catch((error: unknown) => {
                    logReceiverInfoFailure('getConnectedAccessories', error);
                    return { accessories: [] };
                }),
            ]);
            const source = {
                hasLocation: sourceResult.hasLocation === true,
                timestampMs: typeof sourceResult.timestampMs === 'number' ? sourceResult.timestampMs : null,
                externalAccessory: sourceResult.externalAccessory === true,
                simulated: sourceResult.simulated === true,
            };
            const accessories = Array.isArray(accessoryResult.accessories)
                ? accessoryResult.accessories.map((accessory) => ({
                      name: typeof accessory.name === 'string' && accessory.name.trim() ? accessory.name.trim() : null,
                      manufacturer:
                          typeof accessory.manufacturer === 'string' && accessory.manufacturer.trim()
                              ? accessory.manufacturer.trim()
                              : null,
                      modelNumber:
                          typeof accessory.modelNumber === 'string' && accessory.modelNumber.trim()
                              ? accessory.modelNumber.trim()
                              : null,
                      firmwareRevision:
                          typeof accessory.firmwareRevision === 'string' && accessory.firmwareRevision.trim()
                              ? accessory.firmwareRevision.trim()
                              : null,
                      hardwareRevision:
                          typeof accessory.hardwareRevision === 'string' && accessory.hardwareRevision.trim()
                              ? accessory.hardwareRevision.trim()
                              : null,
                  }))
                : [];

            return { source, accessories };
        } catch (error) {
            logReceiverInfoFailure('getGpsReceiverInfo', error);
            return { source: EMPTY_ACTIVE_LOCATION_SOURCE, accessories: [] };
        }
    }

    /**
     * Get current status of background location tracking
     */
    async getStatus() {
        if (!this.isAvailable()) {
            return {
                isTracking: false,
                authorizationStatus: 'unknown' as const,
                canTrackInBackground: false,
            };
        }

        try {
            return await BackgroundLocation.getStatus();
        } catch (error) {
            return {
                isTracking: false,
                authorizationStatus: 'unknown' as const,
                canTrackInBackground: false,
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
            await BackgroundLocation.addListener('authorizationChange', (_data) => {});

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
