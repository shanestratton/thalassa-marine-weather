import React, { useState, useEffect, useCallback } from 'react';
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
import { Geolocation } from '@capacitor/geolocation';
import { crumb } from '../utils/flightRecorder';
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
    const authChecked = useAuthStore((s) => s.authChecked);

    const [query, setQuery] = useState('');
    const [bgImage, setBgImage] = useState(DEFAULT_BACKGROUNDS.default);
    const [showOnboarding, setShowOnboarding] = useState(false);

    // UI Local State
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [sheetData, setSheetData] = useState<any>(null);
    const [sheetOpen, setSheetOpen] = useState(false);
    const [isUpgradeOpen, setIsUpgradeOpen] = useState(false);
    const [isMobileLandscape, setIsMobileLandscape] = useState(false);

    const gpsBootRan = React.useRef(false);

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

        (async () => {
            // Auth still resolving on cold boot — wait. Setting
            // showOnboarding(true) prematurely here causes a race
            // where the wizard pops up before the cloud boats check
            // can decide "no, you have a boat, skip it" — and once
            // the wizard is rendered, the cloud-check's no-op
            // success path never clears it again. So we wait for
            // authChecked to flip true before making any decision.
            if (!authChecked) return;

            const flag = localStorage.getItem('thalassa_v3_onboarded');

            if (flag) {
                // Fast path — flag means we've done this dance before.
                if (!cancelled) setShowOnboarding(false);
                if (!weatherData && !loading && settings.defaultLocation) {
                    setPage('dashboard');
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
            if (authedUser && supabase) {
                try {
                    const { data: boat, error } = await supabase
                        .from('boats')
                        .select('id')
                        .eq('owner_id', authedUser.id)
                        .maybeSingle();
                    if (cancelled) return;
                    if (error) {
                        // Don't swallow this silently — RLS, network,
                        // or a typo in a policy will all surface here
                        // and we want to know about it in Xcode logs.
                        log.warn('boats cloud-check error:', error.message);
                    }
                    if (boat?.id) {
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
                        localStorage.setItem('thalassa_v3_onboarded', 'true');
                        localStorage.setItem('thalassa_tutorial_completed', 'true');
                        localStorage.setItem('thalassa_onboarding_complete', 'true');
                        localStorage.setItem('thalassa_glass_tutorial_seen', 'true');
                        // CRITICAL: explicitly hide the wizard. Without
                        // this, a previous render that set showOnboarding
                        // true (before auth resolved) leaves the wizard
                        // on screen even though we now know they have a
                        // boat. This was the "Apple sign-in but wizard
                        // ran anyway" bug.
                        if (!cancelled) setShowOnboarding(false);
                        // Returning users skip onboarding's "Locate Me"
                        // step, so iOS never sees a location request
                        // until something happens to need GPS — leaves
                        // The Glass page spinning. Trigger the prompt
                        // now via Capacitor's own Geolocation plugin
                        // rather than GpsService, because GpsService
                        // routes through BgGeoManager which would ALSO
                        // initialize Transistorsoft's
                        // BackgroundGeolocation and triggers a Motion
                        // permission prompt on top of Location — three
                        // prompts on first launch is overload. Capacitor
                        // Geolocation requests just Location and stays
                        // out of the motion / background-tracking
                        // permission domain. BgGeoManager will init
                        // later, when the user navigates to a feature
                        // that actually needs background tracking
                        // (Map, Anchor Watch, Voyage), and Motion will
                        // get prompted then — at point-of-need, not
                        // boot. Fire-and-forget.
                        void Geolocation.requestPermissions().catch(() => {
                            /* denied or unavailable — weather will fall
                               back to the user's saved port location */
                        });
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
                            setPage('dashboard');
                            fetchWeather(settings.defaultLocation, false, settings.defaultLocationCoords);
                        }
                        return;
                    }
                } catch (err) {
                    log.warn('boats cloud-check failed; falling through to onboarding:', err);
                }
            }

            // Genuinely new account (or offline + no flag). Show
            // onboarding ONLY if signed in. Un-authed users have no
            // cloud account to attach a vessel to yet, so the wizard
            // would dead-end at the "save your boat" step. Browsing
            // without an account is supported — onboarding waits until
            // the user signs in at a save point and we land back here
            // with authedUser populated. (Deferred-sign-in flow,
            // 2026-05-17.)
            if (!cancelled && authedUser) {
                setShowOnboarding(true);
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
    }, [settings.defaultLocation, authedUser, authChecked]);

    // 1b. CHARTPLOTTER DEFAULT — every open re-centres on the live position
    // and enters GPS-follow mode (2026-06-16, Shane: "when I open the app it
    // should ALWAYS default to my current location"). On a successful boot
    // fix we switch to 'Current Location'/'gps' regardless of the last-saved
    // place, so weather + location track the boat as it moves. Saved ports
    // live in settings.savedLocations (a separate picker) and are untouched —
    // they become picks, not the open default.
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
        if (gpsBootRan.current) return;
        const onboarded = localStorage.getItem('thalassa_v3_onboarded');
        if (!onboarded) return; // don't run during onboarding

        gpsBootRan.current = true;

        // Fire GPS check in background — non-blocking.
        GpsService.getCurrentPosition({ staleLimitMs: 60_000, timeoutSec: 8 }).then((pos) => {
            if (!pos) return; // GPS denied or timed out — keep the saved location 1a painted

            // Already following GPS → the WeatherContext follower owns it
            // (renames + refetches underway without leaving 'gps' mode). Read
            // the LIVE store, not the mount-time closure.
            if (useSettingsStore.getState().settings.defaultLocation === 'Current Location') return;

            // Enter sticky GPS-follow mode at the live position. selectLocation
            // flips locationMode 'gps' + persists the intent; the follower
            // prettifies the 'Current Location' label on its first tick and
            // keeps it live as the boat moves. Seeding the coords makes the
            // switch a silent background refresh, not a blur overlay.
            log.info(`GPS boot: entering follow mode at ${pos.latitude.toFixed(2)}, ${pos.longitude.toFixed(2)}`);
            selectLocation('Current Location', { lat: pos.latitude, lon: pos.longitude }).catch(() => {});
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

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
        if (isOffline) {
            toast.error('GPS requires network.');
            return;
        }
        setQuery('Locating...');
        GpsService.getCurrentPosition({ staleLimitMs: 30_000, timeoutSec: 15 }).then(async (pos) => {
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
                if (name) searchTarget = name;
            } catch (e) {
                // Silently ignored — non-critical failure
            }
            setQuery(searchTarget);
            setPage('dashboard');
            selectLocation(searchTarget, { lat: latitude, lon: longitude });
        });
    };

    /**
     * "Lite" one-shot location handler for first-touch surfaces
     * (e.g. The Glass empty-state's "Use my location" button).
     *
     * Routes through Capacitor's basic Geolocation plugin instead
     * of `GpsService` → `BgGeoManager` (Transistorsoft). The
     * reason matters: BgGeoManager initialises the background-
     * tracking engine the first time it's called, which prompts
     * for the iOS **Motion & Fitness** permission on top of
     * **Location** — two prompts back-to-back on first tap is
     * jarring and confusing. Capacitor Geolocation prompts only
     * for Location.
     *
     * BgGeoManager + the Motion prompt are deferred to when the
     * user actually opens a feature that needs background tracking
     * (Map, Anchor Watch, Voyage). Point-of-need permissions,
     * not boot-time overload.
     */
    const handleLocateLite = useCallback(async () => {
        if (isOffline) {
            toast.error('GPS requires network.');
            return;
        }
        try {
            const perms = await Geolocation.requestPermissions();
            if (perms.location !== 'granted' && perms.coarseLocation !== 'granted') {
                toast.error('Location denied. Try the map picker instead.');
                return;
            }
            const pos = await Geolocation.getCurrentPosition({
                enableHighAccuracy: true,
                timeout: 12_000,
                maximumAge: 30_000,
            });
            const { latitude, longitude } = pos.coords;
            let searchTarget = `WP ${Math.abs(latitude).toFixed(4)}°${latitude >= 0 ? 'N' : 'S'}, ${Math.abs(longitude).toFixed(4)}°${longitude >= 0 ? 'E' : 'W'}`;
            try {
                const name = await reverseGeocode(latitude, longitude);
                if (name) searchTarget = name;
            } catch {
                // Silent — the coord string fallback is fine
            }
            setQuery(searchTarget);
            setPage('dashboard');
            selectLocation(searchTarget, { lat: latitude, lon: longitude });
        } catch (e) {
            log.warn('handleLocateLite failed:', e);
            toast.error("Couldn't get your location. Try the map picker instead.");
        }
    }, [isOffline, selectLocation, setPage]);

    const handleOnboardingComplete = (newSettings: Partial<UserSettings>) => {
        updateSettings(newSettings);
        setShowOnboarding(false);
        if (newSettings.defaultLocation) {
            setQuery(newSettings.defaultLocation);
            // Pass coords — the onboarding wizard now saves them alongside
            // the name. Forward-geocoding 'Newport, QLD, AU' returns UK
            // Newport as a top match; bypassing parseLocation with the
            // authoritative coords from the wizard kills that bug.
            setTimeout(() => fetchWeather(newSettings.defaultLocation!, true, newSettings.defaultLocationCoords), 100);
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
                    if (geoName) locationQuery = geoName;
                } catch (e) {
                    log.warn(e);
                    // Geocode failed — fall through
                }
            }
            // Final fallback: WP coordinates
            if (!locationQuery || locationQuery.startsWith('WP ')) {
                // Reformat nicely if it's still a WP string or empty
                locationQuery = `WP ${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(normalizedLon).toFixed(4)}°${normalizedLon >= 0 ? 'E' : 'W'}`;
            }

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

            // Fire-and-forget fetch
            selectLocation(locationQuery, finalCoords)
                .then(() => crumb('pick:fetch-ok'))
                .catch(() => {
                    crumb('pick:fetch-fail');
                    showToast('Location update failed, check network.');
                });
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [setQuery, selectLocation, setPage, showToast],
    );

    // Same as handleMapTargetSelect but stays on the current page (for Map tab — user must press back chevron)
    const handleMapStaySelect = useCallback(
        async (lat: number, lon: number, name?: string) => {
            let normalizedLon = lon;
            while (normalizedLon > 180) normalizedLon -= 360;
            while (normalizedLon < -180) normalizedLon += 360;

            const finalCoords = { lat, lon: normalizedLon };
            let locationQuery = name || '';
            if (!locationQuery || /^-?\d/.test(locationQuery) || locationQuery.startsWith('WP ')) {
                try {
                    const geoName = await reverseGeocode(lat, normalizedLon);
                    if (geoName) locationQuery = geoName;
                } catch (e) {
                    log.warn(e);
                }
            }
            if (!locationQuery || locationQuery.startsWith('WP ')) {
                locationQuery = `WP ${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(normalizedLon).toFixed(4)}°${normalizedLon >= 0 ? 'E' : 'W'}`;
            }

            setQuery(locationQuery);
            setSheetOpen(false);
            updateSettings({ dashboardMode: 'full' });
            // Don't navigate — stay on map
            selectLocation(locationQuery, finalCoords).catch((e) => {
                showToast('Location update failed, check network.');
            });
        },
        [setQuery, selectLocation, showToast, updateSettings],
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
    const pendingFavoriteClaimRef = React.useRef<{ name: string; at: number } | null>(null);

    useEffect(() => {
        const pending = pendingFavoriteClaimRef.current;
        if (!pending || !weatherData) return;
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
    }, [weatherData]);

    const handleFavoriteSelect = useCallback(
        (loc: string) => {
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
                pendingFavoriteClaimRef.current = { name: loc, at: Date.now() };
                selectLocation(loc);
            }
            setPage('dashboard');
        },
        [setQuery, selectLocation, setPage],
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
        setShowOnboarding,
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
