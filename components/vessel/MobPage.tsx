/**
 * MobPage — Man Overboard.
 *
 * Idle: one large red button marks the current GPS fix as MOB.
 * Active: huge bearing/distance/elapsed readout relative to the fix, plus
 * quick actions (speak Mayday, copy Mayday, jump to DSC Distress, clear).
 *
 * Clear requires a 3-second hold to prevent accidental cancellation of a
 * live MOB. Activation is instant — every second matters.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MobService, type MobState } from '../../services/MobService';
import { useSettings } from '../../context/SettingsContext';
import { triggerHaptic } from '../../utils/system';
import { PageHeader } from '../ui/PageHeader';

interface MobPageProps {
    onBack: () => void;
    onNavigate?: (page: string) => void;
}

// ── Formatting helpers ──────────────────────────────────────────────────────
function formatLat(dec: number): string {
    const abs = Math.abs(dec);
    const deg = Math.floor(abs);
    const min = (abs - deg) * 60;
    const dir = dec >= 0 ? 'N' : 'S';
    return `${deg}°${min.toFixed(3)}′${dir}`;
}
function formatLon(dec: number): string {
    const abs = Math.abs(dec);
    const deg = Math.floor(abs);
    const min = (abs - deg) * 60;
    const dir = dec >= 0 ? 'E' : 'W';
    return `${String(deg).padStart(3, '0')}°${min.toFixed(3)}′${dir}`;
}
function formatDistance(m: number | null): string {
    if (m === null) return '—';
    const nm = m / 1852;
    if (nm >= 1) return `${nm.toFixed(2)} NM`;
    return `${Math.round(m)} m`;
}
function formatElapsed(sec: number): string {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function buildMaydayText(
    vesselName: string,
    callSign: string | undefined,
    mmsi: string | undefined,
    pob: number | undefined,
    fixLat: number,
    fixLon: number,
    activatedAt: number,
): string {
    const absLat = Math.abs(fixLat);
    const latDeg = Math.floor(absLat);
    const latMin = ((absLat - latDeg) * 60).toFixed(1);
    const latDir = fixLat >= 0 ? 'North' : 'South';
    const absLon = Math.abs(fixLon);
    const lonDeg = Math.floor(absLon);
    const lonMin = ((absLon - lonDeg) * 60).toFixed(1);
    const lonDir = fixLon >= 0 ? 'East' : 'West';
    const utc = new Date(activatedAt).toISOString().slice(11, 16) + ' UTC';

    let out = 'Mayday, Mayday, Mayday. ';
    out += `This is sailing vessel ${vesselName}, ${vesselName}, ${vesselName}. `;
    if (callSign) out += `Call sign ${callSign.split('').join(' ')}. `;
    if (mmsi) out += `MMSI ${mmsi.split('').join(' ')}. `;
    out += 'Mayday. ';
    out += `This is sailing vessel ${vesselName}. `;
    out += `Position ${latDeg} degrees ${latMin} minutes ${latDir}, `;
    out += `${lonDeg} degrees ${lonMin} minutes ${lonDir}. `;
    out += 'Nature of distress: Man Overboard. ';
    out += `MOB at ${utc}. `;
    if (pob !== undefined) out += `${pob} persons on board. `;
    out += 'Requesting immediate assistance. Over.';
    return out;
}

export const MobPage: React.FC<MobPageProps> = ({ onBack, onNavigate }) => {
    const { settings } = useSettings();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vessel = (settings as any)?.vessel;
    const vesselName = (vessel?.name as string) || 'Thalassa';
    const callSign = vessel?.callSign as string | undefined;
    const mmsi = vessel?.mmsi as string | undefined;
    const pob = vessel?.crewCount as number | undefined;

    const [state, setState] = useState<MobState>(() => MobService.currentState());
    const [activating, setActivating] = useState(false);
    const [copied, setCopied] = useState(false);
    const [speaking, setSpeaking] = useState(false);
    const [holdProgress, setHoldProgress] = useState(0);
    const holdTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    useEffect(() => {
        const unsub = MobService.subscribe(setState);
        return () => {
            unsub();
        };
    }, []);

    const handleActivate = useCallback(async () => {
        if (activating || state.active) return;
        triggerHaptic('heavy');
        setActivating(true);
        try {
            const result = await MobService.activate();
            if (!result) {
                alert('MOB activation failed — no GPS fix available.');
            }
        } finally {
            setActivating(false);
        }
    }, [activating, state.active]);

    // ── Hold-to-clear (3 seconds) to prevent accidental MOB cancellation ──
    const startClearHold = useCallback(() => {
        if (holdTimerRef.current) return;
        const start = Date.now();
        holdTimerRef.current = setInterval(() => {
            const elapsed = (Date.now() - start) / 3000;
            if (elapsed >= 1) {
                if (holdTimerRef.current) clearInterval(holdTimerRef.current);
                holdTimerRef.current = null;
                setHoldProgress(0);
                triggerHaptic('heavy');
                MobService.clear();
            } else {
                setHoldProgress(elapsed);
            }
        }, 50);
    }, []);
    const cancelClearHold = useCallback(() => {
        if (holdTimerRef.current) {
            clearInterval(holdTimerRef.current);
            holdTimerRef.current = null;
        }
        setHoldProgress(0);
    }, []);
    useEffect(
        () => () => {
            if (holdTimerRef.current) clearInterval(holdTimerRef.current);
        },
        [],
    );

    // ── Mayday actions ──
    const maydayText =
        state.active &&
        buildMaydayText(
            vesselName,
            callSign,
            mmsi,
            pob,
            state.active.fixLat,
            state.active.fixLon,
            state.active.activatedAt,
        );

    const handleSpeakMayday = useCallback(() => {
        if (!maydayText || speaking) return;
        triggerHaptic('medium');
        const utt = new SpeechSynthesisUtterance(maydayText);
        utt.rate = 0.8;
        utt.pitch = 0.95;
        utt.onstart = () => setSpeaking(true);
        utt.onend = () => setSpeaking(false);
        utt.onerror = () => setSpeaking(false);
        speechSynthesis.speak(utt);
    }, [maydayText, speaking]);

    const handleCopyMayday = useCallback(() => {
        if (!maydayText) return;
        triggerHaptic('light');
        navigator.clipboard.writeText(maydayText).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2500);
        });
    }, [maydayText]);

    const handleGoToDsc = useCallback(() => {
        triggerHaptic('light');
        if (typeof window !== 'undefined') {
            localStorage.setItem('thalassa_dsc_intent', 'distress-mob');
        }
        onNavigate?.('radio');
    }, [onNavigate]);

    // ── Render: idle or active ────────────────────────────────────────────
    if (!state.active) {
        return (
            <div className="w-full h-full flex flex-col bg-slate-950 slide-up-enter overflow-y-auto">
                <PageHeader title="Man Overboard" subtitle="Mark & Track" onBack={onBack} />
                <div className="flex-1 flex flex-col items-center justify-center px-6 pb-8 gap-8">
                    <div className="text-center max-w-sm">
                        <div className="text-[11px] font-extrabold tracking-[0.2em] uppercase text-slate-500 mb-2">
                            Ready
                        </div>
                        <h2 className="text-2xl font-black text-white mb-3">Mark MOB Position</h2>
                        <p className="text-[13px] text-slate-400 leading-relaxed">
                            Tap to snapshot the current GPS fix. The app will keep a live bearing and distance back to
                            the position so the helm can return to it.
                        </p>
                    </div>

                    <button
                        type="button"
                        onClick={handleActivate}
                        disabled={activating}
                        aria-label="Activate Man Overboard"
                        className="relative w-56 h-56 rounded-full flex items-center justify-center active:scale-[0.97] transition-transform disabled:opacity-60 disabled:cursor-not-allowed"
                        style={{
                            background: 'radial-gradient(circle at 30% 30%, #f87171 0%, #ef4444 40%, #b91c1c 100%)',
                            boxShadow:
                                '0 0 40px rgba(239,68,68,0.5), 0 0 80px rgba(239,68,68,0.25), inset 0 -6px 16px rgba(0,0,0,0.25)',
                            border: '3px solid rgba(255,255,255,0.15)',
                        }}
                    >
                        <div className="flex flex-col items-center gap-1 text-white">
                            <svg
                                width="48"
                                height="48"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth={2}
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M12 2v4M12 18v4M2 12h4M18 12h4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"
                                />
                                <circle cx="12" cy="12" r="3" />
                            </svg>
                            <span className="text-[22px] font-black tracking-widest uppercase">
                                {activating ? 'Marking…' : 'MOB'}
                            </span>
                            <span className="text-[10px] font-bold tracking-widest uppercase opacity-80">
                                Tap to Mark
                            </span>
                        </div>
                    </button>

                    <div className="text-center text-[11px] font-bold tracking-wider uppercase text-slate-600 max-w-xs">
                        Also immediately: throw a flotation device, shout &ldquo;Man Overboard,&rdquo; assign a spotter,
                        and hit the MOB button on your chartplotter if fitted.
                    </div>
                </div>
            </div>
        );
    }

    // ── Active MOB ────────────────────────────────────────────────────────
    const { active, distanceMeters, bearingDeg, elapsedSec, own } = state;

    return (
        <div
            className="w-full h-full flex flex-col slide-up-enter overflow-y-auto"
            style={{ background: 'linear-gradient(180deg, #450a0a 0%, #020617 60%)' }}
        >
            <PageHeader
                title="MOB ACTIVE"
                subtitle="Return to fix"
                onBack={onBack}
                action={
                    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border bg-red-500/20 border-red-400/50 text-red-200 text-[10px] font-extrabold uppercase tracking-widest animate-pulse">
                        <span className="w-1.5 h-1.5 rounded-full bg-red-300" />
                        <span>Live</span>
                    </div>
                }
            />

            {/* Headline bearing + distance */}
            <div className="shrink-0 px-5 py-6 text-center">
                <div className="text-[10px] font-extrabold tracking-[0.25em] uppercase text-red-300/70 mb-1">
                    Bearing to MOB
                </div>
                <div className="text-[68px] font-black text-white leading-none font-mono tracking-tight">
                    {bearingDeg !== null ? `${Math.round(bearingDeg).toString().padStart(3, '0')}°` : '—'}
                </div>
                <div className="text-[10px] font-bold tracking-widest uppercase text-red-300/70 mt-1">True</div>
            </div>

            <div className="shrink-0 mx-5 rounded-2xl border border-red-400/20 bg-red-950/30 backdrop-blur-sm grid grid-cols-2 divide-x divide-red-400/15">
                <div className="px-4 py-4 text-center">
                    <div className="text-[10px] font-extrabold tracking-[0.2em] uppercase text-red-300/70 mb-1">
                        Distance
                    </div>
                    <div className="text-[28px] font-black text-white font-mono">{formatDistance(distanceMeters)}</div>
                </div>
                <div className="px-4 py-4 text-center">
                    <div className="text-[10px] font-extrabold tracking-[0.2em] uppercase text-red-300/70 mb-1">
                        Elapsed
                    </div>
                    <div className="text-[28px] font-black text-white font-mono tracking-wider">
                        {formatElapsed(elapsedSec)}
                    </div>
                </div>
            </div>

            {/* Positions */}
            <div className="shrink-0 mx-5 mt-3 rounded-2xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
                <div className="px-4 py-3 border-b border-white/[0.06]">
                    <div className="text-[10px] font-extrabold tracking-[0.2em] uppercase text-red-300/80 mb-1.5">
                        MOB Fix
                    </div>
                    <div className="font-mono text-[15px] font-bold text-white leading-tight">
                        {formatLat(active.fixLat)}
                        <br />
                        {formatLon(active.fixLon)}
                    </div>
                    <div className="text-[10px] text-slate-500 mt-1">
                        @ {new Date(active.activatedAt).toISOString().slice(11, 19)} UTC
                        {active.fixAccuracy !== null && ` · ±${Math.round(active.fixAccuracy)}m`}
                    </div>
                </div>
                <div className="px-4 py-3">
                    <div className="text-[10px] font-extrabold tracking-[0.2em] uppercase text-sky-400/80 mb-1.5">
                        Own Position
                    </div>
                    <div className="font-mono text-[15px] font-bold text-white leading-tight">
                        {own ? formatLat(own.latitude) : '—'}
                        <br />
                        {own ? formatLon(own.longitude) : '—'}
                    </div>
                </div>
            </div>

            {/* Action grid */}
            <div className="shrink-0 grid grid-cols-2 gap-2.5 px-5 py-5">
                <button
                    type="button"
                    onClick={handleSpeakMayday}
                    disabled={speaking}
                    className={`py-3.5 px-3 rounded-xl text-[12px] font-extrabold uppercase tracking-wider border transition-all active:scale-[0.97] disabled:opacity-50 ${
                        speaking
                            ? 'bg-red-500/30 border-red-400/60 text-red-100 animate-pulse'
                            : 'bg-red-500/15 border-red-400/40 text-red-200 hover:bg-red-500/25'
                    }`}
                >
                    {speaking ? 'Speaking…' : 'Speak Mayday'}
                </button>
                <button
                    type="button"
                    onClick={handleCopyMayday}
                    className={`py-3.5 px-3 rounded-xl text-[12px] font-extrabold uppercase tracking-wider border transition-all active:scale-[0.97] ${
                        copied
                            ? 'bg-emerald-500/20 border-emerald-400/40 text-emerald-200'
                            : 'bg-white/[0.04] border-white/10 text-slate-200 hover:bg-white/[0.08]'
                    }`}
                >
                    {copied ? 'Copied' : 'Copy Mayday'}
                </button>
                <button
                    type="button"
                    onClick={handleGoToDsc}
                    className="col-span-2 py-3.5 px-3 rounded-xl text-[12px] font-extrabold uppercase tracking-wider border transition-all active:scale-[0.97] bg-amber-500/15 border-amber-400/40 text-amber-200 hover:bg-amber-500/25"
                >
                    Send DSC Distress via Radio →
                </button>
            </div>

            {/* Hold-to-clear */}
            <div
                className="shrink-0 px-5 pb-8 mt-auto"
                style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}
            >
                <button
                    type="button"
                    onPointerDown={startClearHold}
                    onPointerUp={cancelClearHold}
                    onPointerLeave={cancelClearHold}
                    onPointerCancel={cancelClearHold}
                    aria-label="Hold to clear MOB"
                    className="relative w-full py-3.5 rounded-xl border border-white/10 bg-white/[0.03] text-[11px] font-extrabold uppercase tracking-widest text-slate-400 overflow-hidden"
                >
                    <span
                        className="absolute inset-y-0 left-0 bg-red-500/30 transition-[width] duration-75"
                        style={{ width: `${Math.min(100, holdProgress * 100)}%` }}
                    />
                    <span className="relative">
                        {holdProgress > 0 ? 'Hold to clear MOB…' : 'Hold 3 s to clear MOB'}
                    </span>
                </button>
            </div>
        </div>
    );
};
