/**
 * GalleyCookingMode — Step-by-step high-contrast cooking interface.
 *
 * Full-screen, galley-friendly UI for recipe execution at sea:
 *  - Large text, high contrast (readable in a rocking galley)
 *  - Step-by-step instruction flow with haptic check-offs
 *  - Ingredient checklist with reservation indicators
 *  - Meal completion triggers DELTA subtractions from Ship's Stores
 *  - Leftover management on completion
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { startCooking, completeMeal, saveLeftovers, skipMeal, type MealPlan } from '../../services/MealPlanService';
import { getRecipeInstructions } from '../../services/GalleyRecipeService';
import { triggerHaptic } from '../../utils/system';
import { useFocusTrap } from '../../hooks/useFocusTrap';

interface GalleyCookingModeProps {
    meal: MealPlan;
    onClose: () => void;
    onComplete: () => void;
}

function generateFallbackChecklist(meal: MealPlan): string[] {
    const steps: string[] = [];
    if (meal.ingredients.length > 0) {
        steps.push(
            `Gather ingredients: ${meal.ingredients
                .slice(0, 5)
                .map((i) => i.name)
                .join(', ')}${meal.ingredients.length > 5 ? '...' : ''}`,
        );
    }
    steps.push('Prepare your workspace and galley equipment');
    steps.push(`Prepare ingredients for ${meal.servings_planned} servings`);
    steps.push('Cook using your saved recipe directions');
    steps.push('Plate and serve');
    return steps;
}

export const GalleyCookingMode: React.FC<GalleyCookingModeProps> = ({ meal, onClose, onComplete }) => {
    const [steps, setSteps] = useState(() => generateFallbackChecklist(meal));
    const [checkedSteps, setCheckedSteps] = useState<Set<number>>(new Set());
    const [isCooking, setIsCooking] = useState(meal.status === 'cooking');
    const [directionsSource, setDirectionsSource] = useState<'loading' | 'recipe' | 'checklist'>('loading');
    const [showComplete, setShowComplete] = useState(false);
    const [servingsConsumed, setServingsConsumed] = useState(meal.servings_planned);
    const [showLeftovers, setShowLeftovers] = useState(false);
    const [starting, setStarting] = useState(false);
    const [skipping, setSkipping] = useState(false);
    const [finishing, setFinishing] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);
    const titleId = useId();
    const servingsLabelId = useId();
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    const firstStepRef = useRef<HTMLButtonElement>(null);
    const wasCookingRef = useRef(isCooking);
    const stepsTouchedRef = useRef(false);
    const completionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const mountedRef = useRef(true);
    const actionLockRef = useRef<'start' | 'skip' | 'finish' | null>(null);
    const workflowBusy = starting || skipping || finishing;
    const dialogRef = useFocusTrap<HTMLDivElement>(true, {
        initialFocusRef: closeButtonRef,
        onEscape: workflowBusy ? undefined : onClose,
    });

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            if (completionTimerRef.current) clearTimeout(completionTimerRef.current);
        };
    }, []);

    useEffect(() => {
        let active = true;

        void getRecipeInstructions(meal.spoonacular_id)
            .then((recipeSteps) => {
                if (!active) return;
                const loadedSteps = recipeSteps.map((step) => step.step.trim()).filter(Boolean);
                if (loadedSteps.length > 0 && !stepsTouchedRef.current) {
                    setSteps(loadedSteps);
                    setDirectionsSource('recipe');
                    return;
                }
                setDirectionsSource('checklist');
            })
            .catch(() => {
                if (active) setDirectionsSource('checklist');
            });

        return () => {
            active = false;
        };
    }, [meal.spoonacular_id]);

    useEffect(() => {
        if (!wasCookingRef.current && isCooking) firstStepRef.current?.focus();
        wasCookingRef.current = isCooking;
    }, [isCooking]);

    const handleStartCooking = useCallback(async () => {
        if (actionLockRef.current) return;
        actionLockRef.current = 'start';
        setStarting(true);
        setActionError(null);
        try {
            const started = await startCooking(meal.id);
            if (!mountedRef.current) return;
            if (!started) {
                setActionError('Cooking mode could not be started. Please try again.');
                return;
            }
            setIsCooking(true);
        } catch {
            if (mountedRef.current) setActionError('Cooking mode could not be started. Please try again.');
        } finally {
            if (actionLockRef.current === 'start') actionLockRef.current = null;
            if (mountedRef.current) setStarting(false);
        }
    }, [meal.id]);

    const handleToggleStep = useCallback(
        (idx: number) => {
            stepsTouchedRef.current = true;
            const next = new Set(checkedSteps);
            if (next.has(idx)) {
                next.delete(idx);
            } else {
                next.add(idx);
                triggerHaptic('light'); // Haptic on check-off
            }
            setCheckedSteps(next);

            if (completionTimerRef.current) {
                clearTimeout(completionTimerRef.current);
                completionTimerRef.current = null;
            }

            if (next.size === steps.length) {
                completionTimerRef.current = setTimeout(() => {
                    setShowComplete(true);
                    completionTimerRef.current = null;
                }, 300);
            } else {
                setShowComplete(false);
            }
        },
        [checkedSteps, steps.length],
    );

    const handleComplete = useCallback(async () => {
        if (actionLockRef.current) return;
        actionLockRef.current = 'finish';
        setFinishing(true);
        setActionError(null);
        try {
            const completed = await completeMeal(meal.id, servingsConsumed);
            if (!mountedRef.current) return;
            if (!completed) {
                setActionError("The meal could not be completed, so Ship's Stores were not updated.");
                return;
            }

            if (showLeftovers && servingsConsumed < meal.servings_planned) {
                const remaining = meal.servings_planned - servingsConsumed;
                try {
                    await saveLeftovers(meal.id, remaining);
                } catch {
                    // The meal is already completed and stores have already been
                    // subtracted. Do not offer a retry that could subtract twice.
                }
            }

            if (mountedRef.current) onComplete();
        } catch {
            if (mountedRef.current) {
                setActionError("The meal could not be completed, so Ship's Stores were not updated.");
            }
        } finally {
            if (actionLockRef.current === 'finish') actionLockRef.current = null;
            if (mountedRef.current) setFinishing(false);
        }
    }, [meal.id, meal.servings_planned, servingsConsumed, showLeftovers, onComplete]);

    const handleSkip = useCallback(async () => {
        if (actionLockRef.current) return;
        actionLockRef.current = 'skip';
        setSkipping(true);
        setActionError(null);
        try {
            const skipped = await skipMeal(meal.id);
            if (!mountedRef.current) return;
            if (!skipped) {
                setActionError('The meal could not be skipped. Please try again.');
                return;
            }
            triggerHaptic('light');
            onClose();
        } catch {
            if (mountedRef.current) setActionError('The meal could not be skipped. Please try again.');
        } finally {
            if (actionLockRef.current === 'skip') actionLockRef.current = null;
            if (mountedRef.current) setSkipping(false);
        }
    }, [meal.id, onClose]);

    const progress = steps.length > 0 ? checkedSteps.size / steps.length : 0;

    return (
        <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-busy={workflowBusy}
            className="fixed inset-0 z-[1100] bg-[#0a0e14] text-white flex flex-col"
        >
            {/* ── Header ── */}
            <div className="px-5 pt-5 pb-3 flex items-center justify-between border-b border-white/10">
                <div>
                    <h2 id={titleId} className="text-lg font-bold text-amber-300 uppercase tracking-widest">
                        🍳 Cooking Mode
                    </h2>
                    <p className="text-sm text-gray-400 mt-0.5">{meal.title}</p>
                </div>
                <div className="flex items-center gap-3">
                    <span className="text-xs text-gray-500">{meal.servings_planned} serves</span>
                    <button
                        ref={closeButtonRef}
                        aria-label="Close cooking mode"
                        onClick={onClose}
                        disabled={workflowBusy}
                        className="w-10 h-10 flex items-center justify-center rounded-full bg-white/5 hover:bg-white/10 text-gray-400 text-lg transition-colors"
                    >
                        ✕
                    </button>
                </div>
            </div>

            {/* ── Progress Bar ── */}
            <div className="px-5 py-2">
                <div
                    role="progressbar"
                    aria-label="Cooking progress"
                    aria-valuemin={0}
                    aria-valuemax={steps.length}
                    aria-valuenow={checkedSteps.size}
                    aria-valuetext={`${checkedSteps.size} of ${steps.length} steps complete`}
                    className="h-2 bg-white/5 rounded-full overflow-hidden"
                >
                    <div
                        className="h-full bg-gradient-to-r from-amber-500 to-orange-500 rounded-full transition-all duration-500"
                        style={{ width: `${progress * 100}%` }}
                    />
                </div>
                <div className="flex justify-between mt-1">
                    <span className="text-[11px] text-gray-500 uppercase tracking-wider">
                        {checkedSteps.size}/{steps.length} steps
                    </span>
                    <span className="text-[11px] text-gray-500 uppercase tracking-wider">
                        {Math.round(progress * 100)}%
                    </span>
                </div>
            </div>

            {/* ── Ingredients Checklist ── */}
            {meal.ingredients.length > 0 && (
                <div className="px-5 py-3 border-b border-white/5">
                    <h3 className="text-[11px] font-bold text-gray-500 uppercase tracking-[0.15em] mb-2">
                        📦 Ingredients (from Ship&apos;s Stores)
                    </h3>
                    <div className="flex flex-wrap gap-2">
                        {meal.ingredients.map((ing, i) => (
                            <span
                                key={i}
                                className="px-2.5 py-1 rounded-full text-xs bg-amber-500/10 text-amber-300 border border-amber-500/20"
                            >
                                {ing.amount} {ing.unit} {ing.name}
                                {!ing.scalable && <span className="text-amber-500/40 ml-1">📦</span>}
                            </span>
                        ))}
                    </div>
                </div>
            )}

            {/* ── Steps ── */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
                {actionError && (
                    <p
                        role="alert"
                        className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200"
                    >
                        {actionError}
                    </p>
                )}
                {!isCooking ? (
                    <div className="flex flex-col items-center justify-center h-full gap-6">
                        <div className="text-6xl">🔥</div>
                        <h3 className="text-xl font-bold text-amber-300">Ready to Cook?</h3>
                        <p className="text-sm text-gray-400 text-center max-w-[280px]">
                            Starting keeps your ingredients reserved and records the cooking start time.
                        </p>
                        <button
                            onClick={handleStartCooking}
                            disabled={starting || skipping}
                            className="px-8 py-4 bg-gradient-to-r from-amber-500/20 to-orange-500/20 hover:from-amber-500/30 hover:to-orange-500/30 border border-amber-500/30 rounded-2xl text-sm font-bold uppercase tracking-widest text-amber-300 transition-all active:scale-[0.97]"
                        >
                            {starting ? '⏳ Starting…' : '🔥 Start Cooking'}
                        </button>
                        <button
                            onClick={handleSkip}
                            disabled={starting || skipping}
                            className="text-xs text-gray-500 hover:text-gray-400 transition-colors"
                        >
                            {skipping ? 'Skipping…' : 'Skip this meal →'}
                        </button>
                    </div>
                ) : (
                    <>
                        <p aria-live="polite" className="text-xs text-gray-400">
                            {directionsSource === 'loading'
                                ? 'Loading saved recipe directions…'
                                : directionsSource === 'recipe'
                                  ? 'Recipe directions'
                                  : 'Detailed recipe directions are unavailable. Use this galley checklist with your saved recipe source.'}
                        </p>
                        {steps.map((step, i) => (
                            <button
                                key={i}
                                ref={i === 0 ? firstStepRef : undefined}
                                aria-label={`${checkedSteps.has(i) ? 'Mark incomplete' : 'Mark complete'}: Step ${i + 1}, ${step}`}
                                aria-pressed={checkedSteps.has(i)}
                                onClick={() => handleToggleStep(i)}
                                className={`w-full flex items-start gap-4 p-4 rounded-xl border transition-all active:scale-[0.98] text-left ${
                                    checkedSteps.has(i)
                                        ? 'bg-emerald-500/10 border-emerald-500/20'
                                        : 'bg-white/[0.03] border-white/5 hover:bg-white/[0.06]'
                                }`}
                            >
                                <div
                                    className={`w-8 h-8 flex-shrink-0 rounded-full flex items-center justify-center text-sm font-bold transition-all ${
                                        checkedSteps.has(i)
                                            ? 'bg-emerald-500/30 text-emerald-300'
                                            : 'bg-white/10 text-gray-400'
                                    }`}
                                >
                                    {checkedSteps.has(i) ? '✓' : i + 1}
                                </div>
                                <p
                                    className={`text-sm leading-relaxed pt-1 ${
                                        checkedSteps.has(i) ? 'text-emerald-300/70 line-through' : 'text-white'
                                    }`}
                                >
                                    {step}
                                </p>
                            </button>
                        ))}
                    </>
                )}
            </div>

            {/* ── Completion Panel ── */}
            {showComplete && (
                <div className="px-5 py-4 border-t border-white/10 bg-emerald-500/5 space-y-3 animate-in slide-in-from-bottom duration-300">
                    <h3 className="text-sm font-bold text-emerald-300 uppercase tracking-widest flex items-center gap-2">
                        ✅ Ready to Serve
                    </h3>

                    {/* Servings consumed */}
                    <div role="group" aria-labelledby={servingsLabelId} className="flex items-center gap-3">
                        <span id={servingsLabelId} className="text-xs text-gray-400">
                            Servings consumed:
                        </span>
                        <div className="flex items-center gap-2">
                            <button
                                aria-label="Decrease servings consumed"
                                onClick={() => setServingsConsumed(Math.max(1, servingsConsumed - 1))}
                                className="w-8 h-8 rounded-full bg-white/10 text-white flex items-center justify-center hover:bg-white/20 transition-colors"
                            >
                                −
                            </button>
                            <span aria-live="polite" className="text-lg font-bold text-white w-8 text-center">
                                {servingsConsumed}
                            </span>
                            <button
                                aria-label="Increase servings consumed"
                                onClick={() =>
                                    setServingsConsumed(Math.min(meal.servings_planned * 2, servingsConsumed + 1))
                                }
                                className="w-8 h-8 rounded-full bg-white/10 text-white flex items-center justify-center hover:bg-white/20 transition-colors"
                            >
                                +
                            </button>
                        </div>
                    </div>

                    {/* Leftovers toggle */}
                    {servingsConsumed < meal.servings_planned && (
                        <button
                            aria-pressed={showLeftovers}
                            onClick={() => setShowLeftovers(!showLeftovers)}
                            className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-all ${
                                showLeftovers
                                    ? 'bg-blue-500/10 border-blue-500/20 text-blue-300'
                                    : 'bg-white/5 border-white/10 text-gray-400'
                            }`}
                        >
                            <span className="text-xs font-bold uppercase tracking-wider">
                                🥡 Save {meal.servings_planned - servingsConsumed} serves as Leftovers
                            </span>
                            <span className="text-sm">{showLeftovers ? '✓' : '○'}</span>
                        </button>
                    )}

                    {/* Complete button */}
                    <button
                        onClick={handleComplete}
                        disabled={finishing}
                        className="w-full py-4 bg-gradient-to-r from-emerald-500/20 to-green-500/20 hover:from-emerald-500/30 hover:to-green-500/30 border border-emerald-500/30 rounded-xl text-sm font-bold uppercase tracking-widest text-emerald-300 transition-all active:scale-[0.97] disabled:opacity-50"
                    >
                        {finishing ? "⏳ Updating Ship's Stores..." : '✅ Complete & Subtract from Stores'}
                    </button>
                </div>
            )}
        </div>
    );
};
