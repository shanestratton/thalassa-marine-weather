
import React, { useState, useEffect } from 'react';
import { UserSettings, VesselProfile, LengthUnit, WeightUnit, SpeedUnit, TempUnit, DistanceUnit, VolumeUnit } from '../types';
import { BoatIcon, SailBoatIcon, PowerBoatIcon, ArrowRightIcon, CheckIcon, CompassIcon, EyeIcon, GearIcon, SearchIcon, MapPinIcon, DropletIcon, MapIcon, XIcon } from './Icons';
import { reverseGeocode } from '../services/weatherService';
import { WeatherMap } from './WeatherMap';
import { getSystemUnits } from '../utils';

interface OnboardingWizardProps {
    onComplete: (settings: Partial<UserSettings>) => void;
}

export const OnboardingWizard: React.FC<OnboardingWizardProps> = ({ onComplete }) => {
    const [step, setStep] = useState(1);
    
    // Step 2: Location Data
    const [homePort, setHomePort] = useState('');
    const [isLocating, setIsLocating] = useState(false);
    const [showMap, setShowMap] = useState(false);
    const [tempLocation, setTempLocation] = useState<{lat: number, lon: number, name: string} | null>(null);

    // Core Vessel Data
    const [vesselType, setVesselType] = useState<'sail' | 'power' | 'observer'>('sail');
    const [name, setName] = useState('');
    const [riggingType, setRiggingType] = useState<'Sloop' | 'Cutter' | 'Ketch' | 'Yawl' | 'Schooner' | 'Catboat' | 'Solent' | 'Other'>('Sloop');
    
    // Initialize Defaults from System
    const defaults = getSystemUnits();

    // Preference Data
    const [prefSpeed, setPrefSpeed] = useState<SpeedUnit>(defaults.speed);
    const [prefTemp, setPrefTemp] = useState<TempUnit>(defaults.temp);
    const [prefDist, setPrefDist] = useState<DistanceUnit>(defaults.distance);
    const [prefLength, setPrefLength] = useState<LengthUnit>(defaults.length);

    // Dimension Data - Initialize as Strings to detect empty vs 0
    const [length, setLength] = useState<string>('');
    const [beam, setBeam] = useState<string>('');
    const [draft, setDraft] = useState<string>('');
    const [displacement, setDisplacement] = useState<string>('');
    
    // Units
    const [lengthUnit, setLengthUnit] = useState<LengthUnit>(defaults.length); 
    const [beamUnit, setBeamUnit] = useState<LengthUnit>(defaults.length); 
    const [draftUnit, setDraftUnit] = useState<LengthUnit>(defaults.length); 
    
    // Weight Units - Default to lbs for US (ft), kg for Metric (m)
    const [dispUnit, setDispUnit] = useState<WeightUnit>(defaults.length === 'ft' ? 'lbs' : 'kg');
    
    // Tankage Data - Initialize as strings to avoid persistent '0'
    const [fuel, setFuel] = useState<string>('');
    const [water, setWater] = useState<string>('');
    const [volUnit, setVolUnit] = useState<VolumeUnit>(defaults.volume || 'gal');

    const handleNext = () => {
        if (step === 2 && !homePort.trim()) return; // Require location
        setStep(s => s + 1);
    }

    const handleBack = () => {
        setStep(s => Math.max(1, s - 1));
    }

    const handleLocate = () => {
        setIsLocating(true);
        if ('geolocation' in navigator) {
            navigator.geolocation.getCurrentPosition(async (position) => {
                const { latitude, longitude } = position.coords;
                // Save coordinates for map centering
                setTempLocation({ lat: latitude, lon: longitude, name: "Current Location" });
                try {
                    const niceName = await reverseGeocode(latitude, longitude);
                    const finalName = niceName || `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
                    setHomePort(finalName);
                    // Update temp location name once resolved
                    setTempLocation({ lat: latitude, lon: longitude, name: finalName });
                } catch (e) {
                    setHomePort(`${latitude.toFixed(4)}, ${longitude.toFixed(4)}`);
                }
                setIsLocating(false);
            }, (err) => {
                console.error(err);
                setIsLocating(false);
                alert("Could not access location. Please enter manually.");
            });
        } else {
            setIsLocating(false);
        }
    };

    // UPDATE: Instant feedback + async resolution
    const handleMapSelect = async (lat: number, lon: number, name?: string) => {
        const initialName = name || "Identifying..."; 
        setTempLocation({ lat, lon, name: initialName });

        if (!name) {
             try {
                 const geoName = await reverseGeocode(lat, lon);
                 if (geoName) {
                     setTempLocation(prev => {
                         if (prev && prev.lat === lat && prev.lon === lon) {
                             return { lat, lon, name: geoName };
                         }
                         return prev;
                     });
                 } else {
                     setTempLocation(prev => {
                         if (prev && prev.lat === lat && prev.lon === lon) {
                             return { lat, lon, name: `${lat.toFixed(4)}, ${lon.toFixed(4)}` };
                         }
                         return prev;
                     });
                 }
             } catch {
                 setTempLocation(prev => {
                     if (prev && prev.lat === lat && prev.lon === lon) {
                         return { lat, lon, name: `${lat.toFixed(4)}, ${lon.toFixed(4)}` };
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
        }
    };

    const convertValue = (val: number, toUnit: LengthUnit) => {
        if (toUnit === 'm') return Math.round(val * 0.3048 * 10) / 10;
        return Math.round(val * 3.28084);
    }

    // Toggle Handlers
    const toggleLengthUnit = () => { 
        const newUnit = lengthUnit === 'ft' ? 'm' : 'ft'; 
        if(length) setLength(convertValue(parseFloat(length), newUnit).toString()); 
        setLengthUnit(newUnit); 
    }
    const toggleBeamUnit = () => { 
        const newUnit = beamUnit === 'ft' ? 'm' : 'ft'; 
        if(beam) setBeam(convertValue(parseFloat(beam), newUnit).toString()); 
        setBeamUnit(newUnit); 
    }
    const toggleDraftUnit = () => { 
        const newUnit = draftUnit === 'ft' ? 'm' : 'ft'; 
        if(draft) setDraft(convertValue(parseFloat(draft), newUnit).toString()); 
        setDraftUnit(newUnit); 
    }
    
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
                if (b_ft > 0) { l_ft = b_ft * 3; estimatedFields.push('length'); }
                else { l_ft = 30; estimatedFields.push('length'); } // Last ditch default
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

        const vesselData: VesselProfile = {
            name: (finalVesselType === 'observer' ? 'Observer' : name) || (finalVesselType === 'sail' ? 'S/Y Ocean' : 'M/Y Ocean'),
            type: finalVesselType,
            riggingType: finalVesselType === 'sail' ? riggingType : undefined,
            length: l_ft,
            beam: b_ft,
            draft: d_ft,
            displacement: disp_lbs,
            maxWaveHeight: l_ft * 0.35, 
            cruisingSpeed: finalVesselType === 'sail' ? Math.sqrt(l_ft) * 1.2 : Math.sqrt(l_ft) * 3,
            fuelCapacity: fuel ? parseFloat(fuel) : 0,
            waterCapacity: water ? parseFloat(water) : 0,
            estimatedFields: estimatedFields.length > 0 ? estimatedFields : undefined
        };

        const settings: Partial<UserSettings> = {
            defaultLocation: homePort,
            vessel: vesselData,
            units: { speed: prefSpeed, temp: prefTemp, distance: prefDist, length: prefLength, tideHeight: prefLength, visibility: 'nm', volume: 'gal' },
            vesselUnits: { length: lengthUnit, beam: beamUnit, draft: draftUnit, displacement: dispUnit, volume: volUnit },
            savedLocations: [homePort]
        };

        localStorage.setItem('thalassa_has_onboarded', 'true');
        onComplete(settings);
    };

    return (
        <div className="fixed inset-0 z-[100] bg-[#0f172a] flex items-center justify-center p-4">
            {/* Map Modal for Selection */}
            {showMap && (
                <div className="fixed inset-0 z-[150] bg-slate-900 animate-in fade-in zoom-in-95 flex flex-col">
                    <div className="flex-1 relative">
                        <WeatherMap 
                            locationName={tempLocation?.name || "Select Home Port"} 
                            lat={tempLocation?.lat}
                            lon={tempLocation?.lon}
                            onLocationSelect={handleMapSelect} 
                            enableZoom={true} 
                            minimal={false} // Enables interaction
                            initialLayer="buoys" // Default to Buoys for easy selection
                            hideLayerControls={true} // HIDE TAB CONTROLS
                            mapboxToken={process.env.MAPBOX_ACCESS_TOKEN}
                            restrictBounds={false} // Unlocked for global selection
                        />
                        
                        {/* Overlay Controls */}
                        <div className="absolute top-4 right-4 z-[160]">
                            <button 
                                onClick={() => setShowMap(false)}
                                className="p-3 bg-slate-900/90 text-white rounded-full shadow-xl border border-white/20 hover:bg-slate-800 transition-colors"
                            >
                                <XIcon className="w-6 h-6" />
                            </button>
                        </div>

                        {/* Confirmation Overlay */}
                        <div className="absolute bottom-12 left-1/2 -translate-x-1/2 z-[160] w-full max-w-sm px-4">
                            {tempLocation ? (
                                <button 
                                    onClick={confirmMapSelection}
                                    className="w-full bg-sky-500 hover:bg-sky-400 text-white font-bold py-3 px-6 rounded-xl shadow-2xl flex items-center justify-center gap-2 animate-in slide-in-from-bottom-4 transition-all hover:scale-105"
                                >
                                    <MapPinIcon className="w-5 h-5" />
                                    {tempLocation.name === 'Identifying...' ? 'Resolving Location...' : `Confirm: ${tempLocation.name}`}
                                </button>
                            ) : (
                                <div className="bg-slate-900/90 text-white text-xs px-4 py-2 rounded-full border border-white/10 pointer-events-none shadow-lg text-center">
                                    Tap any location or buoy to select
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            <div className="w-full max-w-lg relative">
                
                {/* BACK BUTTON */}
                {step > 1 && (
                    <button 
                        onClick={handleBack}
                        className="absolute -top-12 left-0 p-2 text-gray-400 hover:text-white transition-colors flex items-center gap-2 group z-20"
                    >
                        <ArrowRightIcon className="w-5 h-5 rotate-180 group-hover:-translate-x-1 transition-transform" />
                        <span className="text-sm font-medium">Back</span>
                    </button>
                )}

                {/* STEP 1: WELCOME */}
                {step === 1 && (
                    <div className="text-center animate-in fade-in slide-in-from-bottom-8 duration-700">
                        <div className="w-20 h-20 bg-sky-500 rounded-full mx-auto mb-8 flex items-center justify-center shadow-[0_0_40px_rgba(14,165,233,0.4)]">
                            <BoatIcon className="w-10 h-10 text-white" />
                        </div>
                        <h1 className="text-4xl font-bold text-white mb-4 tracking-tight">Welcome to Thalassa</h1>
                        <p className="text-lg text-slate-400 mb-10 max-w-sm mx-auto leading-relaxed">
                            Advanced marine forecasting. Let's personalise your experience.
                        </p>
                        <button onClick={handleNext} className="bg-white text-slate-900 font-bold py-4 px-10 rounded-xl hover:bg-sky-50 transition-all transform hover:scale-105 shadow-xl flex items-center gap-2 mx-auto">
                            Get Started <ArrowRightIcon className="w-5 h-5" />
                        </button>
                    </div>
                )}

                {/* STEP 2: HOME PORT */}
                {step === 2 && (
                    <div className="animate-in fade-in slide-in-from-right-8 duration-500">
                        <div className="text-center mb-8">
                            <div className="w-16 h-16 bg-white/5 rounded-full mx-auto mb-4 flex items-center justify-center border border-white/10">
                                <MapPinIcon className="w-8 h-8 text-sky-400" />
                            </div>
                            <h2 className="text-2xl font-bold text-white mb-2">Where is your Home Port?</h2>
                            <p className="text-sm text-gray-400">We'll load forecasts for this location on startup.</p>
                        </div>

                        <div className="space-y-4">
                            <div className="relative">
                                <input 
                                    type="text" 
                                    value={homePort} 
                                    onChange={(e) => setHomePort(e.target.value)} 
                                    placeholder="e.g. Newport, RI" 
                                    className="w-full bg-white/5 border border-white/10 rounded-xl pl-4 pr-12 py-4 text-white focus:border-sky-500 outline-none text-lg font-medium transition-colors" 
                                    autoFocus
                                />
                                <div className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500">
                                    <SearchIcon className="w-5 h-5" />
                                </div>
                            </div>

                            <div className="relative flex items-center gap-4 py-2">
                                <div className="h-px bg-white/10 flex-1"></div>
                                <span className="text-xs text-gray-500 font-bold uppercase">Or</span>
                                <div className="h-px bg-white/10 flex-1"></div>
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <button 
                                    onClick={handleLocate}
                                    className="bg-sky-500/10 hover:bg-sky-500/20 border border-sky-500/30 text-sky-300 font-bold py-4 rounded-xl transition-all flex flex-col items-center justify-center gap-2 group"
                                >
                                    {isLocating ? (
                                        <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
                                    ) : (
                                        <>
                                            <CompassIcon rotation={0} className="w-5 h-5 group-hover:scale-110 transition-transform" />
                                            <span className="text-xs">Use GPS</span>
                                        </>
                                    )}
                                </button>
                                <button 
                                    onClick={() => setShowMap(true)}
                                    className="bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/30 text-purple-300 font-bold py-4 rounded-xl transition-all flex flex-col items-center justify-center gap-2 group"
                                >
                                    <MapIcon className="w-5 h-5 group-hover:scale-110 transition-transform" />
                                    <span className="text-xs">Pick on Map</span>
                                </button>
                            </div>
                        </div>

                        <button 
                            onClick={handleNext} 
                            disabled={!homePort}
                            className={`w-full mt-8 font-bold py-4 rounded-xl transition-all ${homePort ? 'bg-sky-500 hover:bg-sky-400 text-white shadow-lg' : 'bg-white/5 text-gray-500 cursor-not-allowed'}`}
                        >
                            Next
                        </button>
                    </div>
                )}

                {/* STEP 3: VESSEL TYPE */}
                {step === 3 && (
                    <div className="animate-in fade-in slide-in-from-right-8 duration-500">
                        <h2 className="text-2xl font-bold text-white mb-6 text-center">What brings you to the water?</h2>
                        <div className="grid grid-cols-1 gap-4 mb-8">
                            <button onClick={() => setVesselType('sail')} className={`p-6 rounded-2xl border transition-all flex items-center gap-4 group ${vesselType === 'sail' ? 'bg-sky-500/20 border-sky-500' : 'bg-white/5 border-white/10 hover:bg-white/10'}`}>
                                <div className={`p-3 rounded-full ${vesselType === 'sail' ? 'bg-sky-500 text-white' : 'bg-white/10 text-gray-400'}`}><SailBoatIcon className="w-8 h-8" /></div>
                                <div className="text-left"><span className="block text-lg font-bold text-white">Sailing</span><span className="text-sm text-gray-400">Wind-powered vessel</span></div>
                                {vesselType === 'sail' && <CheckIcon className="w-6 h-6 text-sky-500 ml-auto" />}
                            </button>
                            <button onClick={() => setVesselType('power')} className={`p-6 rounded-2xl border transition-all flex items-center gap-4 group ${vesselType === 'power' ? 'bg-sky-500/20 border-sky-500' : 'bg-white/5 border-white/10 hover:bg-white/10'}`}>
                                <div className={`p-3 rounded-full ${vesselType === 'power' ? 'bg-sky-500 text-white' : 'bg-white/10 text-gray-400'}`}><PowerBoatIcon className="w-8 h-8" /></div>
                                <div className="text-left"><span className="block text-lg font-bold text-white">Power Boating</span><span className="text-sm text-gray-400">Motor yacht or cruiser</span></div>
                                {vesselType === 'power' && <CheckIcon className="w-6 h-6 text-sky-500 ml-auto" />}
                            </button>
                            <button onClick={() => setVesselType('observer')} className={`p-6 rounded-2xl border transition-all flex items-center gap-4 group ${vesselType === 'observer' ? 'bg-sky-500/20 border-sky-500' : 'bg-white/5 border-white/10 hover:bg-white/10'}`}>
                                <div className={`p-3 rounded-full ${vesselType === 'observer' ? 'bg-sky-500 text-white' : 'bg-white/10 text-gray-400'}`}><EyeIcon className="w-8 h-8" /></div>
                                <div className="text-left"><span className="block text-lg font-bold text-white">Observation</span><span className="text-sm text-gray-400">Surfing, fishing, or coastal watching</span></div>
                                {vesselType === 'observer' && <CheckIcon className="w-6 h-6 text-sky-500 ml-auto" />}
                            </button>
                        </div>
                        <button onClick={handleNext} className="w-full bg-sky-500 hover:bg-sky-400 text-white font-bold py-4 rounded-xl transition-all">Next</button>
                    </div>
                )}

                {/* STEP 4: VESSEL DETAILS */}
                {step === 4 && (
                    <div className="animate-in fade-in slide-in-from-right-8 duration-500">
                        {vesselType === 'observer' ? (
                            <div className="text-center py-10">
                                <SearchIcon className="w-16 h-16 text-gray-600 mx-auto mb-4" />
                                <h2 className="text-xl font-bold text-white mb-2">Just Watching?</h2>
                                <p className="text-gray-400 mb-8">Observers skip vessel setup. We'll optimize the display for general sea state conditions.</p>
                                <button onClick={handleNext} className="w-full bg-sky-500 hover:bg-sky-400 text-white font-bold py-4 rounded-xl transition-all">Continue to Preferences</button>
                            </div>
                        ) : (
                            <>
                                <h2 className="text-2xl font-bold text-white mb-2 text-center">Tell us about your boat</h2>
                                <p className="text-sm text-gray-400 text-center mb-8">Leave blank to auto-estimate based on typical ratios.</p>
                                
                                <div className="space-y-6">
                                    <div>
                                        <label className="text-xs font-bold text-gray-500 uppercase tracking-widest block mb-2">Vessel Name</label>
                                        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Black Pearl" className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:border-sky-500 outline-none text-lg font-medium" />
                                    </div>

                                    {vesselType === 'sail' && (
                                        <div>
                                            <label className="text-xs font-bold text-gray-500 uppercase tracking-widest block mb-2">Rigging Type</label>
                                            <select 
                                                value={riggingType} 
                                                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setRiggingType(e.target.value as any)} 
                                                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:border-sky-500 outline-none appearance-none"
                                            >
                                                <option value="Sloop" className="bg-slate-900">Sloop</option>
                                                <option value="Cutter" className="bg-slate-900">Cutter</option>
                                                <option value="Ketch" className="bg-slate-900">Ketch</option>
                                                <option value="Yawl" className="bg-slate-900">Yawl</option>
                                                <option value="Schooner" className="bg-slate-900">Schooner</option>
                                                <option value="Catboat" className="bg-slate-900">Catboat</option>
                                                <option value="Solent" className="bg-slate-900">Solent</option>
                                                <option value="Other" className="bg-slate-900">Other</option>
                                            </select>
                                        </div>
                                    )}

                                    <div className="grid grid-cols-2 gap-4">
                                        <div>
                                            <label className="text-xs font-bold text-gray-500 uppercase tracking-widest block mb-2 flex justify-between">Length <button onClick={toggleLengthUnit} className="text-sky-400 hover:text-white">{lengthUnit}</button></label>
                                            <input type="number" value={length} onChange={(e) => setLength(e.target.value)} placeholder="0" className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:border-sky-500 outline-none font-mono placeholder-gray-600" />
                                        </div>
                                        <div>
                                            <label className="text-xs font-bold text-gray-500 uppercase tracking-widest block mb-2 flex justify-between">Beam <button onClick={toggleBeamUnit} className="text-sky-400 hover:text-white">{beamUnit}</button></label>
                                            <input type="number" value={beam} onChange={(e) => setBeam(e.target.value)} placeholder="Auto" className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:border-sky-500 outline-none font-mono placeholder-gray-600" />
                                        </div>
                                    </div>
                                    
                                    <div className="grid grid-cols-2 gap-4">
                                        <div>
                                            <label className="text-xs font-bold text-gray-500 uppercase tracking-widest block mb-2 flex justify-between">Draft <button onClick={toggleDraftUnit} className="text-sky-400 hover:text-white">{draftUnit}</button></label>
                                            <input type="number" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Auto" className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:border-sky-500 outline-none font-mono placeholder-gray-600" />
                                        </div>
                                        <div>
                                            <label className="text-xs font-bold text-gray-500 uppercase tracking-widest block mb-2 flex justify-between">Displacement <button onClick={toggleDispUnit} className="text-sky-400 hover:text-white">{dispUnit}</button></label>
                                            <input type="number" value={displacement} onChange={(e) => setDisplacement(e.target.value)} placeholder="Auto" className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:border-sky-500 outline-none font-mono placeholder-gray-600" />
                                        </div>
                                    </div>

                                    {/* Tankage */}
                                    <div className="grid grid-cols-2 gap-4">
                                        <div>
                                            <label className="text-xs font-bold text-gray-500 uppercase tracking-widest block mb-2 flex justify-between gap-1 items-center"><span className="flex items-center gap-1"><GearIcon className="w-3 h-3 text-orange-400"/> Fuel</span> <button onClick={() => setVolUnit(u => u === 'gal' ? 'l' : 'gal')} className="text-sky-400 hover:text-white uppercase">{volUnit}</button></label>
                                            <input type="number" value={fuel} onChange={(e) => setFuel(e.target.value)} placeholder="0" className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:border-sky-500 outline-none font-mono" />
                                        </div>
                                        <div>
                                            <label className="text-xs font-bold text-gray-500 uppercase tracking-widest block mb-2 flex justify-between gap-1 items-center"><span className="flex items-center gap-1"><DropletIcon className="w-3 h-3 text-blue-400"/> Water</span> <button onClick={() => setVolUnit(u => u === 'gal' ? 'l' : 'gal')} className="text-sky-400 hover:text-white uppercase">{volUnit}</button></label>
                                            <input type="number" value={water} onChange={(e) => setWater(e.target.value)} placeholder="0" className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:border-sky-500 outline-none font-mono" />
                                        </div>
                                    </div>
                                </div>
                                <button onClick={handleNext} className="w-full mt-8 bg-sky-500 hover:bg-sky-400 text-white font-bold py-4 rounded-xl transition-all">Next</button>
                            </>
                        )}
                    </div>
                )}

                {/* STEP 5: PREFERENCES */}
                {step === 5 && (
                    <div className="animate-in fade-in slide-in-from-right-8 duration-500">
                        <h2 className="text-2xl font-bold text-white mb-6 text-center">Unit Preferences</h2>
                        
                        <div className="space-y-4 mb-8">
                            <div className="bg-white/5 rounded-xl p-4 flex justify-between items-center">
                                <span className="text-gray-300 font-medium">Wind Speed</span>
                                <div className="flex bg-black/20 rounded-lg p-1">
                                    {['kts', 'mph', 'kmh'].map((u) => (
                                        <button key={u} onClick={() => setPrefSpeed(u as SpeedUnit)} className={`px-3 py-1.5 rounded-md text-xs font-bold uppercase transition-all ${prefSpeed === u ? 'bg-sky-500 text-white' : 'text-gray-500'}`}>{u}</button>
                                    ))}
                                </div>
                            </div>
                            
                            {/* Wave & Tide Height Preference */}
                            <div className="bg-white/5 rounded-xl p-4 flex justify-between items-center">
                                <span className="text-gray-300 font-medium">Wave & Tide Height</span>
                                <div className="flex bg-black/20 rounded-lg p-1">
                                    {['m', 'ft'].map((u) => (
                                        <button key={u} onClick={() => setPrefLength(u as LengthUnit)} className={`px-4 py-1.5 rounded-md text-xs font-bold uppercase transition-all ${prefLength === u ? 'bg-sky-500 text-white' : 'text-gray-500'}`}>{u}</button>
                                    ))}
                                </div>
                            </div>

                            <div className="bg-white/5 rounded-xl p-4 flex justify-between items-center">
                                <span className="text-gray-300 font-medium">Temperature</span>
                                <div className="flex bg-black/20 rounded-lg p-1">
                                    {['C', 'F'].map((u) => (
                                        <button key={u} onClick={() => setPrefTemp(u as TempUnit)} className={`px-4 py-1.5 rounded-md text-xs font-bold uppercase transition-all ${prefTemp === u ? 'bg-sky-500 text-white' : 'text-gray-500'}`}>{u}</button>
                                    ))}
                                </div>
                            </div>
                            <div className="bg-white/5 rounded-xl p-4 flex justify-between items-center">
                                <span className="text-gray-300 font-medium">Distance</span>
                                <div className="flex bg-black/20 rounded-lg p-1">
                                    {['nm', 'mi', 'km'].map((u) => (
                                        <button key={u} onClick={() => setPrefDist(u as DistanceUnit)} className={`px-4 py-1.5 rounded-md text-xs font-bold uppercase transition-all ${prefDist === u ? 'bg-sky-500 text-white' : 'text-gray-500'}`}>{u}</button>
                                    ))}
                                </div>
                            </div>
                        </div>

                        <button onClick={handleFinish} className="w-full bg-emerald-500 hover:bg-emerald-400 text-white font-bold py-4 rounded-xl transition-all shadow-lg shadow-emerald-500/20">
                            Launch Dashboard
                        </button>
                    </div>
                )}

                {/* Progress Dots */}
                <div className="flex justify-center gap-2 mt-8">
                    {[1,2,3,4,5].map(i => (
                        <div key={i} className={`w-2 h-2 rounded-full transition-all ${step >= i ? 'bg-sky-500 w-4' : 'bg-gray-700'}`}></div>
                    ))}
                </div>
            </div>
        </div>
    );
};
