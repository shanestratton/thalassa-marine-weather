/**
 * RecipeSheet — one saved recipe, read-only (132-B18, binder audit GAL-08).
 *
 * Saved recipes were a dead end: a card showed a name and four ingredients,
 * a recipe saved when a meal was planned could not be opened, the Favourite
 * badge could never be set and nothing could be deleted. A card now opens
 * this sheet: the whole recipe, a Favourite star (the Captain's Table's heart:
 * one list, recipeFavourites.ts), Cook or plan it, Edit and Delete. Who may
 * edit or delete is GalleyPage's call (services/galley/recipeRights.ts); the
 * sheet says why when it may not. Loaded the first time a card is opened.
 *
 * Centred, as every modal box is (Shane 2026-09-02).
 */
import React, { useId, useRef, useState } from 'react';
import {
    deleteSavedRecipe,
    storedRecipeToMeal,
    type RecipeDeleteResult,
    type StoredRecipe,
} from '../../services/GalleyRecipeService';
import { getMealPlans, scheduleMeal, type MealPlan, type MealSlot } from '../../services/MealPlanService';
import { parseRecipeSteps } from '../../services/galley/recipeRefs';
import { mealDayLabel, mealSlotName } from '../../services/galley/activeMeals';
import { addLocalDays, toLocalDateString } from '../../utils/localDate';
import { safeExternalHttpUrl } from '../../utils/safeUrl';
import { triggerHaptic } from '../../utils/system';
import { createLogger, getErrorMessage } from '../../utils/createLogger';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { OverlayPortal } from '../ui/OverlayPortal';
import { EditIcon, FoodIcon, StarIcon, TrashIcon, XIcon } from '../Icons';

// A device-log trace (GAL-13): a reason and the error message, never a title.
const log = createLogger('Galley');

const SLOTS: MealSlot[] = ['breakfast', 'lunch', 'dinner', 'snack'];
/** Today and the six days after it. */
const PLAN_DAYS = 7;

/** The meal the clock suggests: breakfast before ten, lunch before three. */
function slotForNow(now = new Date()): MealSlot {
    const hour = now.getHours();
    return hour < 10 ? 'breakfast' : hour < 15 ? 'lunch' : 'dinner';
}

export interface RecipePlanTarget {
    /** The passage the Galley shows, or null for the galley with no passage. */
    voyageId: string | null;
    ownerUserId: string | null;
}

export interface RecipeSheetProps {
    recipe: StoredRecipe;
    favourite: boolean;
    onToggleFavourite: () => void;
    canEdit: boolean;
    /** Why Edit is not offered, when that is worth saying. */
    editNote: string | null;
    canDelete: boolean;
    /** Where Cook/Plan writes; null when it cannot, with planNote saying why. */
    plan: RecipePlanTarget | null;
    planNote: string | null;
    onEdit: () => void;
    /** A meal planned for today, to cook now. */
    onCook: (meal: MealPlan) => void;
    onPlanned: () => void;
    onDeleted: (message: string) => void;
    onClose: () => void;
}

const actionButton =
    'min-h-[44px] flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl px-3 text-sm font-bold transition-all active:scale-[0.97] disabled:opacity-40';

export const RecipeSheet: React.FC<RecipeSheetProps> = ({
    recipe,
    favourite,
    onToggleFavourite,
    canEdit,
    editNote,
    canDelete,
    plan,
    planNote,
    onEdit,
    onCook,
    onPlanned,
    onDeleted,
    onClose,
}) => {
    const titleId = useId();
    const dayId = useId();
    const slotId = useId();
    const closeRef = useRef<HTMLButtonElement>(null);
    const [busy, setBusy] = useState(false);
    const [dayOffset, setDayOffset] = useState(0);
    const [slot, setSlot] = useState<MealSlot>(() => slotForNow());
    const [servings, setServings] = useState(() => Math.max(1, recipe.servings || 1));
    const [planned, setPlanned] = useState<string | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const dialogRef = useFocusTrap<HTMLDivElement>(true, {
        initialFocusRef: closeRef,
        onEscape: busy ? undefined : onClose,
    });

    const steps = parseRecipeSteps(recipe.instructions);
    const source = safeExternalHttpUrl(recipe.source_url);
    const sourceHost = source ? new URL(source).hostname.replace(/^www\./, '') : null;
    const days = Array.from({ length: PLAN_DAYS }, (_, offset) => toLocalDateString(addLocalDays(new Date(), offset)));
    // Meals still to cook that read their directions from this recipe.
    const linkedMeals = confirmDelete
        ? getMealPlans().filter(
              (meal) => meal.recipe_id === recipe.id && meal.status !== 'completed' && meal.status !== 'skipped',
          ).length
        : 0;

    const planMeal = async (cookNow: boolean) => {
        if (!plan || busy) return;
        setBusy(true);
        setProblem(null);
        setPlanned(null);
        const date = days[cookNow ? 0 : dayOffset];
        try {
            const meal = await scheduleMeal(
                storedRecipeToMeal(recipe),
                date,
                slot,
                plan.voyageId,
                servings,
                plan.ownerUserId,
            );
            onPlanned();
            if (cookNow) {
                onCook(meal);
                return;
            }
            setPlanned(`Added to meals: ${mealDayLabel(date)}, ${mealSlotName(slot).toLowerCase()}.`);
        } catch (error) {
            log.warn('galley: recipe-plan', getErrorMessage(error));
            setProblem('The meal could not be added. Please try again.');
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        if (busy) return;
        setBusy(true);
        setProblem(null);
        let result: RecipeDeleteResult;
        try {
            result = await deleteSavedRecipe(recipe.id);
        } catch (error) {
            log.warn('galley: recipe-delete', getErrorMessage(error));
            result = { status: 'pending', message: 'The recipe could not be deleted. Please try again.' };
        }
        setBusy(false);
        if (result.status === 'deleted') {
            triggerHaptic('medium');
            onDeleted(result.message);
            return;
        }
        setConfirmDelete(false);
        setProblem(result.message);
    };

    return (
        <OverlayPortal
            className="flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 pb-[calc(4rem+env(safe-area-inset-bottom)+1rem)] pt-[max(1rem,env(safe-area-inset-top))]"
            onClick={busy ? undefined : onClose}
            role="presentation"
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                aria-busy={busy}
                className="flex max-h-full w-full max-w-lg flex-col rounded-3xl border border-white/10 bg-slate-900 shadow-2xl"
                onClick={(event) => event.stopPropagation()}
            >
                <div className="flex items-start gap-3 border-b border-white/6 p-4">
                    <span
                        aria-hidden="true"
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-300"
                    >
                        <FoodIcon className="h-5 w-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                        <h2 id={titleId} className="text-base font-bold text-white [overflow-wrap:anywhere]">
                            {recipe.title}
                        </h2>
                        <p className="text-label text-gray-400 tabular-nums">
                            {recipe.ready_in_minutes} min · serves {recipe.servings} · {recipe.ingredients.length}{' '}
                            ingredient{recipe.ingredients.length === 1 ? '' : 's'}
                        </p>
                        {recipe.visibility === 'shared' && (
                            <p className="text-label text-sky-300">Shared on the Captain&rsquo;s Table</p>
                        )}
                        {sourceHost && <p className="text-label text-gray-400">Saved from {sourceHost}</p>}
                    </div>
                    <button
                        ref={closeRef}
                        type="button"
                        onClick={onClose}
                        disabled={busy}
                        aria-label="Close recipe"
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-gray-400 hover:text-white"
                    >
                        <XIcon className="h-5 w-5" />
                    </button>
                </div>

                <div className="flex-1 space-y-4 overflow-y-auto p-4">
                    <button
                        type="button"
                        onClick={() => {
                            triggerHaptic('light');
                            onToggleFavourite();
                        }}
                        aria-pressed={favourite}
                        className={`min-h-[44px] inline-flex items-center gap-2 rounded-xl border px-3 text-xs font-bold ${
                            favourite
                                ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                                : 'border-white/8 bg-white/3 text-gray-300'
                        }`}
                    >
                        <StarIcon filled={favourite} className="h-4 w-4" />
                        Favourite
                    </button>

                    <section aria-labelledby={`${titleId}-ingredients`} className="space-y-1.5">
                        <h3
                            id={`${titleId}-ingredients`}
                            className="text-label font-black uppercase tracking-widest text-gray-400"
                        >
                            Ingredients
                        </h3>
                        {recipe.ingredients.length === 0 ? (
                            <p className="text-xs text-gray-400">No ingredients saved with this recipe.</p>
                        ) : (
                            <ul className="space-y-1">
                                {recipe.ingredients.map((ingredient, index) => (
                                    <li key={index} className="text-xs text-gray-200 [overflow-wrap:anywhere]">
                                        <span className="tabular-nums text-gray-400">
                                            {ingredient.amount > 0
                                                ? `${ingredient.amount} ${ingredient.unit}`.trim()
                                                : ''}
                                        </span>{' '}
                                        {ingredient.name}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>

                    <section aria-labelledby={`${titleId}-directions`} className="space-y-1.5">
                        <h3
                            id={`${titleId}-directions`}
                            className="text-label font-black uppercase tracking-widest text-gray-400"
                        >
                            Directions
                        </h3>
                        {steps.length === 0 ? (
                            <p className="text-xs text-gray-400">No directions saved with this recipe.</p>
                        ) : (
                            <ol className="space-y-2">
                                {steps.map((step) => (
                                    <li key={step.number} className="flex gap-2 text-xs text-gray-200">
                                        <span className="w-5 shrink-0 font-bold tabular-nums text-amber-300">
                                            {step.number}.
                                        </span>
                                        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{step.step}</span>
                                    </li>
                                ))}
                            </ol>
                        )}
                    </section>

                    <section
                        aria-labelledby={`${titleId}-plan`}
                        className="space-y-3 rounded-xl border border-white/6 bg-white/3 p-3"
                    >
                        <h3 id={`${titleId}-plan`} className="text-xs font-bold text-white">
                            Cook or plan
                        </h3>
                        {plan ? (
                            <>
                                <div className="grid grid-cols-2 gap-2">
                                    <label htmlFor={dayId} className="space-y-1 text-label text-gray-400">
                                        <span className="block">Day</span>
                                        <select
                                            id={dayId}
                                            value={dayOffset}
                                            onChange={(event) => setDayOffset(Number(event.target.value))}
                                            className="min-h-[44px] w-full rounded-lg border border-white/10 bg-slate-950 px-2 text-sm text-white"
                                        >
                                            {days.map((date, offset) => (
                                                <option key={date} value={offset}>
                                                    {mealDayLabel(date)}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                    <label htmlFor={slotId} className="space-y-1 text-label text-gray-400">
                                        <span className="block">Meal</span>
                                        <select
                                            id={slotId}
                                            value={slot}
                                            onChange={(event) => setSlot(event.target.value as MealSlot)}
                                            className="min-h-[44px] w-full rounded-lg border border-white/10 bg-slate-950 px-2 text-sm text-white"
                                        >
                                            {SLOTS.map((option) => (
                                                <option key={option} value={option}>
                                                    {mealSlotName(option)}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                </div>
                                <div className="flex items-center gap-3" role="group" aria-label="Serves">
                                    <span className="text-label text-gray-400">Serves</span>
                                    <button
                                        type="button"
                                        onClick={() => setServings((value) => Math.max(1, value - 1))}
                                        aria-label="Fewer servings"
                                        className="h-11 w-11 rounded-full bg-white/8 text-lg font-bold text-white"
                                    >
                                        −
                                    </button>
                                    <span aria-live="polite" className="min-w-[2ch] text-center font-bold text-white">
                                        {servings}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => setServings((value) => Math.min(50, value + 1))}
                                        aria-label="More servings"
                                        className="h-11 w-11 rounded-full bg-white/8 text-lg font-bold text-white"
                                    >
                                        +
                                    </button>
                                </div>
                                <div className="flex gap-2">
                                    {dayOffset === 0 && (
                                        <button
                                            type="button"
                                            onClick={() => void planMeal(true)}
                                            disabled={busy}
                                            className={`${actionButton} border border-amber-500/20 bg-amber-500/15 text-amber-300`}
                                        >
                                            Cook now
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        onClick={() => void planMeal(false)}
                                        disabled={busy}
                                        className={`${actionButton} border border-white/10 bg-white/6 text-white`}
                                    >
                                        Add to meals
                                    </button>
                                </div>
                                {planned && (
                                    <p role="status" className="text-xs text-emerald-300">
                                        {planned}
                                    </p>
                                )}
                            </>
                        ) : (
                            <p className="text-xs text-gray-400">{planNote}</p>
                        )}
                    </section>

                    {problem && (
                        <p role="alert" className="text-xs font-bold text-red-300">
                            {problem}
                        </p>
                    )}

                    {confirmDelete && (
                        <div
                            role="group"
                            aria-label={`Delete ${recipe.title}?`}
                            className="space-y-3 rounded-xl border border-red-500/20 bg-red-500/5 p-3"
                        >
                            <p className="text-xs text-gray-200">
                                Delete {recipe.title}? It goes from this phone
                                {recipe.user_id ? ' and your other devices' : ''}
                                {recipe.visibility === 'shared' ? ', and from the Captain’s Table' : ''}.
                                {linkedMeals > 0 &&
                                    ` ${linkedMeals} planned meal${linkedMeals === 1 ? ' cooks' : 's cook'} from it: they keep their ingredients but lose its directions.`}
                            </p>
                            <div className="flex gap-2">
                                <button
                                    type="button"
                                    onClick={() => setConfirmDelete(false)}
                                    disabled={busy}
                                    className={`${actionButton} border border-white/10 bg-white/6 text-white`}
                                >
                                    Keep it
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void remove()}
                                    disabled={busy}
                                    className={`${actionButton} border border-red-500/30 bg-red-500/15 text-red-200`}
                                >
                                    {busy ? 'Deleting…' : 'Delete recipe'}
                                </button>
                            </div>
                        </div>
                    )}
                </div>

                <div className="space-y-2 border-t border-white/6 p-4">
                    {!canEdit && editNote && <p className="text-label text-gray-400">{editNote}</p>}
                    <div className="flex gap-2">
                        {canEdit && (
                            <button
                                type="button"
                                onClick={() => {
                                    triggerHaptic('light');
                                    onEdit();
                                }}
                                disabled={busy}
                                aria-label={`Edit ${recipe.title}`}
                                className={`${actionButton} border border-white/10 bg-white/6 text-white`}
                            >
                                <EditIcon className="h-4 w-4" />
                                Edit
                            </button>
                        )}
                        {canDelete && !confirmDelete && (
                            <button
                                type="button"
                                onClick={() => {
                                    triggerHaptic('light');
                                    setProblem(null);
                                    setConfirmDelete(true);
                                }}
                                disabled={busy}
                                aria-label={`Delete ${recipe.title}`}
                                className={`${actionButton} border border-red-500/20 bg-red-500/10 text-red-300`}
                            >
                                <TrashIcon className="h-4 w-4" />
                                Delete
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </OverlayPortal>
    );
};
