/**
 * GalleyPage — Standalone galley view for solo sailors.
 *
 * Opened from the Boat Binder's Reference group on the Vessel hub.
 * Renders Chef's Plate cards for all active meals + recipe browser.
 * Works fully offline — recipes are persisted to LocalDatabase.
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { usePanePortalTarget } from '../../context/PanePortalContext';
import { EmptyState } from '../ui/EmptyState';
import { PageHeader } from '../ui/PageHeader';
import { Button } from '../ui/Button';
import { SignInScreen } from '../SignInScreen';
import { CartIcon, ClipboardIcon, FoodIcon, PackageIcon, ShareIcon, StarIcon } from '../Icons';
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
    const portalTarget = usePanePortalTarget();
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
    const [showSignIn, setShowSignIn] = useState(false);
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
        setShowSignIn(false);

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
        return typeof document !== 'undefined' ? createPortal(groceryList, portalTarget!) : groceryList;
    }

    return (
        <div className="flex flex-col h-full bg-slate-950 text-white slide-up-enter">
            {/* Header — standard PageHeader (title scale: text-xl font-extrabold uppercase) */}
            <div className="border-b border-white/6">
                <PageHeader
                    title="Galley"
                    // Same parent crumb as its binder siblings (Stores, Maintenance…).
                    breadcrumbs={['Boat Binder', 'Galley']}
                    subtitle={
                        /* PageHeader's own grey subtitle, like every other page. Each
                           count is one unbreakable unit and the separator binds to the
                           count before it, so a wrap never starts a line with '·'.
                           The stores count says what it is ('0 stores held' was
                           opaque) and only shows when something is held back for a
                           planned meal (UX scorecard run 7). */
                        <p className="ui-caption text-xs text-gray-300 uppercase tracking-widest">
                            <span className="whitespace-nowrap">
                                {visibleActiveMeals.length} meal{visibleActiveMeals.length === 1 ? '' : 's'}
                                &nbsp;·
                            </span>{' '}
                            <span className="whitespace-nowrap">
                                {visibleSavedRecipes.length} recipe{visibleSavedRecipes.length === 1 ? '' : 's'}
                                {reservedCount > 0 && <>&nbsp;·</>}
                            </span>
                            {reservedCount > 0 && (
                                <>
                                    {' '}
                                    <span className="whitespace-nowrap">{reservedCount} reserved from stores</span>
                                </>
                            )}
                        </p>
                    }
                    onBack={onBack}
                />
                {/* A static note, so plain grey caption text (UX scorecard run 6):
                    as an amber chip it read as a warning or as the live offline
                    badge. It sits under the header, aligned to the title column
                    (16 px gutter + 44 px back button + 12 px gap), so the back
                    chevron stays level with its sibling pages. */}
                <p className="-mt-1.5 pb-3 pl-[72px] pr-4 text-xs text-gray-400">Works offline</p>
            </div>

            {/* Tab bar */}
            <div className="flex border-b border-white/6" role="tablist" aria-label="Galley sections">
                <button
                    type="button"
                    onClick={() => setTab('active')}
                    onKeyDown={(event) => handleTabKeyDown(event, 'active')}
                    id="galley-active-tab"
                    role="tab"
                    aria-selected={tab === 'active'}
                    aria-controls="galley-active-panel"
                    tabIndex={tab === 'active' ? 0 : -1}
                    // The house tab accent: amber made Galley the odd one out (UX
                    // scorecard run 7).
                    className={`min-h-[44px] flex-1 py-2.5 text-[11px] font-bold uppercase tracking-[0.15em] transition-colors ${
                        tab === 'active'
                            ? 'text-sky-400 border-b-2 border-sky-400'
                            : 'text-gray-400 hover:text-gray-200'
                    }`}
                >
                    <span className="inline-flex items-center justify-center gap-1.5">
                        <FoodIcon className="h-3.5 w-3.5" />
                        Active meals
                    </span>
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
                    className={`min-h-[44px] flex-1 py-2.5 text-[11px] font-bold uppercase tracking-[0.15em] transition-colors ${
                        tab === 'recipes'
                            ? 'text-sky-400 border-b-2 border-sky-400'
                            : 'text-gray-400 hover:text-gray-200'
                    }`}
                >
                    <span className="inline-flex items-center justify-center gap-1.5">
                        <ClipboardIcon className="h-3.5 w-3.5" />
                        Saved recipes ({visibleSavedRecipes.length})
                    </span>
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
                            // Not a dead end: the action goes where meals are actually
                            // planned — the Departure Brief on the Passage Planning page
                            // ('crew' view). Signed out, that page is a sign-in wall
                            // about routes, so the action says so and signs in here
                            // instead. The recipes are the tab above; the duplicate
                            // 'Open saved recipes' link is gone (UX scorecard run 7).
                            currentUserId ? (
                                <EmptyState
                                    icon={<FoodIcon className="h-8 w-8 [stroke-width:1.5]" />}
                                    title="No active meals"
                                    subtitle="Plan meals in a passage's Departure Brief and they appear here, ready to cook."
                                    actionLabel="Plan meals in Departure Brief"
                                    onAction={() => {
                                        triggerHaptic('light');
                                        window.dispatchEvent(
                                            new CustomEvent('thalassa:navigate', { detail: { tab: 'crew' } }),
                                        );
                                    }}
                                />
                            ) : (
                                <EmptyState
                                    icon={<FoodIcon className="h-8 w-8 [stroke-width:1.5]" />}
                                    title="No active meals"
                                    subtitle="Meals are planned in a passage's Departure Brief, which needs an account."
                                    actionLabel="Sign in to plan meals"
                                    onAction={() => {
                                        triggerHaptic('light');
                                        setShowSignIn(true);
                                    }}
                                />
                            )
                        ) : (
                            visibleActiveMeals.map((meal) => (
                                <div
                                    key={meal.id}
                                    className="rounded-2xl bg-white/2 border border-white/6 overflow-hidden"
                                >
                                    {/* Mini hero */}
                                    <div className="relative h-28 bg-linear-to-br from-amber-900/60 via-orange-800/40 to-red-900/60">
                                        <div className="absolute bottom-0 left-0 right-0 p-3 bg-linear-to-t from-black/70 to-transparent">
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
                                                <PackageIcon className="h-3.5 w-3.5 shrink-0 text-gray-500" />
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
                                            className="flex-1 min-h-[44px] py-2.5 bg-linear-to-r from-amber-500/15 to-orange-500/15 border border-amber-500/20 rounded-xl text-sm font-bold text-amber-300 disabled:opacity-40 active:scale-[0.97]"
                                        >
                                            {meal.status === 'cooking' ? 'Resume cooking' : 'Cook now'}
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
                                            className="w-11 min-h-[44px] flex items-center justify-center border border-white/8 bg-white/3 rounded-xl text-gray-400"
                                            aria-label={`Share ${meal.title}`}
                                        >
                                            <ShareIcon className="w-4 h-4" />
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
                                        ? 'bg-red-500/4 border-red-500/8 hover:bg-red-500/8'
                                        : visibleShoppingSummary.total > 0
                                          ? 'bg-emerald-500/4 border-emerald-500/10 hover:bg-emerald-500/8'
                                          : 'bg-white/2 border-white/6 hover:bg-white/5'
                                }`}
                            >
                                <span
                                    aria-hidden="true"
                                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/5"
                                >
                                    <CartIcon className="h-5 w-5 text-gray-300" />
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
                            <Button
                                variant="secondary"
                                onClick={() => {
                                    triggerHaptic('light');
                                    setEditorRecipe('new');
                                }}
                                className="shrink-0 text-white"
                            >
                                <svg
                                    aria-hidden="true"
                                    className="h-3.5 w-3.5"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2.5}
                                >
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                                </svg>
                                New recipe
                            </Button>
                        </div>

                        {visibleSavedRecipes.length === 0 ? (
                            <EmptyState
                                icon={<ClipboardIcon className="h-8 w-8 [stroke-width:1.5]" />}
                                title="No saved recipes"
                                subtitle="Create your own recipe or save one when you schedule a meal plan."
                            />
                        ) : (
                            visibleSavedRecipes.map((recipe) => (
                                <div
                                    key={recipe.id}
                                    className="p-3 rounded-xl bg-white/3 border border-white/6 space-y-2"
                                >
                                    <div className="flex items-start gap-3">
                                        <div className="w-12 h-12 rounded-lg bg-linear-to-br from-amber-800/40 to-orange-700/40 flex items-center justify-center shrink-0">
                                            <FoodIcon className="h-6 w-6 text-amber-300" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-xs font-bold text-white truncate">{recipe.title}</p>
                                            <p className="text-[11px] text-gray-500">
                                                {recipe.ready_in_minutes} min · {recipe.servings} serves ·{' '}
                                                {recipe.ingredients.length} ingredients
                                            </p>
                                            {recipe.is_favorite && (
                                                <span className="inline-flex items-center gap-1 text-[11px] text-amber-400">
                                                    <StarIcon filled className="h-3 w-3" />
                                                    Favourite
                                                </span>
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
                                                    className="shrink-0 min-h-[44px] rounded-lg border border-white/8 bg-white/4 px-2.5 py-1.5 text-[11px] font-bold text-gray-300 transition-colors hover:bg-white/8"
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
                                                className="px-2 py-0.5 rounded-full text-[11px] bg-white/4 text-gray-400 border border-white/6"
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
                                        <p className="text-[11px] text-gray-500">Imported recipe · available offline</p>
                                    )}
                                </div>
                            ))
                        )}
                    </div>
                )}
            </div>

            <SignInScreen
                isOpen={showSignIn}
                onClose={() => setShowSignIn(false)}
                prompt="Sign in to plan meals in a passage's Departure Brief."
            />

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
                    portalTarget!,
                )}
        </div>
    );
};
