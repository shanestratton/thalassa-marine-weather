import React from 'react';
import { t } from '../../theme';
import { VesselProfile, VoyagePlan } from '../../types';
import { FuelIcon, WaterIcon, FoodIcon, AlertTriangleIcon } from '../Icons';

interface ResourceCalculatorProps {
    voyagePlan: VoyagePlan;
    vessel: VesselProfile;
    crewCount?: number;
}

export const ResourceCalculator: React.FC<ResourceCalculatorProps> = ({ voyagePlan, vessel, crewCount }) => {
    const effectiveCrewCount = crewCount || vessel.crewCount || 2;

    // Parse distance (e.g., "125 nm" -> 125)
    const distanceNm = parseFloat(voyagePlan.distanceApprox.match(/(\d+\.?\d*)/)?.[0] || '0');

    // Parse duration (e.g., "18 hours" -> 18, "2 days" -> 48)
    const durationStr = voyagePlan.durationApprox.toLowerCase();
    let durationHours = 0;
    if (durationStr.includes('day')) {
        const days = parseFloat(durationStr.match(/(\d+\.?\d*)/)?.[0] || '0');
        durationHours = days * 24;
    } else if (durationStr.includes('hour')) {
        durationHours = parseFloat(durationStr.match(/(\d+\.?\d*)/)?.[0] || '0');
    }

    // FUEL CALCULATION - Vessel type aware
    const isSail = vessel.type === 'sail';
    const fuelBurnRate = vessel.fuelBurn || 0; // L/hr or gal/hr
    // Sailing vessels only use engine ~15% of passage (calms, docking, charging)
    const motoringFraction = isSail ? 0.15 : 1.0;
    const motoringHours = durationHours * motoringFraction;
    const fuelRequired = fuelBurnRate * motoringHours;
    const fuelWithReserve = fuelRequired * 1.3; // 30% reserve
    const fuelCapacity = vessel.fuelCapacity || 0;
    const fuelSufficient = fuelCapacity >= fuelWithReserve || (isSail && fuelBurnRate === 0);

    // WATER CALCULATION (3L per person per day)
    const durationDays = durationHours / 24;
    const waterRequired = effectiveCrewCount * durationDays * 3; // Liters
    const waterCapacity = vessel.waterCapacity || 0;
    const waterSufficient = waterCapacity >= waterRequired;

    // PROVISIONS (rough estimate)
    const mealsRequired = Math.ceil(durationDays * effectiveCrewCount * 3); // 3 meals/day
    const emergencyRations = durationDays < 2; // Only suggest if < 2 days

    return (
        <div className={`w-full bg-slate-900 ${t.border.default} rounded-3xl p-6 md:p-8 shadow-xl relative overflow-hidden`}>
            <div className="absolute top-0 left-0 w-96 h-96 bg-orange-500/5 rounded-full blur-3xl -translate-y-1/2 -translate-x-1/2 pointer-events-none"></div>

            <div className="relative z-10">
                <h3 className="text-lg font-bold text-white uppercase tracking-widest flex items-center gap-2 mb-6 border-b border-white/5 pb-4">
                    <FuelIcon className="w-5 h-5 text-amber-400" />
                    Resources & Logistics
                    <span className="ml-auto text-sm font-mono text-gray-500 normal-case tracking-normal">{effectiveCrewCount} crew</span>
                </h3>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {/* FUEL / MOTOR RESERVE */}
                    <div className={`rounded-2xl p-6 border ${isSail && fuelBurnRate === 0 ? 'bg-sky-500/10 border-sky-500/20' : fuelSufficient ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-red-500/10 border-red-500/20'}`}>
                        <div className="flex items-center gap-2 mb-4">
                            <FuelIcon className={`w-5 h-5 ${isSail && fuelBurnRate === 0 ? 'text-sky-400' : fuelSufficient ? 'text-emerald-400' : 'text-red-400'}`} />
                            <span className="text-sm font-bold uppercase tracking-widest text-gray-400">{isSail ? 'Motor Reserve' : 'Fuel'}</span>
                        </div>

                        <div className="space-y-3">
                            {isSail && fuelBurnRate === 0 ? (
                                <>
                                    <div className="text-sm text-sky-300 font-medium">Wind Powered ⛵</div>
                                    <div className="text-sm text-gray-400 leading-relaxed">
                                        No fuel burn rate configured. This vessel is primarily wind-powered. Set a fuel burn rate in Settings for auxiliary motoring estimates.
                                    </div>
                                </>
                            ) : (
                                <>
                                    <div>
                                        <div className="text-sm text-gray-500 mb-1">{isSail ? 'Motor Reserve (with 30% reserve)' : 'Required (with 30% reserve)'}</div>
                                        <div className="text-2xl font-bold text-white">
                                            {fuelWithReserve.toFixed(0)}
                                            <span className="text-sm font-normal text-gray-400 ml-1">L</span>
                                        </div>
                                    </div>

                                    <div>
                                        <div className="text-sm text-gray-500 mb-1">Tank Capacity</div>
                                        <div className="text-sm font-mono text-gray-300">{fuelCapacity} L</div>
                                    </div>

                                    <div className="pt-2 border-t border-white/10">
                                        <div className="text-sm text-gray-500 mb-1">Burn Rate</div>
                                        <div className="text-sm font-mono text-gray-400">
                                            {fuelBurnRate} L/hr × {motoringHours.toFixed(1)} hrs
                                            {isSail && <span className="text-sky-400 ml-1">(~15% motoring)</span>}
                                        </div>
                                    </div>

                                    {!fuelSufficient && (
                                        <div className="flex items-start gap-2 p-2 bg-red-500/20 rounded-lg" aria-live="assertive">
                                            <AlertTriangleIcon className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
                                            <span className="text-sm text-red-300">{isSail ? 'Motor reserve exceeds tank. Monitor fuel carefully.' : 'Insufficient fuel! Plan refueling stop.'}</span>
                                        </div>
                                    )}

                                    {isSail && fuelSufficient && (
                                        <div className="text-sm text-sky-300 italic">Auxiliary motoring only — calms, docking, charging</div>
                                    )}
                                </>
                            )}
                        </div>
                    </div>

                    {/* WATER */}
                    <div className={`rounded-2xl p-6 border ${waterSufficient ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-amber-500/10 border-amber-500/20'}`}>
                        <div className="flex items-center gap-2 mb-4">
                            <WaterIcon className={`w-5 h-5 ${waterSufficient ? 'text-emerald-400' : 'text-amber-400'}`} />
                            <span className="text-sm font-bold uppercase tracking-widest text-gray-400">Water</span>
                        </div>

                        <div className="space-y-3">
                            <div>
                                <div className="text-sm text-gray-500 mb-1">Required</div>
                                <div className="text-2xl font-bold text-white">
                                    {waterRequired.toFixed(0)}
                                    <span className="text-sm font-normal text-gray-400 ml-1">L</span>
                                </div>
                            </div>

                            <div>
                                <div className="text-sm text-gray-500 mb-1">Tank Capacity</div>
                                <div className="text-sm font-mono text-gray-300">{waterCapacity} L</div>
                            </div>

                            <div className="pt-2 border-t border-white/10">
                                <div className="text-sm text-gray-500 mb-1">Crew Planning</div>
                                <div className="text-sm font-mono text-gray-400">{effectiveCrewCount} crew × {durationDays.toFixed(1)} days × 3L</div>
                            </div>

                            {!waterSufficient && (
                                <div className="flex items-start gap-2 p-2 bg-amber-500/20 rounded-lg">
                                    <AlertTriangleIcon className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
                                    <span className="text-sm text-amber-300">Low water. Consider extra jerry cans.</span>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* PROVISIONS */}
                    <div className="rounded-2xl p-6 border bg-cyan-500/10 border-cyan-500/20">
                        <div className="flex items-center gap-2 mb-4">
                            <FoodIcon className="w-5 h-5 text-cyan-400" />
                            <span className="text-sm font-bold uppercase tracking-widest text-gray-400">Provisions</span>
                        </div>

                        <div className="space-y-3">
                            <div>
                                <div className="text-sm text-gray-500 mb-1">Meals Required</div>
                                <div className="text-2xl font-bold text-white">
                                    {mealsRequired}
                                    <span className="text-sm font-normal text-gray-400 ml-1">meals</span>
                                </div>
                            </div>

                            <div className="pt-2 border-t border-white/10">
                                <div className="text-sm text-gray-500 mb-2">Checklist</div>
                                <div className="space-y-1 text-sm text-gray-300">
                                    <div>✓ {effectiveCrewCount} × breakfast × {Math.ceil(durationDays)}</div>
                                    <div>✓ {effectiveCrewCount} × lunch × {Math.ceil(durationDays)}</div>
                                    <div>✓ {effectiveCrewCount} × dinner × {Math.ceil(durationDays)}</div>
                                    {!emergencyRations && <div>✓ 48hr emergency rations</div>}
                                </div>
                            </div>

                            <div className="flex items-start gap-2 p-2 bg-cyan-500/20 rounded-lg">
                                <span className="text-sm text-cyan-300">Don't forget snacks, caffeine, and seasickness meds!</span>
                            </div>
                        </div>
                    </div>
                </div>

                {/* SUMMARY */}
                <div className="mt-6 p-4 bg-black/20 rounded-xl ${t.border.subtle}">
                    <div className="text-sm text-gray-400 leading-relaxed">
                        <span className="font-bold text-white">Planning Summary:</span> This {durationDays.toFixed(1)}-day passage requires approximately {isSail ? `${fuelRequired.toFixed(0)}L motor reserve` : `${fuelRequired.toFixed(0)}L fuel`} (plus {(fuelWithReserve - fuelRequired).toFixed(0)}L reserve), {waterRequired.toFixed(0)}L water, and {mealsRequired} meals for {effectiveCrewCount} crew.
                        {!fuelSufficient && !isSail && <span className="text-red-400"> ⚠️ Fuel capacity insufficient - plan refueling stop.</span>}
                        {!fuelSufficient && isSail && <span className="text-amber-400"> ⚠️ Motor reserve exceeds tank capacity.</span>}
                        {!waterSufficient && <span className="text-amber-400"> ⚠️ Water capacity low - pack extra jerry cans.</span>}
                    </div>
                </div>
            </div>
        </div>
    );
};
