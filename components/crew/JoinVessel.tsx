/**
 * JoinVessel — 6-Digit Manifest Code onboarding screen.
 *
 * Crew enters the code (e.g., "XP-5501"), which:
 *  1. Redeems the bearer code through a rate-limited database function
 *  2. Atomically links crew_user_id to vessel_crew
 *  3. Triggers full sync of Ship's Stores + Meal Plans
 *
 * Works offline via local mesh: code is cached and validated
 * against a local invite list synced from the skipper's device.
 */
import React, { useState, useCallback, useRef } from 'react';
import { supabase } from '../../services/supabase';
import { redeemManifestCode } from '../../services/CrewService';
import { requestFullReconciliation } from '../../services/vessel/SyncService';
import { triggerHaptic } from '../../utils/system';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
} from '../../services/authIdentityScope';

interface JoinVesselProps {
    onJoined: (vesselName: string) => void;
    onClose: () => void;
}

export const JoinVessel: React.FC<JoinVesselProps> = ({ onJoined, onClose }) => {
    const [code, setCode] = useState(['', '', '', '', '', '']);
    const [status, setStatus] = useState<'idle' | 'checking' | 'pending' | 'error'>('idle');
    const [vesselName, setVesselName] = useState('');
    const [errorMsg, setErrorMsg] = useState('');
    const [offlinePending, setOfflinePending] = useState(false);
    const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
    const firstInputRef = useRef<HTMLInputElement | null>(null);
    const dialogRef = useFocusTrap<HTMLDivElement>(true, {
        initialFocusRef: firstInputRef,
        onEscape: onClose,
    });

    const handleInput = useCallback(
        (index: number, value: string) => {
            const char = value.toUpperCase().slice(-1);
            if (!/[A-Z0-9]/.test(char) && char !== '') return;

            const next = [...code];
            next[index] = char;
            setCode(next);

            // Auto-advance
            if (char && index < 5) {
                inputRefs.current[index + 1]?.focus();
            }
        },
        [code],
    );

    const handleKeyDown = useCallback(
        (index: number, e: React.KeyboardEvent) => {
            if (e.key === 'Backspace' && !code[index] && index > 0) {
                inputRefs.current[index - 1]?.focus();
            }
        },
        [code],
    );

    const formatCode = (): string => {
        const raw = code.join('');
        return raw.length === 6 ? `${raw.slice(0, 2)}-${raw.slice(2)}` : raw;
    };

    const handleSubmit = useCallback(async () => {
        const identity = getAuthIdentityScope();
        const formatted = formatCode();
        if (formatted.length < 7) {
            setErrorMsg('Enter all 6 characters');
            return;
        }

        setStatus('checking');
        setErrorMsg('');

        if (!supabase) {
            // Offline mesh mode: cache the code for later validation
            try {
                localStorage.setItem(authScopedStorageKey('thalassa_pending_manifest', identity), formatted);
                setStatus('pending');
                setOfflinePending(true);
                setVesselName('Vessel (offline)');
                triggerHaptic('medium');
            } catch (e) {
                console.warn('Suppressed:', e);
                setErrorMsg('Failed to save code locally');
                setStatus('error');
            }
            return;
        }

        try {
            const result = await redeemManifestCode(formatted);
            if (!isAuthIdentityScopeCurrent(identity)) return;
            if (!result.success) {
                setErrorMsg(result.error || 'Invalid or expired code');
                setStatus('error');
                triggerHaptic('heavy');
                return;
            }
            setVesselName(result.vesselName || 'Vessel');
            setOfflinePending(false);
            setStatus('pending');

            triggerHaptic('medium');
            // Joining expands the caller's RLS-visible history. An incremental
            // cursor from before membership cannot discover older rows.
            requestFullReconciliation().catch(() => {
                /* will retry through the periodic engine */
            });
        } catch (e) {
            if (!isAuthIdentityScopeCurrent(identity)) return;
            console.warn('Suppressed:', e);
            setErrorMsg('Connection error — try again');
            setStatus('error');
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [code]);

    return (
        <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="join-vessel-title"
            className="fixed inset-0 z-50 bg-[#0a0e14] flex flex-col items-center justify-center px-6"
        >
            {/* Close button */}
            <button
                onClick={onClose}
                className="absolute top-5 right-5 w-10 h-10 rounded-full bg-white/5 text-gray-400 flex items-center justify-center hover:bg-white/10 transition-colors"
                aria-label="Close vessel join form"
            >
                ✕
            </button>

            {status === 'pending' ? (
                // ── Success: Pending Approval ──
                <div className="text-center space-y-6">
                    <div className="text-6xl animate-pulse">⚓</div>
                    <h2 id="join-vessel-title" className="text-xl font-bold text-amber-300">
                        {offlinePending ? 'Code Saved' : 'Welcome Aboard'}
                    </h2>
                    <p className="text-sm text-gray-400 max-w-[280px]">
                        {offlinePending ? (
                            <>Your code will be validated securely as soon as this device reconnects.</>
                        ) : (
                            <>
                                You&apos;ve joined <span className="text-white font-bold">{vesselName}</span>.
                            </>
                        )}
                    </p>
                    <p className="text-xs text-gray-500">Ship&apos;s Stores and Meal Plans will sync when available.</p>
                    <button
                        onClick={() => onJoined(vesselName)}
                        className="px-8 py-3 bg-amber-500/10 border border-amber-500/20 rounded-xl text-sm font-bold text-amber-300 uppercase tracking-widest hover:bg-amber-500/20 transition-colors"
                    >
                        Done
                    </button>
                </div>
            ) : (
                // ── Code Entry ──
                <div className="text-center space-y-8">
                    <div>
                        <h2 id="join-vessel-title" className="text-2xl font-bold text-white mb-2">
                            Join a Vessel
                        </h2>
                        <p className="text-sm text-gray-400">Enter the 6-digit manifest code from your Skipper</p>
                    </div>

                    {/* Code input grid */}
                    <div className="flex items-center justify-center gap-2">
                        {code.map((char, i) => (
                            <React.Fragment key={i}>
                                {i === 2 && <span className="text-2xl text-gray-500 font-bold mx-1">-</span>}
                                <input
                                    ref={(el) => {
                                        inputRefs.current[i] = el;
                                        if (i === 0) firstInputRef.current = el;
                                    }}
                                    type="text"
                                    inputMode="text"
                                    maxLength={1}
                                    value={char}
                                    onChange={(e) => handleInput(i, e.target.value)}
                                    onKeyDown={(e) => handleKeyDown(i, e)}
                                    className={`w-12 h-14 text-center text-xl font-mono font-bold rounded-xl border transition-all focus:outline-none ${
                                        char
                                            ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                                            : 'bg-white/5 border-white/10 text-white focus:border-amber-500/50 focus:bg-amber-500/5'
                                    }`}
                                    aria-label={`Code digit ${i + 1}`}
                                />
                            </React.Fragment>
                        ))}
                    </div>

                    {errorMsg && <p className="text-sm text-red-400 animate-in fade-in">{errorMsg}</p>}

                    <button
                        onClick={handleSubmit}
                        disabled={status === 'checking' || code.some((c) => !c)}
                        className="w-full max-w-[280px] py-4 bg-gradient-to-r from-amber-500/20 to-orange-500/20 hover:from-amber-500/30 hover:to-orange-500/30 border border-amber-500/30 rounded-xl text-sm font-bold text-amber-300 uppercase tracking-widest transition-all active:scale-[0.97] disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                        {status === 'checking' ? '⏳ Checking...' : '⚓ Join Vessel'}
                    </button>

                    <p className="text-[11px] text-gray-500 max-w-[260px]">
                        Works offline too — your code will be validated when connected to the vessel&apos;s mesh
                        network.
                    </p>
                </div>
            )}
        </div>
    );
};
