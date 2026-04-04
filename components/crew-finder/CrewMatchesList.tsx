/**
 * CrewMatchesList — Connections/matches list with compatibility scoring
 *
 * Extracted from LonelyHeartsPage to reduce file size.
 */

import React from 'react';
import { SailorMatch } from '../../services/LonelyHeartsService';
import { EmptyState } from '../ui/EmptyState';

interface CompatResult {
    score: number;
    label: string;
    color: string;
}

interface CrewMatchesListProps {
    matches: SailorMatch[];
    onOpenDM: (userId: string, name: string) => void;
    getCompatibility: (match: SailorMatch) => CompatResult;
    getIcebreakers: (match: SailorMatch) => string[];
}

export const CrewMatchesList: React.FC<CrewMatchesListProps> = React.memo(
    ({ matches, onOpenDM, getCompatibility, getIcebreakers }) => {
        return (
            <div className="px-4 py-5">
                {matches.length === 0 ? (
                    <EmptyState
                        icon="🤝"
                        title="No Connections Yet"
                        description="When you ⭐ someone and they ⭐ you back, you'll both appear here. Start browsing!"
                    />
                ) : (
                    <div className="space-y-2 stagger-in">
                        {matches.map((match) => {
                            const compat = getCompatibility(match);
                            const colorClasses =
                                compat.color === 'emerald'
                                    ? 'text-emerald-300 border-emerald-400/30 bg-emerald-500/15'
                                    : compat.color === 'sky'
                                      ? 'text-sky-300 border-sky-400/30 bg-sky-500/15'
                                      : compat.color === 'amber'
                                        ? 'text-amber-300 border-amber-400/30 bg-amber-500/15'
                                        : 'text-white/40 border-white/10 bg-white/5';
                            const barColor =
                                compat.color === 'emerald'
                                    ? 'bg-emerald-400'
                                    : compat.color === 'sky'
                                      ? 'bg-sky-400'
                                      : compat.color === 'amber'
                                        ? 'bg-amber-400'
                                        : 'bg-white/20';

                            return (
                                <button
                                    aria-label="Open DM"
                                    key={match.user_id}
                                    onClick={() => onOpenDM(match.user_id, match.display_name)}
                                    className="w-full flex items-center gap-4 p-4 rounded-2xl bg-white/[0.02] hover:bg-white/[0.05] border border-white/[0.04] hover:border-emerald-400/10 transition-all active:scale-[0.98] card-lift"
                                >
                                    <div className="w-14 h-14 rounded-2xl overflow-hidden border-2 border-emerald-400/20 flex-shrink-0">
                                        {match.avatar_url ? (
                                            <img src={match.avatar_url} alt="" className="w-full h-full object-cover" />
                                        ) : (
                                            <div className="w-full h-full bg-gradient-to-br from-emerald-500/10 to-sky-500/10 flex items-center justify-center">
                                                <span className="text-xl">⛵</span>
                                            </div>
                                        )}
                                    </div>
                                    <div className="flex-1 text-left min-w-0">
                                        <p className="text-base font-semibold text-white/80 truncate">
                                            {match.display_name}
                                        </p>
                                        <p className="text-xs text-white/60 truncate">
                                            {match.home_port ? `📍 ${match.home_port}` : ''}
                                        </p>
                                        {compat.score > 0 && (
                                            <div className="mt-1.5">
                                                <div className="flex items-center gap-2 mb-0.5">
                                                    <span
                                                        className={`text-[11px] font-bold ${compat.color === 'emerald' ? 'text-emerald-300' : compat.color === 'sky' ? 'text-sky-300' : compat.color === 'amber' ? 'text-amber-300' : 'text-white/30'}`}
                                                    >
                                                        {compat.score}% · {compat.label}
                                                    </span>
                                                </div>
                                                <div className="w-full h-1 rounded-full bg-white/[0.05] overflow-hidden">
                                                    <div
                                                        className={`h-full rounded-full ${barColor} transition-all`}
                                                        style={{ width: `${compat.score}%` }}
                                                    />
                                                </div>
                                            </div>
                                        )}
                                        {match.interests.length > 0 && (
                                            <div className="flex flex-wrap gap-1 mt-1.5">
                                                {match.interests.slice(0, 4).map((i) => (
                                                    <span
                                                        key={i}
                                                        className="px-2 py-0.5 rounded-full bg-amber-500/10 text-[11px] text-amber-200/60 border border-amber-500/10"
                                                    >
                                                        {i}
                                                    </span>
                                                ))}
                                                {match.interests.length > 4 && (
                                                    <span className="px-2 py-0.5 rounded-full bg-white/[0.03] text-[11px] text-white/40">
                                                        +{match.interests.length - 4}
                                                    </span>
                                                )}
                                            </div>
                                        )}
                                        {(() => {
                                            const tips = getIcebreakers(match);
                                            return tips.length > 0 ? (
                                                <div className="mt-1">
                                                    {tips.map((tip, i) => (
                                                        <p key={i} className="text-[11px] text-violet-300/40 italic">
                                                            💡 {tip}
                                                        </p>
                                                    ))}
                                                </div>
                                            ) : null;
                                        })()}
                                    </div>
                                    <div
                                        className={`w-11 h-11 rounded-xl border flex items-center justify-center flex-shrink-0 ${colorClasses}`}
                                    >
                                        <span className="text-xs font-bold">
                                            {compat.score > 0 ? `${compat.score}%` : '💬'}
                                        </span>
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>
        );
    },
);

CrewMatchesList.displayName = 'CrewMatchesList';
