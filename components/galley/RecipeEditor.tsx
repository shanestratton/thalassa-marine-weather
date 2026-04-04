/**
 * RecipeEditor — Multi-step recipe creation form.
 *
 * Steps:
 *   1. Title & Photo
 *   2. Details (servings, cook time, tags)
 *   3. Ingredients (add/remove list)
 *   4. Instructions (free-text)
 *   5. Visibility (personal / shared)
 *
 * Saves via createCustomRecipe() → LocalDB + Supabase.
 */
import React, { useState, useCallback } from 'react';
import {
    createCustomRecipe,
    type RecipeIngredient,
    type RecipeVisibility,
    type CreateRecipeInput,
} from '../../services/GalleyRecipeService';
import { triggerHaptic } from '../../utils/system';

interface RecipeEditorProps {
    onClose: () => void;
    onSaved: () => void;
}

const MEAL_TAGS = ['Breakfast', 'Lunch', 'Dinner', 'Snack', 'Dessert', 'Sea-Friendly', 'Quick'];

const GLASS = {
    background: 'rgba(20, 25, 35, 0.6)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: '16px',
} as React.CSSProperties;

export const RecipeEditor: React.FC<RecipeEditorProps> = ({ onClose, onSaved }) => {
    const [step, setStep] = useState(1);
    const [saving, setSaving] = useState(false);

    // Form state
    const [title, setTitle] = useState('');
    const [imageUrl, setImageUrl] = useState('');
    const [servings, setServings] = useState(4);
    const [cookTime, setCookTime] = useState(30);
    const [tags, setTags] = useState<string[]>([]);
    const [ingredients, setIngredients] = useState<RecipeIngredient[]>([
        { name: '', amount: 1, unit: '', scalable: true, aisle: 'Other' },
    ]);
    const [instructions, setInstructions] = useState('');
    const [visibility, setVisibility] = useState<RecipeVisibility>('personal');

    const totalSteps = 5;

    const toggleTag = (tag: string) => {
        setTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
    };

    const addIngredient = () => {
        setIngredients((prev) => [...prev, { name: '', amount: 1, unit: '', scalable: true, aisle: 'Other' }]);
    };

    const removeIngredient = (index: number) => {
        if (ingredients.length <= 1) return;
        setIngredients((prev) => prev.filter((_, i) => i !== index));
    };

    const updateIngredient = (index: number, field: keyof RecipeIngredient, value: string | number) => {
        setIngredients((prev) => prev.map((ing, i) => (i === index ? { ...ing, [field]: value } : ing)));
    };

    const canProceed = useCallback(() => {
        switch (step) {
            case 1:
                return title.trim().length >= 2;
            case 2:
                return servings > 0 && cookTime > 0;
            case 3:
                return ingredients.some((ing) => ing.name.trim().length > 0);
            case 4:
                return true; // Instructions are optional
            case 5:
                return true;
            default:
                return false;
        }
    }, [step, title, servings, cookTime, ingredients]);

    const handleSave = async () => {
        if (saving) return;
        setSaving(true);
        triggerHaptic('medium');

        const input: CreateRecipeInput = {
            title,
            instructions,
            image_url: imageUrl || undefined,
            ready_in_minutes: cookTime,
            servings,
            ingredients: ingredients.filter((ing) => ing.name.trim().length > 0),
            tags,
            visibility,
        };

        const result = await createCustomRecipe(input);
        setSaving(false);

        if (result) {
            triggerHaptic('heavy');
            onSaved();
            onClose();
        }
    };

    return (
        <div className="fixed inset-0 z-[1100] flex flex-col bg-black/90">
            {/* Header */}
            <div className="flex items-center justify-between px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-3">
                <button
                    onClick={onClose}
                    className="text-gray-400 hover:text-white text-sm font-bold transition-colors"
                >
                    Cancel
                </button>
                <div className="text-center">
                    <h2 className="text-white font-black text-sm tracking-wider">NEW RECIPE</h2>
                    <p className="text-[11px] text-gray-500 mt-0.5">
                        Step {step} of {totalSteps}
                    </p>
                </div>
                <div className="w-14" /> {/* Spacer */}
            </div>

            {/* Progress bar */}
            <div className="px-4 pb-4">
                <div className="h-1 bg-white/10 rounded-full overflow-hidden">
                    <div
                        className="h-full bg-gradient-to-r from-amber-500 to-orange-500 rounded-full transition-all duration-300"
                        style={{ width: `${(step / totalSteps) * 100}%` }}
                    />
                </div>
            </div>

            {/* Step content */}
            <div className="flex-1 overflow-y-auto px-4 pb-32">
                {step === 1 && (
                    <div className="space-y-4 animate-in fade-in duration-200">
                        <div style={GLASS} className="p-4">
                            <label className="block text-[11px] font-bold text-gray-400 uppercase tracking-widest mb-2">
                                Recipe Title
                            </label>
                            <input
                                type="text"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                placeholder="e.g., Mum's Fish Curry"
                                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-gray-500 text-sm outline-none focus:border-amber-500/50 transition-colors"
                                autoFocus
                            />
                        </div>

                        <div style={GLASS} className="p-4">
                            <label className="block text-[11px] font-bold text-gray-400 uppercase tracking-widest mb-2">
                                Photo URL <span className="text-gray-500">(optional)</span>
                            </label>
                            <input
                                type="url"
                                value={imageUrl}
                                onChange={(e) => setImageUrl(e.target.value)}
                                placeholder="https://..."
                                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-gray-500 text-sm outline-none focus:border-amber-500/50 transition-colors"
                            />
                            {imageUrl && (
                                <div className="mt-3 rounded-xl overflow-hidden border border-white/10 h-32">
                                    <img
                                        src={imageUrl}
                                        alt="Preview"
                                        className="w-full h-full object-cover"
                                        onError={(e) => {
                                            (e.target as HTMLImageElement).style.display = 'none';
                                        }}
                                    />
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {step === 2 && (
                    <div className="space-y-4 animate-in fade-in duration-200">
                        <div style={GLASS} className="p-4">
                            <label className="block text-[11px] font-bold text-gray-400 uppercase tracking-widest mb-2">
                                Servings
                            </label>
                            <div className="flex items-center gap-4">
                                <button
                                    onClick={() => setServings(Math.max(1, servings - 1))}
                                    className="w-10 h-10 rounded-full bg-white/10 text-white text-xl font-bold flex items-center justify-center active:scale-90 transition-transform"
                                >
                                    −
                                </button>
                                <span className="text-2xl font-black text-white min-w-[3ch] text-center">
                                    {servings}
                                </span>
                                <button
                                    onClick={() => setServings(servings + 1)}
                                    className="w-10 h-10 rounded-full bg-white/10 text-white text-xl font-bold flex items-center justify-center active:scale-90 transition-transform"
                                >
                                    +
                                </button>
                            </div>
                        </div>

                        <div style={GLASS} className="p-4">
                            <label className="block text-[11px] font-bold text-gray-400 uppercase tracking-widest mb-2">
                                Cook Time (minutes)
                            </label>
                            <div className="flex items-center gap-3">
                                {[15, 30, 45, 60, 90].map((t) => (
                                    <button
                                        key={t}
                                        onClick={() => setCookTime(t)}
                                        className={`px-3 py-2 rounded-lg text-sm font-bold transition-all ${
                                            cookTime === t
                                                ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                                                : 'bg-white/5 text-gray-400 border border-white/5'
                                        }`}
                                    >
                                        {t}m
                                    </button>
                                ))}
                            </div>
                            <input
                                type="number"
                                value={cookTime}
                                onChange={(e) => setCookTime(parseInt(e.target.value, 10) || 0)}
                                className="w-full mt-3 bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-white text-sm outline-none focus:border-amber-500/50 transition-colors"
                            />
                        </div>

                        <div style={GLASS} className="p-4">
                            <label className="block text-[11px] font-bold text-gray-400 uppercase tracking-widest mb-2">
                                Tags
                            </label>
                            <div className="flex flex-wrap gap-2">
                                {MEAL_TAGS.map((tag) => (
                                    <button
                                        key={tag}
                                        onClick={() => toggleTag(tag)}
                                        className={`px-3 py-1.5 rounded-full text-xs font-bold transition-all ${
                                            tags.includes(tag)
                                                ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                                                : 'bg-white/5 text-gray-400 border border-white/10'
                                        }`}
                                    >
                                        {tag}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                )}

                {step === 3 && (
                    <div className="space-y-3 animate-in fade-in duration-200">
                        <div className="flex items-center justify-between mb-1">
                            <p className="text-[11px] font-bold text-gray-400 uppercase tracking-widest">Ingredients</p>
                            <button
                                onClick={addIngredient}
                                className="text-[11px] font-bold text-amber-400 hover:text-amber-300 transition-colors"
                            >
                                + Add
                            </button>
                        </div>

                        {ingredients.map((ing, i) => (
                            <div key={i} style={GLASS} className="p-3 flex items-center gap-2">
                                <input
                                    type="number"
                                    value={ing.amount}
                                    onChange={(e) => updateIngredient(i, 'amount', parseFloat(e.target.value) || 0)}
                                    className="w-16 bg-white/5 border border-white/10 rounded-lg px-2 py-2 text-white text-sm text-center outline-none"
                                    placeholder="Qty"
                                />
                                <input
                                    type="text"
                                    value={ing.unit}
                                    onChange={(e) => updateIngredient(i, 'unit', e.target.value)}
                                    className="w-16 bg-white/5 border border-white/10 rounded-lg px-2 py-2 text-white text-sm outline-none"
                                    placeholder="Unit"
                                />
                                <input
                                    type="text"
                                    value={ing.name}
                                    onChange={(e) => updateIngredient(i, 'name', e.target.value)}
                                    className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm outline-none"
                                    placeholder="Ingredient name"
                                />
                                {ingredients.length > 1 && (
                                    <button
                                        onClick={() => removeIngredient(i)}
                                        className="text-red-400/60 hover:text-red-400 text-lg font-bold transition-colors shrink-0"
                                    >
                                        ×
                                    </button>
                                )}
                            </div>
                        ))}
                    </div>
                )}

                {step === 4 && (
                    <div className="animate-in fade-in duration-200">
                        <div style={GLASS} className="p-4">
                            <label className="block text-[11px] font-bold text-gray-400 uppercase tracking-widest mb-2">
                                Cooking Instructions
                            </label>
                            <textarea
                                value={instructions}
                                onChange={(e) => setInstructions(e.target.value)}
                                placeholder="Step 1: Heat olive oil in a heavy-based pan...&#10;Step 2: Add onion and garlic...&#10;Step 3: ..."
                                rows={10}
                                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-gray-500 text-sm outline-none focus:border-amber-500/50 transition-colors resize-none leading-relaxed"
                                autoFocus
                            />
                        </div>
                    </div>
                )}

                {step === 5 && (
                    <div className="space-y-4 animate-in fade-in duration-200">
                        {/* Summary */}
                        <div style={GLASS} className="p-4">
                            <h3 className="text-white font-black text-base mb-1">{title || 'Untitled Recipe'}</h3>
                            <div className="flex items-center gap-3 text-xs text-gray-400 mt-1">
                                <span>🍽️ {servings} serves</span>
                                <span>⏱️ {cookTime} min</span>
                                <span>📝 {ingredients.filter((i) => i.name).length} ingredients</span>
                            </div>
                            {tags.length > 0 && (
                                <div className="flex flex-wrap gap-1 mt-2">
                                    {tags.map((t) => (
                                        <span
                                            key={t}
                                            className="px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 text-[11px] font-bold"
                                        >
                                            {t}
                                        </span>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Visibility toggle */}
                        <div style={GLASS} className="p-4">
                            <label className="block text-[11px] font-bold text-gray-400 uppercase tracking-widest mb-3">
                                Who can see this recipe?
                            </label>
                            <div className="grid grid-cols-2 gap-3">
                                <button
                                    onClick={() => setVisibility('personal')}
                                    className={`p-4 rounded-xl border-2 text-center transition-all ${
                                        visibility === 'personal'
                                            ? 'border-cyan-500/50 bg-cyan-500/10'
                                            : 'border-white/10 bg-white/[0.02]'
                                    }`}
                                >
                                    <span className="text-2xl block mb-1">🔒</span>
                                    <span className="text-xs font-bold text-white block">Personal</span>
                                    <span className="text-[11px] text-gray-500 block mt-0.5">Only you</span>
                                </button>
                                <button
                                    onClick={() => setVisibility('shared')}
                                    className={`p-4 rounded-xl border-2 text-center transition-all ${
                                        visibility === 'shared'
                                            ? 'border-amber-500/50 bg-amber-500/10'
                                            : 'border-white/10 bg-white/[0.02]'
                                    }`}
                                >
                                    <span className="text-2xl block mb-1">🌍</span>
                                    <span className="text-xs font-bold text-white block">Community</span>
                                    <span className="text-[11px] text-gray-500 block mt-0.5">All sailors</span>
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Footer nav */}
            <div className="fixed bottom-0 left-0 right-0 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 bg-gradient-to-t from-black via-black/95 to-transparent">
                <div className="flex items-center gap-3">
                    {step > 1 && (
                        <button
                            onClick={() => setStep(step - 1)}
                            className="px-6 py-3.5 rounded-xl bg-white/10 text-white text-sm font-bold transition-all active:scale-95"
                        >
                            Back
                        </button>
                    )}
                    {step < totalSteps ? (
                        <button
                            onClick={() => canProceed() && setStep(step + 1)}
                            disabled={!canProceed()}
                            className={`flex-1 py-3.5 rounded-xl text-sm font-bold transition-all active:scale-95 ${
                                canProceed()
                                    ? 'bg-gradient-to-r from-amber-500 to-orange-500 text-black'
                                    : 'bg-white/10 text-gray-500 cursor-not-allowed'
                            }`}
                        >
                            Continue
                        </button>
                    ) : (
                        <button
                            onClick={handleSave}
                            disabled={saving}
                            className="flex-1 py-3.5 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 text-black text-sm font-bold transition-all active:scale-95 flex items-center justify-center gap-2"
                        >
                            {saving ? (
                                <>
                                    <div className="w-4 h-4 border-2 border-black border-t-transparent rounded-full animate-spin" />
                                    Saving...
                                </>
                            ) : (
                                <>🍳 Save Recipe</>
                            )}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};
