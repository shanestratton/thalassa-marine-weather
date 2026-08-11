/**
 * Remote access via the skipper's own Tailscale account — shared card,
 * mounted on BOTH "Boat Network" surfaces (the Ship's Office page in the
 * Vessel hub, and Settings → Advanced → Boat Network), because Shane went
 * looking on the Ship's Office page first and was right to.
 *
 * Self-contained AND self-gating: renders nothing until the Pi is
 * reachable, owns its own polling, and talks to pi-cache
 * /api/remote-access over the paired pinned-TLS channel. Identity
 * off-boat is the same pinned key + challenge-response as on the LAN.
 */
import React, { useState, useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { Section } from './SettingsPrimitives';
import { CheckCircleIcon } from '../Icons';
import { piCache, type PiRemoteAccessStatus } from '../../services/PiCacheService';
import { Browser } from '@capacitor/browser';
import { triggerHaptic } from '../../utils/system';

export const RemoteAccessSection: React.FC = () => {
    const reachable = useSyncExternalStore(
        (onChange) => piCache.onStatusChange(onChange),
        () => piCache.getStatus().reachable,
    );
    const [ra, setRa] = useState<PiRemoteAccessStatus | null | 'unsupported'>(null);
    const [busy, setBusy] = useState(false);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const refresh = useCallback(async () => {
        const status = await piCache.fetchRemoteAccessStatus();
        // null from a reachable Pi = the endpoint doesn't exist yet (older
        // pi-cache build) — distinct from "still loading".
        setRa(status ?? 'unsupported');
    }, []);

    useEffect(() => {
        if (reachable) void refresh();
        return () => {
            if (pollRef.current) clearInterval(pollRef.current);
        };
    }, [reachable, refresh]);

    // While the skipper is off signing in with Tailscale, poll until the
    // Pi reports connected (or they give up and the section unmounts).
    const state = typeof ra === 'object' && ra ? ra.state : null;
    useEffect(() => {
        if (state === 'needs-auth' || state === 'starting') {
            if (!pollRef.current) pollRef.current = setInterval(() => void refresh(), 4000);
        } else if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
        }
    }, [state, refresh]);

    const handleEnable = async (): Promise<void> => {
        triggerHaptic('light');
        setBusy(true);
        const status = await piCache.enableRemoteAccess();
        setRa(status ?? 'unsupported');
        setBusy(false);
        if (status?.state === 'needs-auth' && status.authUrl) {
            await Browser.open({ url: status.authUrl });
        }
    };

    const handleDisable = async (): Promise<void> => {
        triggerHaptic('light');
        setBusy(true);
        const status = await piCache.disableRemoteAccess();
        setRa(status ?? 'unsupported');
        setBusy(false);
    };

    if (!reachable) return null; // no Pi on the horizon — no card
    if (ra === null) return null; // first status still in flight
    return (
        <Section title="Remote Access">
            {ra === 'unsupported' ? (
                <div className="p-4">
                    <p className="text-xs text-gray-400 leading-relaxed">
                        This Pi&apos;s software predates remote access. Update the Pi (redeploy pi-cache) and this
                        section lights up.
                    </p>
                </div>
            ) : ra.state === 'not-installed' ? (
                <div className="p-4">
                    <p className="text-xs text-gray-400 leading-relaxed">
                        Tailscale isn&apos;t installed on this Pi yet. Re-run the Pi installer (it now sets this up
                        automatically), then come back here.
                    </p>
                </div>
            ) : ra.state === 'connected' ? (
                <div className="p-4 space-y-3">
                    <div className="flex items-start gap-2">
                        <span className="text-emerald-400 mt-0.5">
                            <CheckCircleIcon className="w-4 h-4" />
                        </span>
                        <div className="min-w-0">
                            <p className="text-sm font-medium text-white">Reachable away from the boat</p>
                            <p className="text-xs text-gray-400 mt-0.5 break-all">
                                {ra.dnsName?.replace(/\.$/, '') || ra.tailscaleIps?.[0]}
                                {piCache.viaRemoteAccess ? ' · connected via Tailscale now' : ''}
                            </p>
                            <p className="text-[11px] text-gray-500 mt-1.5 leading-relaxed">
                                Your phone needs the free Tailscale app signed into the same account to reach the Pi
                                off-boat.
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={handleDisable}
                        disabled={busy}
                        className="w-full py-2 rounded-xl bg-white/5 text-gray-400 text-[11px] font-bold uppercase tracking-wider hover:bg-white/10 active:scale-[0.98] transition-all disabled:opacity-40"
                    >
                        {busy ? 'Turning off…' : 'Turn Off Remote Access'}
                    </button>
                </div>
            ) : ra.state === 'needs-auth' ? (
                <div className="p-4 space-y-3">
                    <p className="text-xs text-gray-400 leading-relaxed">
                        Almost there — sign in with your Tailscale account (free) to link the Pi to your devices.
                        Waiting for the sign-in to complete…
                    </p>
                    {/* A sign-in link is single-use and expires with the login
                        attempt that minted it — when the Pi has none to offer,
                        this button re-runs enable to mint a fresh one instead
                        of sitting greyed out. */}
                    <button
                        onClick={() => (ra.authUrl ? void Browser.open({ url: ra.authUrl }) : void handleEnable())}
                        disabled={busy}
                        className="w-full py-3 rounded-xl bg-sky-500/20 border border-sky-500/30 text-sky-300 text-sm font-bold uppercase tracking-wider hover:bg-sky-500/30 active:scale-[0.98] transition-all disabled:opacity-40"
                    >
                        {busy
                            ? 'Getting sign-in link…'
                            : ra.authUrl
                              ? 'Sign In with Tailscale'
                              : 'Get a Fresh Sign-In Link'}
                    </button>
                </div>
            ) : (
                <div className="p-4 space-y-3">
                    <p className="text-xs text-gray-400 leading-relaxed">
                        Reach your Pi&apos;s weather, charts and tides when you&apos;re away from the boat — over your
                        own private Tailscale network. Needs a free Tailscale account; the Pi side is one tap.
                    </p>
                    {ra.state === 'error' && ra.message && (
                        <p className="text-[11px] text-amber-300/80">{ra.message}</p>
                    )}
                    <button
                        onClick={handleEnable}
                        disabled={busy}
                        className="w-full py-3 rounded-xl bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 text-sm font-bold uppercase tracking-wider hover:bg-emerald-500/30 active:scale-[0.98] transition-all disabled:opacity-40"
                    >
                        {busy ? 'Starting…' : 'Enable Remote Access'}
                    </button>
                </div>
            )}
        </Section>
    );
};
