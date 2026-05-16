/**
 * DiscoverVoyagesSection — community Voyage Logs surface inside
 * the Log tab.
 *
 * Why this exists
 * ---------------
 * The public Voyage Log feature (thalassawx.app/logs/<handle>) is
 * the strongest differentiation pillar in the "Plan it · Sail it ·
 * Share it" positioning — no other marine app does shareable
 * public voyage logs. But until today the in-app Log tab showed
 * only the user's OWN voyages, with zero entry point into
 * community content. New users couldn't see what was possible.
 *
 * This section closes that gap. It renders a curated list of
 * featured public voyages (see utils/featuredPublicVoyages.ts) —
 * each card teases the vessel + route, and tapping opens the
 * live public page in the OS browser (Capacitor.Browser on
 * native, window.open on web). The cards themselves don't fetch
 * the API; the live data stays on thalassawx.app where it's
 * always fresh.
 *
 * Design
 * ------
 * Uses the BRAND palette introduced with the logo refresh
 * (teal-300 stroke, orange-400 accent) rather than the cyan UI
 * palette — these are "Share it" moments, so they deserve the
 * brand-treatment colours. Section header matches the same
 * SectionHeader style used on the Vessel hub.
 */

import React from 'react';
import { triggerHaptic } from '../../utils/system';
import { FEATURED_PUBLIC_VOYAGES, type FeaturedPublicVoyage } from '../../utils/featuredPublicVoyages';

// Brand palette (matches SignInScreen logo refresh)
const BRAND = {
    primary: '#0F766E', //   teal-700 — deep sea green
    primarySoft: '#5EEAD4', // teal-300 — line / glow accent
    accent: '#FB923C', //    orange-400 — destination terminator / badge
};

/**
 * Opens the public Voyage Log page in the user's preferred
 * browser. On Capacitor native, the system browser sheet opens
 * (no app context switch); on web fallback, opens a new tab.
 */
async function openPublicVoyage(handle: string): Promise<void> {
    const url = `https://thalassawx.app/logs/${handle}`;
    triggerHaptic('light');
    try {
        const cap = await import('@capacitor/core');
        if (cap.Capacitor.isNativePlatform()) {
            const browser = await import('@capacitor/browser');
            await browser.Browser.open({ url, presentationStyle: 'popover' });
            return;
        }
    } catch {
        // Capacitor not available — fall through to web.
    }
    window.open(url, '_blank', 'noopener,noreferrer');
}

const VoyageCardItem: React.FC<{ voyage: FeaturedPublicVoyage }> = ({ voyage }) => {
    const icon = voyage.vesselType === 'power' ? '🛥️' : '⛵';
    return (
        <button
            type="button"
            onClick={() => void openPublicVoyage(voyage.handle)}
            aria-label={`Open ${voyage.vesselName} voyage log — ${voyage.route || 'Live voyage log'}`}
            className="w-full text-left rounded-xl border bg-gradient-to-br from-teal-500/[0.06] via-slate-900/30 to-teal-500/[0.02] backdrop-blur-md hover:from-teal-500/[0.10] transition-colors shadow-lg p-4 mb-3 active:scale-[0.98]"
            style={{ borderColor: 'rgba(94, 234, 212, 0.20)' }}
        >
            <div className="flex items-start gap-3">
                <div
                    className="w-11 h-11 rounded-xl flex items-center justify-center text-xl flex-shrink-0"
                    style={{
                        background: 'rgba(15, 118, 110, 0.15)',
                        border: '1px solid rgba(94, 234, 212, 0.25)',
                    }}
                    aria-hidden="true"
                >
                    {icon}
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                        <h3
                            className="text-base font-bold text-white truncate"
                            style={{
                                fontFamily: '"Cochin", "Optima", "Athelas", "Iowan Old Style", Georgia, serif',
                                fontWeight: 600,
                                letterSpacing: '0.01em',
                            }}
                        >
                            {voyage.vesselName}
                        </h3>
                        {voyage.badge && (
                            <span
                                className="shrink-0 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-widest"
                                style={{
                                    backgroundColor: 'rgba(251, 146, 60, 0.15)',
                                    border: '1px solid rgba(251, 146, 60, 0.35)',
                                    color: BRAND.accent,
                                }}
                            >
                                {voyage.badge}
                            </span>
                        )}
                    </div>
                    <p className="text-[12px] font-semibold text-teal-300/90 truncate">
                        {voyage.route || 'Live voyage log'}
                    </p>
                    {voyage.description && (
                        <p className="text-[12px] text-slate-300/70 leading-relaxed mt-1.5 line-clamp-2">
                            {voyage.description}
                        </p>
                    )}
                </div>
                {/* Open-external chevron */}
                <svg
                    className="w-4 h-4 mt-2 shrink-0"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                    style={{ color: BRAND.primarySoft }}
                    aria-hidden="true"
                >
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                    />
                </svg>
            </div>
        </button>
    );
};

export const DiscoverVoyagesSection: React.FC = () => {
    if (FEATURED_PUBLIC_VOYAGES.length === 0) return null;

    return (
        <section className="mt-6 mb-4">
            {/* Section header — matches the SectionHeader pattern on
                Vessel hub. Cyan pill stays for visual consistency with
                the rest of the app; the brand teal/orange only applies
                INSIDE the cards (the "Share it" moments themselves). */}
            <div className="w-full flex items-center gap-2.5 mb-2 py-2 px-1">
                <div className="w-1.5 h-4 rounded-full" style={{ backgroundColor: BRAND.primarySoft }} />
                <span
                    className="text-xs font-black uppercase tracking-[0.2em] flex-1 text-left"
                    style={{ color: BRAND.primarySoft }}
                >
                    Discover Voyages
                </span>
            </div>

            <p className="text-[12px] text-slate-400 leading-relaxed px-1 mb-3 max-w-md">
                Live voyage logs from other sailors. Tap to open the public page — track, weather, diary, and AIS,
                updated in real time.
            </p>

            {FEATURED_PUBLIC_VOYAGES.map((voyage) => (
                <VoyageCardItem key={voyage.handle} voyage={voyage} />
            ))}

            {/* Footer hint — points users at the publishing flow.
                Settings → Voyage Log is where they enable their own
                public page; same VoyageLogTab the existing app already
                ships. Hint is subtle (slate-500), not a primary CTA —
                the section's job is to inspire, not pitch. */}
            <p className="text-[11px] text-slate-500/80 leading-relaxed px-1 mt-2">
                Publish your own at Settings → Voyage Log.
            </p>
        </section>
    );
};
