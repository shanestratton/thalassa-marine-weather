/**
 * GalleyPage — Standalone galley view for solo sailors.
 *
 * Accessible directly from VesselHub Ship's Office grid.
 * Renders Chef's Plate cards for all active meals + recipe browser.
 * Works fully offline — recipes are persisted to LocalDatabase.
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
    getMealsByStatus,
    getMealPlans,
    startCooking,
    completeMeal,
    getStoresAvailability,
    type MealPlan,
} from '../../services/MealPlanService';
import { getShoppingList, type ShoppingListSummary } from '../../services/ShoppingListService';
import { getStoredRecipes, type StoredRecipe } from '../../services/GalleyRecipeService';
import { triggerHaptic } from '../../utils/system';

interface GalleyPageProps {
    onBack: () => void;
}

export const GalleyPage: React.FC<GalleyPageProps> = ({ onBack }) => {
    const [tab, setTab] = useState<'active' | 'recipes'>('active');
    const [activeMeals, setActiveMeals] = useState<MealPlan[]>([]);
    const [savedRecipes, setSavedRecipes] = useState<StoredRecipe[]>([]);
    const [shoppingSummary, setShoppingSummary] = useState<ShoppingListSummary | null>(null);
    const [cookingId, setCookingId] = useState<string | null>(null);

    useEffect(() => {
        const reserved = getMealsByStatus('reserved');
        const cooking = getMealsByStatus('cooking');
        setActiveMeals([...cooking, ...reserved]);
        setShoppingSummary(getShoppingList());
        setSavedRecipes(getStoredRecipes());
    }, []);

    const handleCookNow = useCallback(async (meal: MealPlan) => {
        setCookingId(meal.id);
        triggerHaptic('heavy');
        await startCooking(meal.id);
        await completeMeal(meal.id);
        setCookingId(null);

        // Refresh
        const reserved = getMealsByStatus('reserved');
        const cooking = getMealsByStatus('cooking');
        setActiveMeals([...cooking, ...reserved]);
    }, []);

    const storesAvail = getStoresAvailability();
    const reservedCount = storesAvail.filter((s) => s.reserved > 0).length;

    return (
        <div className="flex flex-col h-full bg-slate-950 text-white">
            {/* Header */}
            <div className="flex items-center gap-3 p-4 border-b border-white/[0.06]">
                <button
                    onClick={onBack}
                    className="w-9 h-9 rounded-lg bg-white/[0.06] flex items-center justify-center text-gray-400 hover:bg-white/[0.1]"
                    aria-label="Back"
                >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                    </svg>
                </button>
                <div className="flex-1">
                    <h1 className="text-base font-black">Galley</h1>
                    <p className="text-[10px] text-amber-400/60 uppercase tracking-widest">
                        {activeMeals.length} active · {savedRecipes.length} saved · {reservedCount} reserved
                    </p>
                </div>
                <div className="px-2 py-1 rounded-md bg-amber-500/10 border border-amber-500/15">
                    <span className="text-[9px] font-bold text-amber-400/70 tracking-widest uppercase">
                        Offline Ready
                    </span>
                </div>
            </div>

            {/* Tab bar */}
            <div className="flex border-b border-white/[0.06]">
                <button
                    onClick={() => setTab('active')}
                    className={`flex-1 py-2.5 text-[11px] font-bold uppercase tracking-[0.15em] transition-colors ${
                        tab === 'active'
                            ? 'text-amber-400 border-b-2 border-amber-400'
                            : 'text-gray-500 hover:text-gray-300'
                    }`}
                >
                    🍳 Active Meals
                </button>
                <button
                    onClick={() => setTab('recipes')}
                    className={`flex-1 py-2.5 text-[11px] font-bold uppercase tracking-[0.15em] transition-colors ${
                        tab === 'recipes'
                            ? 'text-sky-400 border-b-2 border-sky-400'
                            : 'text-gray-500 hover:text-gray-300'
                    }`}
                >
                    📖 Saved Recipes ({savedRecipes.length})
                </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto">
                {tab === 'active' && (
                    <div className="space-y-4 p-4">
                        {activeMeals.length === 0 ? (
                            <div className="text-center py-12">
                                <span className="text-5xl">🍽️</span>
                                <p className="text-sm font-bold text-gray-300 mt-4">No Active Meals</p>
                                <p className="text-[11px] text-gray-500 mt-1">
                                    Schedule recipes from the Saved Recipes tab or use a passage meal plan
                                </p>
                            </div>
                        ) : (
                            activeMeals.map((meal) => (
                                <div
                                    key={meal.id}
                                    className="rounded-2xl bg-white/[0.02] border border-white/[0.06] overflow-hidden"
                                >
                                    {/* Mini hero */}
                                    <div className="relative h-28 bg-gradient-to-br from-amber-900/60 via-orange-800/40 to-red-900/60">
                                        <div className="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black/70 to-transparent">
                                            <p className="text-sm font-black text-white">{meal.title}</p>
                                            <p className="text-[10px] text-amber-300/70">
                                                {meal.planned_date} · {meal.meal_slot} · {meal.servings_planned} serves
                                            </p>
                                        </div>
                                        <div className="absolute top-2 right-2 px-2 py-0.5 rounded-md bg-black/40 backdrop-blur-sm">
                                            <span className="text-[8px] font-bold text-white/50 tracking-widest uppercase">
                                                SupaSpoon™
                                            </span>
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
                                            <p className="text-[10px] text-gray-500 pl-6">
                                                +{meal.ingredients.length - 5} more
                                            </p>
                                        )}
                                    </div>

                                    {/* Actions */}
                                    <div className="p-3 pt-0 flex gap-2">
                                        <button
                                            onClick={() => handleCookNow(meal)}
                                            disabled={cookingId === meal.id}
                                            className="flex-1 py-2.5 bg-gradient-to-r from-amber-500/15 to-orange-500/15 border border-amber-500/20 rounded-xl text-[11px] font-bold uppercase tracking-widest text-amber-300 disabled:opacity-40 active:scale-[0.97]"
                                        >
                                            {cookingId === meal.id ? '⏳ Subtracting…' : '🔥 Cook Now'}
                                        </button>
                                        <button
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
                                            aria-label="Share"
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
                        {shoppingSummary && shoppingSummary.remaining > 0 && (
                            <div className="p-3 rounded-xl bg-red-500/[0.04] border border-red-500/[0.08] flex items-center gap-3">
                                <span className="text-lg">🛒</span>
                                <div>
                                    <p className="text-xs font-bold text-red-300">
                                        {shoppingSummary.remaining} items still needed
                                    </p>
                                    <p className="text-[10px] text-gray-500">
                                        {shoppingSummary.purchased}/{shoppingSummary.total} purchased
                                    </p>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {tab === 'recipes' && (
                    <div className="p-4 space-y-3">
                        {savedRecipes.length === 0 ? (
                            <div className="text-center py-12">
                                <span className="text-5xl">📖</span>
                                <p className="text-sm font-bold text-gray-300 mt-4">No Saved Recipes</p>
                                <p className="text-[11px] text-gray-500 mt-1">
                                    Recipes are saved automatically when you schedule a meal plan
                                </p>
                            </div>
                        ) : (
                            savedRecipes.map((recipe) => (
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
                                            <p className="text-[10px] text-gray-500">
                                                ⏱️ {recipe.ready_in_minutes} min · 👥 {recipe.servings} serves ·{' '}
                                                {recipe.ingredients.length} ingredients
                                            </p>
                                            {recipe.is_favorite && (
                                                <span className="text-[9px] text-amber-400">⭐ Favourite</span>
                                            )}
                                        </div>
                                    </div>

                                    {/* Ingredients preview */}
                                    <div className="flex flex-wrap gap-1">
                                        {recipe.ingredients.slice(0, 4).map((ing, i) => (
                                            <span
                                                key={i}
                                                className="px-2 py-0.5 rounded-full text-[10px] bg-white/[0.04] text-gray-400 border border-white/[0.06]"
                                            >
                                                {ing.name}
                                            </span>
                                        ))}
                                        {recipe.ingredients.length > 4 && (
                                            <span className="text-[10px] text-gray-500">
                                                +{recipe.ingredients.length - 4}
                                            </span>
                                        )}
                                    </div>

                                    {/* SupaSpoon attribution */}
                                    {recipe.source_url && (
                                        <p className="text-[9px] text-gray-600">🔗 via SupaSpoon™ · saved offline</p>
                                    )}
                                </div>
                            ))
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};
