import React, { useState } from 'react';
import { VesselProfile, VoyagePlan } from '../../types';
import { FuelIcon, WaterIcon, FoodIcon, AlertTriangleIcon, GearIcon, WindIcon } from '../Icons';

/* ───────────────────────────────────────────────────────────
   Provisioning Standards (ISAF / maritime best-practice)
   ─────────────────────────────────────────────────────────── */
const WATER_DRINKING_L = 2.0; // litres/person/day — minimum
const WATER_COOKING_L = 1.0;  // litres/person/day
const WATER_HYGIENE_L = 0.5;  // litres/person/day (minimal ocean hygiene)
const WATER_TOTAL_L = WATER_DRINKING_L + WATER_COOKING_L + WATER_HYGIENE_L;
const WATER_EMERGENCY_DAYS = 2; // extra emergency water buffer

const CALORIES_PER_DAY = 3000; // active sailing
const SNACKS_PER_DAY = 2;

/* ───────────────────────────────────────────────────────────
   Meal Ideas (practical galley cooking — no oven required)
   ─────────────────────────────────────────────────────────── */
const BREAKFAST_IDEAS = [
    { name: 'Porridge with dried fruit & honey', emoji: '🥣', shelf: 'long' },
    { name: 'Granola & powdered milk', emoji: '🥣', shelf: 'long' },
    { name: 'Scrambled eggs (fresh/powdered)', emoji: '🍳', shelf: 'medium' },
    { name: 'Toast with PB & banana', emoji: '🍞', shelf: 'medium' },
    { name: 'Muesli bars & coffee', emoji: '☕', shelf: 'long' },
    { name: 'Pancakes (pre-mix + water)', emoji: '🥞', shelf: 'long' },
    { name: 'Baked beans on toast', emoji: '🫘', shelf: 'long' },
];

const LUNCH_IDEAS = [
    { name: 'Wraps with tuna & salad', emoji: '🌯', shelf: 'medium' },
    { name: 'Instant noodles + egg', emoji: '🍜', shelf: 'long' },
    { name: 'Canned soup & crusty bread', emoji: '🥫', shelf: 'long' },
    { name: 'Pasta salad (pre-made Day 1)', emoji: '🥗', shelf: 'short' },
    { name: 'Cheese & crackers + fruit', emoji: '🧀', shelf: 'medium' },
    { name: 'Couscous with canned chickpeas', emoji: '🥘', shelf: 'long' },
    { name: 'Pita bread with hummus & veg', emoji: '🥙', shelf: 'medium' },
];

const DINNER_IDEAS = [
    { name: 'One-pot pasta with sauce', emoji: '🍝', shelf: 'long' },
    { name: 'Curry (canned coconut + rice)', emoji: '🍛', shelf: 'long' },
    { name: 'Stir-fry with instant rice', emoji: '🍚', shelf: 'medium' },
    { name: 'Canned chilli with rice', emoji: '🌶️', shelf: 'long' },
    { name: 'Fish tacos (fresh catch!)', emoji: '🐟', shelf: 'n/a' },
    { name: 'Sausage & mash (instant)', emoji: '🌭', shelf: 'long' },
    { name: 'Risotto (parmesan + stock)', emoji: '🍚', shelf: 'long' },
];

const SNACK_IDEAS = [
    'Trail mix & nuts', 'Jerky / biltong', 'Dark chocolate',
    'Dried mango', 'Protein bars', 'Rice crackers',
    'Dried apricots', 'Peanut butter sachets', 'Corn chips & salsa',
];

const ESSENTIALS_CHECKLIST = [
    { item: 'Coffee / tea bags', emoji: '☕', critical: true },
    { item: 'Sugar & powdered milk', emoji: '🥛', critical: true },
    { item: 'Seasickness meds', emoji: '💊', critical: true },
    { item: 'Electrolyte sachets', emoji: '⚡', critical: true },
    { item: 'Sunscreen SPF 50+', emoji: '☀️', critical: false },
    { item: 'Cooking oil / spray', emoji: '🫒', critical: false },
    { item: 'Salt, pepper & spices', emoji: '🧂', critical: false },
    { item: 'Bin bags (galley waste)', emoji: '🗑️', critical: false },
    { item: 'Paper towels', emoji: '🧻', critical: false },
    { item: 'Dishwashing liquid', emoji: '🧼', critical: false },
];

interface ResourceCalculatorProps {
    voyagePlan: VoyagePlan;
    vessel: VesselProfile;
    crewCount?: number;
}

export const ResourceCalculator: React.FC<ResourceCalculatorProps> = ({ voyagePlan, vessel, crewCount }) => {
    const isObserver = vessel.type === 'observer';
    const isSail = vessel.type === 'sail';
    const isPower = vessel.type === 'power';
    const [showMealPlan, setShowMealPlan] = useState(false);

    // Parse distance
    const distanceNm = parseFloat(voyagePlan.distanceApprox.match(/(\d+\.?\d*)/)?.[0] || '0');

    // Parse duration
    const durationStr = voyagePlan.durationApprox.toLowerCase();
    let durationHours = 0;
    const dayMatch = durationStr.match(/(\d+\.?\d*)\s*day/);
    const hourMatch = durationStr.match(/(\d+\.?\d*)\s*h/);
    if (dayMatch) durationHours += parseFloat(dayMatch[1]) * 24;
    if (hourMatch) durationHours += parseFloat(hourMatch[1]);
    if (!dayMatch && !hourMatch) durationHours = parseFloat(durationStr.match(/(\d+\.?\d*)/)?.[0] || '0');
    const durationDays = Math.max(durationHours / 24, 0.5); // minimum half a day

    const effectiveCrewCount = crewCount || vessel.crewCount || 2;

    // ─── OBSERVER MODE ──────────────────────────────────────
    if (isObserver) {
        return (
            <div className="space-y-4">
                <div className="bg-sky-500/5 border border-sky-500/15 rounded-xl p-5">
                    <h4 className="text-xs text-sky-400 font-bold uppercase tracking-widest mb-3 flex items-center gap-2">
                        <GearIcon className="w-3.5 h-3.5" /> Passage Summary
                    </h4>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <div className="text-[11px] text-gray-500 uppercase tracking-widest mb-1">Distance</div>
                            <div className="text-lg font-bold text-white">{voyagePlan.distanceApprox}</div>
                        </div>
                        <div>
                            <div className="text-[11px] text-gray-500 uppercase tracking-widest mb-1">Duration</div>
                            <div className="text-lg font-bold text-white">{voyagePlan.durationApprox}</div>
                        </div>
                    </div>
                </div>
                <div className="flex items-start gap-3 p-4 bg-amber-500/5 border border-amber-500/15 rounded-xl">
                    <AlertTriangleIcon className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                    <div>
                        <h4 className="text-xs font-bold text-amber-300 mb-1">Observer Mode</h4>
                        <p className="text-xs text-gray-400 leading-relaxed">
                            Configure your vessel in <span className="text-white font-medium">Settings → Vessel Profile</span> to unlock
                            detailed resource planning.
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    // ─── CALCULATIONS ───────────────────────────────────────
    const fuelBurnRate = vessel.fuelBurn || 0;
    const fuelCapacity = vessel.fuelCapacity || 0;
    const waterCapacity = vessel.waterCapacity || 0;

    // Fuel
    const motoringFraction = isSail ? 0.15 : 1.0;
    const motoringHours = durationHours * motoringFraction;
    const fuelRequired = fuelBurnRate * motoringHours;
    const fuelWithReserve = fuelRequired * 1.3;
    const fuelSufficient = fuelCapacity >= fuelWithReserve || (isSail && fuelBurnRate === 0);

    // Water breakdown
    const provisionDays = Math.ceil(durationDays) + WATER_EMERGENCY_DAYS;
    const waterDrinking = effectiveCrewCount * provisionDays * WATER_DRINKING_L;
    const waterCooking = effectiveCrewCount * provisionDays * WATER_COOKING_L;
    const waterHygiene = effectiveCrewCount * provisionDays * WATER_HYGIENE_L;
    const waterTotal = waterDrinking + waterCooking + waterHygiene;
    const waterSufficient = waterCapacity >= waterTotal;
    const waterPercent = waterCapacity > 0 ? Math.min((waterTotal / waterCapacity) * 100, 100) : 0;

    // Provisions
    const totalDaysCeil = Math.ceil(durationDays);
    const breakfasts = effectiveCrewCount * totalDaysCeil;
    const lunches = effectiveCrewCount * totalDaysCeil;
    const dinners = effectiveCrewCount * totalDaysCeil;
    const totalMeals = breakfasts + lunches + dinners;
    const snackPacks = effectiveCrewCount * totalDaysCeil * SNACKS_PER_DAY;

    // Pick meal ideas for the trip (rotate based on day count)
    const pickMeals = (ideas: typeof BREAKFAST_IDEAS, count: number) => {
        const result = [];
        for (let i = 0; i < count && i < ideas.length; i++) {
            result.push(ideas[i % ideas.length]);
        }
        return result;
    };
    const bMeals = pickMeals(BREAKFAST_IDEAS, totalDaysCeil);
    const lMeals = pickMeals(LUNCH_IDEAS, totalDaysCeil);
    const dMeals = pickMeals(DINNER_IDEAS, totalDaysCeil);

    const hasFuelInfo = isPower ? fuelBurnRate > 0 && fuelCapacity > 0 : true;
    const missingCriticalInfo = isPower && !hasFuelInfo;

    return (
        <div className="space-y-5">
            {/* Missing info warning */}
            {missingCriticalInfo && (
                <div className="flex items-start gap-3 p-4 bg-amber-500/5 border border-amber-500/15 rounded-xl">
                    <AlertTriangleIcon className="w-5 h-5 text-amber-400 mt-0.5 shrink-0" />
                    <div>
                        <h4 className="text-sm font-bold text-amber-300 mb-1">Vessel Profile Incomplete</h4>
                        <p className="text-xs text-gray-400 leading-relaxed">
                            Fuel burn rate and tank capacity needed for accurate planning. Update in{' '}
                            <span className="text-white font-medium">Settings → Vessel Profile</span>.
                        </p>
                    </div>
                </div>
            )}

            {/* ═══════════════════════════════════════════════════
                CREW & VOYAGE SUMMARY HERO
                ═══════════════════════════════════════════════════ */}
            <div className="bg-gradient-to-br from-sky-500/10 via-sky-600/5 to-indigo-500/10 border border-sky-500/20 rounded-2xl p-5 relative overflow-hidden">
                <div className="absolute top-0 right-0 w-32 h-32 bg-sky-400/5 rounded-full -translate-y-8 translate-x-8 blur-2xl" />
                <div className="relative z-10 flex items-center gap-4 flex-wrap">
                    <div className="flex items-center gap-3 bg-white/5 rounded-xl px-4 py-3 border border-white/10">
                        <span className="text-2xl">👥</span>
                        <div>
                            <div className="text-2xl font-black text-white">{effectiveCrewCount}</div>
                            <div className="text-[11px] text-gray-400 uppercase tracking-widest font-bold">Crew</div>
                        </div>
                    </div>
                    <div className="flex items-center gap-3 bg-white/5 rounded-xl px-4 py-3 border border-white/10">
                        <span className="text-2xl">📅</span>
                        <div>
                            <div className="text-2xl font-black text-white">{totalDaysCeil}</div>
                            <div className="text-[11px] text-gray-400 uppercase tracking-widest font-bold">
                                Day{totalDaysCeil > 1 ? 's' : ''}
                            </div>
                        </div>
                    </div>
                    <div className="flex items-center gap-3 bg-white/5 rounded-xl px-4 py-3 border border-white/10">
                        <span className="text-2xl">🍽️</span>
                        <div>
                            <div className="text-2xl font-black text-white">{totalMeals}</div>
                            <div className="text-[11px] text-gray-400 uppercase tracking-widest font-bold">Meals</div>
                        </div>
                    </div>
                    <div className="flex items-center gap-3 bg-white/5 rounded-xl px-4 py-3 border border-white/10">
                        <span className="text-2xl">💧</span>
                        <div>
                            <div className="text-2xl font-black text-white">{waterTotal.toFixed(0)}<span className="text-sm text-gray-400 ml-0.5">L</span></div>
                            <div className="text-[11px] text-gray-400 uppercase tracking-widest font-bold">Water</div>
                        </div>
                    </div>
                </div>
            </div>

            {/* ═══════════════════════════════════════════════════
                THREE RESOURCE CARDS
                ═══════════════════════════════════════════════════ */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

                {/* ─── FUEL / MOTOR RESERVE ─── */}
                <div className={`rounded-xl p-5 border ${
                    isSail && fuelBurnRate === 0
                        ? 'bg-sky-500/5 border-sky-500/15'
                        : fuelSufficient
                          ? 'bg-emerald-500/5 border-emerald-500/15'
                          : 'bg-red-500/5 border-red-500/15'
                }`}>
                    <div className="flex items-center gap-2 mb-3">
                        <FuelIcon className={`w-4 h-4 ${
                            isSail && fuelBurnRate === 0 ? 'text-sky-400'
                            : fuelSufficient ? 'text-emerald-400' : 'text-red-400'
                        }`} />
                        <span className="text-xs font-bold uppercase tracking-widest text-gray-400">
                            {isSail ? 'Motor Reserve' : 'Fuel'}
                        </span>
                    </div>
                    <div className="space-y-3">
                        {isSail && fuelBurnRate === 0 ? (
                            <>
                                <div className="text-sm text-sky-300 font-medium">Wind Powered ⛵</div>
                                <p className="text-xs text-gray-400 leading-relaxed">
                                    Depart with full tanks. Auxiliary needed ~15% of passage (calms, docking, charging).
                                </p>
                                {fuelCapacity > 0 && (
                                    <div className="pt-2 border-t border-white/10 text-sm font-mono text-gray-300">
                                        {fuelCapacity} L — depart full
                                    </div>
                                )}
                            </>
                        ) : (
                            <>
                                <div>
                                    <div className="text-[11px] text-gray-500 uppercase tracking-widest mb-1">
                                        {isSail ? 'Motor Reserve (30% buffer)' : 'Required (30% reserve)'}
                                    </div>
                                    <div className="text-xl font-bold text-white">
                                        {fuelWithReserve.toFixed(0)}
                                        <span className="text-xs font-normal text-gray-500 ml-1">L</span>
                                    </div>
                                </div>
                                <div className="text-xs text-gray-400 font-mono">
                                    {fuelBurnRate} L/hr × {motoringHours.toFixed(1)} hrs
                                    {isSail && <span className="text-sky-400"> (~15% motoring)</span>}
                                </div>
                                {fuelCapacity > 0 && (
                                    <div className="pt-2 border-t border-white/10 flex justify-between text-xs">
                                        <span className="text-gray-500">Tank</span>
                                        <span className={`font-mono ${fuelSufficient ? 'text-emerald-400' : 'text-red-400'}`}>
                                            {fuelCapacity}L {fuelSufficient ? '✓' : '✗'}
                                        </span>
                                    </div>
                                )}
                                {!fuelSufficient && (
                                    <div className="flex items-start gap-2 p-2 bg-red-500/10 rounded-lg">
                                        <AlertTriangleIcon className="w-3.5 h-3.5 text-red-400 mt-0.5 shrink-0" />
                                        <span className="text-xs text-red-300">
                                            {isPower ? 'Insufficient fuel! Plan a refueling stop.' : 'Monitor fuel carefully.'}
                                        </span>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </div>

                {/* ─── WATER (detailed breakdown) ─── */}
                <div className={`rounded-xl p-5 border ${
                    waterCapacity === 0
                        ? 'bg-white/5 border-white/10'
                        : waterSufficient
                          ? 'bg-emerald-500/5 border-emerald-500/15'
                          : 'bg-amber-500/5 border-amber-500/15'
                }`}>
                    <div className="flex items-center gap-2 mb-3">
                        <WaterIcon className={`w-4 h-4 ${
                            waterCapacity === 0 ? 'text-gray-400'
                            : waterSufficient ? 'text-emerald-400' : 'text-amber-400'
                        }`} />
                        <span className="text-xs font-bold uppercase tracking-widest text-gray-400">Water</span>
                    </div>
                    <div className="space-y-3">
                        <div>
                            <div className="text-[11px] text-gray-500 uppercase tracking-widest mb-1">
                                Total Required ({provisionDays} days incl. {WATER_EMERGENCY_DAYS}d emergency)
                            </div>
                            <div className="text-xl font-bold text-white">
                                {waterTotal.toFixed(0)}
                                <span className="text-xs font-normal text-gray-500 ml-1">L</span>
                            </div>
                        </div>

                        {/* Breakdown bar */}
                        <div className="space-y-1.5">
                            <div className="flex items-center gap-2 text-xs">
                                <div className="w-3 h-3 rounded-sm bg-sky-400" />
                                <span className="text-gray-400">Drinking</span>
                                <span className="ml-auto font-mono text-gray-300">{waterDrinking.toFixed(0)}L</span>
                            </div>
                            <div className="flex items-center gap-2 text-xs">
                                <div className="w-3 h-3 rounded-sm bg-sky-600" />
                                <span className="text-gray-400">Cooking</span>
                                <span className="ml-auto font-mono text-gray-300">{waterCooking.toFixed(0)}L</span>
                            </div>
                            <div className="flex items-center gap-2 text-xs">
                                <div className="w-3 h-3 rounded-sm bg-sky-800" />
                                <span className="text-gray-400">Hygiene</span>
                                <span className="ml-auto font-mono text-gray-300">{waterHygiene.toFixed(0)}L</span>
                            </div>
                        </div>

                        {/* Visual bar */}
                        {waterCapacity > 0 && (
                            <div className="pt-2 border-t border-white/10 space-y-1.5">
                                <div className="flex justify-between text-xs">
                                    <span className="text-gray-500">Tank: {waterCapacity}L</span>
                                    <span className={`font-mono font-bold ${waterSufficient ? 'text-emerald-400' : 'text-amber-400'}`}>
                                        {Math.round(waterPercent)}% used
                                    </span>
                                </div>
                                <div className="w-full h-2 bg-white/10 rounded-full overflow-hidden">
                                    <div
                                        className={`h-full rounded-full transition-all duration-700 ${
                                            waterSufficient
                                                ? 'bg-gradient-to-r from-sky-400 to-emerald-400'
                                                : 'bg-gradient-to-r from-amber-400 to-red-400'
                                        }`}
                                        style={{ width: `${Math.min(waterPercent, 100)}%` }}
                                    />
                                </div>
                            </div>
                        )}

                        {waterCapacity > 0 && !waterSufficient && (
                            <div className="flex items-start gap-2 p-2 bg-amber-500/10 rounded-lg">
                                <AlertTriangleIcon className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
                                <span className="text-xs text-amber-300">
                                    Tank insufficient! Carry {Math.ceil(waterTotal - waterCapacity)}L in jerry cans.
                                </span>
                            </div>
                        )}

                        <div className="text-[11px] text-gray-500 font-mono">
                            {effectiveCrewCount} crew × {WATER_TOTAL_L}L/day × {provisionDays} days
                        </div>
                    </div>
                </div>

                {/* ─── PROVISIONS SUMMARY ─── */}
                <div className="rounded-xl p-5 border bg-gradient-to-b from-amber-500/5 to-orange-500/5 border-amber-500/15">
                    <div className="flex items-center gap-2 mb-3">
                        <FoodIcon className="w-4 h-4 text-amber-400" />
                        <span className="text-xs font-bold uppercase tracking-widest text-gray-400">Provisions</span>
                    </div>
                    <div className="space-y-3">
                        <div className="grid grid-cols-3 gap-2">
                            <div className="text-center bg-white/5 rounded-lg py-2 border border-white/5">
                                <div className="text-lg font-black text-white">{breakfasts}</div>
                                <div className="text-[11px] text-gray-500 uppercase tracking-widest font-bold">Brekky</div>
                            </div>
                            <div className="text-center bg-white/5 rounded-lg py-2 border border-white/5">
                                <div className="text-lg font-black text-white">{lunches}</div>
                                <div className="text-[11px] text-gray-500 uppercase tracking-widest font-bold">Lunch</div>
                            </div>
                            <div className="text-center bg-white/5 rounded-lg py-2 border border-white/5">
                                <div className="text-lg font-black text-white">{dinners}</div>
                                <div className="text-[11px] text-gray-500 uppercase tracking-widest font-bold">Dinner</div>
                            </div>
                        </div>

                        <div className="flex items-center justify-between text-xs bg-white/5 rounded-lg px-3 py-2 border border-white/5">
                            <span className="text-gray-400">🍫 Snack packs</span>
                            <span className="font-bold text-amber-300">{snackPacks}</span>
                        </div>

                        {durationDays >= 2 && (
                            <div className="flex items-start gap-2 p-2 bg-emerald-500/10 rounded-lg border border-emerald-500/15">
                                <span className="text-xs text-emerald-300">
                                    🆘 Pack 48hr emergency rations (freeze-dried or energy bars) per crew member.
                                </span>
                            </div>
                        )}

                        {/* Meal plan toggle */}
                        <button
                            onClick={() => setShowMealPlan(!showMealPlan)}
                            className="w-full py-2.5 px-4 bg-gradient-to-r from-amber-500/20 to-orange-500/20 hover:from-amber-500/30 hover:to-orange-500/30 border border-amber-500/30 rounded-xl text-xs font-bold uppercase tracking-widest text-amber-300 transition-all active:scale-[0.98] flex items-center justify-center gap-2"
                        >
                            🍳 {showMealPlan ? 'Hide' : 'Show'} Meal Ideas
                            <span className="text-[11px] text-amber-400/60 font-normal normal-case">
                                ({totalDaysCeil} day plan)
                            </span>
                        </button>
                    </div>
                </div>
            </div>

            {/* ═══════════════════════════════════════════════════
                MEAL PLAN (expanded)
                ═══════════════════════════════════════════════════ */}
            {showMealPlan && (
                <div className="animate-in fade-in slide-in-from-top-4 duration-300 space-y-4">
                    <div className="bg-gradient-to-br from-amber-500/5 via-orange-500/5 to-red-500/5 border border-amber-500/20 rounded-2xl p-5 relative overflow-hidden">
                        <div className="absolute bottom-0 right-0 w-40 h-40 bg-orange-400/5 rounded-full translate-y-12 translate-x-12 blur-3xl" />
                        <h3 className="text-sm font-bold text-amber-300 uppercase tracking-widest mb-4 flex items-center gap-2">
                            🍳 Suggested Meal Plan
                            <span className="text-[11px] text-gray-500 font-normal normal-case ml-auto">
                                {effectiveCrewCount} crew • {totalDaysCeil} day{totalDaysCeil > 1 ? 's' : ''}
                            </span>
                        </h3>

                        <div className="space-y-4 relative z-10">
                            {Array.from({ length: totalDaysCeil }, (_, dayIdx) => (
                                <div key={dayIdx} className="bg-white/5 rounded-xl p-4 border border-white/5 space-y-2.5">
                                    <div className="text-xs font-bold text-white uppercase tracking-widest flex items-center gap-2">
                                        <span className="w-6 h-6 bg-amber-500/20 rounded-full flex items-center justify-center text-amber-400 text-[11px] font-black border border-amber-500/30">
                                            {dayIdx + 1}
                                        </span>
                                        Day {dayIdx + 1}
                                        {dayIdx === 0 && <span className="text-[11px] text-emerald-400 font-normal ml-1">(use fresh first)</span>}
                                    </div>

                                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                        {/* Breakfast */}
                                        <div className="bg-black/20 rounded-lg px-3 py-2 space-y-1">
                                            <div className="text-[11px] text-gray-500 uppercase tracking-widest font-bold">Breakfast</div>
                                            <div className="text-xs text-gray-200 flex items-center gap-1.5">
                                                <span>{bMeals[dayIdx % bMeals.length].emoji}</span>
                                                {bMeals[dayIdx % bMeals.length].name}
                                            </div>
                                            <div className="text-[11px] text-gray-600">
                                                × {effectiveCrewCount} serves
                                            </div>
                                        </div>

                                        {/* Lunch */}
                                        <div className="bg-black/20 rounded-lg px-3 py-2 space-y-1">
                                            <div className="text-[11px] text-gray-500 uppercase tracking-widest font-bold">Lunch</div>
                                            <div className="text-xs text-gray-200 flex items-center gap-1.5">
                                                <span>{lMeals[dayIdx % lMeals.length].emoji}</span>
                                                {lMeals[dayIdx % lMeals.length].name}
                                            </div>
                                            <div className="text-[11px] text-gray-600">
                                                × {effectiveCrewCount} serves
                                            </div>
                                        </div>

                                        {/* Dinner */}
                                        <div className="bg-black/20 rounded-lg px-3 py-2 space-y-1">
                                            <div className="text-[11px] text-gray-500 uppercase tracking-widest font-bold">Dinner</div>
                                            <div className="text-xs text-gray-200 flex items-center gap-1.5">
                                                <span>{dMeals[dayIdx % dMeals.length].emoji}</span>
                                                {dMeals[dayIdx % dMeals.length].name}
                                            </div>
                                            <div className="text-[11px] text-gray-600">
                                                × {effectiveCrewCount} serves
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>

                        {/* Snack suggestions */}
                        <div className="mt-4 pt-4 border-t border-white/10">
                            <div className="text-[11px] text-gray-500 uppercase tracking-widest font-bold mb-2">
                                🍫 Snack Ideas (keep accessible in cockpit)
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                                {SNACK_IDEAS.map((snack, i) => (
                                    <span
                                        key={i}
                                        className="text-[11px] text-gray-300 bg-white/5 border border-white/5 rounded-full px-2.5 py-1 hover:bg-amber-500/10 hover:border-amber-500/20 hover:text-amber-200 transition-colors cursor-default"
                                    >
                                        {snack}
                                    </span>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* ═══════════════════════════════════════════════════
                GALLEY ESSENTIALS CHECKLIST
                ═══════════════════════════════════════════════════ */}
            <div className="bg-white/5 border border-white/10 rounded-xl p-5">
                <h4 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3 flex items-center gap-2">
                    ☕ Galley Essentials
                </h4>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
                    {ESSENTIALS_CHECKLIST.map((item, i) => (
                        <div
                            key={i}
                            className={`flex items-center gap-2 text-xs px-3 py-2 rounded-lg border transition-colors ${
                                item.critical
                                    ? 'bg-amber-500/5 border-amber-500/15 text-amber-200'
                                    : 'bg-white/5 border-white/5 text-gray-300'
                            }`}
                        >
                            <span>{item.emoji}</span>
                            <span className="truncate">{item.item}</span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};
