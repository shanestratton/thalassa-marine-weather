/**
 * VoyageListPlaceholders — the two non-list states of the Ship's Log voyage
 * list, extracted verbatim from pages/LogPage.tsx: the hydrating skeleton and
 * the "Begin Your Log" empty state. The caller keeps the ternary that chooses
 * between them and the real cards.
 */
import React from 'react';

/* History still hydrating (cache miss / first network
   load) — skeleton cards, NOT the "Begin Your Log"
   empty state, and never a page-wide spinner: the
   Start control below is live the whole time. */
export const VoyageListSkeleton: React.FC = () => (
    <div className="space-y-3 px-1 py-2" aria-label="Loading voyages">
        {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-2xl bg-slate-900/40 border border-white/5 p-4 animate-pulse">
                <div className="h-3 w-28 bg-white/10 rounded-sm mb-3" />
                <div className="h-2.5 w-44 bg-white/5 rounded-sm mb-2" />
                <div className="h-2.5 w-36 bg-white/5 rounded-sm" />
            </div>
        ))}
    </div>
);

export const VoyageListEmptyState: React.FC = () => (
    <div className="flex-1 flex flex-col items-center justify-center text-slate-400 px-6 py-12">
        {/* Decorative maritime line art */}
        <div className="relative w-24 h-24 mb-6">
            <svg viewBox="0 0 96 96" fill="none" className="w-full h-full">
                {/* Outer ring — dashed */}
                <circle cx="48" cy="48" r="44" stroke="rgba(56,189,248,0.12)" strokeWidth="1" strokeDasharray="3 5" />
                {/* Middle ring — solid faint */}
                <circle cx="48" cy="48" r="32" stroke="rgba(56,189,248,0.08)" strokeWidth="0.5" />
                {/* Compass rose petals */}
                <path d="M48 4L51 44H45L48 4Z" fill="rgba(56,189,248,0.25)" />
                <path d="M48 92L45 52H51L48 92Z" fill="rgba(56,189,248,0.10)" />
                <path d="M4 48L44 45V51L4 48Z" fill="rgba(56,189,248,0.10)" />
                <path d="M92 48L52 51V45L92 48Z" fill="rgba(56,189,248,0.10)" />
                {/* Center dot */}
                <circle cx="48" cy="48" r="3" fill="rgba(56,189,248,0.30)" />
                {/* Track line suggestion — curved */}
                <path
                    d="M20 70 C32 55, 64 42, 76 28"
                    stroke="rgba(52,211,153,0.25)"
                    strokeWidth="1.5"
                    strokeDasharray="4 3"
                    strokeLinecap="round"
                />
                {/* Waypoint dots on the track */}
                <circle cx="20" cy="70" r="2.5" fill="rgba(52,211,153,0.35)" />
                <circle cx="48" cy="49" r="2" fill="rgba(52,211,153,0.25)" />
                <circle cx="76" cy="28" r="2.5" fill="rgba(52,211,153,0.35)" />
            </svg>
        </div>
        <p className="text-base font-bold text-white mb-1.5">Begin Your Log</p>
        <p className="text-[13px] text-white/40 max-w-[260px] text-center leading-relaxed">
            Every great voyage starts with a single position. Slide below to begin GPS tracking.
        </p>
    </div>
);
