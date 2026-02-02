import React from 'react';
import { VesselProfile, VoyagePlan } from '../../types';
import { FuelIcon, WaterIcon, FoodIcon, AlertTriangleIcon } from '../Icons';

interface ResourceCalculatorProps {
    voyagePlan: VoyagePlan;
    vessel: VesselProfile;
    crewCount?: number;
}

export const ResourceCalculator: React.FC<ResourceCalculatorProps> = ({ voyagePlan, vessel, crewCount = 2 }) => {
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

    // FUEL CALCULATION
    const fuelBurnRate = vessel.fuelBurn || 0; // L/hr or gal/hr
    const fuelRequired = fuelBurnRate * durationHours;
    const fuelWithReserve = fuelRequired * 1.3; // 30% reserve
    const fuelCapacity = vessel.fuelCapacity || 0;
    const fuelSufficient = fuelCapacity >= fuelWithReserve;

    // WATER CALCULATION (3L per person per day)
    const durationDays = durationHours / 24;
    const waterRequired = crewCount * durationDays * 3; // Liters
    const waterCapacity = vessel.waterCapacity || 0;
    const waterSufficient = waterCapacity >= waterRequired;

    // PROVISIONS (rough estimate)
    const mealsRequired = Math.ceil(durationDays * crewCount * 3); // 3 meals/day
    const emergencyRations = durationDays < 2; // Only suggest if < 2 days

    return (
        <div className="w-full bg-slate-900 border border-white/10 rounded-3xl p-6 md:p-8 shadow-xl relative overflow-hidden">
            <div className="absolute top-0 left-0 w-96 h-96 bg-orange-500/5 rounded-full blur-3xl -translate-y-1/2 -translate-x-1/2 pointer-events-none"></div>

            <div className="relative z-10">
                <h3 className="text-lg font-bold text-white uppercase tracking-widest flex items-center gap-2 mb-6 border-b border-white/5 pb-4">
                    <FuelIcon className="w-5 h-5 text-amber-400" />
                    Resources & Logistics
                </h3>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {/* FUEL */}
                    <div className={`rounded-2xl p-6 border ${fuelSufficient ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-red-500/10 border-red-500/20'}`}>
                        <div className="flex items-center gap-2 mb-4">
                            <FuelIcon className={`w-5 h-5 ${fuelSufficient ? 'text-emerald-400' : 'text-red-400'}`} />
                            <span className="text-xs font-bold uppercase tracking-widest text-gray-400">Fuel</span>
                        </div>

                        <div className="space-y-3">
                            <div>
                                <div className="text-[10px] text-gray-500 mb-1">Required (with 30% reserve)</div>
                                <div className="text-2xl font-bold text-white">
                                    {fuelWithReserve.toFixed(0)}
                                    <span className="text-sm font-normal text-gray-400 ml-1">L</span>
                                </div>
                            </div>

                            <div>
                                <div className="text-[10px] text-gray-500 mb-1">Tank Capacity</div>
                                <div className="text-sm font-mono text-gray-300">{fuelCapacity} L</div>
                            </div>

                            <div className="pt-2 border-t border-white/10">
                                <div className="text-[10px] text-gray-500 mb-1">Burn Rate</div>
                                <div className="text-xs font-mono text-gray-400">{fuelBurnRate} L/hr × {durationHours.toFixed(1)} hrs</div>
                            </div>

                            {!fuelSufficient && (
                                <div className="flex items-start gap-2 p-2 bg-red-500/20 rounded-lg">
                                    <AlertTriangleIcon className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
                                    <span className="text-[10px] text-red-300">Insufficient fuel! Plan refueling stop.</span>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* WATER */}
                    <div className={`rounded-2xl p-6 border ${waterSufficient ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-amber-500/10 border-amber-500/20'}`}>
                        <div className="flex items-center gap-2 mb-4">
                            <WaterIcon className={`w-5 h-5 ${waterSufficient ? 'text-emerald-400' : 'text-amber-400'}`} />
                            <span className="text-xs font-bold uppercase tracking-widest text-gray-400">Water</span>
                        </div>

                        <div className="space-y-3">
                            <div>
                                <div className="text-[10px] text-gray-500 mb-1">Required</div>
                                <div className="text-2xl font-bold text-white">
                                    {waterRequired.toFixed(0)}
                                    <span className="text-sm font-normal text-gray-400 ml-1">L</span>
                                </div>
                            </div>

                            <div>
                                <div className="text-[10px] text-gray-500 mb-1">Tank Capacity</div>
                                <div className="text-sm font-mono text-gray-300">{waterCapacity} L</div>
                            </div>

                            <div className="pt-2 border-t border-white/10">
                                <div className="text-[10px] text-gray-500 mb-1">Crew Planning</div>
                                <div className="text-xs font-mono text-gray-400">{crewCount} crew × {durationDays.toFixed(1)} days × 3L</div>
                            </div>

                            {!waterSufficient && (
                                <div className="flex items-start gap-2 p-2 bg-amber-500/20 rounded-lg">
                                    <AlertTriangleIcon className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
                                    <span className="text-[10px] text-amber-300">Low water. Consider extra jerry cans.</span>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* PROVISIONS */}
                    <div className="rounded-2xl p-6 border bg-cyan-500/10 border-cyan-500/20">
                        <div className="flex items-center gap-2 mb-4">
                            <FoodIcon className="w-5 h-5 text-cyan-400" />
                            <span className="text-xs font-bold uppercase tracking-widest text-gray-400">Provisions</span>
                        </div>

                        <div className="space-y-3">
                            <div>
                                <div className="text-[10px] text-gray-500 mb-1">Meals Required</div>
                                <div className="text-2xl font-bold text-white">
                                    {mealsRequired}
                                    <span className="text-sm font-normal text-gray-400 ml-1">meals</span>
                                </div>
                            </div>

                            <div className="pt-2 border-t border-white/10">
                                <div className="text-[10px] text-gray-500 mb-2">Checklist</div>
                                <div className="space-y-1 text-xs text-gray-300">
                                    <div>✓ {crewCount} × breakfast × {Math.ceil(durationDays)}</div>
                                    <div>✓ {crewCount} × lunch × {Math.ceil(durationDays)}</div>
                                    <div>✓ {crewCount} × dinner × {Math.ceil(durationDays)}</div>
                                    {!emergencyRations && <div>✓ 48hr emergency rations</div>}
                                </div>
                            </div>

                            <div className="flex items-start gap-2 p-2 bg-cyan-500/20 rounded-lg">
                                <span className="text-[10px] text-cyan-300">Don't forget snacks, caffeine, and seasickness meds!</span>
                            </div>
                        </div>
                    </div>
                </div>

                {/* SUMMARY */}
                <div className="mt-6 p-4 bg-black/20 rounded-xl border border-white/5">
                    <div className="text-xs text-gray-400 leading-relaxed">
                        <span className="font-bold text-white">Planning Summary:</span> This {durationDays.toFixed(1)}-day passage requires approximately {fuelRequired.toFixed(0)}L fuel (plus {(fuelWithReserve - fuelRequired).toFixed(0)}L reserve), {waterRequired.toFixed(0)}L water, and {mealsRequired} meals for {crewCount} crew.
                        {!fuelSufficient && <span className="text-red-400"> ⚠️ Fuel capacity insufficient - plan refueling stop.</span>}
                        {!waterSufficient && <span className="text-amber-400"> ⚠️ Water capacity low - pack extra jerry cans.</span>}
                    </div>
                </div>
            </div>
        </div>
    );
};
