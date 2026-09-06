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
    <div className="flex-1 flex flex-col items-center justify-center text-slate-400 px-6 py-8">
        {/* Watermark — the Thalassa mark, big and faint, where the little
            compass used to be (Shane 2026-09-06: "the thalassa icon in a
            watermark look. do it big"). The PNG is opaque on near-black:
            `lighten` lets the page ground win under it and a radial mask
            feathers the square away, so only the rose and the wave remain. */}
        <div className="relative mb-2 h-[280px] w-full max-w-[380px]" aria-hidden="true" data-testid="log-watermark">
            <img
                src="/thalassa-icon.png"
                alt=""
                draggable={false}
                className="pointer-events-none absolute left-1/2 top-1/2 w-[380px] max-w-none -translate-x-1/2 -translate-y-1/2 select-none opacity-[0.16] mix-blend-lighten"
                style={{
                    maskImage: 'radial-gradient(circle at 50% 50%, black 52%, transparent 76%)',
                    WebkitMaskImage: 'radial-gradient(circle at 50% 50%, black 52%, transparent 76%)',
                }}
            />
        </div>
        <p className="text-base font-bold text-white mb-1.5">Begin Your Log</p>
        <p className="text-[13px] text-white/40 max-w-[260px] text-center leading-relaxed">
            Every great voyage starts with a single position. Slide below to begin GPS tracking.
        </p>
    </div>
);
