/**
 * RecipeCard — Renders a shared recipe in Crew Talk or DMs.
 *
 * Parses 🍳RECIPE: prefixed messages into a tappable card
 * showing title, servings, cook time, and image thumbnail.
 * Same pattern as PinDropCard for location shares.
 */
import React, { useState } from 'react';
import { decodeRecipeShare, getRecipeById, type StoredRecipe } from '../../services/GalleyRecipeService';
import { triggerHaptic } from '../../utils/system';

interface RecipeCardProps {
    message: string;
    isMine: boolean;
}

export const RecipeCard: React.FC<RecipeCardProps> = ({ message, isMine }) => {
    const data = decodeRecipeShare(message);
    const [expanded, setExpanded] = useState(false);
    const [recipe, setRecipe] = useState<StoredRecipe | null>(null);
    const [loading, setLoading] = useState(false);

    if (!data) return null;

    const handleTap = async () => {
        triggerHaptic('light');

        if (expanded) {
            setExpanded(false);
            return;
        }

        setExpanded(true);

        if (!recipe && !loading) {
            setLoading(true);
            const full = await getRecipeById(data.recipeId);
            setRecipe(full);
            setLoading(false);
        }
    };

    return (
        <button
            onClick={handleTap}
            className={`w-full max-w-[280px] rounded-2xl overflow-hidden text-left transition-all active:scale-[0.97] ${
                isMine ? 'bg-sky-500/10 border border-sky-500/20' : 'bg-amber-500/10 border border-amber-500/20'
            }`}
        >
            {/* Header with image */}
            {data.imageUrl && (
                <div className="h-28 w-full bg-slate-800 overflow-hidden">
                    <img
                        src={data.imageUrl}
                        alt={data.title}
                        className="w-full h-full object-cover"
                        onError={(e) => {
                            (e.target as HTMLImageElement).style.display = 'none';
                        }}
                    />
                </div>
            )}

            <div className="p-3">
                {/* Title */}
                <div className="flex items-start gap-2">
                    <span className="text-lg">🍳</span>
                    <div className="flex-1 min-w-0">
                        <h4 className="text-sm font-black text-white truncate">{data.title}</h4>
                        <div className="flex items-center gap-3 mt-1 text-[10px] text-gray-400">
                            <span>🍽️ {data.servings} serves</span>
                            <span>⏱️ {data.readyInMinutes} min</span>
                        </div>
                    </div>
                </div>

                {/* Expanded: full recipe details */}
                {expanded && (
                    <div className="mt-3 pt-3 border-t border-white/10 space-y-2 animate-in fade-in duration-200">
                        {loading ? (
                            <div className="flex items-center gap-2 py-2">
                                <div className="w-3 h-3 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
                                <span className="text-[11px] text-gray-400">Loading recipe...</span>
                            </div>
                        ) : recipe ? (
                            <>
                                {/* Ingredients */}
                                {recipe.ingredients.length > 0 && (
                                    <div>
                                        <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">
                                            Ingredients
                                        </p>
                                        {recipe.ingredients.slice(0, 8).map((ing, i) => (
                                            <p key={i} className="text-[11px] text-gray-300">
                                                • {ing.amount} {ing.unit} {ing.name}
                                            </p>
                                        ))}
                                        {recipe.ingredients.length > 8 && (
                                            <p className="text-[10px] text-gray-500 mt-1">
                                                +{recipe.ingredients.length - 8} more...
                                            </p>
                                        )}
                                    </div>
                                )}

                                {/* Instructions preview */}
                                {recipe.instructions && (
                                    <div>
                                        <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">
                                            Instructions
                                        </p>
                                        <p className="text-[11px] text-gray-300 leading-relaxed line-clamp-3">
                                            {recipe.instructions}
                                        </p>
                                    </div>
                                )}

                                {/* Tags */}
                                {recipe.tags.length > 0 && (
                                    <div className="flex flex-wrap gap-1">
                                        {recipe.tags.map((tag) => (
                                            <span
                                                key={tag}
                                                className="px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400 text-[9px] font-bold"
                                            >
                                                {tag}
                                            </span>
                                        ))}
                                    </div>
                                )}
                            </>
                        ) : (
                            <p className="text-[11px] text-gray-500 italic">Recipe not available offline</p>
                        )}
                    </div>
                )}

                {/* Tap hint */}
                <p className="text-[9px] text-gray-500 mt-2 text-center">
                    {expanded ? 'Tap to collapse' : 'Tap to view details'}
                </p>
            </div>
        </button>
    );
};

/**
 * Check if a message string is a recipe share.
 * Used by the chat renderer to decide which component to use.
 */
export function isRecipeShareMessage(message: string): boolean {
    return message.startsWith('🍳RECIPE:');
}
