/**
 * PlanOnWebHint — the PLAN page's "there's a bigger screen for this" nudge.
 *
 * Plotting a route by thumb on a phone works, but it is fiddly compared with a
 * laptop and a mouse — and most skippers never discover the page exists (Shane
 * 2026-07-19: "a nice modal screen at the beginning of the plan page, stating
 * that they can plot a track at the web page for easier use").
 *
 * Shows EVERY time by design, because a hint you see once is a hint you forget.
 * The "don't show again" checkbox is the escape hatch, and it is deliberately a
 * checkbox rather than an auto-suppress-after-N-views: the skipper decides when
 * they have got the message, not us.
 *
 * Portalled to <body>. The PLAN page rides inside PageTransition, whose
 * translate3d makes it the containing block for `fixed` children — an
 * un-portalled overlay covers the page box rather than the screen, and lands
 * wherever that box happens to be. Learned the hard way on the Log page's
 * follow-route sheet, which took three attempts.
 */
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Capacitor } from '@capacitor/core';
import { triggerHaptic } from '../../utils/system';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('PlanOnWebHint');

const DISMISS_KEY = 'thalassa_plan_web_hint_dismissed';

/** Generic form, used until (or unless) the boat's real handle resolves. */
const GENERIC_URL = 'your-boat.thalassawx.app/plan';

export const PlanOnWebHint: React.FC = () => {
    const [open, setOpen] = useState(false);
    const [dontShow, setDontShow] = useState(false);
    const [url, setUrl] = useState<string>(GENERIC_URL);

    useEffect(() => {
        // NATIVE ONLY. Telling someone already sitting at the web planner to go
        // use the web planner is the kind of thing that makes an app feel like
        // nobody tested it. RoutePlanner renders on both surfaces.
        if (!Capacitor.isNativePlatform()) return;
        try {
            if (localStorage.getItem(DISMISS_KEY) === '1') return;
        } catch {
            /* storage unavailable — showing it is the safe side of this call */
        }
        setOpen(true);
    }, []);

    // Resolve the boat's own subdomain so the hint names a URL the skipper can
    // actually type, not a placeholder. Fails quiet: the generic form is still
    // useful, and this must never block or delay the hint appearing.
    useEffect(() => {
        if (!open) return;
        let alive = true;
        void (async () => {
            try {
                const { VoyageLogService } = await import('../../services/VoyageLogService');
                const config = await VoyageLogService.getConfig();
                const handle = config?.handle?.trim();
                if (alive && handle) setUrl(`${handle}.thalassawx.app/plan`);
            } catch (e) {
                log.warn('handle lookup failed — keeping the generic URL:', e);
            }
        })();
        return () => {
            alive = false;
        };
    }, [open]);

    const close = () => {
        if (dontShow) {
            try {
                localStorage.setItem(DISMISS_KEY, '1');
            } catch {
                log.warn('dismissal not persisted — the hint will return');
            }
        }
        triggerHaptic('light');
        setOpen(false);
    };

    if (!open) return null;

    return createPortal(
        <div
            className="fixed inset-0 z-[10070] flex items-center justify-center bg-black/70 px-4 py-[max(1rem,env(safe-area-inset-bottom))]"
            onClick={close}
            role="dialog"
            aria-modal="true"
            aria-label="Plot on the big screen"
        >
            <div
                className="flex max-h-full w-full max-w-sm flex-col overflow-hidden rounded-3xl border border-sky-500/25 bg-slate-900 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="shrink-0 border-b border-white/10 px-5 py-4">
                    <div className="text-sm font-black uppercase tracking-widest text-sky-300">
                        🖥 Plot on the big screen
                    </div>
                </div>

                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
                    <p className="text-[13px] leading-relaxed text-gray-300">
                        Tracing a route is far easier with a mouse and a big chart. Open this on your laptop and plot
                        there — it is the same planner, the same charts, and anything you save syncs straight back to
                        the boat.
                    </p>
                    <div className="rounded-xl border border-white/10 bg-slate-800/70 px-3 py-2.5">
                        <div className="text-[10px] font-black uppercase tracking-widest text-gray-500">
                            Your planner
                        </div>
                        <div className="mt-0.5 select-all break-all font-mono text-[13px] font-bold text-sky-300">
                            {url}
                        </div>
                    </div>
                    <p className="text-[11px] leading-snug text-gray-500">
                        Sign in with the same account and your vessel, saved routes and trips are already there.
                    </p>
                </div>

                <div className="shrink-0 space-y-3 border-t border-white/10 px-5 py-4">
                    {/* A LABEL, not a bare checkbox — a 16px box is not a thumb
                        target, so the whole row toggles it. */}
                    <label className="flex cursor-pointer items-center gap-2.5 py-1">
                        <input
                            type="checkbox"
                            checked={dontShow}
                            onChange={(e) => setDontShow(e.target.checked)}
                            className="h-4 w-4 shrink-0 accent-sky-400"
                        />
                        <span className="text-[12px] font-bold text-gray-400">Don’t show this again</span>
                    </label>
                    <button
                        onClick={close}
                        className="w-full rounded-xl bg-sky-500/20 py-2.5 text-[12px] font-black uppercase tracking-widest text-sky-300 active:scale-95"
                    >
                        Got it — plot here anyway
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
};
