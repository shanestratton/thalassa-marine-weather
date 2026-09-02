/**
 * PiPairingBanner — the one-tap "is this my boat's Pi?" decision, surfaced
 * where the skipper actually is.
 *
 * Why this is a banner and not automatic
 * ──────────────────────────────────────
 * Shane, 2026-08-07: "why press a button, when it should just pair
 * automatically." Fair question, and the answer is the whole reason pairing
 * exists. Anyone on a marina Wi-Fi can answer `calypso.local`. Auto-trusting
 * whatever replies first would mean accepting DEPTH AND CHART DATA from a
 * stranger's box — a grounding risk, not a privacy nicety — and handing it the
 * diary relay token. This is SSH's trust-on-first-use model, and the one human
 * decision it needs is what makes the rest of the pinned-key machinery mean
 * anything.
 *
 * What WAS wrong was the ergonomics, not the decision. The offer lived only
 * inside Settings → Boat Network, so a skipper who never opened that tab was
 * never asked — and the ENC sync silently did nothing, because the identity
 * gate blocks until paired. Discovery is automatic; only trust is manual, it
 * is one tap, and it happens once per Pi ever.
 *
 * Deliberately quiet: it never covers the chart, never steals focus, and a
 * dismissal is respected for the rest of the session.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { piCache, type PiPairingEvent } from '../services/PiCacheService';
import { getPairing, pairWithPi, type PairInfo } from '../services/PiPairingService';
import { PI_INTEGRATION_ENABLED } from '../services/piPublicBetaBoundary';
import { triggerHaptic } from '../utils/system';
import { createLogger } from '../utils/createLogger';

const log = createLogger('PiPairingBanner');

interface Offer {
    host: string;
    baseUrl: string;
    info: PairInfo;
}

export const PiPairingBanner: React.FC = () => {
    const [offer, setOffer] = useState<Offer | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Session-only. A skipper who says "not now" is not asked again until the
    // next launch — but the offer is not forgotten, so Settings still shows it.
    const [dismissed, setDismissed] = useState(false);

    useEffect(() => {
        if (!PI_INTEGRATION_ENABLED) return;
        if (getPairing()) return;

        // Read the STANDING offer first: it is usually made at boot, from
        // checkHealth, long before this mounts. Subscribing alone would miss it.
        const standing = piCache.getPairableCandidate();
        if (standing?.type === 'pairable-found') {
            setOffer({ host: standing.host, baseUrl: standing.baseUrl, info: standing.info });
        }

        return piCache.onPairingEvent((event: PiPairingEvent) => {
            if (event.type === 'pairable-found') {
                setOffer({ host: event.host, baseUrl: event.baseUrl, info: event.info });
            }
        });
    }, []);

    const handlePair = useCallback(async () => {
        if (!offer) return;
        triggerHaptic('light');
        setBusy(true);
        setError(null);
        try {
            const record = await pairWithPi(offer.baseUrl, offer.host);
            if (record) {
                log.warn(`paired with ${record.boatName} via banner`);
                piCache.adoptPairing(offer.host);
                setOffer(null);
            } else {
                // pairWithPi returns null when the responder could not sign for
                // the key it advertised, or the TLS channel could not be bound
                // to it. Say so plainly rather than "try again".
                setError('That device could not prove it owns the key it advertised. Not paired.');
            }
        } finally {
            setBusy(false);
        }
    }, [offer]);

    if (!PI_INTEGRATION_ENABLED || !offer || dismissed) return null;

    return (
        <div
            role="status"
            aria-live="polite"
            className="pointer-events-auto fixed inset-x-0 z-880 mx-auto w-[min(420px,calc(100vw-24px))] rounded-2xl border border-sky-400/30 bg-slate-950/95 p-3 shadow-2xl backdrop-blur-xl"
            style={{ bottom: 'calc(env(safe-area-inset-bottom) + 88px)' }}
        >
            <p className="text-[13px] font-black leading-snug text-white">Pair with {offer.info.boatName}?</p>
            <p className="mt-1 text-[11px] leading-snug text-slate-400">
                Found on your network. Pairing lets Thalassa use its charts and cache — and stops anything else
                pretending to be it.
            </p>
            {/* The fingerprint is the whole point of TOFU: it is what the
                skipper checks against their own Pi. Monospace so digits line up. */}
            <p className="mt-2 font-mono text-sm tracking-wider text-sky-300 break-all">{offer.info.fingerprint}</p>

            {error && <p className="mt-2 text-[11px] font-bold leading-snug text-amber-300">{error}</p>}

            <div className="mt-3 flex gap-2">
                <button
                    type="button"
                    onClick={() => void handlePair()}
                    disabled={busy}
                    className="min-h-[44px] flex-1 rounded-xl bg-sky-500 px-4 text-sm font-black text-white transition-colors hover:bg-sky-400 active:scale-[0.98] disabled:opacity-50"
                >
                    {busy ? 'Pairing…' : 'Pair'}
                </button>
                <button
                    type="button"
                    onClick={() => {
                        triggerHaptic('light');
                        setDismissed(true);
                    }}
                    className="min-h-[44px] rounded-xl border border-white/10 px-4 text-sm font-bold text-slate-300 transition-colors hover:bg-white/6"
                >
                    Not now
                </button>
            </div>
        </div>
    );
};
