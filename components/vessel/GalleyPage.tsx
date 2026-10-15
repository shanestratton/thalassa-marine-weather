/**
 * GalleyPage — Standalone galley view for solo sailors.
 *
 * Opened from the Boat Binder's Reference group on the Vessel hub.
 * Renders the active meals, Today and Next first under plain dates (132-B17,
 * GAL-11), + recipe browser. Works fully offline — recipes are persisted to
 * LocalDatabase. A read that fails shows the house LoadErrorState, never the
 * empty galley, and offline the header says "Saved locally" (132-B17).
 *
 * Shared galley (Shane 2026-10-03, "can we share the galley as well with
 * invitees"): while a skipper shares their Galley with this sailor, the page
 * shows and uses the SKIPPER's galley (recipes, and the meals and grocery list
 * kept with no passage) in place of the sailor's own, live, with the
 * "Shared from <boat> — you're crew" line under the title.
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { usePanePortalTarget } from '../../context/PanePortalContext';
import { EmptyState } from '../ui/EmptyState';
import { LoadErrorState } from '../ui/LoadErrorState';
import { OfflineBadge } from '../ui/OfflineBadge';
import { PageHeader } from '../ui/PageHeader';
import { Button } from '../ui/Button';
import { SignInButton } from '../ui/SignInButton';
import { SignInScreen } from '../SignInScreen';
import { appleSignInHoldsSheet } from '../../services/auth/appleSignInAttempt';
import { CartIcon, ClipboardIcon, FoodIcon, PackageIcon, ShareIcon, StarIcon } from '../Icons';
import {
    getMealsByStatus,
    getMealPlans as _getMealPlans,
    getStoresAvailability,
    type MealPlan,
} from '../../services/MealPlanService';
import { getShoppingList, type ShoppingListSummary } from '../../services/ShoppingListService';
import { getStoredRecipes, type StoredRecipe } from '../../services/GalleyRecipeService';
import { purgeOrphanRecipeImagesWhenIdle } from '../../services/galley/recipeImagePurge';
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
import { useBinderSource } from '../../hooks/useBinderSource';
import { isGalleyShareLive } from '../../services/vessel/sharedBinders';
import { SharedBinderLine, bringingInCopy } from './SharedBinderLine';
import { createLogger, getErrorMessage } from '../../utils/createLogger';
import { activeMealSections, mealWhenLine } from '../../services/galley/activeMeals';

// A device-log trace (GAL-13): a reason and the error message, never an id.
const log = createLogger('Galley');

interface GalleyPageProps {
    onBack: () => void;
}

const GALLEY_TABS = ['active', 'recipes'] as const;

/** What this page reads from the phone, each of which can fail on its own (132-B17). */
type GalleyLoad = 'meals' | 'recipes' | 'shopping';
const NO_LOAD_ERRORS: Record<GalleyLoad, boolean> = { meals: false, recipes: false, shopping: false };

/**
 * The house load-error words for a read from this phone (132-B17): a failed
 * read is not an empty galley, and connection advice would be wrong here.
 */
const LOCAL_LOAD_ERROR = 'This is a loading problem, not an empty list. Nothing has been removed. Try again.';

/**
 * The galley kept with no passage: the sailor's own, or the skipper's while
 * they share it (`galleyOwner`). Crew in a shared galley can tick grocery
 * items bought (canEditStores here means "may tick"); whether Ship's Stores
 * gets the receipt is the Stores share's call (ShoppingListService).
 */
function personalGalleyStatus(userId: string | null, galleyOwner: string | null = null): PassageStatus {
    if (!userId) return NO_PASSAGE_ACCESS;
    return {
        visible: true,
        voyageId: null,
        ownerUserId: galleyOwner ?? userId,
        isOwner: !galleyOwner,
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
    /** Which reads failed, kept apart from an empty galley (132-B17). */
    const [loadErrors, setLoadErrors] = useState<Record<GalleyLoad, boolean>>(NO_LOAD_ERRORS);
    const restoreShoppingFocusRef = useRef(false);
    const shoppingListButtonRef = useRef<HTMLButtonElement>(null);
    const reloadGalleyRef = useRef<() => void>(() => undefined);
    const { source: galley, fetchingSkipperBinder: fetchingSkipperGalley } = useBinderSource('galley', {
        reload: () => reloadGalleyRef.current(),
        rowCount: activeMeals.length + savedRecipes.length,
    });
    const galleyOwner = galley.mode === 'shared' ? galley.ownerId : null;
    // Recipes and meal plans are on the realtime publication only once the
    // galley can be shared (migration 20261003100000); until then no channel.
    const galleyLive = isGalleyShareLive();
    const identityOwnsRenderedData =
        resolvedIdentityKey === renderIdentityScope.key && renderIdentityScope.userId === currentUserId;
    const visiblePassageStatus = identityOwnsRenderedData ? passageStatus : NO_PASSAGE_ACCESS;
    const visiblePassageAccessLoaded = identityOwnsRenderedData ? passageAccessLoaded : false;
    const visibleActiveMeals = identityOwnsRenderedData ? activeMeals : [];
    const visibleSavedRecipes = identityOwnsRenderedData ? savedRecipes : [];
    const visibleShoppingSummary = identityOwnsRenderedData ? shoppingSummary : null;
    const visibleLoadErrors = identityOwnsRenderedData ? loadErrors : NO_LOAD_ERRORS;
    const loadFailed = useCallback(
        (load: GalleyLoad, failed: boolean) =>
            setLoadErrors((previous) => (previous[load] === failed ? previous : { ...previous, [load]: failed })),
        [],
    );

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
        setLoadErrors(NO_LOAD_ERRORS);
        // Mid Apple sign-in the account changes before its last steps run: the
        // sheet closes itself once they finish, or shows the failed step.
        if (!appleSignInHoldsSheet()) setShowSignIn(false);

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
                setPassageStatus(personalGalleyStatus(currentUserId, galleyOwner));
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
                .catch((error) => {
                    log.warn('galley: passage-status', getErrorMessage(error));
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
    }, [currentUserId, galleyOwner]);

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

    // Each read on its own (132-B17): one that fails says so in its own place,
    // with a trace and its own reason, and never reads as an empty galley.
    const refreshSavedRecipes = useCallback(() => {
        try {
            setSavedRecipes(getStoredRecipes());
            loadFailed('recipes', false);
        } catch (error) {
            log.warn('galley: load-recipes', getErrorMessage(error));
            loadFailed('recipes', true);
        }
    }, [loadFailed]);

    const refreshActiveMeals = useCallback(() => {
        if (!visiblePassageAccessLoaded || !visiblePassageStatus.visible) {
            setActiveMeals([]);
            loadFailed('meals', false);
            return;
        }
        try {
            const reserved = getMealsByStatus('reserved', visiblePassageStatus.voyageId);
            const cooking = getMealsByStatus('cooking', visiblePassageStatus.voyageId);
            setActiveMeals([...cooking, ...reserved]);
            loadFailed('meals', false);
        } catch (error) {
            log.warn('galley: load-meals', getErrorMessage(error));
            loadFailed('meals', true);
        }
    }, [loadFailed, visiblePassageAccessLoaded, visiblePassageStatus.visible, visiblePassageStatus.voyageId]);

    const refreshShoppingSummary = useCallback(() => {
        if (!visiblePassageAccessLoaded || !visiblePassageStatus.visible) {
            setShoppingSummary(null);
            loadFailed('shopping', false);
            return;
        }
        try {
            setShoppingSummary(getShoppingList(visiblePassageStatus.voyageId, visiblePassageStatus.ownerUserId));
            loadFailed('shopping', false);
        } catch (error) {
            log.warn('galley: load-shopping', getErrorMessage(error));
            setShoppingSummary(null);
            loadFailed('shopping', true);
        }
    }, [
        loadFailed,
        visiblePassageAccessLoaded,
        visiblePassageStatus.ownerUserId,
        visiblePassageStatus.visible,
        visiblePassageStatus.voyageId,
    ]);

    // Today and Next first, in the order the meals are eaten (GAL-11).
    const mealSections = activeMealSections(visibleActiveMeals);

    useEffect(() => {
        refreshActiveMeals();
        refreshShoppingSummary();
        refreshSavedRecipes();
    }, [refreshActiveMeals, refreshSavedRecipes, refreshShoppingSummary]);

    // Once per install, at idle: throwaway recipe photo copies go (126-B2a, GAL-12).
    useEffect(() => purgeOrphanRecipeImagesWhenIdle(), []);

    // A sync that brought rows in, or the galley changing hands, reloads all three.
    reloadGalleyRef.current = () => {
        refreshActiveMeals();
        refreshShoppingSummary();
        refreshSavedRecipes();
    };

    useRealtimeSync('shopping_list', refreshShoppingSummary);
    // One channel each, so a table the server is not publishing cannot take
    // the grocery list's channel down with it.
    useRealtimeSync('meal_plans', refreshActiveMeals, galleyLive);
    useRealtimeSync('recipes', refreshSavedRecipes, galleyLive);

    const handleCookNow = useCallback((meal: MealPlan) => {
        triggerHaptic('medium');
        setActiveCookingMeal(meal);
    }, []);

    /** The meal and its ingredients to the share sheet, or the clipboard where there is none. */
    const shareMeal = useCallback((meal: MealPlan) => {
        const text = `${meal.title}\n${meal.ingredients.map((i) => `${i.amount} ${i.unit} ${i.name}`).join('\n')}`;
        if (navigator.share) {
            navigator.share({ title: meal.title, text }).catch((error: unknown) => {
                // Closing the share sheet is not a failure.
                if ((error as { name?: string } | null)?.name !== 'AbortError') {
                    log.warn('galley: share-meal', getErrorMessage(error));
                }
            });
        } else {
            navigator.clipboard
                .writeText(text)
                .then(() => triggerHaptic('light'))
                .catch((error: unknown) => log.warn('galley: copy-meal', getErrorMessage(error)));
        }
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
                    // "Saved locally" offline, as its binder siblings say it (132-B17).
                    status={
                        <>
                            <OfflineBadge />
                            <SharedBinderLine register="galley" source={galley} />
                        </>
                    }
                    subtitle={
                        /* The bold tracked count its binder siblings wear (Stores,
                           Documents, Checklists, Diary); a regular-weight caption
                           read lighter than them (UX scorecard run 8). Each
                           count is one unbreakable unit and the separator binds to the
                           count before it, so a wrap never starts a line with '·'.
                           The stores count says what it is ('0 stores held' was
                           opaque) and only shows when something is held back for a
                           planned meal (UX scorecard run 7). */
                        <p className="text-label text-gray-400 font-bold uppercase tracking-widest">
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
                {/* 'Saved recipes open offline' no longer sits here: under the
                    header it floated over the Active meals tab it says nothing
                    about (UX scorecard run 9). The Saved recipes tab says it,
                    under Your recipe library. */}
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
                    {/* No '(n)' here: the header count above already says how many
                        recipes there are (UX scorecard run 8: '(0)' twice). */}
                    <span className="inline-flex items-center justify-center gap-1.5">
                        <ClipboardIcon className="h-3.5 w-3.5" />
                        Saved recipes
                    </span>
                </button>
            </div>

            {/* Content. Pads its own bottom clear of the tab bar that floats over
                it, as its binder siblings do, and fades under the bar: with two
                meals on a phone "Open shopping list" (the only way into the
                grocery list) ended under the bar, untappable (audit GAL-01). */}
            <div
                className="thalassa-scroll-fade thalassa-scroll-fade--nav flex-1 overflow-y-auto"
                style={{ paddingBottom: 'calc(var(--thalassa-tabbar-height) + 16px)' }}
            >
                {tab === 'active' && (
                    <div
                        id="galley-active-panel"
                        role="tabpanel"
                        aria-labelledby="galley-active-tab"
                        tabIndex={0}
                        className="space-y-4 p-4"
                    >
                        {visibleLoadErrors.meals ? (
                            // A failed read, not "No active meals" (132-B17).
                            <LoadErrorState
                                what="your planned meals"
                                onRetry={refreshActiveMeals}
                                description={LOCAL_LOAD_ERROR}
                            />
                        ) : visibleActiveMeals.length === 0 && fetchingSkipperGalley ? (
                            <p role="status" className="py-16 text-center text-sm font-semibold text-gray-400">
                                {bringingInCopy(galley, 'galley')}
                            </p>
                        ) : visibleActiveMeals.length === 0 ? (
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
                                    // Says where the Departure Brief lives (UX scorecard run 9).
                                    subtitle="Plan meals in the Departure Brief on Crew & Float Plan and they appear here, ready to cook."
                                    actionLabel="Plan meals in Departure Brief"
                                    onAction={() => {
                                        triggerHaptic('light');
                                        window.dispatchEvent(
                                            new CustomEvent('thalassa:navigate', { detail: { tab: 'crew' } }),
                                        );
                                    }}
                                />
                            ) : (
                                // The one sign-in card (Account & Cloud, Voyage Log): a
                                // left-aligned title and reason, then the full-width
                                // 44 pt SignInButton. An outlined 'Sign in to plan meals'
                                // was the fourth sign-in look (UX scorecard run 8).
                                <section
                                    aria-labelledby="galley-sign-in-title"
                                    className="space-y-4 rounded-2xl border border-white/10 bg-white/3 p-4 shadow-lg shadow-black/10"
                                >
                                    <div className="flex items-start gap-3">
                                        <div
                                            className="shrink-0 rounded-xl bg-white/5 p-2.5 text-gray-300"
                                            aria-hidden="true"
                                        >
                                            <FoodIcon className="h-5 w-5" />
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <h2 id="galley-sign-in-title" className="text-sm font-bold text-white">
                                                Sign in to plan meals
                                            </h2>
                                            {/* No "Departure Brief" while signed out (UX
                                                scorecard run 10): the signed-out Crew &
                                                Float Plan page never names it. */}
                                            <p className="mt-1 text-xs text-gray-400">
                                                No active meals yet. You plan meals for a passage on Crew &amp; Float
                                                Plan, which needs an&nbsp;account.
                                            </p>
                                        </div>
                                    </div>
                                    <SignInButton
                                        fullWidth
                                        onClick={() => {
                                            triggerHaptic('light');
                                            setShowSignIn(true);
                                        }}
                                    />
                                </section>
                            )
                        ) : (
                            // Today and Next first, then Later and Earlier, each in
                            // the order the meals are eaten, under plain dates; the
                            // card is Ship's Stores' card, without the 112 px
                            // decorative gradient each meal wore (GAL-11).
                            mealSections.map((section) => (
                                <section
                                    key={section.group}
                                    aria-labelledby={`galley-meals-${section.group}`}
                                    className="space-y-2"
                                >
                                    <h2
                                        id={`galley-meals-${section.group}`}
                                        className="flex items-center gap-2 text-label font-black uppercase tracking-widest text-gray-400"
                                    >
                                        {section.title}
                                        <span className="text-micro font-bold tabular-nums">
                                            ({section.meals.length})
                                        </span>
                                    </h2>
                                    {section.group === 'earlier' && (
                                        <p className="text-xs text-gray-400">
                                            Planned for a day that has passed and not cooked yet, so their ingredients
                                            are still set aside. Cook or skip them.
                                        </p>
                                    )}
                                    {section.meals.map((meal) => (
                                        <div
                                            key={meal.id}
                                            className="space-y-2 rounded-lg border border-white/5 bg-slate-800/40 p-3"
                                        >
                                            <div className="flex items-start gap-3">
                                                <span
                                                    aria-hidden="true"
                                                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-300"
                                                >
                                                    <FoodIcon className="h-5 w-5" />
                                                </span>
                                                <div className="min-w-0 flex-1">
                                                    <h3 className="text-sm font-bold text-white [overflow-wrap:anywhere]">
                                                        {meal.title}
                                                    </h3>
                                                    <p className="text-label text-gray-400 tabular-nums">
                                                        {mealWhenLine(meal)}
                                                    </p>
                                                    {meal.status === 'cooking' && (
                                                        <p className="text-label font-bold text-amber-300">
                                                            Cooking now
                                                        </p>
                                                    )}
                                                </div>
                                            </div>

                                            {/* Ingredients */}
                                            <ul className="space-y-1">
                                                {meal.ingredients.slice(0, 5).map((ing, i) => (
                                                    <li key={i} className="flex items-center gap-2 text-xs">
                                                        <PackageIcon className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                                                        <span className="min-w-0 text-gray-300 [overflow-wrap:anywhere]">
                                                            <span className="tabular-nums">
                                                                {ing.amount} {ing.unit}
                                                            </span>{' '}
                                                            {ing.name}
                                                        </span>
                                                    </li>
                                                ))}
                                                {meal.ingredients.length > 5 && (
                                                    <li className="pl-5.5 text-label text-gray-400">
                                                        +{meal.ingredients.length - 5} more
                                                    </li>
                                                )}
                                            </ul>

                                            {/* Actions */}
                                            <div className="flex gap-2">
                                                <button
                                                    type="button"
                                                    onClick={() => handleCookNow(meal)}
                                                    className="flex-1 min-h-[44px] py-2.5 bg-linear-to-r from-amber-500/15 to-orange-500/15 border border-amber-500/20 rounded-xl text-sm font-bold text-amber-300 disabled:opacity-40 active:scale-[0.97]"
                                                >
                                                    {meal.status === 'cooking' ? 'Resume cooking' : 'Cook now'}
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => shareMeal(meal)}
                                                    className="w-11 min-h-[44px] flex items-center justify-center border border-white/8 bg-white/3 rounded-xl text-gray-400"
                                                    aria-label={`Share ${meal.title}`}
                                                >
                                                    <ShareIcon className="w-4 h-4" />
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </section>
                            ))
                        )}

                        {/* Shopping status. A list that could not be read here
                            still opens: the grocery list has its own retry. */}
                        {visibleLoadErrors.shopping ? (
                            <button
                                ref={shoppingListButtonRef}
                                type="button"
                                onClick={() => {
                                    triggerHaptic('light');
                                    setShowGroceryList(true);
                                }}
                                aria-label="Open shopping list, which could not be read here"
                                className="w-full min-h-[44px] p-3 rounded-xl border border-amber-500/15 bg-amber-500/5 flex items-center gap-3 text-left transition-colors hover:bg-amber-500/10 active:scale-[0.99]"
                            >
                                <span
                                    aria-hidden="true"
                                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/5"
                                >
                                    <CartIcon className="h-5 w-5 text-gray-300" />
                                </span>
                                <div className="min-w-0 flex-1">
                                    <p className="text-xs font-bold text-amber-200">Grocery list</p>
                                    <p className="text-label text-gray-400">
                                        It could not be read here. Open it to try again.
                                    </p>
                                </div>
                                <svg
                                    className="h-4 w-4 shrink-0 text-gray-400"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                    aria-hidden="true"
                                >
                                    <path strokeLinecap="round" strokeLinejoin="round" d="m9 18 6-6-6-6" />
                                </svg>
                            </button>
                        ) : (
                            visibleShoppingSummary && (
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
                                    className={`w-full min-h-[44px] p-3 rounded-xl border flex items-center gap-3 text-left transition-colors active:scale-[0.99] ${
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
                                    <div className="min-w-0 flex-1">
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
                                        <p className="text-label text-gray-400 tabular-nums">
                                            {visibleShoppingSummary.total > 0
                                                ? `${visibleShoppingSummary.purchased}/${visibleShoppingSummary.total} purchased`
                                                : 'Add groceries, supplies, or missing ingredients'}
                                        </p>
                                    </div>
                                    <span className="text-[11px] font-bold uppercase tracking-widest text-emerald-400">
                                        Open
                                    </span>
                                    <svg
                                        className="h-4 w-4 shrink-0 text-gray-400"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth={2}
                                        aria-hidden="true"
                                    >
                                        <path strokeLinecap="round" strokeLinejoin="round" d="m9 18 6-6-6-6" />
                                    </svg>
                                </button>
                            )
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
                                <p className="text-xs font-bold text-white">
                                    {galley.mode === 'shared' ? "The skipper's recipe library" : 'Your recipe library'}
                                </p>
                                <p className="text-xs text-gray-400">Saved recipes open offline</p>
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

                        {visibleLoadErrors.recipes ? (
                            // A failed read, not "No saved recipes" (132-B17).
                            <LoadErrorState
                                what="your saved recipes"
                                onRetry={refreshSavedRecipes}
                                description={LOCAL_LOAD_ERROR}
                            />
                        ) : visibleSavedRecipes.length === 0 && fetchingSkipperGalley ? (
                            <p role="status" className="py-16 text-center text-sm font-semibold text-gray-400">
                                {bringingInCopy(galley, 'galley')}
                            </p>
                        ) : visibleSavedRecipes.length === 0 ? (
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
                prompt="Sign in to plan meals for a passage on Crew & Float Plan."
            />

            {identityOwnsRenderedData && editorRecipe && (
                <RecipeEditor
                    key={editorRecipe === 'new' ? 'new' : editorRecipe.id}
                    recipe={editorRecipe === 'new' ? undefined : editorRecipe}
                    sharedGalleyBoat={galley.mode === 'shared' ? galley.vesselName : undefined}
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
