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
import { MOB_PRECISE_FIX_ACCURACY_M, MobService, type MobSnapshot, type MobState } from '../../services/MobService';
import { useSettings } from '../../context/SettingsContext';
import { useRadioPosition } from '../../hooks/useRadioPosition';
import { triggerHaptic } from '../../utils/system';
import { PageHeader } from '../ui/PageHeader';
import { prewarmSafetyMessage, speakSafetyMessage, type SafetyUtteranceHandle } from '../../services/voice/safetyTts';
import { formatSpokenPosition, spellDigits, spokenCallSign, spokenMmsi } from '../../services/voice/radioPhrasing';
import { authScopedStorageKey } from '../../services/authIdentityScope';
import { formatLatDegMin, formatLonDegMin } from '../../utils/formatDegMin';

interface MobPageProps {
    onBack: () => void;
    onNavigate?: (page: string) => void;
    /** Built by viewRegistry from where MOB was opened ('Back to Obs',
     *  ['Obs', 'Man Overboard']), so the chevron and crumb name the page Back
     *  really returns to (UX scorecard run 9). */
    backLabel?: string;
    breadcrumbs?: string[];
}

type EmergencyVesselType = 'sail' | 'power' | 'observer' | undefined;

// ── Formatting helpers ──────────────────────────────────────────────────────
const formatLat = (dec: number): string => formatLatDegMin(dec);
const formatLon = (dec: number): string => formatLonDegMin(dec);
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

/** Empty/setup placeholder values are instructions, never vessel identities. */
function emergencyIdentity(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (
        !trimmed ||
        /^(?:not\s+(?:set|configured|available)|unset|unknown|none|null|undefined|tbd|n\/?a|[-—]+)$/i.test(trimmed)
    )
        return undefined;
    return trimmed;
}

function emergencyVesselType(value: unknown): EmergencyVesselType {
    return value === 'sail' || value === 'power' || value === 'observer' ? value : undefined;
}

function spokenVesselKind(type: EmergencyVesselType): string {
    if (type === 'sail') return 'sailing vessel';
    if (type === 'power') return 'motor vessel';
    return 'vessel';
}

function buildMaydayText(
    vesselName: string | undefined,
    vesselType: EmergencyVesselType,
    callSign: string | undefined,
    mmsi: string | undefined,
    pob: number | undefined,
    fixLat: number,
    fixLon: number,
    activatedAt: number,
    fixAccuracy: number,
): string {
    // Radio convention reads a time as digits — "two two four two", not
    // "twenty-two forty-two". TTS engines otherwise say the colon form as a
    // clock time or, worse, a decimal, and a misheard datum time on a MAYDAY
    // costs a search pattern.
    const utcDigits = new Date(activatedAt).toISOString().slice(11, 16).replace(':', '');
    const utc = `${spellDigits(utcDigits)}, U T C`;
    const vesselKind = spokenVesselKind(vesselType);

    let out = 'Mayday, Mayday, Mayday. ';
    out += vesselName
        ? `This is ${vesselKind} ${vesselName}, ${vesselName}, ${vesselName}. `
        : `This is ${vesselKind}. Say your vessel name three times now. `;
    if (callSign) out += spokenCallSign(callSign);
    if (mmsi) out += spokenMmsi(mmsi);
    out += 'Mayday. ';
    out += vesselName ? `This is ${vesselKind} ${vesselName}. ` : 'Say your vessel name once now. ';
    out += `Man Overboard datum. ${formatSpokenPosition(fixLat, fixLon)}. `;
    if (fixAccuracy > MOB_PRECISE_FIX_ACCURACY_M) {
        out += `Position is approximate within ${Math.round(fixAccuracy)} metres. `;
    }
    out += 'Nature of distress: Man Overboard. ';
    out += `MOB at ${utc}. `;
    if (pob !== undefined) out += `${pob} persons on board. `;
    out += 'Requesting immediate assistance. Over.';
    return out;
}

export const MobPage: React.FC<MobPageProps> = ({ onBack, onNavigate, backLabel, breadcrumbs }) => {
    const { settings } = useSettings();
    // Shane 2026-09-26: the idle word must say what the fix is doing, like
    // Radio and NMEA do — 'READY' with no position was a promise the mark
    // could not keep.
    const radio = useRadioPosition();
    const fixWord =
        radio.position && radio.isFresh && !radio.error ? 'Ready' : radio.acquiring ? 'Finding GPS…' : 'No fix';
    // The same bordered pill Radio Console and Anchor Watch use, in the
    // header's status row, rather than a floating red word (UX scorecard run 6).
    // The red pill by day: opaque red-50 with red-800 text, not red-700 on a
    // tint that measured 4.55:1 (UX scorecard run 7).
    const fixPill =
        radio.position && radio.isFresh && !radio.error
            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
            : radio.acquiring
              ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
              : 'bg-red-500/10 border-red-500/30 text-red-400 [.display-light_&]:bg-red-50! [.display-light_&]:text-red-800!';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vessel = (settings as any)?.vessel;
    const vesselName = emergencyIdentity(vessel?.name);
    const vesselType = emergencyVesselType(vessel?.type);
    const callSign = emergencyIdentity(vessel?.callSign);
    const mmsi = emergencyIdentity(vessel?.mmsi);
    const configuredPob = vessel?.crewCount as number | undefined;
    const pob =
        typeof configuredPob === 'number' && Number.isFinite(configuredPob) && configuredPob > 0
            ? Math.round(configuredPob)
            : undefined;

    const [state, setState] = useState<MobState>(() => MobService.currentState());
    const [activating, setActivating] = useState(false);
    const [activationError, setActivationError] = useState<string | null>(null);
    const [clearError, setClearError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [speaking, setSpeaking] = useState(false);
    const [speechError, setSpeechError] = useState<string | null>(null);
    const [copyFailureText, setCopyFailureText] = useState<string | null>(null);
    /** Engine actually used for the most recent MAYDAY playback —
     *  shown to the skipper as a tiny caption ("Calypso voice" /
     *  "Fallback voice") so they know whether the message just went
     *  out clean or via the robotic backup. */
    const [lastVoiceEngine, setLastVoiceEngine] = useState<'calypso' | 'native' | null>(null);
    const utteranceRef = useRef<SafetyUtteranceHandle | null>(null);
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
        setActivationError(null);
        try {
            const result = await MobService.activate();
            if (!result) {
                setActivationError(
                    'MOB position was not marked because no valid GPS position is available. Keep a lookout, use the chartplotter MOB control if fitted, and retry.',
                );
            }
        } catch {
            setActivationError(
                'MOB position could not be marked. Use the chartplotter MOB control if fitted and retry immediately.',
            );
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
                setClearError(null);
                void MobService.clear().catch(() => {
                    setClearError(
                        'MOB remains active because restart-recovery storage could not be cleared. Keep tracking the casualty and hold to retry.',
                    );
                });
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
    const maydayText = state.active
        ? buildMaydayText(
              vesselName,
              vesselType,
              callSign,
              mmsi,
              pob,
              state.active.fixLat,
              state.active.fixLon,
              state.active.activatedAt,
              state.active.fixAccuracy,
          )
        : '';

    /**
     * Synthesise the Mayday the moment it exists, not when Speak is pressed.
     *
     * ElevenLabs needs several seconds for a script this long, and the safety
     * budget deliberately gives it only four before falling back — so Calypso
     * lost every time and the robotic voice was what actually transmitted.
     * The text is known from the instant MOB goes active, which is minutes of
     * warning, so the audio can simply be waiting. Debounced because the text
     * changes as the fix updates, and each distinct script is only ever
     * synthesised once.
     */
    useEffect(() => {
        if (!maydayText) return;
        const timer = window.setTimeout(() => prewarmSafetyMessage(maydayText), 1200);
        return () => window.clearTimeout(timer);
    }, [maydayText]);

    const handleSpeakMayday = useCallback(() => {
        if (!maydayText || speaking) return;
        triggerHaptic('medium');
        setSpeechError(null);
        // Race Calypso's ElevenLabs voice against a 4s budget; fall
        // back to the OS-level SpeechSynthesisUtterance if Calypso
        // can't deliver in time (offline, quota exhausted, slow link).
        // The fallback is the safety net — every iOS device has it.
        utteranceRef.current?.cancel();
        try {
            const handle = speakSafetyMessage(maydayText, {
                nativeRate: 0.8,
                nativePitch: 0.95,
                // Calypso voice override for emergency comms — slower
                // and more stable than casual chat. Shane: "don't sound
                // like introducing Taylor Swift to a concert full of
                // prepubescent teens." Speed 0.875 = a touch quicker
                // than the 0.85 first pass (Shane wanted slightly faster
                // delivery without losing the calm VHF cadence);
                // stability 0.8 = measured, low emotional variation.
                // Falls back to native iOS speech (rate 0.8, pitch 0.95
                // above) if ElevenLabs fails.
                voiceSettings: { speed: 0.875, stability: 0.8 },
                onPlaybackStart: (engine) => {
                    setSpeaking(true);
                    setLastVoiceEngine(engine);
                },
                onPlaybackEnd: () => setSpeaking(false),
                onError: () => {
                    setSpeaking(false);
                    setSpeechError(
                        'Mayday audio stopped or could not start. Read the script below aloud; no complete playback was confirmed.',
                    );
                },
            });
            utteranceRef.current = handle;
        } catch {
            setSpeaking(false);
            setSpeechError(
                'Mayday audio stopped or could not start. Read the script below aloud; no complete playback was confirmed.',
            );
        }
    }, [maydayText, speaking]);

    // Cancel any in-flight TTS when the page unmounts so the message
    // doesn't keep talking after navigating away.
    useEffect(() => {
        return () => {
            utteranceRef.current?.cancel();
        };
    }, []);

    const handleCopyMayday = useCallback(() => {
        if (!maydayText) return;
        triggerHaptic('light');
        setCopied(false);
        setCopyFailureText(null);

        const failCopy = () => setCopyFailureText(maydayText);
        try {
            if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
                failCopy();
                return;
            }
            void navigator.clipboard
                .writeText(maydayText)
                .then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2500);
                })
                .catch(failCopy);
        } catch {
            failCopy();
        }
    }, [maydayText]);

    const handleGoToDsc = useCallback(() => {
        triggerHaptic('light');
        if (typeof window !== 'undefined') {
            const activeSnapshot: MobSnapshot | null = state.active ? { ...state.active } : null;
            try {
                localStorage.setItem(
                    authScopedStorageKey('thalassa_dsc_intent'),
                    JSON.stringify({ version: 1, kind: 'distress-mob', snapshot: activeSnapshot }),
                );
            } catch {
                // Navigation still proceeds. RadioConsole reads the live
                // device-authoritative MobService snapshot as its fallback.
            }
        }
        onNavigate?.('radio');
    }, [onNavigate, state.active]);

    // ── Render: idle or active ────────────────────────────────────────────
    if (!state.active) {
        return (
            <div
                // The nav fade: at 375×667 the procedure ran under the tab bar
                // cut mid-line; now it fades out above the bar instead.
                className="thalassa-scroll-fade thalassa-scroll-fade--nav w-full h-full flex flex-col bg-slate-950 slide-up-enter overflow-y-auto"
                style={{ paddingBottom: 'calc(5.5rem + env(safe-area-inset-bottom))' }}
            >
                <PageHeader
                    title="Man Overboard"
                    subtitle="Mark & track"
                    onBack={onBack}
                    backLabel={backLabel}
                    breadcrumbs={breadcrumbs}
                    status={
                        <span
                            role="status"
                            className={`flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-extrabold uppercase tracking-widest ${fixPill}`}
                        >
                            <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
                            {fixWord}
                        </span>
                    }
                />
                <div className="flex-1 flex flex-col items-center justify-center px-6 pb-8 gap-8 [@media(max-height:700px)]:gap-4">
                    <div className="text-center max-w-sm">
                        <h2 className="text-2xl font-black text-white mb-3">Mark MOB position</h2>
                        {/* Says what the tap will actually mark (UX scorecard run 8):
                            "snapshot the current GPS fix" sat under a NO FIX pill.
                            With no live fix the tap takes the last position held,
                            and with none held it waits a few seconds for a fix
                            (MobService.activate), or says why it could not. It
                            must never read as "nothing to mark, so don't tap".
                            ONE sentence above the button, the first thing read in
                            an emergency, covering both cases (UX scorecard run 10,
                            mob-copy): it used to hedge across a line here and a
                            second one under the button ("With none held, it waits
                            briefly"), and "No fix" was also said on the button. */}
                        <p className="text-[13px] text-slate-400 leading-relaxed">
                            {fixWord === 'Ready'
                                ? 'Tap to snapshot the current GPS fix.'
                                : 'No GPS fix. Tap anyway: it marks your last known position, or the first fix in a few seconds.'}
                        </p>
                        {activationError && (
                            <p
                                role="alert"
                                className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-left text-xs font-semibold leading-relaxed text-red-200"
                            >
                                {activationError}
                            </p>
                        )}
                    </div>

                    <button
                        type="button"
                        onClick={handleActivate}
                        disabled={activating}
                        // Starts with the visible word, so "Tap MOB" works in
                        // Voice Control, and carries the no-fix warning the
                        // caption shows (UX scorecard run 7).
                        aria-label={fixWord === 'No fix' ? 'MOB, mark position, no GPS fix' : 'MOB, mark position'}
                        // 150 pt on short screens (max-height 700px), from 192:
                        // at 375x667 the "Also immediately" checklist was cut in
                        // half by the bottom fade (UX scorecard run 10).
                        className="relative w-56 h-56 [@media(max-height:700px)]:w-[150px] [@media(max-height:700px)]:h-[150px] rounded-full flex items-center justify-center active:scale-[0.97] transition-transform disabled:opacity-60 disabled:cursor-not-allowed"
                        style={{
                            // The highlight stays top-left; from just under the
                            // pivot down the face is #c81e1e → #b91c1c, so the
                            // 12 px white caption reads 5.7–6.5:1 (it was ~4.0:1
                            // on #ea4040, UX scorecard run 6).
                            background:
                                'radial-gradient(circle at 30% 30%, #f87171 0%, #ef4444 22%, #c81e1e 36%, #b91c1c 50%, #991b1b 100%)',
                            boxShadow:
                                '0 0 40px rgba(239,68,68,0.5), 0 0 80px rgba(239,68,68,0.25), inset 0 -6px 16px rgba(0,0,0,0.25)',
                            border: '3px solid rgba(255,255,255,0.15)',
                        }}
                    >
                        {/* White in BOTH palettes, set inline: `.display-light .text-white`
                            turns text navy, and navy on this red measured ~4.6:1 — the
                            emergency control must look the same by day and by night. */}
                        <div className="flex flex-col items-center gap-1" style={{ color: '#ffffff' }}>
                            {/* The lifebuoy the chart's MOB button and the Vessel
                                tile wear: one glyph for the one emergency action.
                                It was a sun (UX scorecard run 8). */}
                            <svg
                                aria-hidden="true"
                                width="48"
                                height="48"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth={2}
                            >
                                <circle cx="12" cy="12" r="9" />
                                <circle cx="12" cy="12" r="4" />
                                <path strokeLinecap="round" d="M12 3v5M12 16v5M3 12h5M16 12h5" />
                            </svg>
                            <span className="text-[22px] font-black tracking-widest uppercase">
                                {activating ? 'Marking…' : 'MOB'}
                            </span>
                            {/* Still tappable with no fix (the tap takes the best position the
                                phone holds and says why if there is none). The no-fix
                                warning is said before the tap by the status pill and
                                the sentence above; the face no longer repeats it (UX
                                scorecard run 10, mob-copy). The button's spoken name
                                still carries it. */}
                            <span className="text-center text-xs font-bold tracking-widest uppercase [@media(max-height:700px)]:tracking-wider">
                                Tap to mark
                            </span>
                        </div>
                    </button>

                    <div className="max-w-xs text-center">
                        {/* What happens after the tap, moved from above the button
                            (UX scorecard run 9): the bearing and distance back. The
                            wait for a fix when none is held is now said once, in
                            the sentence above the button (run 10). */}
                        <p className="mb-3 text-[13px] leading-relaxed text-slate-400">
                            The app then keeps a live bearing and distance back to the mark.
                        </p>
                        {/* A two-sentence procedure, so it is set as prose: uppercase and
                            letter-spacing are for labels, not for instructions someone has
                            to follow with a person in the water. By day it takes an
                            explicit slate-900: the caption remap set it slate-600
                            (6.2:1), lighter than the plain paragraph above (8.5:1),
                            which reversed the emphasis (UX scorecard run 10). */}
                        {/* text-balance as well as the non-breaking space: the
                            space alone moved the orphan from 'fitted.' to 'if
                            fitted.' on its own last line at 393 pt. */}
                        <p className="text-sm font-bold leading-relaxed text-balance text-slate-300 [.display-light_&]:text-slate-900!">
                            Also immediately: throw a flotation device, shout &ldquo;Man Overboard,&rdquo; assign a
                            spotter, and hit the MOB button on your chartplotter if&nbsp;fitted.
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    // ── Active MOB ────────────────────────────────────────────────────────
    const { active, distanceMeters, bearingDeg, elapsedSec, own, ownPositionAgeMs, ownPositionFresh } = state;
    const approximateFix = active.fixAccuracy > MOB_PRECISE_FIX_ACCURACY_M;
    // Defend at the presentation boundary too: even if an older producer ever
    // supplies cached vector values, a stale own-ship fix must never render them.
    const displayedDistance = ownPositionFresh ? distanceMeters : null;
    const displayedBearing = ownPositionFresh ? bearingDeg : null;
    const ownPositionAgeSec = ownPositionAgeMs === null ? null : Math.floor(ownPositionAgeMs / 1000);

    return (
        <div
            className="w-full h-full flex flex-col slide-up-enter overflow-y-auto"
            style={{ background: 'var(--day-ui-alarm-surface, linear-gradient(180deg, #450a0a 0%, #020617 60%))' }}
        >
            <PageHeader
                title="MOB ACTIVE"
                subtitle={approximateFix ? 'Approximate search area' : 'Return to fix'}
                onBack={onBack}
                backLabel={backLabel}
                breadcrumbs={breadcrumbs ? [breadcrumbs[0], 'MOB ACTIVE'] : undefined}
                action={
                    <div
                        role="status"
                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-extrabold uppercase tracking-widest ${
                            ownPositionFresh
                                ? 'bg-emerald-500/15 border-emerald-400/40 text-emerald-200'
                                : 'bg-amber-500/15 border-amber-400/40 text-amber-200'
                        }`}
                    >
                        <span
                            className={`w-1.5 h-1.5 rounded-full ${
                                ownPositionFresh ? 'bg-emerald-300 animate-pulse' : 'bg-amber-300'
                            }`}
                        />
                        <span>{ownPositionFresh ? 'GPS live' : own ? 'GPS stale' : 'No GPS fix'}</span>
                    </div>
                }
            />

            {approximateFix && (
                <div
                    role="alert"
                    className="shrink-0 mx-5 mt-2 rounded-2xl border-2 border-amber-300/70 bg-amber-400/15 px-4 py-3 text-left text-sm font-black leading-relaxed text-amber-50 shadow-lg shadow-amber-950/30"
                >
                    APPROXIMATE MOB MARK — ±{Math.round(active.fixAccuracy)} m uncertainty. Search the full red circle,
                    keep a dedicated lookout, and mark MOB on the chartplotter too. Thalassa is listening briefly for a
                    better GPS fix; the original MOB time will not change.
                </div>
            )}

            {!ownPositionFresh && (
                <div
                    role="alert"
                    className="shrink-0 mx-5 mt-2 rounded-xl border border-amber-400/35 bg-amber-500/10 px-3 py-2 text-left text-xs font-semibold leading-relaxed text-amber-100"
                >
                    {ownPositionAgeSec === null
                        ? 'No own-ship GPS fix is available.'
                        : `Own-ship GPS is ${ownPositionAgeSec}s old.`}{' '}
                    Bearing and distance are hidden until a fresh fix arrives. Any own position below is last known.
                </div>
            )}

            {state.persistenceStatus === 'failed' && (
                <div
                    role="alert"
                    className="shrink-0 mx-5 mt-2 rounded-xl border border-red-400/45 bg-red-500/15 px-3 py-2 text-left text-xs font-bold leading-relaxed text-red-100"
                >
                    MOB is active, but restart recovery is not secured. Keep Thalassa open, mark MOB on the chartplotter
                    if fitted, and continue the physical recovery procedure.
                </div>
            )}

            {/* Headline bearing + distance — Shane wanted this whole
                red-coloured zone smaller so the clear-MOB button is
                easier to reach without scrolling. Was: py-6, 68px
                bearing, 28px stats, py-4 stat boxes. Now: py-3, 52px
                bearing, 22px stats, py-2.5 stat boxes. Same content,
                ~30% less vertical real estate. */}
            <div className="shrink-0 px-5 py-3 text-center">
                <div className="text-xs font-extrabold tracking-[0.25em] uppercase text-red-300/70 mb-0.5">
                    Bearing to MOB
                </div>
                <div className="text-[52px] font-black text-white leading-none font-mono tracking-tight">
                    {displayedBearing !== null ? `${Math.round(displayedBearing).toString().padStart(3, '0')}°` : '—'}
                </div>
                <div className="text-xs font-bold tracking-widest uppercase text-red-300/70 mt-0.5">True</div>
            </div>

            <div className="shrink-0 mx-5 rounded-2xl border border-red-400/20 bg-red-950/30 backdrop-blur-xs grid grid-cols-2 divide-x divide-red-400/15">
                <div className="px-3 py-2.5 text-center">
                    <div className="text-xs font-extrabold tracking-[0.2em] uppercase text-red-300/70 mb-0.5">
                        Distance
                    </div>
                    <div className="text-[22px] font-black text-white font-mono">
                        {formatDistance(displayedDistance)}
                    </div>
                </div>
                <div className="px-3 py-2.5 text-center">
                    <div className="text-xs font-extrabold tracking-[0.2em] uppercase text-red-300/70 mb-0.5">
                        Elapsed
                    </div>
                    <div className="text-[22px] font-black text-white font-mono tracking-wider">
                        {formatElapsed(elapsedSec)}
                    </div>
                </div>
            </div>

            {/* Positions */}
            <div className="shrink-0 mx-5 mt-3 rounded-2xl border border-white/6 bg-white/2 overflow-hidden">
                <div className="px-4 py-3 border-b border-white/6">
                    <div className="text-xs font-extrabold tracking-[0.2em] uppercase text-red-300/80 mb-1.5">
                        MOB Fix
                    </div>
                    <div className="font-mono text-[15px] font-bold text-white leading-tight">
                        {formatLat(active.fixLat)}
                        <br />
                        {formatLon(active.fixLon)}
                    </div>
                    <div className="text-xs font-semibold tabular-nums text-slate-300 mt-1">
                        @ {new Date(active.activatedAt).toISOString().slice(11, 19)} UTC
                        {` · ±${Math.round(active.fixAccuracy)}m`}
                    </div>
                </div>
                <div className="px-4 py-3">
                    <div className="text-xs font-extrabold tracking-[0.2em] uppercase text-sky-400/80 mb-1.5">
                        Own Position · {ownPositionFresh ? 'Live GPS' : 'Last Known'}
                    </div>
                    <div className="font-mono text-[15px] font-bold text-white leading-tight">
                        {own ? formatLat(own.latitude) : '—'}
                        <br />
                        {own ? formatLon(own.longitude) : '—'}
                    </div>
                    <div className="text-xs font-semibold tabular-nums text-slate-300 mt-1">
                        {ownPositionFresh
                            ? `Fresh fix${own && Number.isFinite(own.accuracy) ? ` · ±${Math.round(own.accuracy)}m` : ''}`
                            : ownPositionAgeSec === null
                              ? 'No valid own-ship fix'
                              : `Last fix ${ownPositionAgeSec}s ago${
                                    own && Number.isFinite(own.accuracy) ? ` · ±${Math.round(own.accuracy)}m` : ''
                                }`}
                    </div>
                </div>
            </div>

            {/* Action grid */}
            {!vesselName && (
                <div
                    role="alert"
                    className="shrink-0 mx-5 mt-3 rounded-xl border border-amber-400/35 bg-amber-500/10 px-3 py-2 text-left text-xs font-semibold leading-relaxed text-amber-100"
                >
                    Vessel name is not set. The Mayday script will prompt you to say it; it will not substitute the app
                    name as your vessel identity.
                </div>
            )}

            <div className="shrink-0 grid grid-cols-2 gap-2.5 px-5 pt-5">
                <button
                    type="button"
                    onClick={handleSpeakMayday}
                    disabled={speaking}
                    className={`py-3.5 px-3 rounded-xl text-[12px] font-extrabold uppercase tracking-wider border transition-all active:scale-[0.97] disabled:opacity-50 flex flex-col items-center justify-center gap-0.5 ${
                        speaking
                            ? 'bg-red-500/30 border-red-400/60 text-red-100 animate-pulse'
                            : 'bg-red-500/15 border-red-400/40 text-red-200 hover:bg-red-500/25'
                    }`}
                >
                    <span>{speaking ? 'Speaking…' : 'Speak Mayday'}</span>
                    {/* Voice-engine indicator — only shown after the
                     *  first playback so the skipper knows whether
                     *  they got the human-sounding Calypso voice or
                     *  the robotic fallback (lets them retry once
                     *  online if they got fallback during a moment
                     *  of poor signal). */}
                    {lastVoiceEngine && !speaking && (
                        <span
                            className={`text-xs font-medium normal-case tracking-normal ${
                                lastVoiceEngine === 'calypso' ? 'text-red-300/80' : 'text-amber-300/80'
                            }`}
                        >
                            {lastVoiceEngine === 'calypso' ? 'Calypso voice' : 'Fallback voice'}
                        </span>
                    )}
                </button>
                <button
                    type="button"
                    onClick={handleCopyMayday}
                    className={`py-3.5 px-3 rounded-xl text-[12px] font-extrabold uppercase tracking-wider border transition-all active:scale-[0.97] ${
                        copied
                            ? 'bg-emerald-500/20 border-emerald-400/40 text-emerald-200'
                            : 'bg-white/4 border-white/10 text-slate-200 hover:bg-white/8'
                    }`}
                >
                    {copied ? 'Copied' : 'Copy Mayday'}
                </button>
                <button
                    type="button"
                    onClick={handleGoToDsc}
                    className="col-span-2 py-3.5 px-3 rounded-xl text-[12px] font-extrabold uppercase tracking-wider border transition-all active:scale-[0.97] bg-amber-500/15 border-amber-400/40 text-amber-200 hover:bg-amber-500/25"
                >
                    Open MOB Mayday Script →
                </button>
            </div>

            {(speechError || copyFailureText) && (
                <div
                    role="alert"
                    className="mx-5 mt-2.5 mb-0 rounded-xl border border-red-400/45 bg-red-500/15 px-3 py-2 text-xs font-bold leading-relaxed text-red-100"
                >
                    <p>
                        {speechError ?? 'Mayday was not copied. Select the complete script below and copy it manually.'}
                    </p>
                    <textarea
                        aria-label="Manual Mayday transcript"
                        readOnly
                        value={maydayText}
                        onFocus={(event) => event.currentTarget.select()}
                        /* This box only appears once the spoken Mayday has failed —
                           which is the moment the skipper has to read it aloud off
                           the screen. Proportional text at 14px, not 11px mono. */
                        className="mt-2 min-h-36 w-full resize-y rounded-lg border border-white/15 bg-slate-950/80 p-2 text-sm font-medium leading-relaxed text-white"
                    />
                </div>
            )}

            {clearError && (
                <div
                    role="alert"
                    className="mx-5 mt-2.5 mb-0 rounded-xl border border-red-400/45 bg-red-500/15 px-3 py-2 text-xs font-bold leading-relaxed text-red-100"
                >
                    {clearError}
                </div>
            )}

            {/* Hold-to-clear.
                No `mt-auto`: pushing this to the bottom of the flex column
                left a big uneven gap under "Open MOB Mayday Script" while the
                button itself crowded the tab bar (Shane 2026-08-28: "lift the
                hold 3 s to clear MOB button so that it clears the bottom menu
                area, it just needs to have equal spaces between the two or
                three buttons above it"). It now sits one grid gap below the
                actions, and the bottom padding matches the 5.5rem clearance
                the rest of the app uses over the tab bar — this page was on
                4rem, which is why it alone looked crowded. */}
            <div
                className="shrink-0 px-5 pt-2.5"
                style={{ paddingBottom: 'calc(5.5rem + env(safe-area-inset-bottom))' }}
            >
                <button
                    type="button"
                    onPointerDown={startClearHold}
                    onPointerUp={cancelClearHold}
                    onPointerLeave={cancelClearHold}
                    onPointerCancel={cancelClearHold}
                    onContextMenu={(e) => e.preventDefault()}
                    aria-label="Hold to clear MOB"
                    className="relative w-full py-3.5 rounded-xl border border-white/10 bg-white/3 text-xs font-extrabold uppercase tracking-widest text-slate-400 overflow-hidden select-none"
                    style={{
                        // iOS long-press defaults — magnifier loupe, text
                        // selection, Copy/Look-Up context sheet — were
                        // hijacking the 3 s hold-to-clear gesture. Belt-
                        // and-braces: -webkit-touch-callout disables the
                        // context menu; user-select stops the loupe;
                        // touch-action: manipulation stops 350 ms
                        // double-tap-to-zoom delay.
                        WebkitTouchCallout: 'none',
                        WebkitUserSelect: 'none',
                        userSelect: 'none',
                        touchAction: 'manipulation',
                    }}
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
