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
import { useAuthStore } from '../stores/authStore';
import { supabase } from '../services/supabase';
import { Geolocation } from '@capacitor/geolocation';

const DEFAULT_BACKGROUNDS = {
    sunny: 'https://images.unsplash.com/photo-1566371486490-560ded23b5e4?q=80&w=1080&fm=jpg&fit=crop',
    cloudy: 'https://images.unsplash.com/photo-1534008753122-a83776b29f6c?q=80&w=1080&fm=jpg&fit=crop',
    rain: 'https://images.unsplash.com/photo-1515694346937-94d85e41e6f0?q=80&w=1080&fm=jpg&fit=crop',
    storm: 'https://images.unsplash.com/photo-1505672675380-4d329615699c?q=80&w=1080&fm=jpg&fit=crop',
    fog: 'https://images.unsplash.com/photo-1485230905346-71acb9518d9c?q=80&w=1080&fm=jpg&fit=crop',
    night: 'https://images.unsplash.com/photo-1500382017468-9049fed747ef?q=80&w=1080&fm=jpg&fit=crop',
    default: 'https://images.unsplash.com/photo-1478359844494-1092259d93e4?q=80&w=1080&fm=jpg&fit=crop',
};

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

/** Haversine distance in km between two lat/lon points */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

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
                    // Pass the saved coords if we have them — prevents
                    // the weather orchestrator from forward-geocoding
                    // and picking a wrong match (e.g. Mapbox prefers
                    // Newport, Monmouthshire UK over Newport, QLD AU).
                    fetchWeather(settings.defaultLocation, false, settings.defaultLocationCoords);
                }
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
            if (!cancelled && authedUser) setShowOnboarding(true);
        })();

        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [settings.defaultLocation, authedUser, authChecked]);

    // 1b. GPS Auto-Locate — update weather ONLY if the current weather is the
    // user's home port AND they've moved away from it. If the cached weather
    // is a location they picked explicitly (favorite, search, map pin), we
    // respect it — the user plans trips to distant ports and the app
    // stomping on that selection is exactly what they don't want.
    //
    // Example: home port = New York, phone in California → cache shows a
    // recent favorite (say, Denver) → DON'T override to California. The
    // location box stays on Denver and the map centers on Denver.
    useEffect(() => {
        if (gpsBootRan.current) return;
        const onboarded = localStorage.getItem('thalassa_v3_onboarded');
        if (!onboarded) return; // don't run during onboarding

        gpsBootRan.current = true;

        // Fire GPS check in background — non-blocking
        GpsService.getCurrentPosition({ staleLimitMs: 60_000, timeoutSec: 8 }).then(async (pos) => {
            if (!pos) return; // GPS denied or timed out — keep saved location

            const { latitude, longitude } = pos;

            const saved = weatherData?.coordinates;
            if (saved) {
                const dist = haversineKm(saved.lat, saved.lon, latitude, longitude);
                if (dist < 10) return; // Haven't moved significantly — keep current weather

                // Only override if what's currently loaded is the home port.
                // Anything else is an explicit selection the user made and
                // expects to come back to.
                const home = settings.defaultLocationCoords;
                const isHomePort =
                    home && Math.abs(saved.lat - home.lat) < 0.05 && Math.abs(saved.lon - home.lon) < 0.05;
                if (!isHomePort) {
                    log.info(
                        `GPS boot: skipping auto-update — cached weather (${weatherData?.locationName}) is not the home port`,
                    );
                    return;
                }
            }

            // User has moved and we're looking at home port — reverse geocode for a readable name
            let locationName = `WP ${Math.abs(latitude).toFixed(4)}°${latitude >= 0 ? 'N' : 'S'}, ${Math.abs(longitude).toFixed(4)}°${longitude >= 0 ? 'E' : 'W'}`;
            try {
                const geoName = await reverseGeocode(latitude, longitude);
                if (geoName) locationName = geoName;
            } catch {
                // geocode failed — use coordinate string
            }

            log.info(`GPS boot: moved to ${locationName} (${latitude.toFixed(2)}, ${longitude.toFixed(2)})`);
            setQuery(locationName);
            selectLocation(locationName, { lat: latitude, lon: longitude }).catch(() => {});
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
        (async () => {
            try {
                const name = await reverseGeocode(coords.lat, coords.lon);
                if (!name) return;
                log.info(`Reverse-geocoded Current Location → ${name}`);
                // Promote the friendly name via selectLocation. This:
                //   1. Flips locationMode 'gps' → 'selected' so the
                //      30-second auto-refresh stops calling
                //      fetchWeather('Current Location', ...) which
                //      was clobbering weatherData.locationName back
                //      to the literal string every refresh. That was
                //      the bug behind "name reverts to Current
                //      Location after restart" — local Preferences
                //      did save the friendly name, but the refresh
                //      kept resetting it. (Drift detection in
                //      WeatherContext still picks up real movement
                //      and re-runs reverseGeocode → selectLocation
                //      with the new name, so users underway still
                //      see their actual position.)
                //   2. Calls updateSettings({defaultLocation: name})
                //      internally so the cloud-sync persists the
                //      friendly name.
                //   3. Hits the history cache for the just-loaded
                //      weather, no extra network round-trip.
                await selectLocation(name, { lat: coords.lat, lon: coords.lon });
                // Persist coords too — selectLocation only writes the
                // name. Coords let future cold boots skip the Mapbox
                // forward-geocode round-trip on the saved name.
                updateSettings({ defaultLocationCoords: { lat: coords.lat, lon: coords.lon } });
                setQuery(name);
            } catch (err) {
                log.warn('reverseGeocode failed:', err);
                // Reset the ref so a future weatherData update can retry.
                reverseGeocodeRanRef.current = false;
            }
        })();
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

            // NAVIGATION FIRST (Optimistic UI)
            // Default to full dashboard — inland locations are auto-forced to essential by Dashboard
            updateSettings({ dashboardMode: 'full' });
            setPage('dashboard');

            // Fire-and-forget fetch
            selectLocation(locationQuery, finalCoords).catch((e) => {
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
                selectLocation(loc, { lat, lon });
            } else {
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
