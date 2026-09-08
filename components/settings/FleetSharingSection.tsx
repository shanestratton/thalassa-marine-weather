/**
 * FleetSharingSection — "Share what you hear": the AIS crowd-feed consent
 * toggle, its disclaimer sheet and the low-data link switch.
 *
 * Lives in Settings → Preferences (moved from the NMEA Gateway page on
 * 2026-09-09 — Shane: "can we move that into the preferences page on the
 * settings page. i want to move most toggles there"). The consent rules are
 * unchanged and documented on ConsentSheet below.
 */
import React, { useEffect, useState } from 'react';
import { Toggle } from './SettingsPrimitives';
import { useAuthStore } from '../../stores/authStore';
import { useNmeaConnectionStatus } from '../nmea/useNmeaStore';
import { triggerHaptic } from '../../utils/system';
import {
    getShareStats,
    isLowDataLink,
    isShareConfigured,
    isShareEnabled,
    setLowDataLink,
    setShareEnabled,
    subscribeShareStats,
} from '../../services/AisShareService';

/**
 * The crowd-feed consent card and its disclaimer sheet.
 *
 * Two rules shape this UI, both learned the hard way elsewhere in the app:
 *
 *  1. TURNING IT ON IS A DECISION; TURNING IT OFF IS NOT. Enabling opens the
 *     full disclaimer and requires an explicit accept — because for a boat with
 *     a transponder, opting in publishes its own position publicly and that
 *     cannot be undone once AISHub copies it onward. Disabling is one tap with
 *     no friction, no confirmation and no "are you sure": consent withdrawal
 *     must never carry a cost.
 *  2. A DEAD CONTROL MUST LOOK DEAD. Inert-with-reason whenever the relay is
 *     unconfigured or the skipper is signed out, never a green light over
 *     nothing.
 *
 * Note what is NOT here any more: "waiting for the gateway". A disconnected
 * gateway no longer stops the watch — the check-in reports the fault and
 * standing is held — so telling the skipper sharing has stopped would be
 * false, and would push them to switch it off.
 */
const ConsentSheet: React.FC<{ onAccept: () => void; onDismiss: () => void }> = ({ onAccept, onDismiss }) => (
    <div
        className="fixed inset-0 z-200 flex items-center justify-center bg-black/70 p-4 pb-[calc(4rem+env(safe-area-inset-bottom)+1rem)] pt-[max(1rem,env(safe-area-inset-top))]"
        role="dialog"
        aria-modal="true"
        aria-label="Share what you hear"
        onClick={onDismiss}
    >
        {/* Centred per the standing modal rule (Shane 2026-09-02: "all modal boxes centered on the punters screen"). */}
        <div
            className="max-h-full w-full max-w-md overflow-y-auto rounded-3xl border border-white/10 bg-slate-900 p-5 pb-8"
            onClick={(e) => e.stopPropagation()}
        >
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-white/20" />
            <h2 className="text-lg font-bold text-gray-100">Share what you hear</h2>
            <p className="mt-3 text-[13px] leading-relaxed text-gray-300">
                Turn this on and every AIS sentence your gateway hears gets sent to Thalassa&rsquo;s fleet map and on to
                AISHub, a public AIS network that copies it out to other tracking sites. It&rsquo;s off by default and
                it&rsquo;s entirely your call.
            </p>

            <h3 className="mt-5 text-[15px] font-bold text-amber-300">Your own boat becomes publicly trackable.</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-gray-300">
                If your setup transmits &mdash; any Class A or Class B transponder &mdash; your boat&rsquo;s own
                position reports go out with everything else. Your MMSI, your boat&rsquo;s name if it&rsquo;s programmed
                in, your position, course and speed, live, on public tracking websites, to anyone who cares to look.
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-gray-300">
                We can&rsquo;t take that back. Once it reaches AISHub it&rsquo;s copied onward within seconds and we
                have no way to reach the sites that copied it. Turning sharing off later stops new reports. It does not
                remove what&rsquo;s already out there.
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-gray-300">
                Don&rsquo;t turn this on if there&rsquo;s any reason you&rsquo;d rather your boat wasn&rsquo;t findable
                &mdash; you sail alone, you&rsquo;re avoiding someone, or you&rsquo;re heading somewhere that being
                tracked is a risk.
            </p>
            <p className="mt-2 text-[12px] leading-relaxed text-gray-400">
                If your gear only receives and never transmits, nothing about your boat goes out. Only the ships you
                hear.
            </p>

            <h3 className="mt-5 text-[15px] font-bold text-gray-100">Being heard by nobody still counts.</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-gray-300">
                Anchored somewhere with no ships for 200 miles? That silence is worth as much as a busy harbour &mdash;
                it proves someone was listening out there. What we count is time on watch, never ships delivered. An
                empty ocean earns exactly what Sydney Harbour earns.
            </p>

            <h3 className="mt-5 text-[15px] font-bold text-gray-100">What we keep about you.</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-gray-300">
                One row: how many minutes you&rsquo;ve been on watch, when we last heard from you, and how many
                sentences you&rsquo;ve sent. Not where you were, not where you went, no history. It&rsquo;s deleted when
                your account is.
            </p>

            <h3 className="mt-5 text-[15px] font-bold text-gray-100">What this never affects.</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-gray-300">
                Nothing here changes what you see from your own AIS receiver, the collision guard, the anchor radar, or
                any ship near you. That&rsquo;s safety data. It&rsquo;s never rationed, for anyone, and never will be.
            </p>

            <p className="mt-4 text-[12px] leading-relaxed text-gray-400">
                <span className="font-semibold text-gray-300">Data cost.</span> About 5 MB a month when there&rsquo;s
                nothing to hear, more in busy water. Switch on Low-data link for a satellite connection and it&rsquo;s
                under 1 MB &mdash; you earn exactly the same either way.
            </p>
            <p className="mt-2 text-[12px] leading-relaxed text-gray-400">
                <span className="font-semibold text-gray-300">Turning it off.</span> One tap, any time. Sharing stops
                immediately.
            </p>

            <div className="mt-5 flex flex-col gap-2">
                <button
                    type="button"
                    onClick={onAccept}
                    className="rounded-xl bg-emerald-500 px-4 py-3 text-[15px] font-semibold text-slate-950 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-emerald-300"
                >
                    Share what I hear
                </button>
                <button
                    type="button"
                    onClick={onDismiss}
                    className="rounded-xl px-4 py-3 text-[15px] font-semibold text-emerald-300 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-emerald-300"
                >
                    Not now
                </button>
            </div>
        </div>
    </div>
);

export const FleetSharingSection: React.FC = () => {
    // "Connected" here means the boat is being heard: the gateway socket, or
    // the Pi over the boat LAN. Read from the store so this section needs no
    // props from whichever page mounts it (it moved from the NMEA Gateway page
    // to Settings → Preferences on 2026-09-09: Shane wants the toggles there).
    const link = useNmeaConnectionStatus();
    const connected = link.status === 'connected' || (link.status === 'remote' && link.remote?.via === 'lan');
    const [enabled, setEnabled] = useState(() => isShareEnabled());
    const [lowData, setLowData] = useState(() => isLowDataLink());
    const [sheetOpen, setSheetOpen] = useState(false);
    const [, force] = useState(0);
    useEffect(() => subscribeShareStats(() => force((n) => n + 1)), []);
    // Sharing uploads through an authenticated endpoint — signed out, every
    // batch is dropped by getAuthenticatedFunctionHeaders. The card must not
    // claim "Sharing live" in that state (review, 2026-08-21).
    const signedIn = useAuthStore((state) => state.user !== null);

    const configured = isShareConfigured();
    const stats = getShareStats();
    const active = enabled && configured && signedIn;
    const hours = stats.card ? Math.floor(stats.card.watchMinutes / 60) : 0;

    return (
        <div className="p-4">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <p className="text-sm font-bold text-gray-100">Share what you hear</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-gray-400">
                        Contribute the AIS traffic this gateway hears to the Thalassa fleet map and to AISHub&rsquo;s
                        public network. Off by default &mdash; sharing is an explicit choice.
                    </p>
                </div>
                <Toggle
                    checked={enabled}
                    onChange={(value) => {
                        // ON asks first. OFF is immediate — withdrawal must
                        // never be made harder than consent.
                        if (value) {
                            setSheetOpen(true);
                            return;
                        }
                        setShareEnabled(false);
                        setEnabled(false);
                    }}
                    label="Share what you hear"
                />
            </div>

            {enabled && !configured && (
                <p className="mt-2 text-[11px] font-semibold text-amber-300">
                    This build has no share relay configured &mdash; nothing is being sent.
                </p>
            )}
            {enabled && configured && !signedIn && (
                <p className="mt-2 text-[11px] font-semibold text-amber-300">
                    Sign in to share &mdash; the fleet feed needs a Thalassa account.
                </p>
            )}

            {active && (
                <>
                    <p className="mt-2 text-[11px] font-semibold text-emerald-300">
                        {stats.card
                            ? `On watch · ${hours.toLocaleString()} h total · ${stats.card.watchMinutes7d.toLocaleString()} min this week`
                            : 'On watch · first check-in on its way'}
                    </p>
                    {!connected && (
                        // Deliberately NOT an error. Standing is held through a
                        // gateway fault, and telling someone their contribution
                        // has stopped is how you get them to switch it off.
                        <p className="mt-1 text-[11px] leading-relaxed text-gray-400">
                            Gateway down{stats.linkError ? ` — ${stats.linkError}` : ''}. Standing held. Nothing to fix
                            if the boat&rsquo;s ashore.
                        </p>
                    )}
                    {connected && stats.sharedTotal === 0 && (
                        <p className="mt-1 text-[11px] leading-relaxed text-gray-400">
                            Nothing heard yet. If you&rsquo;re offshore that&rsquo;s exactly what we&rsquo;d expect, and
                            it still counts.
                        </p>
                    )}
                    {stats.rejected && stats.rejected.checksum > 0 && stats.rejected.notAis === 0 && (
                        <p className="mt-1 text-[11px] leading-relaxed text-amber-200/80">
                            Most sentences are failing their checksum &mdash; usually a baud-rate or NMEA-0183 wiring
                            fault.
                        </p>
                    )}
                    <div className="mt-3 flex items-center justify-between gap-3 border-t border-white/6 pt-3">
                        <div className="min-w-0">
                            <p className="text-[12px] font-semibold text-gray-200">Low-data link</p>
                            <p className="text-[11px] leading-relaxed text-gray-400">
                                Check in every 30 minutes instead of 5, for satellite. Earns exactly the same.
                            </p>
                        </div>
                        <Toggle
                            checked={lowData}
                            onChange={(value) => {
                                setLowDataLink(value);
                                setLowData(value);
                            }}
                            label="Low-data link"
                        />
                    </div>
                </>
            )}

            {sheetOpen && (
                <ConsentSheet
                    onAccept={() => {
                        setShareEnabled(true);
                        setEnabled(true);
                        setSheetOpen(false);
                        triggerHaptic();
                    }}
                    onDismiss={() => setSheetOpen(false)}
                />
            )}
        </div>
    );
};
