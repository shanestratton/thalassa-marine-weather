/**
 * VoyageListPlaceholders — the two non-list states of the Ship's Log voyage
 * list, extracted verbatim from pages/LogPage.tsx: the hydrating skeleton and
 * the "Begin your log" empty state. The caller keeps the ternary that chooses
 * between them and the real cards.
 */
import React, { useSyncExternalStore } from 'react';
import { LOG_SIGNED_OUT_BODY, getIdentitySnapshot, subscribeIdentitySnapshot } from './logPageHelpers';

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
    /** A history read failed, so a status card or line heads the page: the
     *  watermark shrinks, and goes on short phones, so it is not cut in half
     *  by the slide bar under the words. The words change too — see below. */
    compact?: boolean;
}> = ({ compact = false }) => {
    // Signed out, there is no account history to wait for, so the page must
    // not promise that it will load (UX scorecard run 10).
    const signedOut = !useSyncExternalStore(subscribeIdentitySnapshot, getIdentitySnapshot, getIdentitySnapshot).userId;
    return (
        <div className="flex-1 flex flex-col items-center justify-center text-slate-400 px-6 pt-6 pb-8">
            {/* The words come first: under the two status cards the heading sat
                below the fold at 393 and 375, behind a watermark (UX scorecard
                run 7). Under a failed history read, "Begin your log" read as
                "your log is empty" to a skipper whose voyages simply had not
                loaded, so it says what is actually known (run 8). The line above
                has already said the history didn't load, so the body no longer
                says it a fourth time (run 10); signed out, it says what signing
                in adds instead of promising a load. text-balance keeps the last
                word from sitting alone on its own line. */}
            {compact ? (
                <>
                    <h2 className="text-base font-bold text-white mb-1.5">No voyages on this phone yet</h2>
                    <p className="text-[13px] text-white/40 max-w-[260px] text-center leading-relaxed text-balance">
                        {signedOut ? `${LOG_SIGNED_OUT_BODY} ` : ''}Slide below to begin GPS tracking.
                    </p>
                </>
            ) : (
                <>
                    <h2 className="text-base font-bold text-white mb-1.5">Begin your log</h2>
                    <p className="text-[13px] text-white/40 max-w-[260px] text-center leading-relaxed text-balance">
                        Every great voyage starts with a single position. Slide below to begin GPS tracking.
                    </p>
                </>
            )}
            {/* Watermark — the Thalassa mark, big and faint, where the little
                compass used to be (Shane 2026-09-06: "the thalassa icon in a
                watermark look. do it big"). The PNG is opaque on near-black:
                `lighten` lets the page ground win under it and a radial mask
                feathers the square away, so only the rose and the wave remain.
                It is sized to the room left above the slide bar (clamp on dvh) and
                smaller while a status card heads the page; on a short phone it
                stays, at 110 px (Shane asked for it big, so it never disappears on
                the plain empty page). While a history card above is open (Voyage
                stats or Archived voyages — a section whose disclosure button is
                aria-expanded), the page below it is pushed down and only the
                mark's tip peeked over the slide bar as a stray glyph, so it steps
                out until the card closes (UX scorecard run 8). */}
            <div
                className={`relative mt-4 w-full max-w-[380px] in-[:has(>section>button[aria-expanded=true])]:hidden ${
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
};
