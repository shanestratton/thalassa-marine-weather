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

/** The Obs chart's base, chosen in the map-base menu at the top of the page. */
export type ObsChartBase = 'relief' | 'reliefSat' | 'ocean' | 'satellite' | 'hybrid';

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
 *              legs, galley, AI diary, Apple Watch companion
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
 *   poetic     — Shakespearean maritime prose, high romance and cadence
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
    // Keep the persisted key as `poetic` for existing skipper settings,
    // while naming the actual experience plainly in the interface.
    poetic: 'Shakespearean — maritime grandeur',
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
     *  a second device must take it over deliberately. Absent or null = unclaimed
     *  (a RELEASE writes null so the cloud patch carries the key), and
     *  an unclaimed boat publishes from any device, so shipping this cannot
     *  silently take an existing skipper off their own page.
     *  See services/skipperDevice.ts. */
    skipperDevice?: { deviceId: string; deviceName: string; claimedAt: string; lastSeenAt?: string } | null;
    /** Who may replace the followed route another device set (services/shiplog/routeAuthority.ts).
     *  DARK — no UI. 'confirm' (default): any device, after a confirm naming the other device.
     *  'skipper': only the device holding the skipper claim, without asking. */
    routeAuthority?: 'confirm' | 'skipper';
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
     * Settings → Preferences → "Daily ocean currents". Ocean currents are
     * always live data (Copernicus Marine, else NOAA CoastWatch — there is no
     * climatology in the app); this only sets how long a fetched field is
     * reused: a day when ON, up to a week when OFF (OceanCurrentService
     * `freshness`). The key keeps its old name so saved settings carry over.
     *
     * Default OFF. Turn ON for passages where day-to-day current change
     * matters (a timing-critical Gulf Stream or Agulhas crossing).
     */
    currentNrtEnabled?: boolean;
    /**
     * Settings → Preferences → Chart: "Show charted leads". Draws the
     * compiled lead graph (services/routing/leadCompiler.ts) from the
     * installed navigation cells in view — charted recommended tracks, the
     * on-water spans of leading lines, buoyed channels — classed against the
     * vessel's draft + 0.5 m and the chart's hazards, structures and survey
     * quality. Off by default (owner rule for new chart overlays). Chart
     * furniture only: it routes nothing, and Auto does not follow it yet.
     */
    showChartLeads?: boolean;
    /**
     * The Obs chart's base, picked in the map-base menu at the top of the
     * page and kept with the account (2026-10-04). Unset = Relief, the
     * seamless seafloor base that replaced Satellite as the default (Shane:
     * "the stitching"). The planning surface keeps Hybrid until a base is
     * picked. components/map/useMapBase.ts reads it.
     */
    obsChartBase?: ObsChartBase;
    /**
     * Settings → Preferences → Chart: "Show ENC charts when Obs opens"
     * (build 123, W1-01). Off by default, so browse charts keep starting off
     * on every fresh Obs (Release 119: each ENC merge allocates about 25 MB,
     * and the 2026-09-04 jetsam came with cells merging). Only exactly `true`
     * turns them on, and only on the Obs chart, never a picker or planner map.
     * It is read live, not once at open: an Obs that is already open follows
     * a change (from this phone's Preferences or an account sync from another
     * device) until the skipper uses the map-base menu's ENC row, which then
     * wins for the session. Pinned in tests/EncMasterSwitch.test.tsx;
     * components/map/mapHub/useEncAtOpen.ts reads it.
     */
    obsEncOnOpen?: boolean;
    /**
     * Settings → Preferences → Collision alarm (build 125, 125-01): the CPA /
     * TCPA pair the collision alarm and the chart's CPA chip use, offshore and
     * inshore (inshore applies under 3 kn of our own speed). Unset or
     * unreadable parts fall back to the recommended 0.5 NM / 15 min offshore
     * and 0.2 NM / 6 min inshore; values are clamped on read
     * (utils/collisionRule.ts sanitiseCollisionPrefs). Close quarters
     * (0.1 NM / 3 min) is fixed and always sounds. The watch itself is armed
     * with the shield in the chart's AIS key.
     */
    collisionAlarm?: {
        offshore?: { cpaNm?: number; tcpaMin?: number };
        inshore?: { cpaNm?: number; tcpaMin?: number };
    };
    /**
     * Settings → Preferences → Routing: "Auto route (trial)" (2026-10-01).
     * Auto routing and Plan Your Day run Thalassa's own router only while
     * this is on (services/autorouteTrialSwitch.ts). Off by default: Pro is
     * every account while the public beta is on, and the router must not
     * reach every tester before Shane has proved it in the Whitsundays.
     * The manual planner's ⚡ Auto route and the passage planner ignore it.
     */
    autorouteTrialEnabled?: boolean;
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
     * currently live in an account-scoped Capacitor Preferences envelope.
     * Preferences uses UserDefaults on iOS (and localStorage on web), not
     * Keychain/Keystore, so this is isolation rather than secure-at-rest
     * storage; a native secure-storage backend remains required. The toggle
     * gates OAuth + tool registration. Disabling deletes this account's local
     * tokens and unregisters the tools, but does not revoke Google's grant.
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
     * Legacy Calypso proactive-alert opt-in. Public-beta builds retire this
     * value to false: the current rules engine is foreground JavaScript and
     * cannot promise monitoring after iOS suspension or termination. Retained
     * only for settings-envelope compatibility until a separately consented,
     * native-lifecycle implementation replaces it.
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
