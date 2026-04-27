/**
 * MealCalendar — Multi-day meal calendar grid with recipe picker.
 *
 * Renders a day-by-day grid of breakfast/lunch/dinner slots.
 * Includes SlotPicker for recipe search, Provision Passage CTA,
 * crew stepper, and copy/move context menu.
 */
import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
    scheduleMeal,
    unscheduleMeal,
    getStoresAvailability,
    type MealPlan,
    type MealSlot,
    type MealDayInfo,
} from '../../services/MealPlanService';
import {
    scaleIngredient,
    searchRecipes,
    getGalleyDifficulty,
    type GalleyMeal,
} from '../../services/GalleyRecipeService';
import { type ShoppingListSummary, getShoppingList } from '../../services/ShoppingListService';
import { triggerHaptic } from '../../utils/system';
import { ChefPlate } from './ChefPlate';
import { CustomRecipeForm } from './CustomRecipeForm';
import { SLOT_CONFIG, STRIP_WORDS } from './galleyTokens';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('MealCalendar');

export interface MealCalendarProps {
    mealDays: MealDayInfo | null;
    crewCount: number;
    voyageId: string | null;
    voyageName: string | null;
    activeMeals: MealPlan[];
    onMealsChanged: () => void;
    cookingMealId: string | null;
    onCookNow: (meal: MealPlan) => void;
    shoppingSummary: ShoppingListSummary | null;
    onCrewCountChange?: (n: number) => void;
    onShoppingChanged?: () => void;
}

export const MealCalendar: React.FC<MealCalendarProps> = ({
    mealDays,
    crewCount,
    voyageId,
    voyageName,
    activeMeals,
    onMealsChanged,
    cookingMealId,
    onCookNow,
    shoppingSummary,
    onCrewCountChange,
    onShoppingChanged,
}) => {
    const [slotPicker, setSlotPicker] = useState<{ date: string; slot: MealSlot } | null>(null);
    const [expandedMeal, setExpandedMeal] = useState<string | null>(null);

    // Context menu for meal card actions (copy/move)
    const [contextMenu, setContextMenu] = useState<{ meal: MealPlan; action: 'copy' | 'move' } | null>(null);
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // ── Delete meal ──
    const handleDeleteMeal = useCallback(
        async (meal: MealPlan, e: React.MouseEvent) => {
            e.stopPropagation();
            await unscheduleMeal(meal.id);
            triggerHaptic('medium');
            onMealsChanged();
            // Dispatch stores-changed so stores UI updates
            window.dispatchEvent(new CustomEvent('thalassa:stores-changed'));
        },
        [onMealsChanged],
    );

    // ── Copy/Move meal to target date ──
    const handleCopyToDate = useCallback(
        async (targetDate: string) => {
            if (!contextMenu || !voyageId) return;
            const meal = contextMenu.meal;
            const isMove = contextMenu.action === 'move';

            // Construct GalleyMeal from MealPlan for scheduleMeal
            const galleyMeal: GalleyMeal = {
                id: meal.spoonacular_id || Date.now(),
                title: meal.title,
                readyInMinutes: 30,
                servings: meal.servings_planned,
                image: '',
                sourceUrl: '',
                ingredients: meal.ingredients,
            };

            await scheduleMeal(galleyMeal, targetDate, meal.meal_slot, voyageId, meal.servings_planned);

            // If move, delete original
            if (isMove) {
                await unscheduleMeal(meal.id);
            }

            triggerHaptic('medium');
            setContextMenu(null);
            onMealsChanged();
            window.dispatchEvent(new CustomEvent('thalassa:stores-changed'));
        },
        [contextMenu, voyageId, onMealsChanged],
    );

    // Long-press handlers
    const startLongPress = useCallback((meal: MealPlan) => {
        longPressTimer.current = setTimeout(() => {
            triggerHaptic('heavy');
            setContextMenu({ meal, action: 'copy' });
        }, 500);
    }, []);
    const cancelLongPress = useCallback(() => {
        if (longPressTimer.current) {
            clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
        }
    }, []);

    // Force re-render when stores change (e.g. after shopping/purchasing)
    const [storesVersion, setStoresVersion] = useState(0);
    useEffect(() => {
        const handler = () => setStoresVersion((v) => v + 1);
        window.addEventListener('thalassa:stores-changed', handler);
        return () => window.removeEventListener('thalassa:stores-changed', handler);
    }, []);

    // ── Shared shortfall computation ──
    // Single source of truth for what needs to go on the shopping list.
    // Used by both the CTA badge count AND the add-to-list handler.
    // Memoised so the inner loop runs once per relevant change instead of
    // 2× per render (badge count + expanded ChefPlate aggregate set).
    const shortfalls = useMemo(() => {
        void storesVersion; // reactive dep — re-compute when stores change
        if (!mealDays || activeMeals.length === 0) return [];

        const storesAvail = getStoresAvailability();

        // Build map of quantities already on the shopping list (unpurchased)
        const shoppingNow = getShoppingList();
        const onListQty = new Map<string, number>();
        for (const zone of shoppingNow.zones) {
            for (const item of zone.items) {
                if (!item.purchased) {
                    const key = item.ingredient_name.toLowerCase();
                    onListQty.set(key, (onListQty.get(key) || 0) + item.required_qty);
                }
            }
        }

        const fuzzyMatch = (name: string) => {
            const lower = name.toLowerCase().trim();
            const exact = storesAvail.find((s) => s.item_name.toLowerCase() === lower);
            if (exact) return exact;
            const core = lower
                .split(/\s+/)
                .filter((w) => !STRIP_WORDS.has(w) && w.length > 2)
                .join(' ');
            if (!core) return undefined;
            return storesAvail.find((s) => {
                const sl = s.item_name.toLowerCase();
                return sl.includes(core) || core.includes(sl);
            });
        };

        // Aggregate all ingredients across all scheduled meals
        const needs = new Map<string, { qty: number; unit: string; name: string }>();
        for (const meal of activeMeals) {
            const servings = meal.servings_planned || crewCount;
            for (const ing of meal.ingredients || []) {
                const scaled = scaleIngredient(ing.amount, ing.scalable, ing.amount, servings, ing.unit);
                const key = ing.name.toLowerCase();
                const prev = needs.get(key);
                if (prev) {
                    prev.qty += scaled;
                } else {
                    needs.set(key, { qty: scaled, unit: ing.unit, name: ing.name });
                }
            }
        }

        // Calculate remaining shortfall for each ingredient
        const out: { name: string; qty: number; unit: string }[] = [];
        for (const [key, need] of needs) {
            const store = fuzzyMatch(need.name);
            // Use on_hand (not available) — available subtracts reservations from
            // these same meals, which we're already counting in `needs`.
            const inStores = store ? store.on_hand : 0;
            const onList = onListQty.get(key) || 0;
            const remaining = Math.round((need.qty - inStores - onList) * 10) / 10;
            if (remaining > 0) {
                out.push({ name: need.name, qty: remaining, unit: need.unit });
            }
        }
        return out;
    }, [mealDays, activeMeals, crewCount, storesVersion]);

    const shortfallCount = shortfalls.length;
    const aggregateShortfallNames = useMemo(() => new Set(shortfalls.map((s) => s.name.toLowerCase())), [shortfalls]);

    // ── Add to Shopping List: aggregate all shortfalls at once ──
    const [provisioning, setProvisioning] = useState(false);
    const [lastAddedCount, setLastAddedCount] = useState<number | null>(null);

    // Reset success state when meals change (new meal added/removed)
    useEffect(() => {
        setLastAddedCount(null);
    }, [activeMeals]);

    const handleAddToShoppingList = useCallback(async () => {
        if (!mealDays || activeMeals.length === 0) return;
        setProvisioning(true);
        setLastAddedCount(null);
        try {
            const { addManualItem } = await import('../../services/ShoppingListService');

            let added = 0;
            for (const sf of shortfalls) {
                await addManualItem({
                    name: sf.name,
                    qty: sf.qty,
                    unit: sf.unit,
                    notes: 'Passage provision',
                });
                added++;
            }

            triggerHaptic('medium');
            window.dispatchEvent(new CustomEvent('thalassa:stores-changed'));
            onShoppingChanged?.();
            setLastAddedCount(added);
            // Success state persists until activeMeals changes (new meal added/removed)
        } catch (e) {
            log.error('Add to shopping list error:', e);
        }
        setProvisioning(false);
    }, [mealDays, activeMeals, onShoppingChanged, shortfalls]);

    // No dates set — prompt user
    if (!mealDays) {
        return (
            <div className="p-6 text-center">
                <span className="text-4xl">📅</span>
                <p className="text-sm font-bold text-white mt-3">Set Voyage Dates</p>
                <p className="text-[11px] text-gray-500 mt-1 leading-relaxed">
                    Add departure and arrival dates to your passage plan to unlock the meal calendar.
                </p>
                <div className="mt-3 px-4">
                    <div className="flex items-center gap-3 p-3 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                        <span className="text-base">🧭</span>
                        <p className="text-[11px] text-gray-400 text-left">
                            Go to Vessel Hub → select your passage → set departure {'&'} ETA dates
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    // Build a map of existing meals by date+slot for quick lookup
    const mealMap = new Map<string, MealPlan>();
    for (const m of activeMeals) {
        mealMap.set(`${m.planned_date}_${m.meal_slot}`, m);
    }

    return (
        <div className="p-3 space-y-1" role="grid" aria-label="Meal calendar">
            {/* Calendar header */}
            <div className="flex items-center justify-between px-1 pb-2">
                <div>
                    <p className="text-[11px] text-gray-500 uppercase tracking-widest font-bold">
                        {voyageName || 'Passage'} · {mealDays.passageDays}d + {mealDays.emergencyDays}d buffer
                    </p>
                </div>
                <div className="flex items-center gap-1.5">
                    {/* Crew count stepper */}
                    <div
                        className="flex items-center gap-0.5 rounded-full bg-sky-500/10 border border-sky-500/20 px-1 py-0.5"
                        role="group"
                        aria-label="Crew count"
                    >
                        <button
                            onClick={() => onCrewCountChange?.(crewCount - 1)}
                            disabled={crewCount <= 1}
                            className="w-5 h-5 rounded-full flex items-center justify-center text-sky-400 text-xs font-bold hover:bg-sky-500/20 disabled:opacity-30 active:scale-90 transition-all"
                            aria-label="Decrease crew count"
                        >
                            −
                        </button>
                        <span
                            className="text-[11px] font-bold text-sky-400 min-w-[28px] text-center"
                            aria-live="polite"
                        >
                            👥 {crewCount}
                        </span>
                        <button
                            onClick={() => onCrewCountChange?.(crewCount + 1)}
                            disabled={crewCount >= 20}
                            className="w-5 h-5 rounded-full flex items-center justify-center text-sky-400 text-xs font-bold hover:bg-sky-500/20 disabled:opacity-30 active:scale-90 transition-all"
                            aria-label="Increase crew count"
                        >
                            +
                        </button>
                    </div>
                </div>
            </div>

            {/* Add to Shopping List CTA */}
            {activeMeals.length > 0 &&
                (lastAddedCount !== null ? (
                    /* Success state — auto-resets after 3s */
                    <div className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-emerald-500/15 border border-emerald-500/25 text-emerald-400 text-xs font-bold mb-1 transition-all">
                        ✅{' '}
                        {lastAddedCount > 0
                            ? `${lastAddedCount} item${lastAddedCount !== 1 ? 's' : ''} added to shopping list`
                            : 'Fully stocked — nothing to add'}
                    </div>
                ) : (
                    <button
                        onClick={handleAddToShoppingList}
                        disabled={provisioning || shortfallCount === 0}
                        className={`w-full flex items-center justify-center gap-3 py-2.5 rounded-xl text-xs font-bold active:scale-[0.98] disabled:opacity-50 transition-all mb-1 ${
                            shortfallCount === 0
                                ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400/60'
                                : 'bg-emerald-500/15 border border-emerald-500/25 text-emerald-400'
                        }`}
                        aria-label={
                            shortfallCount > 0
                                ? `Add ${shortfallCount} items to shopping list`
                                : 'All items fully stocked'
                        }
                    >
                        {provisioning ? (
                            <div className="w-3.5 h-3.5 border-2 border-emerald-400/30 border-t-emerald-400 rounded-full animate-spin" />
                        ) : (
                            '🛒'
                        )}
                        {provisioning
                            ? 'Adding to list…'
                            : shortfallCount > 0
                              ? `Add All ${shortfallCount} Missing Item${shortfallCount !== 1 ? 's' : ''} to Shopping List`
                              : '✅ Fully Stocked'}
                    </button>
                ))}

            {/* Day rows */}
            {mealDays.dates.map((date, dayIdx) => {
                const isEmergency = mealDays.emergencyDates.has(date);
                const dayLabel = `Day ${dayIdx + 1}`;
                const dateLabel = new Date(date + 'T12:00:00Z').toLocaleDateString(undefined, {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                });

                return (
                    <div
                        key={date}
                        className={`rounded-xl border p-2 transition-all ${
                            isEmergency
                                ? 'border-amber-500/25 border-dashed bg-amber-500/[0.03]'
                                : 'border-white/[0.06] bg-white/[0.02]'
                        }`}
                        role="row"
                        aria-label={`${dayLabel} — ${dateLabel}${isEmergency ? ' (buffer day)' : ''}`}
                    >
                        {/* Day label */}
                        <div className="flex items-center gap-2 px-1 pb-1.5">
                            <span
                                className={`text-[11px] font-black uppercase tracking-widest ${isEmergency ? 'text-amber-400' : 'text-gray-500'}`}
                            >
                                {isEmergency ? '📦 ' : ''}
                                {dayLabel}
                            </span>
                            <span className="text-[11px] text-gray-500">{dateLabel}</span>
                            {isEmergency && (
                                <span className="ml-auto text-[11px] font-bold text-amber-400/60 uppercase tracking-wider">
                                    Buffer
                                </span>
                            )}
                        </div>

                        {/* 3-column slot grid */}
                        <div className="grid grid-cols-3 gap-1.5" role="gridcell">
                            {SLOT_CONFIG.map(({ slot, label, emoji }) => {
                                const meal = mealMap.get(`${date}_${slot}`);
                                const isExpanded = expandedMeal === meal?.id;

                                if (meal) {
                                    return (
                                        <div
                                            key={slot}
                                            className={`relative p-2 rounded-lg text-left transition-all select-none ${
                                                isExpanded
                                                    ? 'bg-amber-500/15 border border-amber-500/25'
                                                    : 'bg-white/[0.04] border border-white/[0.06] hover:bg-white/[0.08]'
                                            }`}
                                            onClick={() => setExpandedMeal(isExpanded ? null : meal.id)}
                                            onTouchStart={() => startLongPress(meal)}
                                            onTouchEnd={cancelLongPress}
                                            onTouchMove={cancelLongPress}
                                            role="button"
                                            aria-label={`${label}: ${meal.title}. Tap to ${isExpanded ? 'collapse' : 'expand'}`}
                                            aria-expanded={isExpanded}
                                            tabIndex={0}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter' || e.key === ' ') {
                                                    e.preventDefault();
                                                    setExpandedMeal(isExpanded ? null : meal.id);
                                                }
                                            }}
                                        >
                                            {/* ✕ Delete button */}
                                            <button
                                                onClick={(e) => handleDeleteMeal(meal, e)}
                                                className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-gray-600/90 text-white text-[11px] leading-none flex items-center justify-center z-10 active:scale-90 opacity-60 hover:opacity-100 transition-opacity"
                                                aria-label={`Remove ${meal.title}`}
                                            >
                                                ✕
                                            </button>
                                            <p className="text-[11px] text-gray-500 font-bold uppercase tracking-wider">
                                                {emoji} {label}
                                            </p>
                                            <p className="text-[11px] font-bold text-white truncate mt-0.5 pr-3">
                                                {meal.title.replace(
                                                    /^[\p{Emoji_Presentation}\p{Emoji}\uFE0F?\s]+/u,
                                                    '',
                                                )}
                                            </p>
                                            {(() => {
                                                const diff = getGalleyDifficulty(
                                                    meal.title,
                                                    undefined,
                                                    meal.ingredients?.length,
                                                );
                                                return (
                                                    <p
                                                        className={`text-[11px] font-bold mt-0.5 ${
                                                            diff.score <= 2
                                                                ? 'text-emerald-400/60'
                                                                : diff.score === 3
                                                                  ? 'text-amber-400/60'
                                                                  : diff.score === 4
                                                                    ? 'text-orange-400/70'
                                                                    : 'text-red-400/70'
                                                        }`}
                                                    >
                                                        {diff.emoji} {diff.label}
                                                    </p>
                                                );
                                            })()}
                                        </div>
                                    );
                                }

                                // Empty slot — "+" button
                                return (
                                    <button
                                        key={slot}
                                        onClick={() => {
                                            setSlotPicker({ date, slot });
                                            triggerHaptic('light');
                                        }}
                                        className="p-2 rounded-lg border border-dashed border-white/[0.08] hover:border-amber-500/30 hover:bg-amber-500/[0.04] transition-all flex flex-col items-center justify-center min-h-[48px] group"
                                        aria-label={`Add ${label} meal for ${dateLabel}`}
                                    >
                                        <span className="text-[11px] text-gray-500 font-bold uppercase tracking-wider group-hover:text-gray-400">
                                            {emoji} {label}
                                        </span>
                                        <span className="text-lg text-gray-500 group-hover:text-amber-400 transition-colors leading-none mt-0.5">
                                            +
                                        </span>
                                    </button>
                                );
                            })}
                        </div>

                        {/* Expanded ChefPlate for the selected meal in this day, regardless of slot */}
                        {expandedMeal &&
                            SLOT_CONFIG.some((s) => mealMap.get(`${date}_${s.slot}`)?.id === expandedMeal) &&
                            (() => {
                                const meal = activeMeals.find((m) => m.id === expandedMeal);
                                if (!meal) return null;
                                return (
                                    <div className="mt-2">
                                        <ChefPlate
                                            meal={meal}
                                            baseServings={meal.servings_planned || crewCount}
                                            cooking={cookingMealId === expandedMeal}
                                            onCook={() => onCookNow(meal)}
                                            shoppingSummary={shoppingSummary}
                                            aggregateShortfallNames={aggregateShortfallNames}
                                        />
                                    </div>
                                );
                            })()}
                    </div>
                );
            })}

            {slotPicker && (
                <SlotPicker
                    date={slotPicker.date}
                    slot={slotPicker.slot}
                    crewCount={crewCount}
                    voyageId={voyageId}
                    onScheduled={() => {
                        setSlotPicker(null);
                        onMealsChanged();
                    }}
                    onClose={() => setSlotPicker(null)}
                />
            )}

            {/* ── Copy/Move Context Menu ── */}
            {contextMenu &&
                mealDays &&
                createPortal(
                    <div
                        className="fixed inset-0 z-[9999] flex items-end justify-center bg-black/70"
                        onClick={() => setContextMenu(null)}
                    >
                        <div
                            className="w-full max-w-lg bg-slate-950 border-t border-amber-500/20 rounded-t-3xl shadow-2xl p-5 space-y-4"
                            onClick={(e) => e.stopPropagation()}
                            role="dialog"
                            aria-modal="true"
                            aria-label={`${contextMenu.action === 'copy' ? 'Copy' : 'Move'} ${contextMenu.meal.title}`}
                        >
                            {/* Header */}
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-xl bg-amber-500/15 border border-amber-500/25 flex items-center justify-center text-lg">
                                    {contextMenu.action === 'copy' ? '📋' : '↗️'}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-bold text-white truncate">{contextMenu.meal.title}</p>
                                    <p className="text-[11px] text-amber-400/70">
                                        {contextMenu.meal.planned_date} · {contextMenu.meal.meal_slot}
                                    </p>
                                </div>
                            </div>

                            {/* Action toggle */}
                            <div className="flex gap-2">
                                <button
                                    onClick={() => setContextMenu({ ...contextMenu, action: 'copy' })}
                                    className={`flex-1 py-2.5 rounded-xl text-sm font-bold transition-all ${
                                        contextMenu.action === 'copy'
                                            ? 'bg-amber-500/20 border border-amber-500/30 text-amber-400'
                                            : 'bg-white/[0.04] border border-white/[0.06] text-gray-400'
                                    }`}
                                >
                                    📋 Copy
                                </button>
                                <button
                                    onClick={() => setContextMenu({ ...contextMenu, action: 'move' })}
                                    className={`flex-1 py-2.5 rounded-xl text-sm font-bold transition-all ${
                                        contextMenu.action === 'move'
                                            ? 'bg-sky-500/20 border border-sky-500/30 text-sky-400'
                                            : 'bg-white/[0.04] border border-white/[0.06] text-gray-400'
                                    }`}
                                >
                                    ↗️ Move
                                </button>
                            </div>

                            {/* Day picker */}
                            <p className="text-[11px] text-gray-500 font-bold uppercase tracking-wider">
                                Select target day
                            </p>
                            <div className="max-h-[200px] overflow-y-auto space-y-1.5">
                                {mealDays.dates.map((date, idx) => {
                                    const isSource = date === contextMenu.meal.planned_date;
                                    const existing = mealMap.get(`${date}_${contextMenu.meal.meal_slot}`);
                                    const occupied = !!existing && existing.id !== contextMenu.meal.id;
                                    const dateLabel = new Date(date + 'T12:00:00Z').toLocaleDateString(undefined, {
                                        weekday: 'short',
                                        month: 'short',
                                        day: 'numeric',
                                    });
                                    return (
                                        <button
                                            key={date}
                                            onClick={() => handleCopyToDate(date)}
                                            disabled={isSource || occupied}
                                            className={`w-full flex items-center gap-3 p-3 rounded-xl border transition-all ${
                                                isSource
                                                    ? 'border-white/[0.06] bg-white/[0.02] opacity-40 cursor-not-allowed'
                                                    : occupied
                                                      ? 'border-red-500/10 bg-red-500/[0.03] opacity-50 cursor-not-allowed'
                                                      : 'border-white/[0.06] bg-white/[0.03] hover:bg-amber-500/10 hover:border-amber-500/20 active:scale-[0.98]'
                                            }`}
                                        >
                                            <span className="text-[11px] font-black text-gray-500 w-12">
                                                Day {idx + 1}
                                            </span>
                                            <span className="text-xs text-white flex-1 text-left">{dateLabel}</span>
                                            {isSource && <span className="text-[11px] text-gray-500">current</span>}
                                            {occupied && <span className="text-[11px] text-red-400">occupied</span>}
                                        </button>
                                    );
                                })}
                            </div>

                            {/* Cancel */}
                            <button
                                onClick={() => setContextMenu(null)}
                                className="w-full py-3 rounded-xl bg-white/[0.04] text-sm text-gray-400 font-medium"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>,
                    document.body,
                )}
        </div>
    );
};

// ── Slot Picker Modal ──
const SlotPicker: React.FC<{
    date: string;
    slot: MealSlot;
    crewCount: number;
    voyageId: string | null;
    onScheduled: () => void;
    onClose: () => void;
}> = ({ date, slot, crewCount, voyageId, onScheduled, onClose }) => {
    const [searchQuery, setSearchQuery] = useState('');
    const [results, setResults] = useState<GalleyMeal[]>([]);
    const [searching, setSearching] = useState(false);
    const [scheduling, setScheduling] = useState(false);
    const [customName, setCustomName] = useState('');
    const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
    const customInputRef = useRef<HTMLInputElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const [keyboardOpen, setKeyboardOpen] = useState(false);
    const [showRecipeForm, setShowRecipeForm] = useState(false);
    const [brokenImageIds, setBrokenImageIds] = useState<Set<string | number>>(new Set());

    // ── Keyboard tracking for iOS ──
    useEffect(() => {
        let cleanup: (() => void) | undefined;

        // Use Capacitor keyboard events if available
        import('@capacitor/keyboard')
            .then(({ Keyboard }) => {
                const showHandle = Keyboard.addListener('keyboardDidShow', () => {
                    setKeyboardOpen(true);
                });
                const hideHandle = Keyboard.addListener('keyboardWillHide', () => {
                    setKeyboardOpen(false);
                });
                cleanup = () => {
                    showHandle.then((h) => h.remove());
                    hideHandle.then((h) => h.remove());
                };
            })
            .catch(() => {
                // Web fallback: use visualViewport
                const vp = window.visualViewport;
                if (vp) {
                    const handler = () => {
                        setKeyboardOpen(vp.height < window.innerHeight - 150);
                    };
                    vp.addEventListener('resize', handler);
                    cleanup = () => vp.removeEventListener('resize', handler);
                }
            });

        return () => cleanup?.();
    }, []);

    const slotLabel = SLOT_CONFIG.find((s) => s.slot === slot);
    const dateLabel = new Date(date + 'T12:00:00Z').toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
    });

    // Debounced search
    const handleSearch = useCallback(
        (q: string) => {
            setSearchQuery(q);
            if (searchTimeout.current) clearTimeout(searchTimeout.current);
            if (!q.trim()) {
                setResults([]);
                return;
            }
            searchTimeout.current = setTimeout(async () => {
                setSearching(true);
                const r = await searchRecipes(q, slot === 'breakfast' ? 'breakfast' : undefined);
                setResults(r);
                setSearching(false);
            }, 400);
        },
        [slot],
    );

    const handleSelectRecipe = async (meal: GalleyMeal) => {
        setScheduling(true);
        try {
            await scheduleMeal(meal, date, slot, voyageId, crewCount);
            triggerHaptic('medium');
            onScheduled();
        } catch (e) {
            log.warn('Failed to schedule recipe:', e);
        }
        setScheduling(false);
    };

    const handleCustomMeal = async () => {
        if (!customName.trim()) return;
        setScheduling(true);
        try {
            const meal: GalleyMeal = {
                id: Date.now(),
                title: customName.trim(),
                readyInMinutes: 45,
                servings: crewCount,
                image: '',
                sourceUrl: '',
                ingredients: [],
            };
            await scheduleMeal(meal, date, slot, voyageId, crewCount);
            triggerHaptic('medium');
            onScheduled();
        } catch (e) {
            log.warn('Failed to add custom meal:', e);
        }
        setScheduling(false);
    };

    // Auto-scroll custom meal input into view when focused
    const handleCustomFocus = () => {
        setTimeout(() => {
            customInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 450); // Wait for keyboard animation
    };

    return (
        <>
            <div
                className={`fixed inset-0 z-[900] flex ${keyboardOpen ? 'items-start pt-[max(1rem,env(safe-area-inset-top))]' : 'items-center'} justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200`}
                onClick={onClose}
                role="dialog"
                aria-modal="true"
                aria-label={`Add ${slotLabel?.label} recipe for ${dateLabel}`}
            >
                <div
                    className={`w-[calc(100%-2rem)] max-w-lg bg-slate-900 border border-white/[0.1] rounded-3xl ${keyboardOpen ? 'max-h-[50vh]' : 'max-h-[80vh]'} flex flex-col shadow-2xl animate-in zoom-in-95 duration-200 transition-all`}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                        if (e.key === 'Escape') onClose();
                    }}
                >
                    {/* Header */}
                    <div className="flex items-center justify-between p-4 border-b border-white/[0.06]">
                        <div>
                            <p className="text-sm font-bold text-white">
                                {slotLabel?.emoji} {slotLabel?.label}
                            </p>
                            <p className="text-[11px] text-gray-500">{dateLabel}</p>
                        </div>
                        <button
                            onClick={onClose}
                            className="w-8 h-8 rounded-full bg-white/[0.06] flex items-center justify-center text-gray-400 hover:text-white transition-colors"
                            aria-label="Close recipe picker"
                        >
                            ✕
                        </button>
                    </div>

                    {/* Search */}
                    <div className="p-3">
                        <input
                            value={searchQuery}
                            onChange={(e) => handleSearch(e.target.value)}
                            placeholder="🔍 Search recipes…"
                            autoFocus
                            data-no-keyboard-scroll
                            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-amber-500/30"
                            aria-label="Search recipes"
                        />
                    </div>

                    {/* Results + Custom meal (all scrollable) */}
                    <div
                        ref={scrollContainerRef}
                        className="flex-1 overflow-y-auto px-3 pb-3 space-y-2"
                        role="listbox"
                        aria-label="Recipe results"
                    >
                        {/* Quick suggestions when search is empty */}
                        {!searchQuery && results.length === 0 && !searching && (
                            <div className="space-y-2 pb-2">
                                <p className="text-[11px] text-gray-500 font-bold uppercase tracking-wider px-1">
                                    💡 Suggestions for {slotLabel?.label || 'this meal'}
                                </p>
                                <div className="flex flex-wrap gap-1.5">
                                    {(slot === 'breakfast'
                                        ? [
                                              'Scrambled Eggs',
                                              'Pancakes',
                                              'Porridge',
                                              'French Toast',
                                              'Omelette',
                                              'Baked Beans on Toast',
                                              'Smoothie Bowl',
                                              'Eggs Benedict',
                                          ]
                                        : slot === 'lunch'
                                          ? [
                                                'Chicken Wrap',
                                                'Tuna Salad',
                                                'Fried Rice',
                                                'BLT Sandwich',
                                                'Soup',
                                                'Quesadilla',
                                                'Fish Tacos',
                                                'Pasta Salad',
                                            ]
                                          : [
                                                'Spaghetti Bolognese',
                                                'Grilled Chicken',
                                                'Beef Stew',
                                                'Fish Curry',
                                                'Stir Fry',
                                                'Lamb Chops',
                                                'Chilli Con Carne',
                                                'Pad Thai',
                                            ]
                                    ).map((suggestion) => (
                                        <button
                                            key={suggestion}
                                            onClick={() => {
                                                setSearchQuery(suggestion);
                                                handleSearch(suggestion);
                                            }}
                                            className="px-2.5 py-1.5 rounded-lg bg-amber-500/[0.06] border border-amber-500/15 text-[11px] text-amber-400/80 font-medium hover:bg-amber-500/15 hover:text-amber-300 transition-all active:scale-95"
                                        >
                                            {suggestion}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}

                        {searching && (
                            <p className="text-center text-[11px] text-gray-500 py-4">⏳ Searching recipes…</p>
                        )}

                        {results.map((meal) => (
                            <button
                                key={`${meal.source || 'spoon'}-${meal.id}`}
                                onClick={() => handleSelectRecipe(meal)}
                                disabled={scheduling}
                                className="w-full flex items-center gap-3 p-2.5 rounded-xl bg-white/[0.03] border border-white/[0.06] hover:bg-amber-500/[0.06] hover:border-amber-500/20 transition-all text-left disabled:opacity-40"
                                role="option"
                                aria-label={`${meal.title} — ${meal.readyInMinutes} minutes, ${meal.ingredients.length} ingredients`}
                            >
                                {meal.image && !brokenImageIds.has(meal.id) ? (
                                    <img
                                        src={meal.image}
                                        alt=""
                                        className="w-14 h-14 rounded-lg object-cover flex-shrink-0"
                                        loading="lazy"
                                        onError={() =>
                                            setBrokenImageIds((prev) => {
                                                const next = new Set(prev);
                                                next.add(meal.id);
                                                return next;
                                            })
                                        }
                                    />
                                ) : (
                                    <div className="w-14 h-14 rounded-lg bg-amber-500/10 flex items-center justify-center text-xl flex-shrink-0">
                                        🍽️
                                    </div>
                                )}
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-1.5">
                                        <p className="text-xs font-bold text-white truncate">{meal.title}</p>
                                        {meal.source === 'private' && (
                                            <span className="shrink-0 px-1.5 py-0.5 rounded text-[11px] font-bold bg-amber-500/15 text-amber-400 border border-amber-500/20">
                                                🔒 MINE
                                            </span>
                                        )}
                                        {meal.source === 'community' && (
                                            <span className="shrink-0 px-1.5 py-0.5 rounded text-[11px] font-bold bg-sky-500/15 text-sky-400 border border-sky-500/20">
                                                👥
                                            </span>
                                        )}
                                    </div>
                                    <p className="text-[11px] text-gray-500">
                                        ⏱️ {meal.readyInMinutes}min · {meal.ingredients.length} ingredients
                                        {meal.authorName && meal.source === 'community' && ` · by ${meal.authorName}`}
                                    </p>
                                </div>
                            </button>
                        ))}

                        {!searching && results.length === 0 && searchQuery.trim() && (
                            <p className="text-center text-[11px] text-gray-500 py-4">
                                No recipes found. Try a different search or create your own below.
                            </p>
                        )}

                        {/* Custom recipe creation — inside scrollable area */}
                        <div className="pt-2 mt-2 border-t border-white/[0.06] space-y-2">
                            {/* Quick add (simple name only) */}
                            <div className="flex gap-2">
                                <input
                                    ref={customInputRef}
                                    value={customName}
                                    onChange={(e) => setCustomName(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && handleCustomMeal()}
                                    onFocus={handleCustomFocus}
                                    placeholder="Quick add meal name…"
                                    data-no-keyboard-scroll
                                    className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-amber-500/30"
                                    aria-label="Quick add meal name"
                                />
                                <button
                                    onClick={handleCustomMeal}
                                    disabled={!customName.trim() || scheduling}
                                    className="px-4 py-2.5 bg-amber-500/15 border border-amber-500/20 rounded-xl text-[11px] font-bold text-amber-300 disabled:opacity-30 hover:bg-amber-500/25 transition-all"
                                >
                                    {scheduling ? '⏳' : '+ Add'}
                                </button>
                            </div>

                            {/* Full recipe creator */}
                            <button
                                onClick={() => setShowRecipeForm(true)}
                                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-gradient-to-r from-amber-500/10 to-orange-500/10 border border-amber-500/20 text-[11px] font-bold text-amber-300 hover:from-amber-500/15 hover:to-orange-500/15 transition-all active:scale-[0.98]"
                            >
                                📝 Create Full Recipe
                                <span className="text-[11px] text-amber-400/50 font-normal">
                                    (with ingredients, directions & photo)
                                </span>
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {/* Custom Recipe Form Modal */}
            {showRecipeForm && (
                <CustomRecipeForm
                    onSaved={() => {
                        setShowRecipeForm(false);
                        onScheduled();
                    }}
                    onClose={() => setShowRecipeForm(false)}
                />
            )}
        </>
    );
};
