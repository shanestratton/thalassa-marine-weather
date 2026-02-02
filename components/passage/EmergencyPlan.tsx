import React from 'react';
import { VoyagePlan, VesselProfile } from '../../types';
import { MapPinIcon, PhoneIcon, RadioTowerIcon, AlertTriangleIcon, WindIcon, CrosshairIcon } from '../Icons';

interface EmergencyPlanProps {
    voyagePlan: VoyagePlan;
    vessel: VesselProfile;
}

// Emergency harbor data (would ideally come from API)
interface SafeHarbor {
    name: string;
    distance: number; // nm from midpoint
    coordinates: { lat: number; lon: number };
    facilities: string[];
    vhfChannel: string;
}

export const EmergencyPlan: React.FC<EmergencyPlanProps> = ({ voyagePlan, vessel }) => {
    // Calculate approximate safe harbors along route
    // In production, this would query a marine database API
    const safeHarbors: SafeHarbor[] = [
        {
            name: "Marina del Rey",
            distance: 12,
            coordinates: { lat: 33.9750, lon: -118.4517 },
            facilities: ["Fuel", "Medical", "Repair", "24hr"],
            vhfChannel: "16"
        },
        {
            name: "Newport Harbor",
            distance: 28,
            coordinates: { lat: 33.6189, lon: -117.9298 },
            facilities: ["Fuel", "Medical", "Repair"],
            vhfChannel: "16"
        },
        {
            name: "Dana Point",
            distance: 45,
            coordinates: { lat: 33.4673, lon: -117.6981 },
            facilities: ["Fuel", "Repair"],
            vhfChannel: "12"
        }
    ];

    // Emergency contacts (region-specific in production)
    const emergencyContacts = [
        { service: "US Coast Guard", frequency: "156.8 MHz (VHF-16)", phone: "1-800-221-8724" },
        { service: "Marine Rescue Coordination", frequency: "156.8 MHz (VHF-16)", phone: "911" },
        { service: "NOAA Weather Radio", frequency: "162.55 MHz", phone: "N/A" }
    ];

    // Weather diversion scenarios
    const diversionScenarios = [
        {
            condition: "Wind > 30kts",
            action: "Seek nearest harbor within 20nm",
            recommendation: "Monitor VHF-16 for small craft advisories"
        },
        {
            condition: "Wave Height > 3m",
            action: "Consider heave-to or run to safe harbor",
            recommendation: "Reduce sail, prepare storm equipment"
        },
        {
            condition: "Visibility < 1nm",
            action: "Activate navigation lights, reduce speed",
            recommendation: "Use radar if available, post lookout"
        },
        {
            condition: "Equipment Failure",
            action: "Assess severity, call for assistance if needed",
            recommendation: "Have backup navigation (GPS, charts, compass)"
        }
    ];

    return (
        <div className="w-full bg-slate-900 border border-white/10 rounded-3xl p-6 md:p-8 shadow-xl relative overflow-hidden">
            <div className="absolute top-0 left-0 w-96 h-96 bg-red-500/5 rounded-full blur-3xl -translate-y-1/2 -translate-x-1/2 pointer-events-none"></div>

            <div className="relative z-10">
                <div className="flex justify-between items-start mb-6 border-b border-white/5 pb-4">
                    <div>
                        <h3 className="text-lg font-bold text-white uppercase tracking-widest flex items-center gap-2">
                            <AlertTriangleIcon className="w-5 h-5 text-red-400" />
                            Emergency & Contingency Plan
                        </h3>
                        <p className="text-xs text-slate-400 font-medium">Pre-Planned Safety Options Along Route</p>
                    </div>
                    <div className="text-xs font-mono text-red-400 bg-red-500/10 px-3 py-1.5 rounded border border-red-500/20">
                        SAFETY CRITICAL
                    </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* SAFE HARBORS */}
                    <div className="space-y-4">
                        <h4 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                            <MapPinIcon className="w-4 h-4 text-emerald-400" />
                            Nearest Safe Harbors
                        </h4>

                        <div className="space-y-3">
                            {safeHarbors.map((harbor, idx) => (
                                <div key={idx} className="bg-white/5 border border-white/10 rounded-xl p-4 hover:bg-white/10 transition-colors">
                                    <div className="flex justify-between items-start mb-2">
                                        <div>
                                            <h5 className="text-sm font-bold text-white">{harbor.name}</h5>
                                            <p className="text-xs text-gray-400 font-mono">
                                                {harbor.coordinates.lat.toFixed(4)}°N {Math.abs(harbor.coordinates.lon).toFixed(4)}°W
                                            </p>
                                        </div>
                                        <span className="text-xs font-bold text-emerald-400 bg-emerald-500/10 px-2 py-1 rounded">
                                            {harbor.distance} nm
                                        </span>
                                    </div>

                                    <div className="flex flex-wrap gap-2 mb-2">
                                        {harbor.facilities.map((facility, i) => (
                                            <span key={i} className="text-[10px] font-bold text-sky-300 bg-sky-500/10 px-2 py-0.5 rounded border border-sky-500/20">
                                                {facility}
                                            </span>
                                        ))}
                                    </div>

                                    <div className="flex items-center gap-2 text-xs text-gray-400">
                                        <RadioTowerIcon className="w-3 h-3" />
                                        <span>VHF Ch {harbor.vhfChannel}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* EMERGENCY CONTACTS */}
                    <div className="space-y-4">
                        <h4 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                            <PhoneIcon className="w-4 h-4 text-amber-400" />
                            Emergency Contacts
                        </h4>

                        <div className="space-y-3">
                            {emergencyContacts.map((contact, idx) => (
                                <div key={idx} className="bg-white/5 border border-white/10 rounded-xl p-4">
                                    <h5 className="text-sm font-bold text-white mb-2">{contact.service}</h5>
                                    <div className="space-y-1 text-xs">
                                        <div className="flex items-center gap-2 text-amber-400">
                                            <RadioTowerIcon className="w-3 h-3" />
                                            <span className="font-mono">{contact.frequency}</span>
                                        </div>
                                        <div className="flex items-center gap-2 text-emerald-400">
                                            <PhoneIcon className="w-3 h-3" />
                                            <span className="font-mono">{contact.phone}</span>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>

                        {/* Quick Mayday Template */}
                        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4">
                            <h5 className="text-xs font-bold text-red-400 uppercase tracking-wider mb-2">MAYDAY Protocol</h5>
                            <div className="text-[10px] text-gray-300 space-y-1 font-mono">
                                <div>1. MAYDAY MAYDAY MAYDAY</div>
                                <div>2. This is [VESSEL NAME] × 3</div>
                                <div>3. Position: [LAT/LON]</div>
                                <div>4. Nature of distress</div>
                                <div>5. Assistance required</div>
                                <div>6. Souls on board: {vessel.type === 'sail' ? '2-4' : '2-6'}</div>
                                <div>7. OVER</div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* WEATHER DIVERSION PROCEDURES */}
                <div className="mt-6 pt-6 border-t border-white/10">
                    <h4 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2 mb-4">
                        <WindIcon className="w-4 h-4 text-orange-400" />
                        Weather Diversion Procedures
                    </h4>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {diversionScenarios.map((scenario, idx) => (
                            <div key={idx} className="bg-white/5 border border-white/10 rounded-lg p-3 hover:bg-white/10 transition-colors">
                                <div className="flex items-start gap-2 mb-2">
                                    <AlertTriangleIcon className="w-4 h-4 text-orange-400 mt-0.5 flex-shrink-0" />
                                    <div className="flex-1">
                                        <h5 className="text-xs font-bold text-orange-300 mb-1">{scenario.condition}</h5>
                                        <p className="text-[11px] text-white mb-1"><span className="font-bold">Action:</span> {scenario.action}</p>
                                        <p className="text-[10px] text-gray-400">{scenario.recommendation}</p>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* DISCLAIMER */}
                <div className="mt-6 p-3 bg-amber-950/20 border border-amber-900/30 rounded-lg">
                    <p className="text-[10px] text-amber-200/80 leading-relaxed">
                        <span className="font-bold text-amber-400">⚠️ Important:</span> This emergency plan is generated for reference only.
                        Always verify safe harbor availability via VHF radio before diversion. Maintain updated charts and contact information.
                        The captain is solely responsible for crew safety and vessel operations.
                    </p>
                </div>
            </div>
        </div>
    );
};
