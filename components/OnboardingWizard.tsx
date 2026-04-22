import React, { useState, useEffect } from 'react';
import { createLogger } from '../utils/createLogger';

const log = createLogger('OnboardingWizard');
import { sanitizeText } from '../utils/inputValidation';
import { toast } from './Toast';
import { VesselDetailsStep } from './onboarding/VesselDetailsStep';
import { UnitPreferencesStep } from './onboarding/UnitPreferencesStep';
import { WelcomeStep } from './onboarding/WelcomeStep';
import { HomePortStep } from './onboarding/HomePortStep';
import { RoleSelectionStep } from './onboarding/RoleSelectionStep';
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
} from '../types';
import type { SubscriptionTier } from '../types/settings';
import { ArrowRightIcon } from './Icons';
import { reverseGeocode, parseLocation } from '../services/weatherService';
import { fetchWeatherByStrategy } from '../services/weather';
import { getSystemUnits } from '../utils';
import { GpsService } from '../services/GpsService';
import { Capacitor } from '@capacitor/core';
import { YachtDatabaseSearch as _YachtDatabaseSearch } from './settings/YachtDatabaseSearch';
import type { PolarDatabaseEntry } from '../data/polarDatabase';

interface OnboardingWizardProps {
    onComplete: (settings: Partial<UserSettings>) => void;
}

export const OnboardingWizard: React.FC<OnboardingWizardProps> = React.memo(({ onComplete }) => {
    const [step, setStep] = useState(1);
    const [keyboardHeight, setKeyboardHeight] = useState(0);

    // Keyboard tracking — same pattern as DiaryPage
    useEffect(() => {
        let cleanup: (() => void) | undefined;

        if (Capacitor.isNativePlatform()) {
            import('@capacitor/keyboard')
                .then(({ Keyboard }) => {
                    const showHandle = Keyboard.addListener('keyboardDidShow', (info) => {
                        setKeyboardHeight(info.keyboardHeight > 0 ? info.keyboardHeight : 0);
                        setTimeout(() => {
                            const focused = document.activeElement as HTMLElement;
                            if (focused && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA')) {
                                focused.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            }
                        }, 250);
                    });
                    const hideHandle = Keyboard.addListener('keyboardWillHide', () => {
                        setKeyboardHeight(0);
                    });
                    cleanup = () => {
                        showHandle.then((h) => h.remove());
                        hideHandle.then((h) => h.remove());
                    };
                })
                .catch(() => {
                    /* Keyboard plugin not available */
                });
        }

        return () => {
            cleanup?.();
            setKeyboardHeight(0);
        };
    }, []);

    // Step 2: Location Data
    const [homePort, setHomePort] = useState('');
    const [isLocating, setIsLocating] = useState(false);
    const [showMap, setShowMap] = useState(false);
    const [tempLocation, setTempLocation] = useState<{ lat: number; lon: number; name: string } | null>(null);

    // User Name (collected in step 3 alongside home port)
    const [firstName, setFirstName] = useState('');
    const [lastName, setLastName] = useState('');

    // Core Vessel Data
    const [vesselType, setVesselType] = useState<'sail' | 'power' | 'observer'>('sail');
    const [subscriptionTier, setSubscriptionTier] = useState<SubscriptionTier>('owner');
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
    const [preferredModel, _setPreferredModel] = useState<WeatherModel>('best_match');
    const [offshoreModel, setOffshoreModel] = useState<OffshoreModel>('sg');

    // Display preferences
    const [prefAlwaysOn, setPrefAlwaysOn] = useState(false);
    const [prefOrientation, setPrefOrientation] = useState<'auto' | 'portrait' | 'landscape'>('portrait');

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
    const [volUnit, setVolUnit] = useState<VolumeUnit>(defaults.volume || 'gal');
    const [crewCount, setCrewCount] = useState<string>('2');

    // Yacht database selection (polar data stored for handleFinish)
    const [selectedPolar, setSelectedPolar] = useState<{ data: PolarData; model: string } | null>(null);

    const handleYachtSelect = (entry: PolarDatabaseEntry) => {
        setSelectedPolar({ data: entry.polar, model: entry.model });
        // Don't auto-fill the model name into vessel name — user should name their own boat
        // if (!name) setName(entry.model);
        if (!length) setLength(String(entry.loa));
        if (!beam) setBeam(String(Math.round(entry.loa * 0.32)));
        if (!draft) setDraft(String(Math.round(entry.loa * 0.16)));
    };

    const handleNext = () => {
        if (step === 2 && !homePort.trim()) return; // Require location

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

        // Conditional step routing: non-Skippers skip vessel details (4) + offshore model (5)
        if (step === 3 && subscriptionTier !== 'owner') {
            setStep(6); // Jump to unit preferences
            return;
        }

        setStep((s) => s + 1);
    };

    const handleBack = () => {
        // If going back from step 6 and non-Skipper, jump to step 3 (skip vessel + offshore model)
        if (step === 6 && subscriptionTier !== 'owner') {
            setStep(3);
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
        fetchWeatherByStrategy(lat, lon, name).catch(() => {
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
                // Use GpsService — same unified GPS service the map page uses.
                // Handles native (Transistorsoft BgGeo) and web (navigator.geolocation) automatically.
                const pos = await GpsService.getCurrentPosition({
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
        if (tempLocation) {
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
        let finalVesselType = vesselType;
        let l_ft = length ? (lengthUnit === 'm' ? parseFloat(length) * 3.28084 : parseFloat(length)) : 0;
        let b_ft = beam ? (beamUnit === 'm' ? parseFloat(beam) * 3.28084 : parseFloat(beam)) : 0;
        let d_ft = draft ? (draftUnit === 'm' ? parseFloat(draft) * 3.28084 : parseFloat(draft)) : 0;

        let disp_lbs = displacement ? parseFloat(displacement) : 0;
        if (dispUnit === 'kg') disp_lbs = disp_lbs * 2.20462;
        if (dispUnit === 'tonnes') disp_lbs = disp_lbs * 2204.62;

        const estimatedFields: string[] = [];

        // AUTO-CONVERT LOGIC
        // If NO metrics entered, convert to Observer
        if (finalVesselType !== 'observer' && l_ft === 0 && b_ft === 0 && d_ft === 0 && disp_lbs === 0) {
            finalVesselType = 'observer';
        }

        // HALLUCINATION LOGIC (Filling in blanks)
        if (finalVesselType !== 'observer') {
            if (l_ft === 0) {
                // Infer length from Beam or Displacement if available?
                if (b_ft > 0) {
                    l_ft = b_ft * 3;
                    estimatedFields.push('length');
                } else {
                    l_ft = 30;
                    estimatedFields.push('length');
                } // Last ditch default
            }

            if (b_ft === 0) {
                b_ft = l_ft * 0.32; // Approx ratio
                estimatedFields.push('beam');
            }

            if (d_ft === 0) {
                d_ft = l_ft * 0.16; // Approx ratio
                estimatedFields.push('draft');
            }

            if (disp_lbs === 0) {
                // DLR Formula approximation
                disp_lbs = Math.pow(l_ft, 3) / 2.5;
                estimatedFields.push('displacement');
            }
        }

        const ad_ft = airDraft
            ? airDraftUnit === 'm'
                ? parseFloat(airDraft) * 3.28084
                : parseFloat(airDraft)
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
            maxWaveHeight: hullType === 'catamaran' ? l_ft * 0.45 : hullType === 'trimaran' ? l_ft * 0.5 : l_ft * 0.35,
            cruisingSpeed: finalVesselType === 'sail' ? Math.sqrt(l_ft) * 1.2 : Math.sqrt(l_ft) * 3,
            fuelCapacity: fuel ? parseFloat(fuel) : 0,
            waterCapacity: water ? parseFloat(water) : 0,
            crewCount: crewCount ? parseInt(crewCount) || 2 : 2,
            estimatedFields: estimatedFields.length > 0 ? estimatedFields : undefined,
        };

        const settings: Partial<UserSettings> = {
            firstName: sanitizeText(firstName) || undefined,
            lastName: sanitizeText(lastName) || undefined,
            defaultLocation: homePort,
            vessel: vesselData,
            units: {
                speed: prefSpeed,
                temp: prefTemp,
                distance: prefDist,
                length: prefLength,
                tideHeight: prefLength,
                waveHeight: prefWaveHeight,
                visibility: 'nm',
                volume: 'gal',
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
            savedLocations: [homePort],
            alwaysOn: prefAlwaysOn,
            screenOrientation: prefOrientation,
            // Include polar data if a yacht was selected
            ...(selectedPolar
                ? {
                      polarData: selectedPolar.data,
                      polarBoatModel: selectedPolar.model,
                      polarSource_type: 'database' as const,
                  }
                : {}),
        };

        localStorage.setItem('thalassa_v3_onboarded', 'true');
        localStorage.setItem('thalassa_tutorial_completed', 'true'); // Tips now shown during onboarding
        localStorage.setItem('thalassa_crew_count', String(crewCount ? parseInt(crewCount) || 2 : 2));
        onComplete({
            ...settings,
            subscriptionTier,
            vessel: {
                ...settings.vessel!,
                registration: registration || undefined,
                mmsi: mmsi || undefined,
            },
        });
    };

    return (
        <div className="fixed inset-0 z-[100] bg-slate-950 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-slate-900 via-[#0f172a] to-black flex items-center justify-center p-4 overflow-hidden">
            {/* Ambient Background Glow */}
            <div className="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] bg-sky-500/10 rounded-full blur-[120px] pointer-events-none"></div>
            <div className="absolute bottom-[-10%] right-[-5%] w-[500px] h-[500px] bg-purple-500/10 rounded-full blur-[100px] pointer-events-none"></div>

            <div className="w-full max-w-lg relative">
                {/* BACK BUTTON — fixed to the viewport with safe-area padding
                    so it sits below the Dynamic Island / notch on iPhone rather
                    than (a) going off-screen on tall devices or (b) hiding under
                    the status bar. */}
                {step > 1 && (
                    <button
                        aria-label="Go back"
                        onClick={handleBack}
                        style={{ top: 'max(1rem, calc(env(safe-area-inset-top) + 0.5rem))' }}
                        className="fixed left-4 p-2 text-gray-400 hover:text-white transition-colors flex items-center gap-2 group z-20"
                    >
                        <ArrowRightIcon className="w-5 h-5 rotate-180 group-hover:-translate-x-1 transition-transform" />
                        <span className="text-sm font-medium">Back</span>
                    </button>
                )}

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
                        firstName={firstName}
                        onFirstNameChange={setFirstName}
                        lastName={lastName}
                        onLastNameChange={setLastName}
                        onNext={handleNext}
                    />
                )}

                {/* STEP 3: ROLE & TIER SELECTION */}
                {step === 3 && (
                    <RoleSelectionStep
                        selectedTier={subscriptionTier}
                        onTierChange={setSubscriptionTier}
                        onVesselTypeChange={setVesselType}
                        onNext={handleNext}
                    />
                )}

                {/* STEP 4: VESSEL DETAILS (Skipper only) */}
                {step === 4 && (
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
                        onLengthChange={setLength}
                        lengthUnit={lengthUnit}
                        onToggleLengthUnit={toggleLengthUnit}
                        beam={beam}
                        onBeamChange={setBeam}
                        beamUnit={beamUnit}
                        onToggleBeamUnit={toggleBeamUnit}
                        draft={draft}
                        onDraftChange={setDraft}
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
                        keyboardHeight={keyboardHeight}
                        onNext={handleNext}
                    />
                )}

                {/* STEP 5: OFFSHORE MODEL (Skipper only) */}
                {step === 5 && (
                    <OffshoreModelStep selected={offshoreModel} onChange={setOffshoreModel} onNext={handleNext} />
                )}

                {/* STEP 6: UNIT PREFERENCES */}
                {step === 6 && (
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
                        onNext={handleNext}
                    />
                )}

                {/* STEP 7: DISPLAY PREFERENCES */}
                {step === 7 && (
                    <DisplayPrefsStep
                        prefAlwaysOn={prefAlwaysOn}
                        onAlwaysOnChange={setPrefAlwaysOn}
                        prefOrientation={prefOrientation}
                        onOrientationChange={setPrefOrientation}
                        onFinish={handleFinish}
                    />
                )}

                {/* Progress Dots */}
                <div className="flex justify-center gap-2 mt-8">
                    {[1, 2, 3, 4, 5, 6, 7].map((i) => (
                        <div
                            key={i}
                            className={`w-2 h-2 rounded-full transition-all ${step >= i ? 'bg-sky-500 w-4' : 'bg-gray-700'}`}
                        ></div>
                    ))}
                </div>
            </div>
        </div>
    );
});
