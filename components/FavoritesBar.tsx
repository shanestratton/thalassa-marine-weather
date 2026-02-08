
import React from 'react';
import { t } from '../theme';
import { StarIcon, XIcon, MapPinIcon } from './Icons';

interface FavoritesBarProps {
    favorites: string[];
    onSelect: (location: string) => void;
    onRemove: (location: string) => void;
}

export const FavoritesBar: React.FC<FavoritesBarProps> = ({ favorites, onSelect, onRemove }) => {
    if (!favorites || favorites.length === 0) return null;

    return (
        <div className="w-full max-w-7xl mx-auto px-4 mt-2 mb-4 animate-in fade-in slide-in-from-top-2 duration-500">
            <div className="flex items-center gap-2 overflow-x-auto custom-scrollbar pb-2 mask-linear">
                <div className={`flex items-center justify-center w-8 h-8 rounded-full bg-white/5 shrink-0 ${t.border.subtle}`}>
                    <StarIcon className="w-4 h-4 text-yellow-400" filled />
                </div>
                {favorites.map((loc, idx) => (
                    <div 
                        key={idx} 
                        onClick={() => onSelect(loc)}
                        className={`group flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 hover:bg-sky-500/20 ${t.border.default} hover:border-sky-500/30 transition-all cursor-pointer whitespace-nowrap active:scale-95 select-none`}
                    >
                        <MapPinIcon className="w-3 h-3 text-sky-400 group-hover:text-sky-300" />
                        {/* Display full location string to show State/Country if available */}
                        <span className="text-sm font-medium text-gray-300 group-hover:text-white transition-colors">{loc}</span>
                        <button 
                            onClick={(e) => {
                                e.stopPropagation();
                                onRemove(loc);
                            }}
                            className="ml-1 p-0.5 rounded-full hover:bg-white/20 text-gray-500 hover:text-white transition-colors opacity-0 group-hover:opacity-100"
                        >
                            <XIcon className="w-3 h-3" />
                        </button>
                    </div>
                ))}
            </div>
        </div>
    );
};
