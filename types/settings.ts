/**
 * types/settings.ts — User settings type
 */

import type { DisplayMode, DashboardMode, ScreenOrientationType, UnitPreferences } from './units';
import type { NotificationPreferences, WeatherModel, OffshoreModel } from './weather';
import type { VesselProfile, VesselDimensionUnits } from './vessel';
import type { PolarData } from './navigation';

/** User-defined safety thresholds for passage planning.
 *  The isochrone router treats zones exceeding these as obstacles.
 *  Undefined fields = no limit (disabled). */
export interface ComfortParams {
    maxWindKts?: number; // Max sustained wind (default: off)
    maxWaveM?: number; // Max significant wave height (default: off)
    maxGustKts?: number; // Max gust (default: off)
}

/**
 * Subscription tiers for Thalassa.
 *
 *  - `free`  — Deckhand (Free): basic weather, read-only chat/chandlery
 *  - `crew`  — First Mate ($49.95/yr): GPS tracking, DMs, AI advice, full weather
 *  - `owner` — Skipper ($149/yr): full feature set inc. route planning, passage
 *              legs, galley, marketplace, AI diary, Apple Watch companion
 *
 * Single source of truth for prices is `TIER_INFO` in services/SubscriptionService.
 */
export type SubscriptionTier = 'free' | 'crew' | 'owner';

export interface UserSettings {
    /** @deprecated Use `subscriptionTier` instead. Kept for migration only. */
    isPro?: boolean;
    /** Active subscription tier */
    subscriptionTier: SubscriptionTier;
    /** ISO date when subscription expires (undefined = free tier) */
    subscriptionExpiry?: string;
    firstName?: string;
    lastName?: string;
    alwaysOn?: boolean;
    notifications: NotificationPreferences;
    units: UnitPreferences;
    defaultLocation?: string;
    /** Coordinates for defaultLocation — saved at the time the user
     *  picked it (GPS / map / search). Prefer these over re-geocoding
     *  the name string, which is ambiguous (e.g. "Newport" matches
     *  six different cities worldwide). Optional for backwards
     *  compatibility with older settings payloads. */
    defaultLocationCoords?: { lat: number; lon: number };
    savedLocations: string[];
    vessel?: VesselProfile;
    vesselUnits?: VesselDimensionUnits;
    timeDisplay: 'location' | 'device';
    displayMode: DisplayMode;
    preferredModel: WeatherModel;
    /** Stormglass source model for offshore (> 20 nm) fetches. Default: 'sg'. */
    offshoreModel?: OffshoreModel;
    mapboxToken?: string;
    aiPersona?: number;
    heroWidgets?: string[];
    topHeroWidget?: string;
    detailsWidgets?: string[];
    rowOrder?: string[];
    dynamicHeaderMetrics?: boolean;
    dashboardMode?: DashboardMode;
    screenOrientation?: ScreenOrientationType;
    autoTrackEnabled?: boolean;
    backgroundLocationEnabled?: boolean;
    polarSource?: 'factory' | 'smart';
    nmeaHost?: string;
    nmeaPort?: number;
    smartPolarsEnabled?: boolean;
    comfortParams?: ComfortParams;
    gribMode?: 'direct' | 'iridium';
    satelliteMode?: boolean;
    cloudSyncSettings?: boolean;
    cloudSyncVoyages?: boolean;
    cloudSyncCommunity?: boolean;
    polarData?: PolarData;
    polarBoatModel?: string;
    polarSource_type?: 'database' | 'file_import' | 'manual';

    // ── Pi Cache ──
    /** Enable routing data requests through a local Raspberry Pi cache server */
    piCacheEnabled?: boolean;
    /** Pi Cache server hostname or IP (e.g., 'raspberrypi.local' or '192.168.1.50') */
    piCacheHost?: string;
    /** Pi Cache server port (default: 3001) */
    piCachePort?: number;
    /** Pre-fetch weather data on the Pi (requires internet connection on the Pi) */
    piCachePrefetch?: boolean;
}
