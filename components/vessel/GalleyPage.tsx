/**
 * GalleyPage — Standalone galley view for solo sailors.
 *
 * Accessible directly from VesselHub Ship's Office grid.
 * Renders Chef's Plate cards for all active meals + recipe browser.
 * Works fully offline — recipes are persisted to LocalDatabase.
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
    getMealsByStatus,
    getMealPlans as _getMealPlans,
    getStoresAvailability,
    type MealPlan,
} from '../../services/MealPlanService';
import { getShoppingList, type ShoppingListSummary } from '../../services/ShoppingListService';
import { getStoredRecipes, type StoredRecipe } from '../../services/GalleyRecipeService';
import { triggerHaptic } from '../../utils/system';
import { useAuthStore } from '../../stores/authStore';
import { useRealtimeSync } from '../../hooks/useRealtimeSync';
import { RecipeEditor } from '../galley/RecipeEditor';
import { GalleyCookingMode } from '../passage/GalleyCookingMode';
import { GroceryListPage } from './GroceryListPage';
import {
    getActivePassageId,
    getPassageStatus,
    NO_PASSAGE_ACCESS,
    type PassageStatus,
} from '../../services/PassagePlanService';
import { getCachedActiveVoyage } from '../../services/VoyageService';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../../services/authIdentityScope';

interface GalleyPageProps {
    onBack: () => void;
}

const GALLEY_TABS = ['active', 'recipes'] as const;

function personalGalleyStatus(userId: string | null): PassageStatus {
    if (!userId) return NO_PASSAGE_ACCESS;
    return {
        visible: true,
        voyageId: null,
        ownerUserId: userId,
        isOwner: true,
        canEditStores: true,
        canViewMeals: true,
        canViewChat: false,
        canViewRoute: false,
        canViewChecklist: false,
    };
}

export const GalleyPage: React.FC<GalleyPageProps> = ({ onBack }) => {
    const currentUserId = useAuthStore((state) => state.user?.id ?? null);
    const renderIdentityScope = getAuthIdentityScope();
    const [passageStatus, setPassageStatus] = useState<PassageStatus>(NO_PASSAGE_ACCESS);
    const [passageAccessLoaded, setPassageAccessLoaded] = useState(false);
    const [resolvedIdentityKey, setResolvedIdentityKey] = useState(renderIdentityScope.key);
    const [tab, setTab] = useState<'active' | 'recipes'>('active');
    const [activeMeals, setActiveMeals] = useState<MealPlan[]>([]);
    const [savedRecipes, setSavedRecipes] = useState<StoredRecipe[]>([]);
    const [shoppingSummary, setShoppingSummary] = useState<ShoppingListSummary | null>(null);
    const [activeCookingMeal, setActiveCookingMeal] = useState<MealPlan | null>(null);
    const [editorRecipe, setEditorRecipe] = useState<StoredRecipe | 'new' | null>(null);
    const [showGroceryList, setShowGroceryList] = useState(false);
    const restoreShoppingFocusRef = useRef(false);
    const shoppingListButtonRef = useRef<HTMLButtonElement>(null);
    const identityOwnsRenderedData =
        resolvedIdentityKey === renderIdentityScope.key && renderIdentityScope.userId === currentUserId;
    const visiblePassageStatus = identityOwnsRenderedData ? passageStatus : NO_PASSAGE_ACCESS;
    const visiblePassageAccessLoaded = identityOwnsRenderedData ? passageAccessLoaded : false;
    const visibleActiveMeals = identityOwnsRenderedData ? activeMeals : [];
    const visibleSavedRecipes = identityOwnsRenderedData ? savedRecipes : [];
    const visibleShoppingSummary = identityOwnsRenderedData ? shoppingSummary : null;

    useEffect(() => {
        let active = true;
        let scopeGeneration = 0;
        const operationScope = getAuthIdentityScope();

        // Effects run after paint. Tag every state payload with its owner so
        // render-time aliases above hide account A synchronously while this
        // reset/hydration cycle moves onto B.
        setResolvedIdentityKey(operationScope.key);
        setPassageStatus(NO_PASSAGE_ACCESS);
        setPassageAccessLoaded(false);
        setActiveMeals([]);
        setSavedRecipes([]);
        setShoppingSummary(null);
        setActiveCookingMeal(null);
        setEditorRecipe(null);
        setShowGroceryList(false);

        if (operationScope.userId !== currentUserId) {
            return () => {
                active = false;
            };
        }

        const resolveScope = () => {
            const requestGeneration = ++scopeGeneration;
            const cachedVoyage = getCachedActiveVoyage();
            const selectedVoyageId = getActivePassageId() ?? cachedVoyage?.id ?? null;

            if (!selectedVoyageId) {
                setPassageStatus(personalGalleyStatus(currentUserId));
                setPassageAccessLoaded(true);
                return;
            }

            const verifiedOfflineOwner =
                cachedVoyage?.id === selectedVoyageId && cachedVoyage.user_id === currentUserId
                    ? {
                          ...personalGalleyStatus(currentUserId),
                          voyageId: selectedVoyageId,
                      }
                    : null;
            setPassageStatus(verifiedOfflineOwner ?? NO_PASSAGE_ACCESS);
            setPassageAccessLoaded(Boolean(verifiedOfflineOwner));

            void getPassageStatus(selectedVoyageId)
                .then((status) => {
                    if (!active || requestGeneration !== scopeGeneration || !isAuthIdentityScopeCurrent(operationScope))
                        return;
                    if (status.visible) setPassageStatus(status);
                    else if (!verifiedOfflineOwner) setPassageStatus(NO_PASSAGE_ACCESS);
                    setPassageAccessLoaded(true);
                })
                .catch(() => {
                    if (!active || requestGeneration !== scopeGeneration || !isAuthIdentityScopeCurrent(operationScope))
                        return;
                    if (!verifiedOfflineOwner) setPassageStatus(NO_PASSAGE_ACCESS);
                    setPassageAccessLoaded(true);
                });
        };

        resolveScope();
        window.addEventListener('thalassa:passage-changed', resolveScope);
        window.addEventListener('thalassa:active-voyage-changed', resolveScope);
        return () => {
            active = false;
            window.removeEventListener('thalassa:passage-changed', resolveScope);
            window.removeEventListener('thalassa:active-voyage-changed', resolveScope);
        };
    }, [currentUserId]);

    const handleTabKeyDown = useCallback(
        (event: React.KeyboardEvent<HTMLButtonElement>, currentTab: (typeof GALLEY_TABS)[number]) => {
            const currentIndex = GALLEY_TABS.indexOf(currentTab);
            let nextIndex: number | null = null;
            if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % GALLEY_TABS.length;
            if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + GALLEY_TABS.length) % GALLEY_TABS.length;
            if (event.key === 'Home') nextIndex = 0;
            if (event.key === 'End') nextIndex = GALLEY_TABS.length - 1;
            if (nextIndex === null) return;

            event.preventDefault();
            setTab(GALLEY_TABS[nextIndex]);
            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
        },
        [],
    );

    const refreshSavedRecipes = useCallback(() => {
        setSavedRecipes(getStoredRecipes());
    }, []);

    const refreshActiveMeals = useCallback(() => {
        if (!visiblePassageAccessLoaded || !visiblePassageStatus.visible) {
            setActiveMeals([]);
            return;
        }
        const reserved = getMealsByStatus('reserved', visiblePassageStatus.voyageId);
        const cooking = getMealsByStatus('cooking', visiblePassageStatus.voyageId);
        setActiveMeals([...cooking, ...reserved]);
    }, [visiblePassageAccessLoaded, visiblePassageStatus.visible, visiblePassageStatus.voyageId]);

    const refreshShoppingSummary = useCallback(() => {
        if (!visiblePassageAccessLoaded || !visiblePassageStatus.visible) {
            setShoppingSummary(null);
            return;
        }
        setShoppingSummary(getShoppingList(visiblePassageStatus.voyageId, visiblePassageStatus.ownerUserId));
    }, [
        visiblePassageAccessLoaded,
        visiblePassageStatus.ownerUserId,
        visiblePassageStatus.visible,
        visiblePassageStatus.voyageId,
    ]);

    useEffect(() => {
        refreshActiveMeals();
        refreshShoppingSummary();
        refreshSavedRecipes();
    }, [refreshActiveMeals, refreshSavedRecipes, refreshShoppingSummary]);

    useRealtimeSync('shopping_list', refreshShoppingSummary);

    const handleCookNow = useCallback((meal: MealPlan) => {
        triggerHaptic('medium');
        setActiveCookingMeal(meal);
    }, []);

    const closeCookingMode = useCallback(() => {
        setActiveCookingMeal(null);
        refreshActiveMeals();
        refreshShoppingSummary();
    }, [refreshActiveMeals, refreshShoppingSummary]);

    const closeGroceryList = useCallback(() => {
        restoreShoppingFocusRef.current = true;
        setShowGroceryList(false);
        refreshShoppingSummary();
    }, [refreshShoppingSummary]);

    useEffect(() => {
        if (showGroceryList || !restoreShoppingFocusRef.current) return;
        restoreShoppingFocusRef.current = false;
        shoppingListButtonRef.current?.focus();
    }, [showGroceryList]);

    const storesAvail = getStoresAvailability(visiblePassageStatus.voyageId, visiblePassageStatus.ownerUserId);
    const reservedCount = storesAvail.filter((s) => s.reserved > 0).length;

    if (identityOwnsRenderedData && showGroceryList) {
        const groceryList = (
            <GroceryListPage
                onBack={closeGroceryList}
                passageStatus={visiblePassageStatus}
                accessLoaded={visiblePassageAccessLoaded}
            />
        );
        return typeof document !== 'undefined' ? createPortal(groceryList, document.body) : groceryList;
    }

    return (
        <div className="flex flex-col h-full bg-slate-950 text-white slide-up-enter">
            {/* Header */}
            <div className="flex items-center gap-3 p-4 border-b border-white/[0.06]">
                <button
                    type="button"
                    onClick={onBack}
                    className="w-9 h-9 rounded-lg bg-white/[0.06] flex items-center justify-center text-gray-400 hover:bg-white/[0.1]"
                    aria-label="Go back to vessel hub"
                >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                    </svg>
                </button>
                <div className="flex-1">
                    <h1 className="text-base font-black">Galley</h1>
                    <p className="text-[11px] text-amber-400/60 uppercase tracking-widest">
                        {visibleActiveMeals.length} active · {visibleSavedRecipes.length} saved · {reservedCount}{' '}
                        reserved
                    </p>
                </div>
                <div className="px-2 py-1 rounded-md bg-amber-500/10 border border-amber-500/15">
                    <span className="text-[11px] font-bold text-amber-400/70 tracking-widest uppercase">
                        Offline Ready
                    </span>
                </div>
            </div>

            {/* Tab bar */}
            <div className="flex border-b border-white/[0.06]" role="tablist" aria-label="Galley sections">
                <button
                    type="button"
                    onClick={() => setTab('active')}
                    onKeyDown={(event) => handleTabKeyDown(event, 'active')}
                    id="galley-active-tab"
                    role="tab"
                    aria-selected={tab === 'active'}
                    aria-controls="galley-active-panel"
                    tabIndex={tab === 'active' ? 0 : -1}
                    className={`flex-1 py-2.5 text-[11px] font-bold uppercase tracking-[0.15em] transition-colors ${
                        tab === 'active'
                            ? 'text-amber-400 border-b-2 border-amber-400'
                            : 'text-gray-500 hover:text-gray-300'
                    }`}
                >
                    🍳 Active Meals
                </button>
                <button
                    type="button"
                    onClick={() => setTab('recipes')}
                    onKeyDown={(event) => handleTabKeyDown(event, 'recipes')}
                    id="galley-recipes-tab"
                    role="tab"
                    aria-selected={tab === 'recipes'}
                    aria-controls="galley-recipes-panel"
                    tabIndex={tab === 'recipes' ? 0 : -1}
                    className={`flex-1 py-2.5 text-[11px] font-bold uppercase tracking-[0.15em] transition-colors ${
                        tab === 'recipes'
                            ? 'text-sky-400 border-b-2 border-sky-400'
                            : 'text-gray-500 hover:text-gray-300'
                    }`}
                >
                    📖 Saved Recipes ({visibleSavedRecipes.length})
                </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto">
                {tab === 'active' && (
                    <div
                        id="galley-active-panel"
                        role="tabpanel"
                        aria-labelledby="galley-active-tab"
                        tabIndex={0}
                        className="space-y-4 p-4"
                    >
                        {visibleActiveMeals.length === 0 ? (
                            <div className="text-center py-12">
                                <span className="text-5xl">🍽️</span>
                                <p className="text-sm font-bold text-gray-300 mt-4">No Active Meals</p>
                                <p className="text-[11px] text-gray-500 mt-1">
                                    Schedule recipes from the Saved Recipes tab or use a passage meal plan
                                </p>
                            </div>
                        ) : (
                            visibleActiveMeals.map((meal) => (
                                <div
                                    key={meal.id}
                                    className="rounded-2xl bg-white/[0.02] border border-white/[0.06] overflow-hidden"
                                >
                                    {/* Mini hero */}
                                    <div className="relative h-28 bg-gradient-to-br from-amber-900/60 via-orange-800/40 to-red-900/60">
                                        <div className="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black/70 to-transparent">
                                            <p className="text-sm font-black text-white">{meal.title}</p>
                                            <p className="text-[11px] text-amber-300/70">
                                                {meal.planned_date} · {meal.meal_slot} · {meal.servings_planned} serves
                                            </p>
                                        </div>
                                    </div>

                                    {/* Ingredients */}
                                    <div className="p-3 space-y-1">
                                        {meal.ingredients.slice(0, 5).map((ing, i) => (
                                            <div key={i} className="flex items-center gap-2 text-xs">
                                                <span className="w-4 text-center">📦</span>
                                                <span className="text-gray-300">
                                                    {ing.amount} {ing.unit} {ing.name}
                                                </span>
                                            </div>
                                        ))}
                                        {meal.ingredients.length > 5 && (
                                            <p className="text-[11px] text-gray-500 pl-6">
                                                +{meal.ingredients.length - 5} more
                                            </p>
                                        )}
                                    </div>

                                    {/* Actions */}
                                    <div className="p-3 pt-0 flex gap-2">
                                        <button
                                            type="button"
                                            onClick={() => handleCookNow(meal)}
                                            className="flex-1 py-2.5 bg-gradient-to-r from-amber-500/15 to-orange-500/15 border border-amber-500/20 rounded-xl text-[11px] font-bold uppercase tracking-widest text-amber-300 disabled:opacity-40 active:scale-[0.97]"
                                        >
                                            {meal.status === 'cooking' ? '🔥 Resume Cooking' : '🔥 Cook Now'}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                const text = `🍽️ ${meal.title}\n${meal.ingredients.map((i) => `${i.amount} ${i.unit} ${i.name}`).join('\n')}`;
                                                if (navigator.share)
                                                    navigator.share({ title: meal.title, text }).catch(() => {});
                                                else
                                                    navigator.clipboard
                                                        .writeText(text)
                                                        .then(() => triggerHaptic('light'));
                                            }}
                                            className="w-10 flex items-center justify-center border border-white/[0.08] bg-white/[0.03] rounded-xl text-gray-400"
                                            aria-label="Share active meal details"
                                        >
                                            <svg
                                                className="w-4 h-4"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                strokeWidth={1.5}
                                            >
                                                <path
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                    d="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0 0a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0-12.814a2.25 2.25 0 103.933-2.185 2.25 2.25 0 00-3.933 2.185z"
                                                />
                                            </svg>
                                        </button>
                                    </div>
                                </div>
                            ))
                        )}

                        {/* Shopping status */}
                        {visibleShoppingSummary && (
                            <button
                                ref={shoppingListButtonRef}
                                type="button"
                                onClick={() => {
                                    triggerHaptic('light');
                                    setShowGroceryList(true);
                                }}
                                aria-label={
                                    visibleShoppingSummary.remaining > 0
                                        ? `Open shopping list, ${visibleShoppingSummary.remaining} item${visibleShoppingSummary.remaining === 1 ? '' : 's'} remaining`
                                        : visibleShoppingSummary.total > 0
                                          ? 'Open shopping list, all items purchased'
                                          : 'Open empty shopping list'
                                }
                                className={`w-full p-3 rounded-xl border flex items-center gap-3 text-left transition-colors active:scale-[0.99] ${
                                    visibleShoppingSummary.remaining > 0
                                        ? 'bg-red-500/[0.04] border-red-500/[0.08] hover:bg-red-500/[0.08]'
                                        : visibleShoppingSummary.total > 0
                                          ? 'bg-emerald-500/[0.04] border-emerald-500/[0.1] hover:bg-emerald-500/[0.08]'
                                          : 'bg-white/[0.02] border-white/[0.06] hover:bg-white/[0.05]'
                                }`}
                            >
                                <span className="text-lg" aria-hidden="true">
                                    🛒
                                </span>
                                <div className="flex-1">
                                    <p
                                        className={`text-xs font-bold ${
                                            visibleShoppingSummary.remaining > 0
                                                ? 'text-red-300'
                                                : visibleShoppingSummary.total > 0
                                                  ? 'text-emerald-300'
                                                  : 'text-gray-300'
                                        }`}
                                    >
                                        {visibleShoppingSummary.remaining > 0
                                            ? `${visibleShoppingSummary.remaining} item${visibleShoppingSummary.remaining === 1 ? '' : 's'} still needed`
                                            : visibleShoppingSummary.total > 0
                                              ? 'Shopping complete'
                                              : 'Shopping list is empty'}
                                    </p>
                                    <p className="text-[11px] text-gray-500">
                                        {visibleShoppingSummary.total > 0
                                            ? `${visibleShoppingSummary.purchased}/${visibleShoppingSummary.total} purchased`
                                            : 'Add groceries, supplies, or missing ingredients'}
                                    </p>
                                </div>
                                <span className="text-[11px] font-bold uppercase tracking-widest text-emerald-400">
                                    Open
                                </span>
                                <svg
                                    className="h-4 w-4 shrink-0 text-gray-500"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                    aria-hidden="true"
                                >
                                    <path strokeLinecap="round" strokeLinejoin="round" d="m9 18 6-6-6-6" />
                                </svg>
                            </button>
                        )}
                    </div>
                )}

                {tab === 'recipes' && (
                    <div
                        id="galley-recipes-panel"
                        role="tabpanel"
                        aria-labelledby="galley-recipes-tab"
                        tabIndex={0}
                        className="p-4 space-y-3"
                    >
                        <div className="flex items-center justify-between gap-3 pb-1">
                            <div className="min-w-0">
                                <p className="text-xs font-bold text-white">Your recipe library</p>
                                <p className="text-[11px] text-gray-500">Available offline in your galley</p>
                            </div>
                            <button
                                type="button"
                                onClick={() => {
                                    triggerHaptic('light');
                                    setEditorRecipe('new');
                                }}
                                className="shrink-0 rounded-xl border border-amber-500/25 bg-amber-500/15 px-3 py-2 text-[11px] font-bold text-amber-300 transition-all hover:bg-amber-500/25 active:scale-95"
                            >
                                + New Recipe
                            </button>
                        </div>

                        {visibleSavedRecipes.length === 0 ? (
                            <div className="text-center py-12">
                                <span className="text-5xl">📖</span>
                                <p className="text-sm font-bold text-gray-300 mt-4">No Saved Recipes</p>
                                <p className="text-[11px] text-gray-500 mt-1">
                                    Create your own recipe or save one when you schedule a meal plan
                                </p>
                            </div>
                        ) : (
                            visibleSavedRecipes.map((recipe) => (
                                <div
                                    key={recipe.id}
                                    className="p-3 rounded-xl bg-white/[0.03] border border-white/[0.06] space-y-2"
                                >
                                    <div className="flex items-start gap-3">
                                        <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-amber-800/40 to-orange-700/40 flex items-center justify-center flex-shrink-0 text-xl">
                                            🍽️
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-xs font-bold text-white truncate">{recipe.title}</p>
                                            <p className="text-[11px] text-gray-500">
                                                ⏱️ {recipe.ready_in_minutes} min · 👥 {recipe.servings} serves ·{' '}
                                                {recipe.ingredients.length} ingredients
                                            </p>
                                            {recipe.is_favorite && (
                                                <span className="text-[11px] text-amber-400">⭐ Favourite</span>
                                            )}
                                        </div>
                                        {recipe.is_custom &&
                                            (recipe.user_id === null || recipe.user_id === currentUserId) && (
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        triggerHaptic('light');
                                                        setEditorRecipe(recipe);
                                                    }}
                                                    aria-label={`Edit ${recipe.title}`}
                                                    className="shrink-0 rounded-lg border border-white/[0.08] bg-white/[0.04] px-2.5 py-1.5 text-[11px] font-bold text-gray-300 transition-colors hover:bg-white/[0.08]"
                                                >
                                                    Edit
                                                </button>
                                            )}
                                    </div>

                                    {/* Ingredients preview */}
                                    <div className="flex flex-wrap gap-1">
                                        {recipe.ingredients.slice(0, 4).map((ing, i) => (
                                            <span
                                                key={i}
                                                className="px-2 py-0.5 rounded-full text-[11px] bg-white/[0.04] text-gray-400 border border-white/[0.06]"
                                            >
                                                {ing.name}
                                            </span>
                                        ))}
                                        {recipe.ingredients.length > 4 && (
                                            <span className="text-[11px] text-gray-500">
                                                +{recipe.ingredients.length - 4}
                                            </span>
                                        )}
                                    </div>

                                    {recipe.source_url && (
                                        <p className="text-[11px] text-gray-500">
                                            🔗 Imported recipe · available offline
                                        </p>
                                    )}
                                </div>
                            ))
                        )}
                    </div>
                )}
            </div>

            {identityOwnsRenderedData && editorRecipe && (
                <RecipeEditor
                    key={editorRecipe === 'new' ? 'new' : editorRecipe.id}
                    recipe={editorRecipe === 'new' ? undefined : editorRecipe}
                    onSaved={refreshSavedRecipes}
                    onClose={() => setEditorRecipe(null)}
                />
            )}

            {identityOwnsRenderedData &&
                activeCookingMeal &&
                typeof document !== 'undefined' &&
                createPortal(
                    <GalleyCookingMode
                        meal={activeCookingMeal}
                        onClose={closeCookingMode}
                        onComplete={closeCookingMode}
                    />,
                    document.body,
                )}
        </div>
    );
};
