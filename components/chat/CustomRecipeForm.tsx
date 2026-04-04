/**
 * CustomRecipeForm — Multi-step custom recipe creation modal.
 *
 * Steps:
 *  1. Basics: Name, photo, cook time
 *  2. Ingredients: Per-person ingredient list with amounts & units
 *  3. Directions: Numbered cooking steps
 *  4. Save: Private or community visibility toggle
 */
import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
    saveCustomRecipe,
    NAUTICAL_TAG_DEFS,
    deriveNauticalTags,
    type RecipeIngredient,
    type RecipeStep,
    type CustomRecipeInput,
    type NauticalTag,
    isScalable,
} from '../../services/GalleyRecipeService';
import { triggerHaptic } from '../../utils/system';

// ── Types ──────────────────────────────────────────────────────────────────

interface CustomRecipeFormProps {
    onSaved: () => void;
    onClose: () => void;
}

interface IngredientRow {
    key: string;
    name: string;
    amount: string;
    unit: string;
}

const UNIT_OPTIONS = [
    '',
    'g',
    'kg',
    'ml',
    'L',
    'cup',
    'cups',
    'tsp',
    'tbsp',
    'oz',
    'lb',
    'whole',
    'large',
    'medium',
    'small',
    'clove',
    'bunch',
    'sprig',
    'slice',
    'piece',
    'fillet',
    'rasher',
];

const STEPS = ['Basics', 'Ingredients', 'Directions', 'Save'] as const;

// ── Component ──────────────────────────────────────────────────────────────

export const CustomRecipeForm: React.FC<CustomRecipeFormProps> = ({ onSaved, onClose }) => {
    const [step, setStep] = useState(0);
    const [saving, setSaving] = useState(false);

    // Step 1: Basics
    const [title, setTitle] = useState('');
    const [readyInMinutes, setReadyInMinutes] = useState(30);
    const [photoPreview, setPhotoPreview] = useState<string | null>(null);
    const [photoFile, setPhotoFile] = useState<File | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Step 2: Ingredients
    const [ingredients, setIngredients] = useState<IngredientRow[]>([
        { key: crypto.randomUUID(), name: '', amount: '', unit: '' },
    ]);

    // Step 3: Directions
    const [directions, setDirections] = useState<string[]>(['']);

    // Step 4: Save
    const [visibility, setVisibility] = useState<'private' | 'community'>('private');

    // Nautical tags (selectable in Basics step)
    const [selectedTags, setSelectedTags] = useState<Set<NauticalTag>>(new Set());

    // Auto-suggest tags when title changes
    useEffect(() => {
        if (title.trim().length > 2) {
            const suggested = deriveNauticalTags(title, [], readyInMinutes);
            setSelectedTags(new Set(suggested));
        }
    }, [title, readyInMinutes]);

    // ── Handlers ───────────────────────────────────────────────────────────

    const handlePhotoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setPhotoFile(file);
        const reader = new FileReader();
        reader.onloadend = () => setPhotoPreview(reader.result as string);
        reader.readAsDataURL(file);
    };

    const updateIngredient = useCallback((key: string, field: keyof IngredientRow, value: string) => {
        setIngredients((prev) => prev.map((ing) => (ing.key === key ? { ...ing, [field]: value } : ing)));
    }, []);

    const addIngredient = () => {
        setIngredients((prev) => [...prev, { key: crypto.randomUUID(), name: '', amount: '', unit: '' }]);
    };

    const removeIngredient = (key: string) => {
        setIngredients((prev) => prev.filter((ing) => ing.key !== key));
    };

    const updateDirection = (index: number, value: string) => {
        setDirections((prev) => prev.map((d, i) => (i === index ? value : d)));
    };

    const addDirection = () => {
        setDirections((prev) => [...prev, '']);
    };

    const removeDirection = (index: number) => {
        setDirections((prev) => prev.filter((_, i) => i !== index));
    };

    const canAdvance = (): boolean => {
        switch (step) {
            case 0:
                return title.trim().length > 0;
            case 1:
                return ingredients.some((i) => i.name.trim().length > 0);
            case 2:
                return directions.some((d) => d.trim().length > 0);
            case 3:
                return true;
            default:
                return false;
        }
    };

    const handleSave = async () => {
        setSaving(true);
        triggerHaptic('medium');

        const parsedIngredients: RecipeIngredient[] = ingredients
            .filter((i) => i.name.trim())
            .map((i) => ({
                name: i.name.trim(),
                amount: parseFloat(i.amount) || 0,
                unit: i.unit,
                scalable: isScalable(i.unit, i.name),
                aisle: 'Other',
            }));

        const parsedSteps: RecipeStep[] = directions
            .filter((d) => d.trim())
            .map((d, i) => ({ number: i + 1, step: d.trim() }));

        const input: CustomRecipeInput = {
            title: title.trim(),
            imageFile: photoFile,
            readyInMinutes,
            servings: 1, // Always per-person
            ingredients: parsedIngredients,
            instructions: parsedSteps,
            visibility,
            tags: [...selectedTags],
        };

        const result = await saveCustomRecipe(input);
        setSaving(false);

        if (result) {
            triggerHaptic('light');
            onSaved();
        } else {
            triggerHaptic('heavy');
            // Still close — recipe might have saved locally
            onSaved();
        }
    };

    // ── Step Renderers ─────────────────────────────────────────────────────

    const renderBasics = () => (
        <div className="space-y-4">
            {/* Recipe Name */}
            <div>
                <label className="block text-[10px] text-gray-500 font-bold uppercase tracking-wider mb-1.5">
                    Recipe Name *
                </label>
                <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g. Mum's Spaghetti Bolognese"
                    className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-amber-500/30"
                    autoFocus
                    data-no-keyboard-scroll
                />
            </div>

            {/* Photo */}
            <div>
                <label className="block text-[10px] text-gray-500 font-bold uppercase tracking-wider mb-1.5">
                    Photo (optional)
                </label>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={handlePhotoSelect}
                    className="hidden"
                />
                {photoPreview ? (
                    <div className="relative">
                        <img
                            src={photoPreview}
                            alt="Recipe preview"
                            className="w-full h-40 object-cover rounded-xl border border-white/[0.08]"
                        />
                        <button
                            onClick={() => {
                                setPhotoFile(null);
                                setPhotoPreview(null);
                            }}
                            className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/60 flex items-center justify-center text-white text-xs"
                        >
                            ✕
                        </button>
                    </div>
                ) : (
                    <button
                        onClick={() => fileInputRef.current?.click()}
                        className="w-full h-32 rounded-xl border-2 border-dashed border-white/[0.1] bg-white/[0.02] flex flex-col items-center justify-center gap-2 text-gray-500 hover:text-gray-300 hover:border-white/[0.2] transition-colors"
                    >
                        <span className="text-2xl">📸</span>
                        <span className="text-[11px] font-medium">Tap to add a photo</span>
                    </button>
                )}
            </div>

            {/* Cook Time */}
            <div>
                <label className="block text-[10px] text-gray-500 font-bold uppercase tracking-wider mb-1.5">
                    Cook Time (minutes)
                </label>
                <div className="flex items-center gap-3">
                    <button
                        onClick={() => setReadyInMinutes(Math.max(5, readyInMinutes - 5))}
                        className="w-10 h-10 rounded-xl bg-white/[0.06] border border-white/[0.1] text-white font-bold text-lg flex items-center justify-center active:scale-95"
                    >
                        −
                    </button>
                    <span className="text-xl font-bold text-white min-w-[4rem] text-center">
                        {readyInMinutes}
                        <span className="text-sm text-gray-500 ml-1">min</span>
                    </span>
                    <button
                        onClick={() => setReadyInMinutes(readyInMinutes + 5)}
                        className="w-10 h-10 rounded-xl bg-white/[0.06] border border-white/[0.1] text-white font-bold text-lg flex items-center justify-center active:scale-95"
                    >
                        +
                    </button>
                </div>
            </div>

            {/* Nautical Tags */}
            <div>
                <label className="block text-[10px] text-gray-500 font-bold uppercase tracking-wider mb-1.5">
                    Galley Tags (auto-suggested)
                </label>
                <div className="flex flex-wrap gap-1.5">
                    {NAUTICAL_TAG_DEFS.map((tag) => (
                        <button
                            key={tag.id}
                            type="button"
                            onClick={() => {
                                setSelectedTags((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(tag.id)) next.delete(tag.id);
                                    else next.add(tag.id);
                                    return next;
                                });
                                triggerHaptic('light');
                            }}
                            className={`px-2.5 py-1.5 rounded-lg text-[10px] font-bold transition-all active:scale-95 ${
                                selectedTags.has(tag.id)
                                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                                    : 'bg-white/[0.03] text-gray-500 border border-white/[0.06]'
                            }`}
                        >
                            {tag.emoji} {tag.label}
                        </button>
                    ))}
                </div>
                <p className="text-[11px] text-gray-500 mt-1.5">
                    Tags help sailors find your recipe by conditions. Tap to add or remove.
                </p>
            </div>
        </div>
    );

    const renderIngredients = () => (
        <div className="space-y-3">
            {/* Info banner */}
            <div className="flex items-start gap-2 p-3 rounded-xl bg-sky-500/[0.08] border border-sky-500/20">
                <span className="text-base mt-0.5">ℹ️</span>
                <p className="text-[11px] text-sky-300/90 leading-relaxed">
                    Enter ingredients for <strong>1 person</strong>. Thalassa will automatically scale for your crew
                    count when scheduling.
                </p>
            </div>

            {/* Ingredient rows */}
            {ingredients.map((ing) => (
                <div key={ing.key} className="flex gap-1.5 items-start">
                    <input
                        value={ing.name}
                        onChange={(e) => updateIngredient(ing.key, 'name', e.target.value)}
                        placeholder="Ingredient"
                        className="flex-1 min-w-0 bg-white/[0.04] border border-white/[0.08] rounded-lg px-2.5 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-amber-500/30"
                        data-no-keyboard-scroll
                    />
                    <input
                        value={ing.amount}
                        onChange={(e) => updateIngredient(ing.key, 'amount', e.target.value)}
                        placeholder="Qty"
                        type="number"
                        inputMode="decimal"
                        step="0.1"
                        className="w-16 bg-white/[0.04] border border-white/[0.08] rounded-lg px-2 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-amber-500/30 text-center"
                        data-no-keyboard-scroll
                    />
                    <select
                        value={ing.unit}
                        onChange={(e) => updateIngredient(ing.key, 'unit', e.target.value)}
                        className="w-20 bg-white/[0.04] border border-white/[0.08] rounded-lg px-1.5 py-2 text-xs text-white focus:outline-none focus:border-amber-500/30 appearance-none"
                    >
                        {UNIT_OPTIONS.map((u) => (
                            <option key={u} value={u} className="bg-slate-900 text-white">
                                {u || 'unit'}
                            </option>
                        ))}
                    </select>
                    <button
                        onClick={() => removeIngredient(ing.key)}
                        className="w-8 h-8 rounded-lg bg-red-500/10 text-red-400 flex items-center justify-center text-xs shrink-0 hover:bg-red-500/20 transition-colors mt-0.5"
                        aria-label="Remove ingredient"
                    >
                        ✕
                    </button>
                </div>
            ))}

            <button
                onClick={addIngredient}
                className="w-full py-2.5 rounded-xl border border-dashed border-amber-500/20 text-[11px] font-bold text-amber-400/70 hover:bg-amber-500/[0.06] transition-colors"
            >
                + Add Ingredient
            </button>
        </div>
    );

    const renderDirections = () => (
        <div className="space-y-3">
            <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wider">Cooking Steps</p>

            {directions.map((dir, i) => (
                <div key={i} className="flex gap-2 items-start">
                    <span className="w-7 h-7 rounded-full bg-amber-500/15 text-amber-400 text-[11px] font-bold flex items-center justify-center shrink-0 mt-1">
                        {i + 1}
                    </span>
                    <textarea
                        value={dir}
                        onChange={(e) => updateDirection(i, e.target.value)}
                        placeholder={`Step ${i + 1}…`}
                        rows={2}
                        className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-amber-500/30 resize-none"
                        data-no-keyboard-scroll
                    />
                    <button
                        onClick={() => removeDirection(i)}
                        className="w-7 h-7 rounded-lg bg-red-500/10 text-red-400 flex items-center justify-center text-xs shrink-0 mt-1 hover:bg-red-500/20 transition-colors"
                        aria-label={`Remove step ${i + 1}`}
                    >
                        ✕
                    </button>
                </div>
            ))}

            <button
                onClick={addDirection}
                className="w-full py-2.5 rounded-xl border border-dashed border-amber-500/20 text-[11px] font-bold text-amber-400/70 hover:bg-amber-500/[0.06] transition-colors"
            >
                + Add Step
            </button>
        </div>
    );

    const renderSave = () => (
        <div className="space-y-4">
            {/* Recipe summary */}
            <div className="flex items-center gap-3 p-3 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                {photoPreview ? (
                    <img src={photoPreview} alt="" className="w-14 h-14 rounded-lg object-cover" />
                ) : (
                    <div className="w-14 h-14 rounded-lg bg-amber-500/10 flex items-center justify-center text-xl">
                        🍽️
                    </div>
                )}
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-white truncate">{title}</p>
                    <p className="text-[10px] text-gray-500">
                        ⏱️ {readyInMinutes}min · {ingredients.filter((i) => i.name.trim()).length} ingredients ·{' '}
                        {directions.filter((d) => d.trim()).length} steps
                    </p>
                </div>
            </div>

            {/* Visibility toggle */}
            <div>
                <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wider mb-2">Save To</p>

                <div className="space-y-2">
                    <button
                        onClick={() => setVisibility('private')}
                        className={`w-full flex items-center gap-3 p-3 rounded-xl border transition-all ${
                            visibility === 'private'
                                ? 'border-amber-500/40 bg-amber-500/[0.06]'
                                : 'border-white/[0.06] bg-white/[0.02] hover:border-white/[0.15]'
                        }`}
                    >
                        <span className="text-lg">🔒</span>
                        <div className="text-left">
                            <p className="text-xs font-bold text-white">My Recipes</p>
                            <p className="text-[10px] text-gray-500">Only visible to you</p>
                        </div>
                        {visibility === 'private' && (
                            <span className="ml-auto w-5 h-5 rounded-full bg-amber-500 flex items-center justify-center text-black text-[10px] font-bold">
                                ✓
                            </span>
                        )}
                    </button>

                    <button
                        onClick={() => setVisibility('community')}
                        className={`w-full flex items-center gap-3 p-3 rounded-xl border transition-all ${
                            visibility === 'community'
                                ? 'border-sky-500/40 bg-sky-500/[0.06]'
                                : 'border-white/[0.06] bg-white/[0.02] hover:border-white/[0.15]'
                        }`}
                    >
                        <span className="text-lg">👥</span>
                        <div className="text-left">
                            <p className="text-xs font-bold text-white">Community Galley</p>
                            <p className="text-[10px] text-gray-500">Shared with all Thalassa sailors</p>
                        </div>
                        {visibility === 'community' && (
                            <span className="ml-auto w-5 h-5 rounded-full bg-sky-500 flex items-center justify-center text-black text-[10px] font-bold">
                                ✓
                            </span>
                        )}
                    </button>
                </div>
            </div>
        </div>
    );

    // ── Render ──────────────────────────────────────────────────────────────

    return (
        <div
            className="fixed inset-0 z-[950] flex items-start justify-center bg-black/70 backdrop-blur-sm animate-in fade-in duration-200 pt-[max(1rem,env(safe-area-inset-top))]"
            onClick={onClose}
        >
            <div
                className="w-[calc(100%-1.5rem)] max-w-lg bg-slate-900 border border-white/[0.1] rounded-3xl max-h-[85vh] flex flex-col shadow-2xl animate-in slide-in-from-bottom-4 duration-300"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-white/[0.06]">
                    <div>
                        <p className="text-sm font-bold text-white">📝 New Recipe</p>
                        <p className="text-[10px] text-gray-500">
                            Step {step + 1} of {STEPS.length} — {STEPS[step]}
                        </p>
                    </div>
                    <button
                        onClick={onClose}
                        className="w-8 h-8 rounded-full bg-white/[0.06] flex items-center justify-center text-gray-400 hover:text-white transition-colors"
                        aria-label="Close"
                    >
                        ✕
                    </button>
                </div>

                {/* Progress bar */}
                <div className="px-4 pt-3">
                    <div className="flex gap-1.5">
                        {STEPS.map((_, i) => (
                            <div
                                key={i}
                                className={`h-1 flex-1 rounded-full transition-all duration-300 ${
                                    i <= step ? 'bg-amber-500' : 'bg-white/[0.08]'
                                }`}
                            />
                        ))}
                    </div>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
                    {step === 0 && renderBasics()}
                    {step === 1 && renderIngredients()}
                    {step === 2 && renderDirections()}
                    {step === 3 && renderSave()}
                </div>

                {/* Footer navigation */}
                <div className="flex items-center gap-2 p-4 border-t border-white/[0.06]">
                    {step > 0 && (
                        <button
                            onClick={() => setStep(step - 1)}
                            className="px-5 py-2.5 rounded-xl bg-white/[0.06] border border-white/[0.08] text-xs font-bold text-gray-300 hover:bg-white/[0.1] transition-colors"
                        >
                            Back
                        </button>
                    )}
                    <div className="flex-1" />
                    {step < STEPS.length - 1 ? (
                        <button
                            onClick={() => setStep(step + 1)}
                            disabled={!canAdvance()}
                            className="px-6 py-2.5 rounded-xl bg-amber-500/15 border border-amber-500/25 text-xs font-bold text-amber-300 hover:bg-amber-500/25 disabled:opacity-30 transition-all active:scale-95"
                        >
                            Next →
                        </button>
                    ) : (
                        <button
                            onClick={handleSave}
                            disabled={saving || !canAdvance()}
                            className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 text-xs font-bold text-black shadow-lg shadow-amber-500/20 disabled:opacity-30 transition-all active:scale-95 flex items-center gap-2"
                        >
                            {saving ? <>⏳ Saving...</> : <>✨ Save Recipe</>}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};
