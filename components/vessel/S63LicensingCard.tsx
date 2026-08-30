import React, { useCallback, useEffect, useState } from 'react';

import { fetchS63Status, generateAndShareFingerprint, saveS63Permits } from '../../services/enc/S63SetupService';
import type { S63Status } from '../../services/enc/S63SetupService';
import { triggerHaptic } from '../../utils/system';

/**
 * Licensing encrypted charts without a terminal.
 *
 * Two chart worlds identify a boat in completely different ways, and which one
 * you are in decides whether any of this applies:
 *
 *   o-charts     the SG-Lock dongle IS the identity. Move it to another Pi and
 *                the charts follow. Nothing here is needed.
 *   ChartWorld   a fingerprint of this one machine is the identity, and moving
 *                costs one of five lifetime InstallPermits.
 *
 * So the dongle check comes first and says so plainly: someone holding a dongle
 * should not spend a permit to discover they never needed one.
 */
export const S63LicensingCard: React.FC = () => {
    const [expanded, setExpanded] = useState(false);
    const [status, setStatus] = useState<S63Status | null>(null);
    const [busy, setBusy] = useState<null | 'status' | 'fingerprint' | 'saving'>(null);
    const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
    const [userPermit, setUserPermit] = useState('');
    const [installPermit, setInstallPermit] = useState('');

    const refresh = useCallback(async () => {
        setBusy('status');
        try {
            const next = await fetchS63Status();
            setStatus(next);
            setUserPermit(next.userPermit ?? '');
            setInstallPermit(next.installPermit ?? '');
        } catch (err) {
            setMessage({ tone: 'bad', text: err instanceof Error ? err.message : String(err) });
        } finally {
            setBusy(null);
        }
    }, []);

    useEffect(() => {
        if (expanded && !status) void refresh();
    }, [expanded, status, refresh]);

    const onFingerprint = useCallback(async () => {
        setBusy('fingerprint');
        setMessage(null);
        try {
            triggerHaptic('light');
            const filename = await generateAndShareFingerprint();
            setMessage({ tone: 'ok', text: `${filename} is ready — upload it at the o-charts shop.` });
        } catch (err) {
            // A cancelled share sheet is a decision, not a fault.
            const text = err instanceof Error ? err.message : String(err);
            if (!/cancel/i.test(text)) setMessage({ tone: 'bad', text });
        } finally {
            setBusy(null);
        }
    }, []);

    const onSave = useCallback(async () => {
        setBusy('saving');
        setMessage(null);
        try {
            triggerHaptic('medium');
            const next = await saveS63Permits(userPermit, installPermit);
            setStatus(next);
            setMessage({ tone: 'ok', text: 'Checked against this Pi and saved. Charts can be installed now.' });
        } catch (err) {
            setMessage({ tone: 'bad', text: err instanceof Error ? err.message : String(err) });
        } finally {
            setBusy(null);
        }
    }, [userPermit, installPermit]);

    const subtitle = (() => {
        if (!status) return 'Fingerprint and permits for ChartWorld S-63';
        if (status.dongle.present) return 'Dongle detected — o-charts need no licensing here';
        if (status.permitsValid) return 'Licensed on this Pi';
        if (status.userPermit) return 'Permits stored, but not valid for this Pi';
        return 'Not licensed yet — start with the fingerprint';
    })();

    return (
        <div className="mb-3 p-4 rounded-2xl bg-white/[0.03] border border-white/[0.06]">
            <button
                onClick={() => {
                    triggerHaptic('light');
                    setExpanded(!expanded);
                }}
                className="w-full flex items-center gap-3"
            >
                <span className="text-lg">{'\u{1F511}'}</span>
                <div className="flex-1 text-left">
                    <p className="text-sm font-bold text-white">Chart Licensing</p>
                    <p className="text-[11px] text-gray-400">{subtitle}</p>
                </div>
                <svg
                    className={`w-4 h-4 text-gray-500 transition-transform ${expanded ? 'rotate-180' : ''}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                </svg>
            </button>

            {expanded && (
                <div className="mt-4 space-y-4">
                    {busy === 'status' && !status && <p className="text-[11px] text-gray-500">Asking the Pi…</p>}

                    {status?.dongle.present && (
                        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.08] px-3 py-2.5">
                            <p className="text-[11px] leading-relaxed text-emerald-300">
                                <span className="font-bold">Dongle detected.</span> Your o-charts charts are licensed to
                                the dongle itself, so they keep working if you move it to another Pi — nothing below is
                                needed for them. This section is only for ChartWorld S-63 charts.
                            </p>
                        </div>
                    )}

                    {status && !status.toolchainReady && (
                        <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.08] px-3 py-2.5">
                            <p className="text-[11px] leading-relaxed text-amber-300">
                                The S-63 tools are not installed on this Pi ({status.missing.join(', ')}). o-charts with
                                a dongle do not need them; ChartWorld S-63 does.
                            </p>
                        </div>
                    )}

                    {/* ── Step 1 ── */}
                    <div className="space-y-2">
                        <p className="text-[11px] font-bold uppercase tracking-widest text-white/40">
                            1 · Fingerprint this Pi
                        </p>
                        <p className="text-[11px] leading-relaxed text-gray-500">
                            S-63 charts are licensed to one machine. This makes a small file that identifies this Pi,
                            and hands it to the share sheet so you can send it to yourself and upload it at the o-charts
                            shop. They send back two codes.
                        </p>
                        <button
                            onClick={() => void onFingerprint()}
                            disabled={busy !== null || (status ? !status.toolchainReady : false)}
                            className="w-full py-3 rounded-xl text-xs font-black uppercase tracking-widest bg-sky-500/15 border border-sky-500/30 text-sky-300 transition-all active:scale-95 disabled:opacity-50"
                        >
                            {busy === 'fingerprint' ? 'Making fingerprint…' : 'Get fingerprint file'}
                        </button>
                    </div>

                    {/* ── Step 2 ── */}
                    <div className="space-y-2">
                        <p className="text-[11px] font-bold uppercase tracking-widest text-white/40">
                            2 · Enter the two codes
                        </p>
                        <p className="text-[11px] leading-relaxed text-gray-500">
                            Checked against this Pi before they are saved, so a permit issued for a different machine is
                            caught here rather than when a chart fails to build.
                        </p>
                        <input
                            value={userPermit}
                            onChange={(e) => setUserPermit(e.target.value)}
                            placeholder="UserPermit (28 characters)"
                            autoCapitalize="characters"
                            autoCorrect="off"
                            spellCheck={false}
                            disabled={busy !== null}
                            className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-3 font-mono text-xs text-white outline-none placeholder:text-gray-500 focus:border-sky-400 disabled:opacity-60"
                        />
                        <input
                            value={installPermit}
                            onChange={(e) => setInstallPermit(e.target.value)}
                            placeholder="InstallPermit (8 characters)"
                            autoCapitalize="characters"
                            autoCorrect="off"
                            spellCheck={false}
                            disabled={busy !== null}
                            className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-3 font-mono text-xs text-white outline-none placeholder:text-gray-500 focus:border-sky-400 disabled:opacity-60"
                        />
                        <button
                            onClick={() => void onSave()}
                            disabled={busy !== null || !userPermit.trim() || !installPermit.trim()}
                            className="w-full py-3 rounded-xl text-xs font-black uppercase tracking-widest bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 transition-all active:scale-95 disabled:opacity-50"
                        >
                            {busy === 'saving' ? 'Checking with the Pi…' : 'Check & save'}
                        </button>
                    </div>

                    {message && (
                        <p
                            role="status"
                            className={`rounded-xl px-3 py-2 text-[11px] leading-relaxed ${
                                message.tone === 'ok'
                                    ? 'border border-emerald-500/20 bg-emerald-500/[0.08] text-emerald-300'
                                    : 'border border-red-500/20 bg-red-500/[0.08] text-red-300'
                            }`}
                        >
                            {message.text}
                        </p>
                    )}

                    {status?.permitsValid === false && status.permitProblem && !message && (
                        <p className="rounded-xl border border-amber-500/20 bg-amber-500/[0.08] px-3 py-2 text-[11px] leading-relaxed text-amber-300">
                            {status.permitProblem}
                        </p>
                    )}
                </div>
            )}
        </div>
    );
};
