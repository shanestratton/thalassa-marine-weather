/**
 * PiSetupWizard — full-screen multi-step flow that walks the skipper
 * through joining a fresh Pi to their boat WiFi.
 *
 * Mirrors the pattern Sonos / Hue / Ring use:
 *   1. Plug in the Pi.
 *   2. Phone joins the Pi's `Calypso-Setup-XXXX` AP (manual join in
 *      Settings for v1; NEHotspotConfiguration auto-join is a
 *      follow-up commit when we have the Apple entitlement wired).
 *   3. Wizard hits the Pi's /api/network/scan to list nearby networks.
 *   4. Skipper picks SSID + types password.
 *   5. /api/network/configure pushes the creds; wizard polls
 *      /api/network/status until the Pi reports success or failure.
 *   6. Skipper switches the phone back to the boat WiFi; the existing
 *      BoatNetworkService discovery picks the Pi up on the new
 *      network and the wizard confirms.
 *
 * Spec for the Pi-side endpoints: docs/BOSUN_NETWORK_SETUP_API.md.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
    configureNetwork,
    isProvisioningReachable,
    scanNetworks,
    setupApContext,
    waitForJoinResolution,
    type NearbyNetwork,
    type NetworkStatus,
    type WifiSecurity,
} from '../../services/voice/piProvisioning';
import { BoatNetworkService } from '../../services/BoatNetworkService';

interface Props {
    isOpen: boolean;
    onClose: () => void;
}

type WizardStep =
    | 'intro' //          Welcome + power on the Pi
    | 'join-ap' //        Walk through Settings → WiFi → Calypso-Setup-…
    | 'verify-ap' //      Probe http://10.0.0.1:5000 to confirm we're on the AP
    | 'pick-network' //   Render scan results, let skipper pick SSID
    | 'enter-password' // Password input for the chosen SSID
    | 'configuring' //    POST configure + poll status
    | 'switch-back' //    Tell skipper to leave the AP and rejoin boat WiFi
    | 'discovering' //    Run BoatNetworkService scan to find Pi on new network
    | 'success' //        Pi found, all done
    | 'error'; //         Anything fatal — render reason + retry button

interface WizardState {
    step: WizardStep;
    error: string | null;
    networks: NearbyNetwork[];
    selectedSsid: string | null;
    selectedSecurity: WifiSecurity | null;
    password: string;
    finalStatus: NetworkStatus | null;
}

const initialState: WizardState = {
    step: 'intro',
    error: null,
    networks: [],
    selectedSsid: null,
    selectedSecurity: null,
    password: '',
    finalStatus: null,
};

const AP_PASSWORD_DISPLAY = 'calypso-setup';

function signalBars(dbm: number): number {
    if (dbm >= -55) return 4;
    if (dbm >= -65) return 3;
    if (dbm >= -75) return 2;
    return 1;
}

function securityLabel(s: WifiSecurity): string {
    if (s === 'open') return 'Open';
    if (s === 'enterprise') return 'Enterprise (not supported)';
    return s.toUpperCase();
}

export const PiSetupWizard: React.FC<Props> = ({ isOpen, onClose }) => {
    const [state, setState] = useState<WizardState>(initialState);

    // Reset to intro every time the wizard re-opens.
    useEffect(() => {
        if (isOpen) setState(initialState);
    }, [isOpen]);

    const advance = useCallback((step: WizardStep) => setState((s) => ({ ...s, step, error: null })), []);
    const fail = useCallback((error: string) => setState((s) => ({ ...s, step: 'error', error })), []);

    // ── Step actions ─────────────────────────────────────────

    const verifyApReachable = useCallback(async () => {
        advance('verify-ap');
        const reachable = await isProvisioningReachable(setupApContext());
        if (!reachable) {
            // Hard to distinguish "not on AP" from "Pi not responding"
            // without iOS network APIs. Surface a single message that
            // covers both, with a Retry button on the same step.
            fail(
                "Couldn't reach the Pi at 10.0.0.1. Make sure you joined the Calypso-Setup network in Settings → WiFi (password: " +
                    AP_PASSWORD_DISPLAY +
                    ') and try again.',
            );
            return;
        }
        // We're on the AP. Move straight into scanning.
        try {
            const networks = await scanNetworks(setupApContext());
            setState((s) => ({ ...s, step: 'pick-network', networks, error: null }));
        } catch (err) {
            fail(`The Pi couldn't list nearby WiFi networks: ${(err as Error).message}`);
        }
    }, [advance, fail]);

    const refreshScan = useCallback(async () => {
        try {
            const networks = await scanNetworks(setupApContext());
            setState((s) => ({ ...s, networks }));
        } catch (err) {
            fail(`Scan failed: ${(err as Error).message}`);
        }
    }, [fail]);

    const onPickNetwork = useCallback(
        (network: NearbyNetwork) => {
            if (network.security === 'enterprise') return; // disabled in UI but defend anyway
            setState((s) => ({
                ...s,
                selectedSsid: network.ssid,
                selectedSecurity: network.security,
                password: '',
                // Open networks skip the password step entirely.
                step: network.security === 'open' ? 'configuring' : 'enter-password',
                error: null,
            }));
            if (network.security === 'open') {
                void runConfigure(network.ssid, network.security, '');
            }
        },
        // runConfigure depends on state and is defined below; we use a
        // ref-style pattern by binding it in useCallback after definition.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [],
    );

    const runConfigure = useCallback(
        async (ssid: string, security: WifiSecurity, password: string) => {
            advance('configuring');
            try {
                await configureNetwork(setupApContext(), { ssid, password, security });
                // Poll until the Pi tells us auth_failed / success / timeout.
                const finalStatus = await waitForJoinResolution(setupApContext(), {
                    targetSsid: ssid,
                    timeoutMs: 30_000,
                });
                const attempt = finalStatus.last_join_attempt;
                if (
                    finalStatus.mode === 'station' &&
                    finalStatus.station_ssid === ssid &&
                    (!attempt || attempt.result === 'success')
                ) {
                    setState((s) => ({ ...s, step: 'switch-back', finalStatus, error: null }));
                    return;
                }
                if (attempt) {
                    const friendly =
                        attempt.result === 'auth_failed'
                            ? `That password didn't work for ${ssid}.`
                            : attempt.result === 'ssid_not_found'
                              ? `The Pi couldn't find ${ssid} on the second look.`
                              : attempt.result === 'timeout'
                                ? `Joining ${ssid} took too long.`
                                : `Couldn't join ${ssid} — ${attempt.error_detail || 'unknown reason'}.`;
                    fail(friendly);
                    return;
                }
                fail(`The Pi never confirmed it joined ${ssid}. Try again.`);
            } catch (err) {
                fail(`Configure failed: ${(err as Error).message}`);
            }
        },
        [advance, fail],
    );

    const submitPassword = useCallback(() => {
        if (!state.selectedSsid || !state.selectedSecurity) return;
        void runConfigure(state.selectedSsid, state.selectedSecurity, state.password);
    }, [runConfigure, state.password, state.selectedSecurity, state.selectedSsid]);

    const onPhoneSwitchedBack = useCallback(async () => {
        advance('discovering');
        try {
            // Force a fresh scan rather than rely on cached piHost — the
            // Pi just got a new IP on the user's WiFi. Note the
            // BoatNetworkService scan returns the host directly when
            // found, but we also read the state for consistency with
            // the rest of the codebase.
            const found = await BoatNetworkService.scan();
            if (found || BoatNetworkService.getState().piHost) {
                advance('success');
            } else {
                fail(
                    "Phone is back on your WiFi but I couldn't find the Pi yet. It may take another moment — try again, or check the Pi has power.",
                );
            }
        } catch (err) {
            fail(`Discovery failed: ${(err as Error).message}`);
        }
    }, [advance, fail]);

    const restart = useCallback(() => setState(initialState), []);

    // ── Step renderers ───────────────────────────────────────

    if (!isOpen) return null;

    return (
        <div
            className="fixed inset-0 z-[300] flex flex-col bg-gradient-to-b from-slate-900 via-slate-950 to-black"
            role="dialog"
            aria-label="Pi setup wizard"
        >
            <Header step={state.step} onClose={onClose} />
            <div className="flex-1 overflow-y-auto px-5 py-6">
                {state.step === 'intro' && <IntroPanel onContinue={() => advance('join-ap')} />}
                {state.step === 'join-ap' && (
                    <JoinApPanel apPassword={AP_PASSWORD_DISPLAY} onContinue={() => void verifyApReachable()} />
                )}
                {state.step === 'verify-ap' && <SpinnerPanel label="Looking for the Pi…" />}
                {state.step === 'pick-network' && (
                    <PickNetworkPanel
                        networks={state.networks}
                        onPick={onPickNetwork}
                        onRefresh={() => void refreshScan()}
                    />
                )}
                {state.step === 'enter-password' && (
                    <PasswordPanel
                        ssid={state.selectedSsid ?? ''}
                        password={state.password}
                        onChange={(password) => setState((s) => ({ ...s, password }))}
                        onSubmit={submitPassword}
                        onBack={() => advance('pick-network')}
                    />
                )}
                {state.step === 'configuring' && (
                    <SpinnerPanel
                        label={`Telling the Pi to join ${state.selectedSsid}…`}
                        sublabel="This usually takes 10–20 seconds."
                    />
                )}
                {state.step === 'switch-back' && (
                    <SwitchBackPanel
                        ssid={state.finalStatus?.station_ssid ?? state.selectedSsid ?? ''}
                        onContinue={() => void onPhoneSwitchedBack()}
                    />
                )}
                {state.step === 'discovering' && <SpinnerPanel label="Finding the Pi on your WiFi…" />}
                {state.step === 'success' && <SuccessPanel onClose={onClose} />}
                {state.step === 'error' && (
                    <ErrorPanel message={state.error ?? 'Something went wrong.'} onRetry={restart} />
                )}
            </div>
        </div>
    );
};

// ── Subcomponents ────────────────────────────────────────────

const Header: React.FC<{ step: WizardStep; onClose: () => void }> = ({ step, onClose }) => (
    <header className="shrink-0 flex items-center justify-between px-5 pt-12 pb-4 border-b border-white/5">
        <div>
            <p className="text-base font-bold text-white">Set up Pi</p>
            <p className="text-[10px] uppercase tracking-widest text-gray-400">Step {stepLabel(step)}</p>
        </div>
        <button
            onClick={onClose}
            className="w-10 h-10 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center text-white/70"
            aria-label="Close setup"
        >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
        </button>
    </header>
);

function stepLabel(step: WizardStep): string {
    switch (step) {
        case 'intro':
            return '1 of 5 — Welcome';
        case 'join-ap':
        case 'verify-ap':
            return '2 of 5 — Connect to the Pi';
        case 'pick-network':
        case 'enter-password':
            return '3 of 5 — Pick your WiFi';
        case 'configuring':
            return '4 of 5 — Configuring';
        case 'switch-back':
        case 'discovering':
            return '5 of 5 — Reconnecting';
        case 'success':
            return 'Done';
        case 'error':
            return 'Something went wrong';
    }
}

const IntroPanel: React.FC<{ onContinue: () => void }> = ({ onContinue }) => (
    <div className="max-w-md mx-auto space-y-4 text-center pt-6">
        <p className="text-2xl font-bold text-white">Let&apos;s get your Pi onto WiFi.</p>
        <p className="text-sm text-gray-400">
            Make sure the Pi is plugged in and powered on. Wait about 30 seconds for it to boot up.
        </p>
        <p className="text-xs text-gray-500">
            When it&apos;s ready, you&apos;ll see a network called{' '}
            <span className="font-mono text-sky-300">Calypso-Setup-XXXX</span> in your iOS WiFi list.
        </p>
        <button
            onClick={onContinue}
            className="mt-6 w-full px-6 py-3 rounded-full bg-sky-500 hover:bg-sky-400 text-white font-bold transition-colors"
        >
            I&apos;m ready
        </button>
    </div>
);

const JoinApPanel: React.FC<{ apPassword: string; onContinue: () => void }> = ({ apPassword, onContinue }) => (
    <div className="max-w-md mx-auto space-y-5 pt-2">
        <p className="text-lg font-bold text-white">Join the Pi&apos;s setup network</p>
        <ol className="space-y-3 text-sm text-gray-300 list-decimal list-inside">
            <li>
                Open <span className="font-bold text-white">Settings → WiFi</span> on this phone.
            </li>
            <li>
                Tap the network starting with <span className="font-mono text-sky-300">Calypso-Setup-</span>.
            </li>
            <li>
                Enter the password{' '}
                <span className="font-mono px-2 py-0.5 rounded bg-white/5 text-sky-200 select-all">{apPassword}</span>.
            </li>
            <li>Come back here and tap below.</li>
        </ol>
        <p className="text-xs text-gray-500">
            iOS may warn you that the network has no internet — that&apos;s expected, the Pi is just for setup. Tap{' '}
            <span className="font-bold">Use Without Internet</span> if asked.
        </p>
        <button
            onClick={onContinue}
            className="mt-4 w-full px-6 py-3 rounded-full bg-sky-500 hover:bg-sky-400 text-white font-bold transition-colors"
        >
            I&apos;m connected
        </button>
    </div>
);

const SpinnerPanel: React.FC<{ label: string; sublabel?: string }> = ({ label, sublabel }) => (
    <div className="max-w-md mx-auto flex flex-col items-center pt-12 gap-3">
        <div className="w-10 h-10 rounded-full border-2 border-sky-400/30 border-t-sky-400 animate-spin" />
        <p className="text-sm font-bold text-white">{label}</p>
        {sublabel && <p className="text-xs text-gray-400 text-center">{sublabel}</p>}
    </div>
);

const PickNetworkPanel: React.FC<{
    networks: NearbyNetwork[];
    onPick: (n: NearbyNetwork) => void;
    onRefresh: () => void;
}> = ({ networks, onPick, onRefresh }) => (
    <div className="max-w-md mx-auto space-y-3">
        <div className="flex items-center justify-between">
            <p className="text-lg font-bold text-white">Pick your WiFi</p>
            <button
                onClick={onRefresh}
                className="text-[10px] uppercase tracking-widest text-sky-400 hover:text-sky-300"
            >
                Refresh
            </button>
        </div>
        {networks.length === 0 && (
            <p className="text-sm text-gray-400 py-8 text-center">
                The Pi didn&apos;t see any WiFi networks. Make sure you&apos;re close to your boat&apos;s router and tap
                Refresh.
            </p>
        )}
        <div className="space-y-1">
            {networks.map((n) => {
                const isEnterprise = n.security === 'enterprise';
                return (
                    <button
                        key={n.ssid}
                        onClick={() => onPick(n)}
                        disabled={isEnterprise}
                        className={`w-full text-left px-4 py-3 rounded-2xl border transition-colors ${
                            isEnterprise
                                ? 'bg-white/5 border-white/5 opacity-50 cursor-not-allowed'
                                : 'bg-white/5 border-white/10 hover:bg-white/10 active:bg-white/15'
                        }`}
                    >
                        <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                                <p className="text-sm font-bold text-white truncate">{n.ssid}</p>
                                <p className="text-[10px] uppercase tracking-widest text-gray-500">
                                    {securityLabel(n.security)} · ch {n.channel}
                                </p>
                            </div>
                            <SignalIndicator bars={signalBars(n.signal_dbm)} />
                        </div>
                    </button>
                );
            })}
        </div>
    </div>
);

const SignalIndicator: React.FC<{ bars: number }> = ({ bars }) => (
    <div className="flex items-end gap-0.5 shrink-0">
        {[1, 2, 3, 4].map((i) => (
            <span
                key={i}
                className={`w-1 rounded-sm ${i <= bars ? 'bg-sky-400' : 'bg-white/10'}`}
                style={{ height: `${4 + i * 3}px` }}
            />
        ))}
    </div>
);

const PasswordPanel: React.FC<{
    ssid: string;
    password: string;
    onChange: (p: string) => void;
    onSubmit: () => void;
    onBack: () => void;
}> = ({ ssid, password, onChange, onSubmit, onBack }) => (
    <div className="max-w-md mx-auto space-y-4">
        <p className="text-lg font-bold text-white">Password for {ssid}</p>
        <input
            type="password"
            value={password}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Enter network password"
            autoFocus
            autoCapitalize="off"
            autoCorrect="off"
            className="w-full px-4 py-3 rounded-full bg-white/5 border border-white/10 text-white placeholder:text-gray-500 text-sm focus:outline-none focus:border-sky-500/50"
        />
        <p className="text-xs text-gray-500">
            The password is sent only to your Pi over the local network — it never leaves the boat.
        </p>
        {password.length > 0 && password.length < 8 && (
            <p className="text-xs text-amber-400">WPA networks require at least 8 characters.</p>
        )}
        <div className="flex gap-2 pt-2">
            <button
                onClick={onBack}
                className="flex-1 px-6 py-3 rounded-full bg-white/5 hover:bg-white/10 text-white text-sm transition-colors"
            >
                Back
            </button>
            <button
                onClick={onSubmit}
                disabled={password.length < 8}
                className="flex-[2] px-6 py-3 rounded-full bg-sky-500 hover:bg-sky-400 disabled:opacity-40 text-white font-bold transition-colors"
            >
                Connect
            </button>
        </div>
    </div>
);

const SwitchBackPanel: React.FC<{ ssid: string; onContinue: () => void }> = ({ ssid, onContinue }) => (
    <div className="max-w-md mx-auto space-y-5 pt-2">
        <p className="text-lg font-bold text-white">The Pi joined {ssid} ✓</p>
        <p className="text-sm text-gray-300">
            Now switch your phone back to the same network so they can find each other:
        </p>
        <ol className="space-y-3 text-sm text-gray-300 list-decimal list-inside">
            <li>
                Open <span className="font-bold text-white">Settings → WiFi</span>.
            </li>
            <li>
                Tap <span className="font-mono text-sky-300">{ssid}</span>.
            </li>
            <li>Come back here and tap below.</li>
        </ol>
        <button
            onClick={onContinue}
            className="mt-4 w-full px-6 py-3 rounded-full bg-sky-500 hover:bg-sky-400 text-white font-bold transition-colors"
        >
            I&apos;m on {ssid}
        </button>
    </div>
);

const SuccessPanel: React.FC<{ onClose: () => void }> = ({ onClose }) => (
    <div className="max-w-md mx-auto space-y-4 text-center pt-12">
        <div className="w-16 h-16 mx-auto rounded-full bg-emerald-500/20 border-2 border-emerald-400/40 flex items-center justify-center">
            <svg
                className="w-8 h-8 text-emerald-400"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={3}
            >
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
        </div>
        <p className="text-2xl font-bold text-white">Calypso&apos;s online.</p>
        <p className="text-sm text-gray-400">She can now read live boat data and search the manuals.</p>
        <button
            onClick={onClose}
            className="mt-4 w-full px-6 py-3 rounded-full bg-sky-500 hover:bg-sky-400 text-white font-bold transition-colors"
        >
            Done
        </button>
    </div>
);

const ErrorPanel: React.FC<{ message: string; onRetry: () => void }> = ({ message, onRetry }) => (
    <div className="max-w-md mx-auto space-y-4 pt-6">
        <div className="px-4 py-4 rounded-2xl bg-red-500/10 border border-red-500/20">
            <p className="text-[10px] uppercase tracking-widest text-red-400 mb-2">Couldn&apos;t finish setup</p>
            <p className="text-sm text-white">{message}</p>
        </div>
        <button
            onClick={onRetry}
            className="w-full px-6 py-3 rounded-full bg-sky-500 hover:bg-sky-400 text-white font-bold transition-colors"
        >
            Start over
        </button>
    </div>
);
