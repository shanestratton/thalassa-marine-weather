import React from 'react';
import { VesselProfile, VoyagePlan } from '../../types';
import { FuelIcon, WaterIcon, FoodIcon, AlertTriangleIcon, GearIcon } from '../Icons';

interface ResourceCalculatorProps {
    voyagePlan: VoyagePlan;
    vessel: VesselProfile;
    crewCount?: number;
}

export const ResourceCalculator: React.FC<ResourceCalculatorProps> = ({ voyagePlan, vessel, crewCount }) => {
    const isObserver = vessel.type === 'observer';
    const isSail = vessel.type === 'sail';
    const isPower = vessel.type === 'power';

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
    const durationDays = durationHours / 24;

    // ─── OBSERVER MODE ────────────────────────────────────────────
    // No vessel-specific assumptions — show generic passage info only
    if (isObserver) {
        return (
            <div className="space-y-4">
                <div className="bg-sky-500/5 border border-sky-500/15 rounded-xl p-5">
                    <h4 className="text-xs text-sky-400 font-bold uppercase tracking-widest mb-3 flex items-center gap-2">
                        <GearIcon className="w-3.5 h-3.5" /> Passage Summary
                    </h4>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Distance</div>
                            <div className="text-lg font-bold text-white">{voyagePlan.distanceApprox}</div>
                        </div>
                        <div>
                            <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Duration</div>
                            <div className="text-lg font-bold text-white">{voyagePlan.durationApprox}</div>
                        </div>
                    </div>
                </div>

                <div className="flex items-start gap-3 p-4 bg-amber-500/5 border border-amber-500/15 rounded-xl">
                    <AlertTriangleIcon className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                    <div>
                        <h4 className="text-xs font-bold text-amber-300 mb-1">Observer Mode</h4>
                        <p className="text-xs text-gray-400 leading-relaxed">
                            Fuel, water, and provisioning calculations require a vessel profile. Configure your vessel in <span className="text-white font-medium">Settings → Vessel Profile</span> to unlock detailed resource planning.
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    // ─── VESSEL INFO CHECK ────────────────────────────────────────
    // For non-observer users, check if enough info exists for meaningful calculations
    const effectiveCrewCount = crewCount || vessel.crewCount || 2;
    const fuelBurnRate = vessel.fuelBurn || 0;
    const fuelCapacity = vessel.fuelCapacity || 0;
    const waterCapacity = vessel.waterCapacity || 0;

    const hasFuelInfo = isPower ? (fuelBurnRate > 0 && fuelCapacity > 0) : true; // Sail doesn't strictly need it
    const hasWaterInfo = waterCapacity > 0;
    const hasVesselSize = vessel.length > 0;
    const missingCriticalInfo = isPower && !hasFuelInfo;

    // ─── FUEL CALCULATION ─────────────────────────────────────────
    // Sailing vessels: engine ~15% of passage (calms, docking, charging)
    const motoringFraction = isSail ? 0.15 : 1.0;
    const motoringHours = durationHours * motoringFraction;
    const fuelRequired = fuelBurnRate * motoringHours;
    const fuelWithReserve = fuelRequired * 1.3; // 30% reserve
    const fuelSufficient = fuelCapacity >= fuelWithReserve || (isSail && fuelBurnRate === 0);

    // ─── WATER CALCULATION ────────────────────────────────────────
    const waterRequired = effectiveCrewCount * durationDays * 3; // 3L per person per day
    const waterSufficient = waterCapacity >= waterRequired;

    // ─── PROVISIONS ───────────────────────────────────────────────
    const mealsRequired = Math.ceil(durationDays * effectiveCrewCount * 3); // 3 meals/day

    return (
        <div className="space-y-4">
            {/* Missing info warning for powerboats */}
            {missingCriticalInfo && (
                <div className="flex items-start gap-3 p-4 bg-amber-500/5 border border-amber-500/15 rounded-xl">
                    <AlertTriangleIcon className="w-5 h-5 text-amber-400 mt-0.5 shrink-0" />
                    <div>
                        <h4 className="text-sm font-bold text-amber-300 mb-1">Vessel Profile Incomplete</h4>
                        <p className="text-xs text-gray-400 leading-relaxed">
                            Accurate fuel planning for a power vessel requires <span className="text-white font-medium">fuel burn rate</span> and <span className="text-white font-medium">tank capacity</span>. Update these in <span className="text-white font-medium">Settings → Vessel Profile</span> for reliable estimates.
                        </p>
                    </div>
                </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

                {/* ═══ FUEL / MOTOR RESERVE ═══ */}
                <div className={`rounded-xl p-5 border ${isSail && fuelBurnRate === 0
                        ? 'bg-sky-500/5 border-sky-500/15'
                        : fuelSufficient
                            ? 'bg-emerald-500/5 border-emerald-500/15'
                            : 'bg-red-500/5 border-red-500/15'
                    }`}>
                    <div className="flex items-center gap-2 mb-3">
                        <FuelIcon className={`w-4 h-4 ${isSail && fuelBurnRate === 0 ? 'text-sky-400'
                                : fuelSufficient ? 'text-emerald-400'
                                    : 'text-red-400'
                            }`} />
                        <span className="text-xs font-bold uppercase tracking-widest text-gray-400">
                            {isSail ? 'Motor Reserve' : 'Fuel'}
                        </span>
                    </div>

                    <div className="space-y-3">
                        {isSail && fuelBurnRate === 0 ? (
                            /* Sailing vessel, no burn rate — recommend full tank */
                            <>
                                <div className="text-sm text-sky-300 font-medium">Wind Powered ⛵</div>
                                <p className="text-xs text-gray-400 leading-relaxed">
                                    Ensure tanks are full before departure. Auxiliary engine may be needed for calms, docking, and battery charging (~15% of passage).
                                </p>
                                {fuelCapacity > 0 && (
                                    <div className="pt-2 border-t border-white/10">
                                        <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Tank Capacity</div>
                                        <div className="text-sm font-mono text-gray-300">{fuelCapacity} L — depart full</div>
                                    </div>
                                )}
                                {fuelCapacity === 0 && (
                                    <div className="text-[10px] text-gray-500 italic">
                                        Set tank capacity in Settings for reserve monitoring.
                                    </div>
                                )}
                            </>
                        ) : isSail ? (
                            /* Sailing vessel WITH burn rate configured */
                            <>
                                <div>
                                    <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Motor Reserve (30% buffer)</div>
                                    <div className="text-xl font-bold text-white">
                                        {fuelWithReserve.toFixed(0)}<span className="text-xs font-normal text-gray-500 ml-1">L</span>
                                    </div>
                                </div>
                                <div className="text-xs text-gray-400 font-mono">
                                    {fuelBurnRate} L/hr × {motoringHours.toFixed(1)} hrs <span className="text-sky-400">(~15% motoring)</span>
                                </div>
                                {fuelCapacity > 0 && (
                                    <div className="pt-2 border-t border-white/10 text-xs text-gray-400">
                                        Tank: {fuelCapacity}L — {fuelSufficient ? '✓ Sufficient' : '⚠ Exceeds capacity'}
                                    </div>
                                )}
                                {!fuelSufficient && (
                                    <div className="flex items-start gap-2 p-2 bg-amber-500/10 rounded-lg">
                                        <AlertTriangleIcon className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
                                        <span className="text-xs text-amber-300">Motor reserve exceeds tank. Monitor fuel carefully.</span>
                                    </div>
                                )}
                            </>
                        ) : (
                            /* Power vessel */
                            <>
                                {fuelBurnRate > 0 ? (
                                    <>
                                        <div>
                                            <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Required (30% reserve)</div>
                                            <div className="text-xl font-bold text-white">
                                                {fuelWithReserve.toFixed(0)}<span className="text-xs font-normal text-gray-500 ml-1">L</span>
                                            </div>
                                        </div>
                                        <div className="text-xs text-gray-400 font-mono">
                                            {fuelBurnRate} L/hr × {motoringHours.toFixed(1)} hrs
                                        </div>
                                        {fuelCapacity > 0 && (
                                            <div className="pt-2 border-t border-white/10">
                                                <div className="flex justify-between text-xs">
                                                    <span className="text-gray-500">Tank Capacity</span>
                                                    <span className={`font-mono ${fuelSufficient ? 'text-emerald-400' : 'text-red-400'}`}>
                                                        {fuelCapacity}L {fuelSufficient ? '✓' : '✗'}
                                                    </span>
                                                </div>
                                            </div>
                                        )}
                                        {!fuelSufficient && (
                                            <div className="flex items-start gap-2 p-2 bg-red-500/10 rounded-lg">
                                                <AlertTriangleIcon className="w-3.5 h-3.5 text-red-400 mt-0.5 shrink-0" />
                                                <span className="text-xs text-red-300">Insufficient fuel! Plan a refueling stop.</span>
                                            </div>
                                        )}
                                    </>
                                ) : (
                                    <div className="text-xs text-gray-400 leading-relaxed">
                                        <p className="text-amber-300 font-medium mb-1">No burn rate configured</p>
                                        Set your fuel burn rate in <span className="text-white">Settings → Vessel Profile</span> for accurate consumption estimates.
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </div>

                {/* ═══ WATER ═══ */}
                <div className={`rounded-xl p-5 border ${!hasWaterInfo
                        ? 'bg-white/5 border-white/10'
                        : waterSufficient
                            ? 'bg-emerald-500/5 border-emerald-500/15'
                            : 'bg-amber-500/5 border-amber-500/15'
                    }`}>
                    <div className="flex items-center gap-2 mb-3">
                        <WaterIcon className={`w-4 h-4 ${!hasWaterInfo ? 'text-gray-400' : waterSufficient ? 'text-emerald-400' : 'text-amber-400'}`} />
                        <span className="text-xs font-bold uppercase tracking-widest text-gray-400">Water</span>
                    </div>

                    <div className="space-y-3">
                        <div>
                            <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Required</div>
                            <div className="text-xl font-bold text-white">
                                {waterRequired.toFixed(0)}<span className="text-xs font-normal text-gray-500 ml-1">L</span>
                            </div>
                        </div>

                        <div className="text-xs text-gray-400 font-mono">
                            {effectiveCrewCount} crew × {durationDays.toFixed(1)} days × 3L/day
                        </div>

                        {hasWaterInfo ? (
                            <div className="pt-2 border-t border-white/10">
                                <div className="flex justify-between text-xs">
                                    <span className="text-gray-500">Tank Capacity</span>
                                    <span className={`font-mono ${waterSufficient ? 'text-emerald-400' : 'text-amber-400'}`}>
                                        {waterCapacity}L {waterSufficient ? '✓' : '⚠'}
                                    </span>
                                </div>
                            </div>
                        ) : (
                            <div className="text-[10px] text-gray-500 italic">
                                Set water capacity in Settings for tank monitoring.
                            </div>
                        )}

                        {hasWaterInfo && !waterSufficient && (
                            <div className="flex items-start gap-2 p-2 bg-amber-500/10 rounded-lg">
                                <AlertTriangleIcon className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
                                <span className="text-xs text-amber-300">Low water capacity. Consider extra jerry cans.</span>
                            </div>
                        )}
                    </div>
                </div>

                {/* ═══ PROVISIONS ═══ */}
                <div className="rounded-xl p-5 border bg-cyan-500/5 border-cyan-500/15">
                    <div className="flex items-center gap-2 mb-3">
                        <FoodIcon className="w-4 h-4 text-cyan-400" />
                        <span className="text-xs font-bold uppercase tracking-widest text-gray-400">Provisions</span>
                    </div>

                    <div className="space-y-3">
                        <div>
                            <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Meals Required</div>
                            <div className="text-xl font-bold text-white">
                                {mealsRequired}<span className="text-xs font-normal text-gray-500 ml-1">meals</span>
                            </div>
                        </div>

                        <div className="pt-2 border-t border-white/10 space-y-1 text-xs text-gray-400">
                            <div>✓ {effectiveCrewCount} × breakfast × {Math.ceil(durationDays)}</div>
                            <div>✓ {effectiveCrewCount} × lunch × {Math.ceil(durationDays)}</div>
                            <div>✓ {effectiveCrewCount} × dinner × {Math.ceil(durationDays)}</div>
                            {durationDays >= 2 && <div>✓ 48hr emergency rations</div>}
                        </div>

                        <div className="flex items-start gap-2 p-2 bg-cyan-500/10 rounded-lg">
                            <span className="text-xs text-cyan-300">Don't forget snacks, caffeine, and seasickness meds!</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
