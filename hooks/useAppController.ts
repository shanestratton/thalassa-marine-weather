import React, { useState, useEffect, useCallback, useRef, useSyncExternalStore } from 'react';
import { createLogger } from '../utils/createLogger';

const log = createLogger('useAppController');
import { useWeather } from '../context/WeatherContext';
import { useSettings } from '../context/SettingsContext';
import { useUI } from '../context/UIContext';
import { reverseGeocode } from '../services/weatherService';
import { formatLocationInput, getSunTimes, formatCoordinate } from '../utils';
import { DisplayMode, WeatherConditionKey, UserSettings } from '../types';
import { toast } from '../components/Toast';
import { GpsService } from '../services/GpsService';
import { LocationStore } from '../stores/LocationStore';
import { useAuthStore } from '../stores/authStore';
import { useSettingsStore } from '../stores/settingsStore';
import { supabase } from '../services/supabase';
import { crumb } from '../utils/flightRecorder';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../services/authIdentityScope';
import { writeScopedNativeDiagnostic } from '../services/nativeDiagnostic';
// Sample/dummy location data removed 2026-05-17 — painting Sydney
// weather for a Brisbane user (or Newport for a Boston user) is
// actively misleading on a marine app, where mistaking demo
// conditions for real ones could affect a passage decision. The
// new pattern: trust the OS GPS flow + show an empty state when
// no location is set, just like Apple Weather. See App.tsx
// dashboard branch for the empty state's two-CTA card.

const DEFAULT_BACKGROUNDS = {
    sunny: 'https://images.unsplash.com/photo-1566371486490-560ded23b5e4?q=80&w=1080&fm=jpg&fit=crop',
    cloudy: 'https://images.unsplash.com/photo-1534008753122-a83776b29f6c?q=80&w=1080&fm=jpg&fit=crop',
    rain: 'https://images.unsplash.com/photo-1515694346937-94d85e41e6f0?q=80&w=1080&fm=jpg&fit=crop',
    storm: 'https://images.unsplash.com/photo-1505672675380-4d329615699c?q=80&w=1080&fm=jpg&fit=crop',
    fog: 'https://images.unsplash.com/photo-1485230905346-71acb9518d9c?q=80&w=1080&fm=jpg&fit=crop',
    night: 'https://images.unsplash.com/photo-1500382017468-9049fed747ef?q=80&w=1080&fm=jpg&fit=crop',
    default: 'https://images.unsplash.com/photo-1478359844494-1092259d93e4?q=80&w=1080&fm=jpg&fit=crop',
};

// How long a name-only favourite pick may wait for its weather report
// before the deferred LocationStore claim is abandoned.
const PENDING_FAVORITE_CLAIM_MS = 60_000;
const ONBOARDED_KEY = 'thalassa_v3_onboarded';
const TUTORIAL_COMPLETED_KEY = 'thalassa_tutorial_completed';
const INTRO_COMPLETED_KEY = 'thalassa_onboarding_complete';
const GLASS_TUTORIAL_SEEN_KEY = 'thalassa_glass_tutorial_seen';

/** "WP 27.4700°S, 153.0200°E" — the coordinate label used when no place name resolves. */
const wpLabel = (lat: number, lon: number) =>
    `WP ${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`;

/**
 * Resolve a map pick into a query label + normalised coordinates. Shared by
 * the "go to the Glass" and "stay on the map" pick handlers, which carried
 * this block twice. Returns null when the auth identity changed mid-geocode
 * (the caller must then do nothing, exactly as before).
 */
async function resolveMapPick(
    lat: number,
    lon: number,
    name: string | undefined,
    actionScope: AuthIdentityScope,
): Promise<{ locationQuery: string; finalCoords: { lat: number; lon: number } } | null> {
    // Normalize Longitude (-180 to 180)
    // Map libraries sometimes return wrapped coords (e.g. 190, 370 etc)
    let normalizedLon = lon;
    while (normalizedLon > 180) normalizedLon -= 360;
    while (normalizedLon < -180) normalizedLon += 360;

    const finalCoords = { lat, lon: normalizedLon };

    // Resolve a human-readable name if the map didn't provide one or it's a raw coordinate
    let locationQuery = name || '';
    if (!locationQuery || /^-?\d/.test(locationQuery) || locationQuery.startsWith('WP ')) {
        try {
            const geoName = await reverseGeocode(lat, normalizedLon);
            if (!isAuthIdentityScopeCurrent(actionScope)) return null;
            if (geoName) locationQuery = geoName;
        } catch (e) {
            if (!isAuthIdentityScopeCurrent(actionScope)) return null;
            log.warn(e);
            // Geocode failed — fall through
        }
    }
    // Final fallback: WP coordinates
    if (!locationQuery || locationQuery.startsWith('WP ')) {
        // Reformat nicely if it's still a WP string or empty
        locationQuery = wpLabel(lat, normalizedLon);
    }
    return { locationQuery, finalCoords };
}

const subscribeIdentitySnapshot = (notify: () => void): (() => void) => subscribeAuthIdentityScope(() => notify());
const getIdentitySnapshot = (): AuthIdentityScope => getAuthIdentityScope();

function hasScopedFlag(key: string, scope: AuthIdentityScope): boolean {
    try {
        return localStorage.getItem(authScopedStorageKey(key, scope)) !== null;
    } catch {
        return false;
    }
}

function setScopedFlag(key: string, scope: AuthIdentityScope, value = 'true'): void {
    try {
        localStorage.setItem(authScopedStorageKey(key, scope), value);
    } catch {
        // Storage can be unavailable in private mode. The cloud vessel check
        // still prevents duplicate setup for authenticated returning users.
    }
}

const mapConditionToKey = (cond: string): WeatherConditionKey => {
    if (!cond) return 'default';
    const c = cond.toLowerCase();
    if (c.includes('rain') || c.includes('drizzle') || c.includes('wet')) return 'rain';
    if (c.includes('storm') || c.includes('thunder') || c.includes('lightning') || c.includes('gale')) return 'storm';
    if (c.includes('fog') || c.includes('mist') || c.includes('haze')) return 'fog';
    if (c.includes('cloud') || c.includes('overcast') || c.includes('grey')) return 'cloudy';
    if (c.includes('night') || c.includes('dark') || c.includes('moon')) return 'night';
    if (c.includes('sun') || c.includes('clear') || c.includes('fair')) return 'sunny';
    return 'default';
};

export const useAppController = () => {
    const { weatherData, loading, fetchWeather, selectLocation } = useWeather();
    const { settings, updateSettings } = useSettings();
    const { setPage, isOffline, currentView } = useUI();
    const authedUser = useAuthStore((s) => s.user);

    /**
     * currentView read at FIRE time, not render time.
     *
     * The boot effect below paints the dashboard when there is no weather yet.
     * That is a first-open concern, but its deps include `authedUser`, and
     * authStore stores Supabase's `session.user` object verbatim — a FRESH
     * object on every auth event, TOKEN_REFRESHED included. Supabase refreshes
     * on a timer and on app resume, so the effect re-fires mid-session with no
     * change in who is signed in. If weather happened to be null right then
     * (a failed refresh, a fetch still in flight, a cache-version wipe) it
     * called setPage('dashboard') and yanked the skipper off whatever they were
     * doing — which is what "the planning screen crashes back to the Glass
     * page" was. Not a crash: a navigation.
     *
     * A ref, not a dep: depping on currentView would re-run this effect on
     * every navigation, which is exactly what it must not do.
     */
    const currentViewRef = useRef(currentView);
    currentViewRef.current = currentView;
    const authChecked = useAuthStore((s) => s.authChecked);
    const identityScope = useSyncExternalStore(subscribeIdentitySnapshot, getIdentitySnapshot, getIdentitySnapshot);

    const [query, setQuery] = useState('');
    const [bgImage, setBgImage] = useState(DEFAULT_BACKGROUNDS.default);
    const [onboardingVisibility, setOnboardingVisibility] = useState<{
        scope: AuthIdentityScope;
        visible: boolean;
    }>(() => ({ scope: identityScope, visible: false }));
    const showOnboarding =
        onboardingVisibility.visible &&
        onboardingVisibility.scope.key === identityScope.key &&
        onboardingVisibility.scope.generation === identityScope.generation &&
        isAuthIdentityScopeCurrent(onboardingVisibility.scope);
    const setShowOnboardingForScope = useCallback((scope: AuthIdentityScope, visible: boolean) => {
        if (!isAuthIdentityScopeCurrent(scope)) return;
        setOnboardingVisibility({ scope, visible });
    }, []);

    // UI Local State
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [sheetData, setSheetData] = useState<any>(null);
    const [sheetOpen, setSheetOpen] = useState(false);
    const [isUpgradeOpen, setIsUpgradeOpen] = useState(false);
    const [isMobileLandscape, setIsMobileLandscape] = useState(false);

    const gpsBootScopeRef = React.useRef<string | null>(null);

    // 1. Initial Load
    //
    // Onboarding gate logic:
    //   - localStorage flag present → user has onboarded before on
    //     THIS install, skip.
    //   - flag absent + signed-in user has a boats row in cloud →
    //     they onboarded on another device. Back-fill the flag so
    //     future boots are fast-path, then skip.
    //   - flag absent + no boats row → genuinely new account, show
    //     onboarding.
    //
    // This is the fix for the "reinstall mints duplicate vessel"
    // bug — pre-refactor, every reinstall ran onboarding because
    // localStorage is sandboxed per-install, even when the cloud
    // identity already had a boat.
    useEffect(() => {
        let cancelled = false;
        const actionScope = identityScope;

        (async () => {
            // Auth still resolving on cold boot — wait. Setting
            // showOnboarding(true) prematurely here causes a race
            // where the wizard pops up before the cloud boats check
            // can decide "no, you have a boat, skip it" — and once
            // the wizard is rendered, the cloud-check's no-op
            // success path never clears it again. So we wait for
            // authChecked to flip true before making any decision.
            if (!authChecked) return;

            const flag = hasScopedFlag(ONBOARDED_KEY, actionScope);

            if (flag) {
                // Fast path — flag means we've done this dance before.
                if (!cancelled) setShowOnboardingForScope(actionScope, false);
                if (!weatherData && !loading && settings.defaultLocation) {
                    // Steer the page only if the skipper is still ON the
                    // dashboard. The weather fetch below must still run — it is
                    // the useful half — but navigating someone off the chart
                    // mid-route-plan never is. See currentViewRef.
                    if (currentViewRef.current === 'dashboard') setPage('dashboard');
                    // Pass the saved coords if we have them —
                    // prevents the weather orchestrator from
                    // forward-geocoding and picking a wrong match
                    // (e.g. Mapbox prefers Newport, Monmouthshire
                    // UK over Newport, QLD AU).
                    fetchWeather(settings.defaultLocation, false, settings.defaultLocationCoords);
                }
                // No defaultLocation → leave weatherData null. The
                // Dashboard branch in App.tsx renders an empty-state
                // card with "Use my location" + "Choose a port" CTAs.
                return;
            }

            // No local flag. Are we authed AND do we have a cloud
            // boat row? If yes, this is a re-install of an existing
            // user — back-fill flag, skip onboarding.
            // Classify this signed-in account: does it already own a boat in
            // the cloud? THREE outcomes, and the distinction is the whole point
            // of the fix — only a CONCLUSIVE "no boat" may launch onboarding.
            // An error or a dropped connection is 'unknown', never 'new':
            // showing the wizard to a returning user whose check merely FAILED
            // makes them create a SECOND vessel (audit item 14). A cold boot's
            // first query often races the network coming up, so retry a couple
            // of times before giving up to 'unknown'.
            type BoatCheck = 'has-boat' | 'no-boat' | 'unknown';
            let boatCheck: BoatCheck = 'unknown';
            if (authedUser?.id === actionScope.userId && supabase) {
                for (let attempt = 0; attempt < 3; attempt++) {
                    try {
                        const { data: boat, error } = await supabase
                            .from('boats')
                            .select('id')
                            .eq('owner_id', actionScope.userId)
                            .limit(1)
                            .maybeSingle();
                        if (cancelled || !isAuthIdentityScopeCurrent(actionScope)) return;
                        if (error) throw new Error(error.message);
                        boatCheck = boat?.id ? 'has-boat' : 'no-boat';
                        break;
                    } catch (err) {
                        // RLS, network, a policy typo — all land here. Retry
                        // with backoff, then leave it 'unknown'. Never guess
                        // 'new' from a failure.
                        log.warn(`boats cloud-check attempt ${attempt + 1} failed:`, err);
                        if (attempt < 2) {
                            await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
                            if (cancelled || !isAuthIdentityScopeCurrent(actionScope)) return;
                        }
                    }
                }
            }

            if (boatCheck === 'has-boat') {
                // Backfill every "first-time user" flag we know
                // about. They all gate the various tutorial /
                // intro overlays via localStorage, which is
                // wiped per-install. Returning users have seen
                // these already; suppress them all so the
                // reinstall feels like a clean resume.
                // (Race caveat: useState initializers in these
                // overlays read the flags during the same React
                // render this effect mounts. The flags may not
                // be set before the overlay's initial render,
                // so they can flash briefly on first sign-in.
                // Worst case the user dismisses them once.)
                setScopedFlag(ONBOARDED_KEY, actionScope);
                setScopedFlag(TUTORIAL_COMPLETED_KEY, actionScope);
                setScopedFlag(INTRO_COMPLETED_KEY, actionScope);
                setScopedFlag(GLASS_TUTORIAL_SEEN_KEY, actionScope);
                // CRITICAL: explicitly hide the wizard. Without
                // this, a previous render that set showOnboarding
                // true (before auth resolved) leaves the wizard
                // on screen even though we now know they have a
                // boat. This was the "Apple sign-in but wizard
                // ran anyway" bug.
                if (!cancelled) setShowOnboardingForScope(actionScope, false);
                // Do not ask for Location merely because a returning
                // account was restored. The Glass empty state exposes
                // an explicit "Use my location" action, and features
                // that need continuous/background fixes request their
                // own permissions at point of use. Boot may consume an
                // already-granted one-shot fix below, but it must never
                // manufacture a permission prompt.
                // Drop the !loading guard. On first launch after
                // a fresh install + sign-in, the orchestrator's
                // init has already run and set loading=false
                // (no defaultLocation yet at that point). By the
                // time this effect re-fires with the cloud-
                // restored defaultLocation, loading might be
                // true or false depending on the race — and the
                // !loading guard occasionally blocked the
                // refetch. The orchestrator's internal
                // isFetching guard prevents duplicate concurrent
                // calls, so dropping !loading here is safe.
                if (!weatherData && settings.defaultLocation) {
                    // Same rule as the fast path — and this branch is
                    // the more dangerous of the two, because it
                    // deliberately dropped the !loading guard, so it
                    // fires while a fetch is still in flight.
                    if (currentViewRef.current === 'dashboard') setPage('dashboard');
                    fetchWeather(settings.defaultLocation, false, settings.defaultLocationCoords);
                }
                return;
                return;
            }

            if (boatCheck === 'unknown' && authedUser?.id === actionScope.userId) {
                // Could not tell. A returning user must NEVER be trapped into
                // re-creating their vessel by a transient error, so onboarding
                // stays hidden and the next launch (or identity change) retries.
                // They still get their weather if a saved location survived.
                log.warn('boats cloud-check inconclusive after retries; leaving onboarding hidden');
                if (!weatherData && settings.defaultLocation) {
                    if (currentViewRef.current === 'dashboard') setPage('dashboard');
                    fetchWeather(settings.defaultLocation, false, settings.defaultLocationCoords);
                }
                return;
            }

            // CONCLUSIVE new account: the cloud answered, and there is no boat.
            // Show onboarding ONLY here, and only signed in — an un-authed user
            // has no cloud account to attach a vessel to yet, so the wizard
            // would dead-end at "save your boat". Browsing without an account is
            // supported; onboarding waits until they sign in at a save point.
            if (
                !cancelled &&
                boatCheck === 'no-boat' &&
                authedUser?.id === actionScope.userId &&
                actionScope.userId &&
                isAuthIdentityScopeCurrent(actionScope)
            ) {
                setShowOnboardingForScope(actionScope, true);
            }
            // Un-authed user, no flag, no defaultLocation: fall
            // through to the Dashboard's empty state (handled in
            // App.tsx). No fake data — they get a clean "Use my
            // location" / "Choose a port" card just like every other
            // weather app on iOS.
        })();

        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [settings.defaultLocation, authedUser, authChecked, identityScope, setShowOnboardingForScope]);

    // 1b. CHARTPLOTTER DEFAULT — when Location has ALREADY been granted, an
    // open re-centres on the live position and enters GPS-follow mode. A boot
    // must never trigger Location or Motion permission UI: if permission is
    // not already granted, the saved location remains in place until the
    // skipper explicitly taps a location/GPS action.
    //
    // Runs once per launch (gpsBootRan) so it only sets the OPEN default; a
    // port the user picks later in the session is respected until the next
    // open. GPS denied/timeout → return early, keeping whatever 1a already
    // painted (the last location) — never strands on a blank fix.
    //
    // (Superseded the old "only auto-update when sitting on the home port"
    // rule — that was what let a stray named place from a weekend trip stick
    // on open instead of re-centring to where you actually are.)
    useEffect(() => {
        if (!authChecked) return;
        const actionScope = identityScope;
        const scopeRunKey = `${actionScope.key}:${actionScope.generation}`;
        if (gpsBootScopeRef.current === scopeRunKey) return;
        const onboarded = hasScopedFlag(ONBOARDED_KEY, actionScope);
        if (!onboarded) return; // don't run during onboarding

        gpsBootScopeRef.current = scopeRunKey;
        let cancelled = false;

        void (async () => {
            try {
                // This already-granted-only path uses the foreground provider
                // and fails closed before any prompt. It never initializes the
                // Transistorsoft background or motion engine.
                const fix = await GpsService.getCurrentPositionIfGranted({
                    staleLimitMs: 60_000,
                    timeoutSec: 8,
                });
                if (cancelled || !isAuthIdentityScopeCurrent(actionScope)) return;
                if (!fix) return;

                // Already following GPS → the WeatherContext follower owns it
                // (renames + refetches underway without leaving 'gps' mode).
                // Read the LIVE store, not the mount-time closure.
                if (useSettingsStore.getState().settings.defaultLocation === 'Current Location') return;

                const { latitude, longitude } = fix;
                // Enter sticky GPS-follow mode at the live position.
                log.info(`GPS boot: entering follow mode at ${latitude.toFixed(2)}, ${longitude.toFixed(2)}`);
                await selectLocation('Current Location', { lat: latitude, lon: longitude });
            } catch {
                // Permission unavailable/denied, location services disabled,
                // or a timed-out fix: retain the saved location silently.
            }
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [authChecked, identityScope]);

    // 1c. Reverse-geocode "Current Location" to a friendly place name
    //
    // When pullFromCloud falls back to 'Current Location' (returning
    // user with an empty profiles row — see settingsStore.pullFromCloud),
    // the location box reads "Current Location" — useful for the
    // weather flow but ugly in the UI. Once weather has actually
    // loaded and we have coords, reverse-geocode them to something
    // like "Newport, QLD" and promote that to settings.defaultLocation,
    // so the Query Sync effect below updates the location box and
    // future cold boots pick up the friendly name instead.
    //
    // Guards: only fires when defaultLocation is the literal
    // 'Current Location' string AND we have a fresh fix from the
    // weather payload. Refires only when those change — won't
    // clobber a user's manual port selection.
    const reverseGeocodeRanRef = React.useRef(false);
    useEffect(() => {
        if (reverseGeocodeRanRef.current) return;
        if (settings.defaultLocation !== 'Current Location') return;
        const coords = weatherData?.coordinates;
        if (!coords || (coords.lat === 0 && coords.lon === 0)) return;

        reverseGeocodeRanRef.current = true;
        // GPS-FOLLOW MODE IS STICKY (2026-06-12). This effect previously
        // promoted the geocoded name via selectLocation(name) — which
        // flipped locationMode 'gps' → 'selected' and permanently killed
        // the GPS follower in WeatherContext (the "position never updates
        // underway" bug; the follower only runs in 'gps' mode). The two
        // problems it was solving are now owned elsewhere:
        //   - pretty display name: the follower prettifies the literal
        //     'Current Location' label on its first tick (and keeps it
        //     live as the boat moves), without touching settings;
        //   - refresh clobber: the smart-refresh GPS branch now labels
        //     its fetches with the current friendly name instead of the
        //     literal string.
        // All that remains here: persist coords so future cold boots can
        // skip a forward-geocode round-trip.
        updateSettings({ defaultLocationCoords: { lat: coords.lat, lon: coords.lon } });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [settings.defaultLocation, weatherData?.coordinates?.lat, weatherData?.coordinates?.lon]);

    // 2. Background Image Sync
    useEffect(() => {
        if (weatherData) {
            const raw = weatherData.current.condition || weatherData.current.description;
            const bg = DEFAULT_BACKGROUNDS[mapConditionToKey(raw)];
            if (bg) setBgImage(bg);
        }
    }, [weatherData]);

    // 3. Query Sync
    // 3. Query Sync
    useEffect(() => {
        if (weatherData && weatherData.locationName && !loading) {
            let targetName = weatherData.locationName;

            // WAYPOINT LOGIC: Unconditional check for Coordinate-like names
            if (weatherData.coordinates) {
                // PRECISE detection — only fires for truly generic names:
                // 1. Starts with "Location", "WP", "Waypoint" (internal placeholders)
                // 2. Is a raw decimal coordinate pair: "-27.47, 153.03" (no letters except optional S/N/E/W)
                // 3. Is purely a water body name: "South Pacific Ocean", "Coral Sea"
                // DOES NOT match: "Brisbane, QLD", "27.47°S, 153.03°E" (already human-readable)
                const isPlaceholder = /^(Location|WP\b|Waypoint)/i.test(weatherData.locationName);
                const isRawDecimal = /^-?\d+\.\d+\s*,\s*-?\d+\.\d+$/.test(weatherData.locationName.trim());
                const isWaterBody =
                    /^(North|South|East|West|Central|Indian|Arctic|Atlantic|Pacific)?\s*(Ocean|Sea|Reef)$/i.test(
                        weatherData.locationName.trim(),
                    );
                const isOceanPoint = weatherData.locationName.includes('Ocean Point');
                const isSafeCoord = isPlaceholder || isRawDecimal || isWaterBody;

                // Only force WP naming if it's truly a raw coordinate or generic placeholder
                if (isSafeCoord || isOceanPoint) {
                    const latStr = formatCoordinate(weatherData.coordinates.lat, 'lat');
                    const lonStr = formatCoordinate(weatherData.coordinates.lon, 'lon');
                    targetName = `WP ${latStr} ${lonStr}`;
                }
            }

            if (query !== targetName) {
                setQuery(targetName);
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [weatherData, loading]);

    // 4. Mobile Landscape Detection
    useEffect(() => {
        const checkOrientation = () => {
            const isLandscape = window.matchMedia('(orientation: landscape)').matches;
            const isShort = window.innerHeight < 500; // Typical mobile landscape height
            setIsMobileLandscape(isLandscape && isShort);
        };
        checkOrientation();
        window.addEventListener('resize', checkOrientation);
        return () => window.removeEventListener('resize', checkOrientation);
    }, []);

    const showToast = useCallback((msg: string) => {
        // Route through global toast system
        if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('failed')) {
            toast.error(msg);
        } else {
            toast.success(msg);
        }
    }, []);

    const handleSearchSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!query || query.length < 2) return;
        const formatted = formatLocationInput(query);
        setQuery(formatted);
        setPage('dashboard');
        // FIX: Use selectLocation to ensure persistence & optimistic UI
        selectLocation(formatted);
    };

    const handleLocate = () => {
        const actionScope = identityScope;
        if (!isAuthIdentityScopeCurrent(actionScope)) return;
        if (isOffline) {
            toast.error('GPS requires network.');
            return;
        }
        setQuery('Locating...');
        void (async () => {
            try {
                const pos = await GpsService.requestCurrentForegroundPosition({
                    staleLimitMs: 30_000,
                    timeoutSec: 15,
                });
                if (!isAuthIdentityScopeCurrent(actionScope)) return;
                if (!pos) {
                    showToast('GPS Error: Unable to get position');
                    setQuery('');
                    return;
                }
                const { latitude, longitude } = pos;
                const coordStr = `WP ${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
                let searchTarget = coordStr;
                try {
                    const name = await reverseGeocode(latitude, longitude);
                    if (!isAuthIdentityScopeCurrent(actionScope)) return;
                    if (name) searchTarget = name;
                } catch {
                    if (!isAuthIdentityScopeCurrent(actionScope)) return;
                    // Silently ignored — non-critical failure
                }
                setQuery(searchTarget);
                setPage('dashboard');
                void selectLocation(searchTarget, { lat: latitude, lon: longitude });
            } catch {
                if (!isAuthIdentityScopeCurrent(actionScope)) return;
                showToast('GPS Error: Unable to get position');
                setQuery('');
            }
        })();
    };

    /**
     * "Lite" one-shot location handler for first-touch surfaces
     * (e.g. The Glass empty-state's "Use my location" button).
     *
     * Routes through GpsService's foreground-only provider instead of its
     * background-safety path. This asks only for ordinary foreground Location
     * and never initializes Transistorsoft or motion activity machinery.
     *
     * BgGeoManager is deferred to features that genuinely need background
     * tracking (MOB, Anchor Watch, active Voyage). Point-of-need permissions,
     * not boot-time initialization.
     */
    const handleLocateLite = useCallback(async () => {
        const actionScope = identityScope;
        if (!isAuthIdentityScopeCurrent(actionScope)) return;
        try {
            const pos = await GpsService.requestCurrentForegroundPosition({
                staleLimitMs: 30_000,
                timeoutSec: 12,
            });
            if (!isAuthIdentityScopeCurrent(actionScope)) return;
            if (!pos) {
                toast.error('Location denied. Try the map picker instead.');
                return;
            }
            const { latitude, longitude } = pos;
            let searchTarget = `WP ${Math.abs(latitude).toFixed(4)}°${latitude >= 0 ? 'N' : 'S'}, ${Math.abs(longitude).toFixed(4)}°${longitude >= 0 ? 'E' : 'W'}`;
            if (!isOffline) {
                try {
                    const name = await reverseGeocode(latitude, longitude);
                    if (!isAuthIdentityScopeCurrent(actionScope)) return;
                    if (name) searchTarget = name;
                } catch {
                    if (!isAuthIdentityScopeCurrent(actionScope)) return;
                    // Silent — the coordinate string fallback is sufficient.
                }
            }
            setQuery(searchTarget);
            setPage('dashboard');
            selectLocation(searchTarget, { lat: latitude, lon: longitude });
            if (isOffline) toast.info('GPS location saved. Weather will update when the network returns.');
        } catch (e) {
            if (!isAuthIdentityScopeCurrent(actionScope)) return;
            log.warn('handleLocateLite failed:', e);
            toast.error("Couldn't get your location. Try the map picker instead.");
        }
    }, [identityScope, isOffline, selectLocation, setPage]);

    const handleOnboardingComplete = (newSettings: Partial<UserSettings>) => {
        const actionScope = identityScope;
        if (!isAuthIdentityScopeCurrent(actionScope)) return;
        updateSettings(newSettings);
        setShowOnboardingForScope(actionScope, false);
        if (newSettings.defaultLocation) {
            setQuery(newSettings.defaultLocation);
            // Pass coords — the onboarding wizard now saves them alongside
            // the name. Forward-geocoding 'Newport, QLD, AU' returns UK
            // Newport as a top match; bypassing parseLocation with the
            // authoritative coords from the wizard kills that bug.
            setTimeout(() => {
                if (!isAuthIdentityScopeCurrent(actionScope)) return;
                void fetchWeather(newSettings.defaultLocation!, true, newSettings.defaultLocationCoords);
            }, 100);
        }
    };

    const toggleFavorite = useCallback(() => {
        if (!weatherData) return;
        const loc = weatherData.locationName;
        const isFav = settings.savedLocations.includes(loc);
        let newLocs;
        if (isFav) {
            newLocs = settings.savedLocations.filter((l) => l !== loc);
            showToast(`Removed ${loc} from favorites`);
        } else {
            newLocs = [loc, ...settings.savedLocations];
            showToast(`Saved ${loc} to favorites`);
        }
        updateSettings({ savedLocations: newLocs });
    }, [weatherData, settings.savedLocations, showToast, updateSettings]);

    const handleMapTargetSelect = useCallback(
        async (lat: number, lon: number, name?: string) => {
            const actionScope = identityScope;
            if (!isAuthIdentityScopeCurrent(actionScope)) return;
            const picked = await resolveMapPick(lat, lon, name, actionScope);
            if (!picked) return;
            const { locationQuery, finalCoords } = picked;
            const normalizedLon = finalCoords.lon;

            setQuery(locationQuery);
            setSheetOpen(false);

            // Distance from the saved home port is the variable that separates
            // a working pick from the crash — stamp it so one trail shows it.
            const home = settings.defaultLocationCoords;
            const nm = home
                ? Math.round(
                      3440.065 *
                          Math.acos(
                              Math.min(
                                  1,
                                  Math.sin((home.lat * Math.PI) / 180) * Math.sin((lat * Math.PI) / 180) +
                                      Math.cos((home.lat * Math.PI) / 180) *
                                          Math.cos((lat * Math.PI) / 180) *
                                          Math.cos(((normalizedLon - home.lon) * Math.PI) / 180),
                              ),
                          ),
                  )
                : -1;
            crumb('pick:commit', `${nm}nm`);

            // NAVIGATION FIRST (Optimistic UI)
            // Default to full dashboard — inland locations are auto-forced to essential by Dashboard
            updateSettings({ dashboardMode: 'full' });
            setPage('dashboard');
            crumb('pick:nav-glass');

            // Fire-and-forget fetch. Reported via Preferences as well as the
            // crumb trail: the trail only surfaces after a CRASH, and this
            // path turned out not to crash at all — it navigated, kept the
            // old numbers, and said nothing. An outcome you can read in
            // Xcode on every pick is what makes that visible.
            void import('@capacitor/preferences')
                .then(({ Preferences }) =>
                    writeScopedNativeDiagnostic(
                        Preferences,
                        'PICK_RESULT',
                        `[PICK] request @${nm}nm — fetching`,
                        actionScope,
                    ),
                )
                .catch(() => {});
            selectLocation(locationQuery, finalCoords)
                .then(() => {
                    if (!isAuthIdentityScopeCurrent(actionScope)) return;
                    crumb('pick:fetch-ok');
                    void import('@capacitor/preferences')
                        .then(({ Preferences }) =>
                            writeScopedNativeDiagnostic(Preferences, 'PICK_RESULT', '[PICK] request — OK', actionScope),
                        )
                        .catch(() => {});
                })
                .catch((e) => {
                    if (!isAuthIdentityScopeCurrent(actionScope)) return;
                    crumb('pick:fetch-fail', String(e).slice(0, 60));
                    void import('@capacitor/preferences')
                        .then(({ Preferences }) =>
                            writeScopedNativeDiagnostic(
                                Preferences,
                                'PICK_RESULT',
                                `[PICK] request — FAILED (${e instanceof Error ? e.name : 'unknown error'})`,
                                actionScope,
                            ),
                        )
                        .catch(() => {});
                    showToast('Location update failed, check network.');
                });
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [identityScope, setQuery, selectLocation, setPage, showToast],
    );

    // Same as handleMapTargetSelect but stays on the current page (for Map tab — user must press back chevron)
    const handleMapStaySelect = useCallback(
        async (lat: number, lon: number, name?: string) => {
            const actionScope = identityScope;
            if (!isAuthIdentityScopeCurrent(actionScope)) return;
            const picked = await resolveMapPick(lat, lon, name, actionScope);
            if (!picked) return;
            const { locationQuery, finalCoords } = picked;

            setQuery(locationQuery);
            setSheetOpen(false);
            updateSettings({ dashboardMode: 'full' });
            // Don't navigate — stay on map
            selectLocation(locationQuery, finalCoords).catch((e) => {
                if (!isAuthIdentityScopeCurrent(actionScope)) return;
                showToast('Location update failed, check network.');
            });
        },
        [identityScope, setQuery, selectLocation, showToast, updateSettings],
    );

    // Favourite picks must CLAIM LocationStore (same defect the map picker
    // had, fixed in db802ae0): The Glass mounts useLiveLocationName, which
    // re-stamps the store with source:'gps' + the boat's own place name
    // every 3s and only yields to a user claim. App.tsx and Dashboard
    // prefer that live name for their titles, and the model-comparison
    // card reads coords straight off the store — so an unclaimed favourite
    // gets the weather it asked for and then has every label (and the
    // comparison card's fetches) quietly reverted to the boat within ~3s.
    //
    // Ocean-point favourites carry coords in the name and claim on tap.
    // Named favourites are just a string — coords only exist once the
    // weather report resolves, so the tap parks the name here and the
    // effect below claims when the report for THAT name lands. Time-boxed
    // so an abandoned pick (fetch died, user moved on) can't ambush a
    // same-named report much later and freeze GPS tracking.
    const pendingFavoriteClaimRef = React.useRef<{
        name: string;
        at: number;
        scope: AuthIdentityScope;
    } | null>(null);

    useEffect(() => {
        const pending = pendingFavoriteClaimRef.current;
        if (!pending) return;
        if (!isAuthIdentityScopeCurrent(pending.scope)) {
            pendingFavoriteClaimRef.current = null;
            return;
        }
        if (!weatherData) return;
        if (Date.now() - pending.at > PENDING_FAVORITE_CLAIM_MS) {
            pendingFavoriteClaimRef.current = null;
            return;
        }
        if (weatherData.locationName !== pending.name) return;
        const coords = weatherData.coordinates;
        // (0,0) is the cold-start optimistic stub, not a real position.
        if (!coords || (coords.lat === 0 && coords.lon === 0)) return;
        pendingFavoriteClaimRef.current = null;
        LocationStore.setFromFavorite(coords.lat, coords.lon, weatherData.locationName);
    }, [identityScope, weatherData]);

    const handleFavoriteSelect = useCallback(
        (loc: string) => {
            const actionScope = identityScope;
            if (!isAuthIdentityScopeCurrent(actionScope)) return;
            setQuery(loc);
            const oceanMatch = loc.match(/Ocean Point\s+(\d+\.\d+)([NS])\s+(\d+\.\d+)([EW])/);
            if (oceanMatch) {
                const rawLat = parseFloat(oceanMatch[1]);
                const latDir = oceanMatch[2];
                const rawLon = parseFloat(oceanMatch[3]);
                const lonDir = oceanMatch[4];
                const lat = latDir === 'S' ? -rawLat : rawLat;
                const lon = lonDir === 'W' ? -rawLon : rawLon;
                LocationStore.setFromFavorite(lat, lon, loc);
                selectLocation(loc, { lat, lon });
            } else {
                pendingFavoriteClaimRef.current = { name: loc, at: Date.now(), scope: actionScope };
                selectLocation(loc);
            }
            setPage('dashboard');
        },
        [identityScope, setQuery, selectLocation, setPage],
    );

    // Navigation Handlers (Encapsulate DOM/Window logic)
    const handleTabDashboard = useCallback(() => {
        if (currentView !== 'dashboard') {
            setPage('dashboard');
        } else {
            // "Pull to Refresh" feel for tab click
            setTimeout(() => window.dispatchEvent(new Event('hero-reset-scroll')), 10);
        }
    }, [currentView, setPage]);

    const handleTabMetrics = useCallback(() => {
        setPage('details');
        // Encapsulate the scroll reset
        document.getElementById('app-scroll-container')?.scrollTo({ top: 0, behavior: 'smooth' });
    }, [setPage]);

    const handleTabPassage = useCallback(() => setPage('voyage'), [setPage]);
    const handleTabMap = useCallback(() => setPage('map'), [setPage]);
    const handleTabSettings = useCallback(() => setPage('settings'), [setPage]);

    // Calculate Display Mode
    let effectiveMode: DisplayMode = settings.displayMode;
    if (settings.displayMode === 'auto') {
        const now = new Date();
        let isNight = false;
        if (weatherData && weatherData.coordinates) {
            const times = getSunTimes(now, weatherData.coordinates.lat, weatherData.coordinates.lon);
            if (times) {
                isNight = now < times.sunrise || now >= times.sunset;
            } else {
                const currentHour = now.getHours();
                isNight = currentHour < 6 || currentHour >= 18;
            }
        } else {
            const currentHour = now.getHours();
            isNight = currentHour < 6 || currentHour >= 18;
        }
        effectiveMode = isNight ? 'dark' : 'light';
    }

    return {
        query,
        setQuery,
        bgImage,
        showOnboarding,
        showToast,
        handleSearchSubmit,
        handleLocate,
        handleLocateLite,
        effectiveMode,

        // Extracted Handlers & State
        toggleFavorite,
        handleMapTargetSelect,
        handleMapStaySelect,
        handleFavoriteSelect,
        handleOnboardingComplete,

        sheetData,
        setSheetData,
        sheetOpen,
        setSheetOpen,
        isUpgradeOpen,
        setIsUpgradeOpen,
        isMobileLandscape,

        // Navigation
        handleTabDashboard,
        handleTabMetrics,
        handleTabPassage,
        handleTabMap,
        handleTabSettings,
    };
};
