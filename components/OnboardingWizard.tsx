import React, { useState, useEffect } from 'react';
import { createLogger } from '../utils/createLogger';

const log = createLogger('OnboardingWizard');
import { sanitizeText } from '../utils/inputValidation';
import { toast } from './Toast';
import {
    VesselDetailsStep,
    roughEstimatedDimensionFields,
    validateVesselDetails,
    type AutoFilledVesselDimensions,
    type VesselDimensionField,
} from './onboarding/VesselDetailsStep';
import { UnitPreferencesStep } from './onboarding/UnitPreferencesStep';
import { WelcomeStep } from './onboarding/WelcomeStep';
import { HomePortStep } from './onboarding/HomePortStep';
import { RoleSelectionStep, type OnboardingRole } from './onboarding/RoleSelectionStep';
import { DisplayPrefsStep } from './onboarding/DisplayPrefsStep';
import { OffshoreModelStep } from './onboarding/OffshoreModelStep';
import {
    UserSettings,
    VesselProfile,
    LengthUnit,
    WeightUnit,
    SpeedUnit,
    TempUnit,
    DistanceUnit,
    VolumeUnit,
    WeatherModel,
    PolarData,
    OffshoreModel,
    DisplayMode,
} from '../types';
import { ArrowRightIcon } from './Icons';
import { reverseGeocode, parseLocation } from '../services/weatherService';
import { fetchWeatherByStrategy } from '../services/weather';
import { saveLargeDataImmediate, DATA_CACHE_KEY } from '../services/nativeStorage';
import { getSystemUnits } from '../utils';
import { GpsService } from '../services/GpsService';
import { supabase } from '../services/supabase';
import type { PolarDatabaseEntry } from '../data/polarDatabase';
import { FEET_PER_METRE, vesselCruisingSpeedKts, vesselMaxWaveHeightFt } from '../services/units';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useKeyboardOffset } from '../hooks/useKeyboardOffset';
import { OverlayPortal } from './ui/OverlayPortal';
import { authScopedStorageKey, getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../services/authIdentityScope';

interface OnboardingWizardProps {
    onComplete: (settings: Partial<UserSettings>) => void;
}

export const OnboardingWizard: React.FC<OnboardingWizardProps> = React.memo(({ onComplete }) => {
    const [step, setStep] = useState(1);
    const keyboardHeight = useKeyboardOffset();
    // Ref to the outer scroll container so we can snapshot + restore
    // scrollTop across keyboard-hide events (see handler below).
    const scrollRef = React.useRef<HTMLDivElement | null>(null);
    const focusTrapRef = useFocusTrap<HTMLDivElement>(true);
    const stepContentRef = React.useRef<HTMLDivElement | null>(null);
    const previousStepRef = React.useRef(step);
    const previousKeyboardHeightRef = React.useRef(0);

    // Preserve position when keyboard padding collapses. This fixes WebKit's
    // tendency to snap a long vessel-details form back to the top on blur.
    useEffect(() => {
        const wasKeyboardOpen = previousKeyboardHeightRef.current > 0;
        previousKeyboardHeightRef.current = keyboardHeight;
        if (!wasKeyboardOpen || keyboardHeight > 0) return;

        const saved = scrollRef.current?.scrollTop ?? 0;
        requestAnimationFrame(() => {
            if (scrollRef.current) scrollRef.current.scrollTop = saved;
        });
    }, [keyboardHeight]);

    // Reset scroll to the top of the wizard every time the step changes.
    // Without this, navigating from a long step (e.g. Vessel Details,
    // scrolled to the Continue button at the bottom) to the next step
    // inherits the previous scrollTop — so the next step's heading sits
    // ABOVE the visible viewport, looking exactly like it's hiding in
    // the notch. The reset is synchronous via a layout effect so the
    // new step renders already at scrollTop = 0.
    React.useLayoutEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = 0;
        }
        if (previousStepRef.current !== step) {
            // The button that advances a step is removed during the render.
            // Keep focus inside the mounted dialog and announce the new step
            // instead of allowing focus to fall back to <body>. Do not focus
            // this group on the initial mount: the trap must first snapshot
            // the external launcher so it can restore it on completion.
            stepContentRef.current?.focus({ preventScroll: true });
            previousStepRef.current = step;
        }
    }, [step]);

    // Step 2: Location Data
    const [homePort, setHomePort] = useState('');
    const [isLocating, setIsLocating] = useState(false);
    const [showMap, setShowMap] = useState(false);
    const [tempLocation, setTempLocation] = useState<{ lat: number; lon: number; name: string } | null>(null);

    // User Name — four parts so two crew with the same first name can share a
    // boat without colliding on the public voyage-log byline. First + surname
    // required; prefix (Capt., Dr., …) + nickname optional.
    const [prefix, setPrefix] = useState('');
    const [firstName, setFirstName] = useState('');
    const [lastName, setLastName] = useState('');
    const [nickname, setNickname] = useState('');

    // Core Vessel Data
    const [vesselType, setVesselType] = useState<'sail' | 'power' | 'observer'>('sail');
    const [selectedRole, setSelectedRole] = useState<OnboardingRole>('skipper');
    const [name, setName] = useState('');
    const [registration, setRegistration] = useState('');
    const [mmsi, setMmsi] = useState('');
    const [riggingType, setRiggingType] = useState<
        'Sloop' | 'Cutter' | 'Ketch' | 'Yawl' | 'Schooner' | 'Catboat' | 'Solent' | 'Other'
    >('Sloop');
    const [hullType, setHullType] = useState<'monohull' | 'catamaran' | 'trimaran'>('monohull');
    const [keelType, setKeelType] = useState<'fin' | 'full' | 'wing' | 'skeg' | 'centerboard' | 'bilge'>('fin');

    // Initialize Defaults from System
    const defaults = getSystemUnits();

    // Preference Data
    const [prefSpeed, setPrefSpeed] = useState<SpeedUnit>(defaults.speed);
    const [prefTemp, setPrefTemp] = useState<TempUnit>(defaults.temp);
    const [prefDist, setPrefDist] = useState<DistanceUnit>(defaults.distance);
    const [prefLength, setPrefLength] = useState<LengthUnit>(defaults.length);
    const [prefWaveHeight, setPrefWaveHeight] = useState<LengthUnit>('m'); // Default to Meters per user request
    const [prefVolume, setPrefVolume] = useState<VolumeUnit>(defaults.volume || 'gal');
    const [preferredModel, _setPreferredModel] = useState<WeatherModel>('best_match');
    const [offshoreModel, setOffshoreModel] = useState<OffshoreModel>('sg');

    // Display preferences
    const [prefAlwaysOn, setPrefAlwaysOn] = useState(false);
    const [prefOrientation, setPrefOrientation] = useState<'auto' | 'portrait' | 'landscape'>('portrait');
    const [prefDisplayMode, setPrefDisplayMode] = useState<DisplayMode>('dark');

    // Dimension Data - Initialize as Strings to detect empty vs 0
    const [length, setLength] = useState<string>('');
    const [beam, setBeam] = useState<string>('');
    const [draft, setDraft] = useState<string>('');
    const [airDraft, setAirDraft] = useState<string>('');
    const [displacement, setDisplacement] = useState<string>('');

    // Units
    const [lengthUnit, setLengthUnit] = useState<LengthUnit>(defaults.length);
    const [beamUnit, setBeamUnit] = useState<LengthUnit>(defaults.length);
    const [draftUnit, setDraftUnit] = useState<LengthUnit>(defaults.length);
    const [airDraftUnit, setAirDraftUnit] = useState<LengthUnit>(defaults.length);

    // Weight Units - Default to lbs for US (ft), kg for Metric (m)
    const [dispUnit, setDispUnit] = useState<WeightUnit>(defaults.length === 'ft' ? 'lbs' : 'kg');

    // Tankage Data - Initialize as strings to avoid persistent '0'
    const [fuel, setFuel] = useState<string>('');
    const [water, setWater] = useState<string>('');
    // volUnit mirrors prefVolume at init; sync'd on transition out of the
    // Unit Prefs step so any user preference choice flows through to the
    // vessel-tankage toggle.
    const [volUnit, setVolUnit] = useState<VolumeUnit>(defaults.volume || 'gal');
    const [crewCount, setCrewCount] = useState<string>('2');

    // Yacht database selection (polar data stored for handleFinish)
    const [selectedPolar, setSelectedPolar] = useState<{ data: PolarData; model: string } | null>(null);
    const [autoFilledDimensions, setAutoFilledDimensions] = useState<AutoFilledVesselDimensions>({});
    const [estimatedDimensionsAcknowledged, setEstimatedDimensionsAcknowledged] = useState(false);

    const feetInUnit = (feet: number, unit: LengthUnit) =>
        unit === 'm' ? String(Math.round((feet / FEET_PER_METRE) * 10) / 10) : String(Math.round(feet));

    const handleDimensionChange = (
        field: VesselDimensionField,
        value: string,
        setter: React.Dispatch<React.SetStateAction<string>>,
    ) => {
        setter(value);
        if (
            field === 'length' &&
            (autoFilledDimensions.beam === 'estimate' || autoFilledDimensions.draft === 'estimate')
        ) {
            const enteredLength = Number(value);
            if (Number.isFinite(enteredLength) && enteredLength > 0) {
                const lengthFt = lengthUnit === 'm' ? enteredLength * FEET_PER_METRE : enteredLength;
                if (autoFilledDimensions.beam === 'estimate') setBeam(feetInUnit(lengthFt * 0.32, beamUnit));
                if (autoFilledDimensions.draft === 'estimate') setDraft(feetInUnit(lengthFt * 0.16, draftUnit));
            }
            setEstimatedDimensionsAcknowledged(false);
        }
        setAutoFilledDimensions((current) => {
            if (!current[field]) return current;
            const next = { ...current };
            delete next[field];
            return next;
        });
    };

    const handleYachtSelect = (entry: PolarDatabaseEntry) => {
        setSelectedPolar({ data: entry.polar, model: entry.model });
        // Don't auto-fill the model name into vessel name — user should name their own boat
        // if (!name) setName(entry.model);
        //
        // polarDatabase LOA is in FEET, but each dimension field holds
        // whatever unit its toggle says (seeded from user prefs at step 4).
        // handleFinish converts field → feet via that toggle, so dropping a
        // raw feet estimate into a metres field double-converts on save
        // (8.8 ft of draft labelled "m" saves as 28.9 ft). Convert each
        // estimate into its field's current unit first.
        const nextSources = { ...autoFilledDimensions };
        if (!length || autoFilledDimensions.length) {
            setLength(feetInUnit(entry.loa, lengthUnit));
            nextSources.length = 'database';
        }
        if (!beam || autoFilledDimensions.beam) {
            setBeam(feetInUnit(entry.loa * 0.32, beamUnit));
            nextSources.beam = 'estimate';
        }
        if (!draft || autoFilledDimensions.draft) {
            setDraft(feetInUnit(entry.loa * 0.16, draftUnit));
            nextSources.draft = 'estimate';
        }
        setAutoFilledDimensions(nextSources);
        if (Object.values(nextSources).includes('estimate')) setEstimatedDimensionsAcknowledged(false);
    };

    const handleNext = () => {
        // Step 2 requires home port + first name + surname before progress.
        if (step === 2 && (!sanitizeText(homePort) || !sanitizeText(firstName) || !sanitizeText(lastName))) {
            toast.error('First name, surname, and home port are required.');
            return;
        }

        // If leaving step 2 with a manually-typed location (no coords yet), geocode + prefetch
        if (step === 2 && !prefetchRef.current && homePort.trim()) {
            // Fire-and-forget: geocode the text, then prefetch weather
            parseLocation(homePort.trim())
                .then(({ lat, lon, name }) => {
                    // Update homePort with the resolved name (e.g. "Newport, QLD, AU")
                    if (name && name !== homePort.trim()) setHomePort(name);
                    setTempLocation({ lat, lon, name: name || homePort.trim() });
                    prefetchWeather(lat, lon, name || homePort.trim());
                })
                .catch((e) => {
                    log.warn('Could not geocode manually entered location:', e);
                });
        }

        // Leaving the Unit Preferences step (4) — seed vessel unit toggles
        // with the user's prefs so Vessel Details fields default correctly.
        // The per-field toggles in VesselDetailsStep still let them override
        // (e.g. length in ft but beam in m) if they want.
        if (step === 4) {
            setLengthUnit(prefLength);
            setBeamUnit(prefLength);
            setDraftUnit(prefLength);
            setAirDraftUnit(prefLength);
            setDispUnit(prefLength === 'ft' ? 'lbs' : 'kg');
            setVolUnit(prefVolume);
        }

        // Role personalises setup only; it never changes paid entitlement.
        // Non-skippers skip vessel details (5) + offshore model (6).
        if (step === 4 && selectedRole !== 'skipper') {
            setStep(7); // Jump to display preferences
            return;
        }

        setStep((s) => s + 1);
    };

    // Non-skippers never see steps 5 (vessel details) and 6 (offshore model)
    // — handleNext jumps 4 → 7. The dots and the "step X of Y" label follow
    // the route the user is actually on, instead of claiming seven steps and
    // then skipping two of the dots.
    const visibleSteps = selectedRole === 'skipper' ? [1, 2, 3, 4, 5, 6, 7] : [1, 2, 3, 4, 7];
    const stepPosition = Math.max(1, visibleSteps.indexOf(step) + 1);

    const handleBack = () => {
        // If going back from step 7 and non-Skipper, jump to step 4 (skip offshore + vessel)
        if (step === 7 && selectedRole !== 'skipper') {
            setStep(4);
            return;
        }
        setStep((s) => Math.max(1, s - 1));
    };

    // Background weather prefetch — fire-and-forget when we have coords
    const prefetchRef = React.useRef(false);
    const prefetchWeather = (lat: number, lon: number, name: string) => {
        if (prefetchRef.current) return; // Only prefetch once
        prefetchRef.current = true;
        log.info(`Prefetching weather for ${name} (${lat.toFixed(2)}, ${lon.toFixed(2)})`);
        fetchWeatherByStrategy(lat, lon, name)
            .then((report) => {
                // Save to the instant-cache key so loadInstantCache on the
                // Dashboard sees it immediately when the user lands on The
                // Glass. Previously the fetch result just lived in the
                // API-layer cache, which meant The Glass still did a full
                // fetch chain on first paint (quick because of TTL hits,
                // but not as fast as a direct localStorage read).
                if (report) {
                    try {
                        saveLargeDataImmediate(DATA_CACHE_KEY, report);
                    } catch (e) {
                        log.warn('Could not persist prefetched weather:', e);
                    }
                }
            })
            .catch(() => {
                prefetchRef.current = false; // Allow retry on failure
            });
    };

    /** Resolve a lat/lon pair into a name and update homePort state */
    const resolveAndSetLocation = async (latitude: number, longitude: number) => {
        setTempLocation({ lat: latitude, lon: longitude, name: 'Current Location' });
        try {
            const niceName = await reverseGeocode(latitude, longitude);
            const finalName =
                niceName ||
                `WP ${Math.abs(latitude).toFixed(4)}°${latitude >= 0 ? 'N' : 'S'}, ${Math.abs(longitude).toFixed(4)}°${longitude >= 0 ? 'E' : 'W'}`;
            setHomePort(finalName);
            setTempLocation({ lat: latitude, lon: longitude, name: finalName });
            prefetchWeather(latitude, longitude, finalName);
        } catch (e) {
            const wpName = `WP ${Math.abs(latitude).toFixed(4)}°${latitude >= 0 ? 'N' : 'S'}, ${Math.abs(longitude).toFixed(4)}°${longitude >= 0 ? 'E' : 'W'}`;
            setHomePort(wpName);
            setTempLocation({ lat: latitude, lon: longitude, name: wpName });
            prefetchWeather(latitude, longitude, wpName);
        }
    };

    const handleLocate = () => {
        setIsLocating(true);
        (async () => {
            try {
                // Onboarding needs one foreground fix, not the background
                // tracking engine used by voyage and safety features.
                const pos = await GpsService.requestCurrentForegroundPosition({
                    staleLimitMs: 30_000,
                    timeoutSec: 10,
                    enableHighAccuracy: true,
                });
                if (!pos) {
                    setIsLocating(false);
                    toast.error('Could not access GPS. Please enter your location manually.');
                    return;
                }
                await resolveAndSetLocation(pos.latitude, pos.longitude);
                setIsLocating(false);
            } catch (e) {
                setIsLocating(false);
                log.warn('handleLocate error:', e);
                toast.error('Could not access location. Please enter manually.');
            }
        })();
    };

    // UPDATE: Instant feedback + async resolution
    const handleMapSelect = async (lat: number, lon: number, name?: string) => {
        const initialName = name || 'Identifying...';
        setTempLocation({ lat, lon, name: initialName });

        if (!name) {
            try {
                const geoName = await reverseGeocode(lat, lon);
                if (geoName) {
                    setTempLocation((prev) => {
                        if (prev && prev.lat === lat && prev.lon === lon) {
                            return { lat, lon, name: geoName };
                        }
                        return prev;
                    });
                } else {
                    setTempLocation((prev) => {
                        if (prev && prev.lat === lat && prev.lon === lon) {
                            return {
                                lat,
                                lon,
                                name: `WP ${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`,
                            };
                        }
                        return prev;
                    });
                }
            } catch (e) {
                log.warn(e);
                /* Reverse geocode failed — fall back to WP coordinate format */
                setTempLocation((prev) => {
                    if (prev && prev.lat === lat && prev.lon === lon) {
                        return {
                            lat,
                            lon,
                            name: `WP ${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`,
                        };
                    }
                    return prev;
                });
            }
        }
    };

    const confirmMapSelection = () => {
        if (tempLocation && tempLocation.name !== 'Identifying...') {
            setHomePort(tempLocation.name);
            setShowMap(false);
            // Prefetch weather in background while user continues onboarding
            prefetchWeather(tempLocation.lat, tempLocation.lon, tempLocation.name);
        }
    };

    const convertValue = (val: number, toUnit: LengthUnit) => {
        if (toUnit === 'm') return Math.round(val * 0.3048 * 10) / 10;
        return Math.round(val * 3.28084);
    };

    // Toggle Handlers
    const toggleLengthUnit = () => {
        const newUnit = lengthUnit === 'ft' ? 'm' : 'ft';
        if (length) setLength(convertValue(parseFloat(length), newUnit).toString());
        setLengthUnit(newUnit);
    };
    const toggleBeamUnit = () => {
        const newUnit = beamUnit === 'ft' ? 'm' : 'ft';
        if (beam) setBeam(convertValue(parseFloat(beam), newUnit).toString());
        setBeamUnit(newUnit);
    };
    const toggleDraftUnit = () => {
        const newUnit = draftUnit === 'ft' ? 'm' : 'ft';
        if (draft) setDraft(convertValue(parseFloat(draft), newUnit).toString());
        setDraftUnit(newUnit);
    };
    const toggleAirDraftUnit = () => {
        const newUnit = airDraftUnit === 'ft' ? 'm' : 'ft';
        if (airDraft) setAirDraft(convertValue(parseFloat(airDraft), newUnit).toString());
        setAirDraftUnit(newUnit);
    };

    const toggleDispUnit = () => {
        let newUnit: WeightUnit = 'lbs';
        const d = parseFloat(displacement);
        if (isNaN(d)) {
            // Just switch label if no value
            setDispUnit(dispUnit === 'lbs' ? 'kg' : dispUnit === 'kg' ? 'tonnes' : 'lbs');
            return;
        }

        let newVal = d;
        if (dispUnit === 'lbs') {
            newUnit = 'kg';
            newVal = d * 0.453592;
        } else if (dispUnit === 'kg') {
            newUnit = 'tonnes';
            newVal = d * 0.001;
        } else {
            newUnit = 'lbs';
            newVal = d * 2204.62;
        }

        setDisplacement(Math.round(newVal).toString());
        setDispUnit(newUnit);
    };

    const handleFinish = () => {
        const actionScope = getAuthIdentityScope();
        if (!actionScope.userId || !isAuthIdentityScopeCurrent(actionScope)) {
            toast.error('Your sign-in changed. Please reopen setup and try again.');
            return;
        }

        if (selectedRole === 'skipper') {
            const errors = validateVesselDetails({
                name,
                mmsi,
                length,
                beam,
                draft,
                displacement,
                airDraft,
                fuel,
                water,
                crewCount,
            });
            const hasUnreviewedEstimate =
                Object.values(autoFilledDimensions).includes('estimate') && !estimatedDimensionsAcknowledged;
            if (Object.keys(errors).length > 0 || hasUnreviewedEstimate) {
                setStep(5);
                toast.error(
                    hasUnreviewedEstimate
                        ? 'Please review the estimated vessel dimensions before continuing.'
                        : 'Please correct the highlighted vessel details before continuing.',
                );
                return;
            }
        }

        const finalVesselType = vesselType;
        // VesselProfile dimensions are stored in FEET — this is THE
        // conversion point that establishes the convention every consumer
        // (vesselDraftMetres in services/units.ts) relies on.
        let l_ft = length ? (lengthUnit === 'm' ? Number(length) * FEET_PER_METRE : Number(length)) : 0;
        let b_ft = beam ? (beamUnit === 'm' ? Number(beam) * FEET_PER_METRE : Number(beam)) : 0;
        let d_ft = draft ? (draftUnit === 'm' ? Number(draft) * FEET_PER_METRE : Number(draft)) : 0;

        let disp_lbs = displacement ? Number(displacement) : 0;
        if (dispUnit === 'kg') disp_lbs = disp_lbs * 2.20462;
        if (dispUnit === 'tonnes') disp_lbs = disp_lbs * 2204.62;

        const estimatedFields = new Set<string>(roughEstimatedDimensionFields(autoFilledDimensions));

        // Crew/deckhand setup deliberately carries no stale vessel geometry,
        // even if the user went back after partially filling the skipper step.
        if (finalVesselType === 'observer') {
            l_ft = 0;
            b_ft = 0;
            d_ft = 0;
            disp_lbs = 0;
            estimatedFields.clear();
        }

        // Fill non-safety-critical gaps, while retaining provenance so the
        // Settings screen can ask the skipper to replace estimates later.
        if (finalVesselType !== 'observer') {
            if (l_ft === 0) {
                // Infer length from Beam or Displacement if available?
                if (b_ft > 0) {
                    l_ft = b_ft * 3;
                    estimatedFields.add('length');
                } else {
                    l_ft = 30;
                    estimatedFields.add('length');
                } // Last ditch default
            }

            if (b_ft === 0) {
                b_ft = l_ft * 0.32; // Approx ratio
                estimatedFields.add('beam');
            }

            // DRAFT IS NEVER FABRICATED. Every other dimension can be guessed
            // from LOA harmlessly, but draft decides whether the chart shades
            // water as safe. Back-filling `l_ft * 0.16` wrote a plausible
            // positive number, which defeated the app's own honesty channel:
            // `draftAssumed` tested `draft > 0`, so a guess reported as
            // verified and the ENC safety contour drew against it.
            //
            // Left at 0, vesselDraftMetres() returns its documented 2.5 m
            // fallback — DEEPER than the guess for anything under ~51 ft, so
            // the honest path is also the conservative one — and
            // vesselDraftIsAssumed() correctly reports the keel as unknown.

            if (disp_lbs === 0) {
                // DLR Formula approximation
                disp_lbs = Math.pow(l_ft, 3) / 2.5;
                estimatedFields.add('displacement');
            }
        }

        const ad_ft = airDraft
            ? airDraftUnit === 'm'
                ? Number(airDraft) * FEET_PER_METRE
                : Number(airDraft)
            : undefined;

        const vesselData: VesselProfile = {
            name:
                (finalVesselType === 'observer' ? 'Crew Member' : sanitizeText(name)) ||
                (finalVesselType === 'sail' ? 'S/Y Ocean' : 'M/Y Ocean'),
            type: finalVesselType,
            riggingType: finalVesselType === 'sail' ? riggingType : undefined,
            length: l_ft,
            beam: b_ft,
            draft: d_ft,
            displacement: disp_lbs,
            airDraft: ad_ft,
            hullType,
            keelType,
            maxWaveHeight: vesselMaxWaveHeightFt({ length: l_ft, hullType }),
            cruisingSpeed: vesselCruisingSpeedKts({ length: l_ft, type: finalVesselType }),
            fuelCapacity: finalVesselType === 'observer' ? 0 : fuel ? Number(fuel) : 0,
            waterCapacity: finalVesselType === 'observer' ? 0 : water ? Number(water) : 0,
            crewCount: crewCount ? Number(crewCount) || 2 : 2,
            estimatedFields: estimatedFields.size > 0 ? [...estimatedFields] : undefined,
        };

        const settings: Partial<UserSettings> = {
            prefix: sanitizeText(prefix) || undefined,
            firstName: sanitizeText(firstName) || undefined,
            lastName: sanitizeText(lastName) || undefined,
            nickname: sanitizeText(nickname) || undefined,
            defaultLocation: sanitizeText(homePort),
            // Save the actual coords too, not just the name string.
            // Without this, the weather fetcher re-geocodes "Newport"
            // from scratch on every cold start and picks whichever
            // Newport the geocoder returns first — often NOT the one
            // the user actually selected during onboarding.
            defaultLocationCoords: tempLocation ? { lat: tempLocation.lat, lon: tempLocation.lon } : undefined,
            vessel: vesselData,
            units: {
                speed: prefSpeed,
                temp: prefTemp,
                distance: prefDist,
                length: prefLength,
                tideHeight: prefLength,
                waveHeight: prefWaveHeight,
                visibility: 'nm',
                volume: prefVolume,
            },
            vesselUnits: {
                length: lengthUnit,
                beam: beamUnit,
                draft: draftUnit,
                displacement: dispUnit,
                volume: volUnit,
            },
            preferredModel: preferredModel,
            offshoreModel: offshoreModel,
            savedLocations: [sanitizeText(homePort)],
            alwaysOn: prefAlwaysOn,
            screenOrientation: prefOrientation,
            displayMode: prefDisplayMode,
            // Include polar data if a yacht was selected
            ...(finalVesselType !== 'observer' && selectedPolar
                ? {
                      polarData: selectedPolar.data,
                      polarBoatModel: selectedPolar.model,
                      polarSource_type: 'database' as const,
                  }
                : {}),
        };

        localStorage.setItem(authScopedStorageKey('thalassa_v3_onboarded', actionScope), 'true');
        localStorage.setItem(authScopedStorageKey('thalassa_tutorial_completed', actionScope), 'true'); // Tips now shown during onboarding
        localStorage.setItem(
            authScopedStorageKey('thalassa_crew_count', actionScope),
            String(crewCount ? parseInt(crewCount) || 2 : 2),
        );

        // Trigger the intro overlay + glass gesture tutorial. Default
        // hidden on mount (see OnboardingOverlay and GlassTutorial)
        // to stop them from flashing for returning users whose
        // boats-row check sets their suppression flags slightly
        // later than the overlays mount. This event is the ONLY
        // moment we show them — exclusively for brand-new accounts
        // that just finished the wizard.
        if (typeof window !== 'undefined' && isAuthIdentityScopeCurrent(actionScope)) {
            window.dispatchEvent(new CustomEvent('thalassa:show-intro-overlay'));
            window.dispatchEvent(new CustomEvent('thalassa:show-glass-tutorial'));
        }

        // Mirror the four name parts into auth.users.raw_user_meta_data so the
        // voyage-log SQL helper (user_name_parts) can compose the byline
        // server-side. Fire-and-forget — local Capacitor Preferences is still
        // the canonical settings store, this is just for the boat-member sync.
        if (supabase && isAuthIdentityScopeCurrent(actionScope)) {
            void supabase.auth
                .updateUser({
                    data: {
                        prefix: sanitizeText(prefix) || null,
                        first_name: sanitizeText(firstName) || null,
                        last_name: sanitizeText(lastName) || null,
                        nickname: sanitizeText(nickname) || null,
                    },
                })
                .catch((err) => log.warn('auth.updateUser failed (non-fatal):', err));
        }

        if (!isAuthIdentityScopeCurrent(actionScope)) return;
        onComplete({
            ...settings,
            // Onboarding is a preferences flow, not a purchase or receipt
            // validator. Paid entitlement must arrive from a trusted service.
            subscriptionTier: 'free',
            isPro: false,
            vessel: {
                ...settings.vessel!,
                registration: sanitizeText(registration) || undefined,
                mmsi: mmsi || undefined,
            },
        });
    };

    return (
        <OverlayPortal
            ref={scrollRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="onboarding-wizard-title"
            // `overflow-x-hidden` prevents the entrance animations
            // (slide-in-from-right-8) or any mis-sized child from
            // letting the user swipe horizontally. `touch-action: pan-y`
            // on the inline style further locks the wizard to
            // vertical-only gestures on iOS WebKit.
            className="bg-slate-950 bg-[radial-gradient(ellipse_at_top,var(--tw-gradient-stops))] from-slate-900 via-[#0f172a] to-black flex items-start md:items-center justify-center px-4 overflow-x-hidden overflow-y-auto wizard-scroll"
            style={{
                paddingTop: 'max(1rem, calc(env(safe-area-inset-top) + 3.5rem))',
                paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
                touchAction: 'pan-y',
            }}
        >
            {/* Ambient Background Glow */}
            <div className="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] bg-sky-500/10 rounded-full blur-[120px] pointer-events-none"></div>
            <div className="absolute bottom-[-10%] right-[-5%] w-[500px] h-[500px] bg-purple-500/10 rounded-full blur-[100px] pointer-events-none"></div>

            <div ref={focusTrapRef} className="w-full max-w-lg relative">
                <h2 id="onboarding-wizard-title" className="sr-only">
                    Set up Thalassa
                </h2>
                {/* BACK BUTTON — fixed to the viewport with safe-area padding
                    so it sits below the Dynamic Island / notch on iPhone rather
                    than (a) going off-screen on tall devices or (b) hiding under
                    the status bar. */}
                {step > 1 && (
                    <button
                        aria-label="Go back"
                        onClick={handleBack}
                        style={{ top: 'max(1rem, calc(env(safe-area-inset-top) + 0.5rem))' }}
                        className="fixed left-4 min-h-[44px] px-3 py-2 text-gray-400 hover:text-white transition-colors flex items-center gap-2 group z-20"
                    >
                        <ArrowRightIcon className="w-5 h-5 rotate-180 group-hover:-translate-x-1 transition-transform" />
                        <span className="text-sm font-medium">Back</span>
                    </button>
                )}

                <div
                    ref={stepContentRef}
                    role="group"
                    aria-label={`Setup step ${stepPosition} of ${visibleSteps.length}`}
                    tabIndex={-1}
                    className="outline-hidden"
                >
                    {/* STEP 1: WELCOME */}
                    {step === 1 && <WelcomeStep onNext={handleNext} />}

                    {/* STEP 2: HOME PORT */}
                    {step === 2 && (
                        <HomePortStep
                            homePort={homePort}
                            onHomePortChange={setHomePort}
                            isLocating={isLocating}
                            showMap={showMap}
                            onShowMap={setShowMap}
                            tempLocation={tempLocation}
                            onLocate={handleLocate}
                            onMapSelect={handleMapSelect}
                            onConfirmMapSelection={confirmMapSelection}
                            prefix={prefix}
                            onPrefixChange={setPrefix}
                            firstName={firstName}
                            onFirstNameChange={setFirstName}
                            lastName={lastName}
                            onLastNameChange={setLastName}
                            nickname={nickname}
                            onNicknameChange={setNickname}
                            onNext={handleNext}
                        />
                    )}

                    {/* STEP 3: SETUP ROLE (not a paid entitlement) */}
                    {step === 3 && (
                        <RoleSelectionStep
                            selectedRole={selectedRole}
                            onRoleChange={setSelectedRole}
                            onVesselTypeChange={setVesselType}
                            onNext={handleNext}
                        />
                    )}

                    {/* STEP 4: UNIT PREFERENCES — moved ahead of Vessel Details so
                    those fields inherit the user's chosen length/volume units */}
                    {step === 4 && (
                        <UnitPreferencesStep
                            prefSpeed={prefSpeed}
                            onSpeedChange={setPrefSpeed}
                            prefWaveHeight={prefWaveHeight}
                            onWaveHeightChange={setPrefWaveHeight}
                            prefLength={prefLength}
                            onLengthChange={setPrefLength}
                            prefTemp={prefTemp}
                            onTempChange={setPrefTemp}
                            prefDist={prefDist}
                            onDistChange={setPrefDist}
                            prefVolume={prefVolume}
                            onVolumeChange={setPrefVolume}
                            onNext={handleNext}
                        />
                    )}

                    {/* STEP 5: VESSEL DETAILS (Skipper only) */}
                    {step === 5 && (
                        <VesselDetailsStep
                            vesselType={vesselType}
                            onVesselTypeChange={setVesselType}
                            name={name}
                            onNameChange={setName}
                            registration={registration}
                            onRegistrationChange={setRegistration}
                            mmsi={mmsi}
                            onMmsiChange={setMmsi}
                            hullType={hullType}
                            onHullTypeChange={setHullType}
                            keelType={keelType}
                            onKeelTypeChange={setKeelType}
                            riggingType={riggingType}
                            onRiggingTypeChange={setRiggingType}
                            length={length}
                            onLengthChange={(value) => handleDimensionChange('length', value, setLength)}
                            lengthUnit={lengthUnit}
                            onToggleLengthUnit={toggleLengthUnit}
                            beam={beam}
                            onBeamChange={(value) => handleDimensionChange('beam', value, setBeam)}
                            beamUnit={beamUnit}
                            onToggleBeamUnit={toggleBeamUnit}
                            draft={draft}
                            onDraftChange={(value) => handleDimensionChange('draft', value, setDraft)}
                            draftUnit={draftUnit}
                            onToggleDraftUnit={toggleDraftUnit}
                            displacement={displacement}
                            onDisplacementChange={setDisplacement}
                            dispUnit={dispUnit}
                            onToggleDispUnit={toggleDispUnit}
                            airDraft={airDraft}
                            onAirDraftChange={setAirDraft}
                            airDraftUnit={airDraftUnit}
                            onToggleAirDraftUnit={toggleAirDraftUnit}
                            fuel={fuel}
                            onFuelChange={setFuel}
                            water={water}
                            onWaterChange={setWater}
                            volUnit={volUnit}
                            onToggleVolUnit={() => setVolUnit((u) => (u === 'gal' ? 'l' : 'gal'))}
                            crewCount={crewCount}
                            onCrewCountChange={setCrewCount}
                            selectedPolarModel={selectedPolar?.model}
                            onYachtSelect={handleYachtSelect}
                            autoFilledDimensions={autoFilledDimensions}
                            estimatedDimensionsAcknowledged={estimatedDimensionsAcknowledged}
                            onEstimatedDimensionsAcknowledgedChange={setEstimatedDimensionsAcknowledged}
                            keyboardHeight={keyboardHeight}
                            onNext={handleNext}
                        />
                    )}

                    {/* STEP 6: OFFSHORE MODEL (Skipper only) */}
                    {step === 6 && (
                        <OffshoreModelStep selected={offshoreModel} onChange={setOffshoreModel} onNext={handleNext} />
                    )}

                    {/* STEP 7: DISPLAY PREFERENCES */}
                    {step === 7 && (
                        <DisplayPrefsStep
                            prefAlwaysOn={prefAlwaysOn}
                            onAlwaysOnChange={setPrefAlwaysOn}
                            prefOrientation={prefOrientation}
                            onOrientationChange={setPrefOrientation}
                            prefDisplayMode={prefDisplayMode}
                            onDisplayModeChange={setPrefDisplayMode}
                            onFinish={handleFinish}
                        />
                    )}
                </div>

                {/* Progress Dots */}
                <div className="flex justify-center gap-2 mt-8">
                    {visibleSteps.map((i) => (
                        <div
                            key={i}
                            className={`w-2 h-2 rounded-full transition-all ${step >= i ? 'bg-sky-500 w-4' : 'bg-gray-700'}`}
                        ></div>
                    ))}
                </div>
            </div>
        </OverlayPortal>
    );
});
