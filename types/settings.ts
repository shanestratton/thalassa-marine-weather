/**
 * types/settings.ts — User settings type
 */

import type { DisplayMode, DashboardMode, ScreenOrientationType, UnitPreferences } from './units';
import type { NotificationPreferences, WeatherModel, OffshoreModel } from './weather';
import type { VesselProfile, VesselDimensionUnits } from './vessel';
import type { PolarData } from './navigation';

/**
 * Preferred wind angle bands — used as a multi-select set so users can
 * pick which sailing angles they're willing to accept on a passage.
 *
 * TWA = True Wind Angle (0° = head to wind, 180° = directly downwind):
 *   - beating      → TWA  0°– 50°  (close-hauled, upwind)
 *   - close_reach  → TWA 50°– 80°  (sailing toward wind, faster than beating)
 *   - beam_reach   → TWA 80°–110°  (wind on the beam — fastest point of sail)
 *   - broad_reach  → TWA 110°–150° (wind on the back quarter)
 *   - running      → TWA 150°–180° (downwind, dead astern)
 *
 * Empty array OR all five selected = no preference (route on raw polar).
 * Otherwise the isochrone engine drops candidate bearings whose TWA
 * falls outside the selected bands. Cruisers who hate beating typically
 * select only [close_reach, beam_reach, broad_reach, running].
 */
export type PreferredAngle = 'beating' | 'close_reach' | 'beam_reach' | 'broad_reach' | 'running';

/** User-defined safety thresholds for passage planning.
 *  The isochrone router treats zones exceeding these as obstacles.
 *  Undefined fields = no limit (disabled). */
export interface ComfortParams {
    maxWindKts?: number; // Max sustained wind (default: off)
    maxWaveM?: number; // Max significant wave height (default: off)
    maxGustKts?: number; // Max gust (default: off)
    /**
     * Acceptable wind angle bands. Undefined / empty / all-five = no
     * angle preference. Otherwise candidates whose true wind angle
     * falls outside the selected bands are dropped from the wavefront.
     */
    preferredAngles?: PreferredAngle[];
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

/**
 * Diary "polish" presets — discrete styles surfaced as a dropdown in
 * the New Entry form. Each maps to an intensity value (0-100) used by
 * the Gemini-backed enhancer in DiaryService.enhanceWithGemini.
 *
 *   clean      — fix grammar/spelling only, no creative additions
 *   tidy       — light cleanup, keep author's voice
 *   polished   — moderate flow improvements (default)
 *   literary   — flowing prose, descriptive language
 *   poetic     — maximum literary flourish, evocative imagery
 */
export type PolishStyle = 'clean' | 'tidy' | 'polished' | 'literary' | 'poetic';

export const POLISH_INTENSITY: Record<PolishStyle, number> = {
    clean: 0,
    tidy: 25,
    polished: 50,
    literary: 75,
    poetic: 100,
};

export const POLISH_LABEL: Record<PolishStyle, string> = {
    clean: 'Clean — grammar only',
    tidy: 'Tidy — keep my voice',
    polished: 'Polished — smooth flow',
    literary: 'Literary — flowing prose',
    poetic: 'Poetic — evocative imagery',
};

export interface UserSettings {
    /** @deprecated Use `subscriptionTier` instead. Kept for migration only. */
    isPro?: boolean;
    /** Active subscription tier */
    subscriptionTier: SubscriptionTier;
    /** ISO date when subscription expires (undefined = free tier) */
    subscriptionExpiry?: string;
    /** Title/prefix (Capt., Dr., Skipper …). Optional. */
    prefix?: string;
    firstName?: string;
    lastName?: string;
    /** Nickname rendered between quotes on the voyage-log byline. Optional. */
    nickname?: string;
    /** Diary "polish" preset — controls how much the Gemini-backed
     *  enhancer rewrites the entry. Persists across sessions and devices
     *  (via profiles.settings sync). */
    polishStyle?: PolishStyle;
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
    /** Per-name coordinates for entries in `savedLocations`. Populated
     *  when the user saved the location via the map/GPS/route planner
     *  (which embeds exact coords); name-only entries (from text-only
     *  favouriting) are simply absent from this map. Optional for
     *  backwards compatibility with older settings payloads. */
    savedLocationCoords?: Record<string, { lat: number; lon: number }>;
    /** The user's designated HOME PORT — a name that must be one of
     *  `savedLocations`. Pinned to the top of the location-star flyout
     *  with an anchor icon. Distinct from `defaultLocation` (which the
     *  app keeps as 'Current Location' so every open follows GPS — see
     *  useAppController effect 1b); home port is a one-tap PICK, never
     *  the open default. Absent until the user sets one. */
    homePort?: string;
    /** Which DEVICE speaks for this boat. Two devices signed into one account
     *  both published track points under the same user_id, so the public page
     *  drew both and the boat marker jumped between them (2026-07-19). Exclusive:
     *  a second device must take it over deliberately. Absent = unclaimed, and
     *  an unclaimed boat publishes from any device, so shipping this cannot
     *  silently take an existing skipper off their own page.
     *  See services/skipperDevice.ts. */
    skipperDevice?: { deviceId: string; deviceName: string; claimedAt: string };
    vessel?: VesselProfile;
    vesselUnits?: VesselDimensionUnits;
    timeDisplay: 'location' | 'device';
    displayMode: DisplayMode;
    preferredModel: WeatherModel;
    /**
     * Forecast model driving the Glass page's atmospheric data (the model
     * picker pill next to the location-type badge). A concrete model id
     * makes that model's Open-Meteo report the atmospheric base of the
     * merged dashboard report; 'best_match' means Auto — the legacy
     * WeatherKit-primary blend. Default: 'dwd_icon' (ICON).
     *
     * Distinct from `preferredModel` (route planner fast-fetch only) and
     * `offshoreModel` (StormGlass source for offshore marine enrichment).
     */
    forecastModel?: WeatherModel;
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
    /** Local tidal-stream flood direction (degrees TOWARD, the way the stream
     *  runs on a rising tide) for the wind-vs-tide view. Undefined = use the
     *  modelled current instead. */
    tideFloodDirection?: number;
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

    // ── Public Voyage Log ──
    /**
     * Trickle live positions to the public Voyage Log page while a voyage is
     * recording (1 decimated point every ~2 min via the `live_track` table).
     * Off by default — sharing your live position is an explicit choice.
     */
    liveTrackShare?: boolean;

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
