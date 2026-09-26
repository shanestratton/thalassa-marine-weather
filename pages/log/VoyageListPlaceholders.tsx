/**
 * VoyageListPlaceholders — the two non-list states of the Ship's Log voyage
 * list, extracted verbatim from pages/LogPage.tsx: the hydrating skeleton and
 * the "Begin your log" empty state. The caller keeps the ternary that chooses
 * between them and the real cards.
 */
import React from 'react';

/* History still hydrating (cache miss / first network
   load) — skeleton cards, NOT the "Begin your log"
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

export const VoyageListEmptyState: React.FC<{
    /** A status card or line heads the page (a failed history read): the
     *  watermark shrinks, and goes on short phones, so it is not cut in half
     *  by the slide bar under the words. */
    compact?: boolean;
}> = ({ compact = false }) => (
    <div className="flex-1 flex flex-col items-center justify-center text-slate-400 px-6 pt-6 pb-8">
        {/* The words come first: under the two status cards the heading sat
            below the fold at 393 and 375, behind a watermark (UX scorecard
            run 7). */}
        <h2 className="text-base font-bold text-white mb-1.5">Begin your log</h2>
        <p className="text-[13px] text-white/40 max-w-[260px] text-center leading-relaxed">
            Every great voyage starts with a single position. Slide below to begin GPS tracking.
        </p>
        {/* Watermark — the Thalassa mark, big and faint, where the little
            compass used to be (Shane 2026-09-06: "the thalassa icon in a
            watermark look. do it big"). The PNG is opaque on near-black:
            `lighten` lets the page ground win under it and a radial mask
            feathers the square away, so only the rose and the wave remain.
            It is sized to the room left above the slide bar (clamp on dvh) and
            smaller while a status card heads the page; on a short phone it
            stays, at 110 px (Shane asked for it big, so it never disappears on
            the plain empty page). */}
        <div
            className={`relative mt-4 w-full max-w-[380px] ${
                compact
                    ? 'h-[clamp(120px,calc(100dvh-650px),240px)] [@media(max-height:760px)]:hidden'
                    : 'h-[clamp(110px,calc(100dvh-565px),380px)]'
            }`}
            aria-hidden="true"
            data-testid="log-watermark"
        >
            <img
                src="/thalassa-icon.png"
                alt=""
                draggable={false}
                className={`pointer-events-none absolute left-1/2 top-0 w-[380px] -translate-x-1/2 select-none opacity-[0.16] mix-blend-lighten ${
                    compact
                        ? 'max-w-[clamp(120px,calc(100dvh-650px),240px)]'
                        : 'max-w-[clamp(110px,calc(100dvh-565px),380px)]'
                }`}
                style={{
                    maskImage: 'radial-gradient(circle at 50% 50%, black 52%, transparent 76%)',
                    WebkitMaskImage: 'radial-gradient(circle at 50% 50%, black 52%, transparent 76%)',
                }}
            />
        </div>
    </div>
);
