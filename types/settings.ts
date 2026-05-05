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
    /**
     * Which metric occupies the big top slot of the hero card.
     * Default: 'temp' (temperature — app's canonical hero metric).
     *
     * When set to something else (e.g. 'gust', 'pressure'), the Glass page
     * promotes that metric to the top slot and the displaced temperature
     * moves into the grid cell the promoted metric was occupying. This is
     * a single-swap model — exactly one non-temp metric can be promoted at
     * a time, and temp always occupies the vacated slot.
     *
     * Persisted via the standard settingsStore localStorage flow so the
     * choice survives app restarts.
     */
    heroMetric?: string;
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
    /**
     * Use OSCAR near-real-time (NRT) ocean currents instead of monthly
     * climatology in the isochrone routing engine. NRT data is 5 days
     * behind real time but reflects actual current conditions (eddies,
     * meanders, anomalies); climatology is always-available but is a
     * monthly average.
     *
     * Default OFF — climatology is good enough for most routes and
     * is faster + more reliable. Turn ON for tight passages where
     * day-to-day current variability matters (e.g. crossing the Gulf
     * Stream timing-critical, exiting an Atlantic trade wind zone).
     */
    currentNrtEnabled?: boolean;
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

    // ── Calypso integrations (Skipper-tier only, gated by canAccess) ──
    /**
     * @deprecated since 2026-05-04 — Apple Music is now always-on for
     * Skipper tier. Auth is handled in-app on the dedicated Music page
     * (MusicKit catalog, ~100M tracks). Field retained for backward
     * compatibility with persisted settings; no code reads it.
     */
    calypsoMusicEnabled?: boolean;

    /**
     * Gmail access — Calypso can read inbox, search messages, draft
     * emails, send (with explicit confirm-before-send UX). Goes through
     * Google OAuth 2.0 with PKCE; the granted access + refresh tokens
     * live in the Capacitor Preferences store (which uses iOS Keychain
     * on device, so they're encrypted at rest). The toggle here gates
     * the OAuth flow + tool registration — disabling it revokes the
     * stored tokens and unregisters the tools from Calypso's registry.
     */
    calypsoEmailEnabled?: boolean;
    /**
     * Email address linked via Gmail OAuth. Read-only display field —
     * lets the settings UI show "Connected as cap'n@gmail.com" so the
     * skipper knows which account Calypso is talking to. Cleared when
     * the integration is disabled.
     */
    calypsoEmailAccount?: string;

    /**
     * Calypso proactive alerts ("speak up" mode) — when ON and the
     * user is on Skipper tier, the AlertMonitorService runs persistently:
     * subscribes to NmeaStore, evaluates threshold rules every tick,
     * and dispatches AlertEvents (chime + voice + voice-page takeover
     * + history turn) when something looks wrong on the boat.
     *
     * Default OFF — the skipper has to opt in. Same model as anchor
     * watch: a safety feature that's invasive when it triggers, so
     * we don't enable it by default.
     */
    calypsoAlertsEnabled?: boolean;

    /**
     * Calypso voice preset key — resolves to an ElevenLabs voice_id
     * via services/voice/voicePresets.ts. We persist the stable preset
     * key (not the raw voice_id) so we can swap voices upstream
     * without invalidating saved preferences. Undefined → default
     * 'calypso' preset (the original warm-female voice).
     */
    calypsoVoiceId?: string;
}
