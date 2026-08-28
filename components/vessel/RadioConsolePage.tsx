/**
 * RadioConsolePage — "Report Position" high-contrast screen.
 *
 * Designed for 0300 VHF position reports:
 *  - Navy dark background with amber/gold text (night-vision safe)
 *  - Live GPS position in nautical degrees-minutes format
 *  - Vessel identity (name, call sign, MMSI, rego)
 *  - SOG/COG from GPS
 *  - TTS readback button (native speech synthesis)
 *  - Copy-to-clipboard for sat-phone SMS
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { GpsService, type GpsPosition } from '../../services/GpsService';
import { useGpsHealth, gpsHealthMessage, openDeviceSettings } from '../../hooks/useGpsHealth';
import { MOB_PRECISE_FIX_ACCURACY_M, MobService, type MobSnapshot, type MobState } from '../../services/MobService';
import { useSettings } from '../../context/SettingsContext';
import { triggerHaptic } from '../../utils/system';
import { PageHeader } from '../ui/PageHeader';
import { createLogger } from '../../utils/createLogger';
import {
    ROUTINE_TTS_BUDGET_MS,
    prewarmSafetyMessage,
    speakSafetyMessage,
    type SafetyUtteranceHandle,
} from '../../services/voice/safetyTts';
import {
    formatSpokenPosition,
    spellDigits,
    spokenCallSign,
    spokenBearing,
    spokenMmsi,
    spokenSpeedOverGround,
} from '../../services/voice/radioPhrasing';
import { GearIcon } from '../Icons';
import { authScopedStorageKey } from '../../services/authIdentityScope';

interface RadioConsolePageProps {
    onBack: () => void;
    onNavigate?: (page: string) => void;
}

type EmergencyVesselType = 'sail' | 'power' | 'observer' | undefined;

// ── Coordinate formatting ─────────────────────────────────────────────────
/** Convert decimal degrees to degrees°minutes.decimal′ N/S/E/W format */
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

function validCourse(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 360 ? value : null;
}

function isMobSnapshot(value: unknown): value is MobSnapshot {
    if (!value || typeof value !== 'object') return false;
    const snapshot = value as Partial<MobSnapshot>;
    return (
        typeof snapshot.fixLat === 'number' &&
        Number.isFinite(snapshot.fixLat) &&
        snapshot.fixLat >= -90 &&
        snapshot.fixLat <= 90 &&
        typeof snapshot.fixLon === 'number' &&
        Number.isFinite(snapshot.fixLon) &&
        snapshot.fixLon >= -180 &&
        snapshot.fixLon <= 180 &&
        typeof snapshot.activatedAt === 'number' &&
        Number.isFinite(snapshot.activatedAt) &&
        snapshot.activatedAt > 0 &&
        snapshot.activatedAt <= Date.now() + 5 * 60_000 &&
        typeof snapshot.fixAccuracy === 'number' &&
        Number.isFinite(snapshot.fixAccuracy) &&
        snapshot.fixAccuracy >= 0
    );
}

function readMobIntent(raw: string | null): { matched: boolean; snapshot: MobSnapshot | null } {
    if (raw === 'distress-mob') return { matched: true, snapshot: null };
    if (!raw) return { matched: false, snapshot: null };
    try {
        const parsed = JSON.parse(raw) as { version?: unknown; kind?: unknown; snapshot?: unknown };
        if (parsed?.version !== 1 || parsed.kind !== 'distress-mob') return { matched: false, snapshot: null };
        return { matched: true, snapshot: isMobSnapshot(parsed.snapshot) ? { ...parsed.snapshot } : null };
    } catch {
        return { matched: false, snapshot: null };
    }
}

function mobDatumSpoken(snapshot: MobSnapshot): string {
    // Digits, not "11:20". An engine reads the colon form as a clock time or,
    // worse, as a decimal, and a misheard datum time on a MAYDAY costs a
    // search pattern. MobPage has said it this way for a while; this one had
    // been left behind.
    const markedAt = new Date(snapshot.activatedAt).toISOString().slice(11, 16).replace(':', '');
    let out = `Man Overboard datum. ${formatSpokenPosition(snapshot.fixLat, snapshot.fixLon)}. `;
    out += `MOB marked at ${spellDigits(markedAt)}, U T C. `;
    if (snapshot.fixAccuracy > MOB_PRECISE_FIX_ACCURACY_M) {
        out += `Datum is approximate within ${Math.round(snapshot.fixAccuracy)} metres. `;
    }
    return out;
}

// ── DSC transcript modes ─────────────────────────────────────────────────
export type DscMode = 'routine' | 'urgency' | 'distress';
/** ITU-R M.493 nature-of-distress categories, limited to the set a solo VHF operator realistically selects. */
export type DistressNature =
    | 'undesignated'
    | 'fire'
    | 'flooding'
    | 'collision'
    | 'grounding'
    | 'capsizing'
    | 'sinking'
    | 'disabled'
    | 'mob'
    | 'abandoning'
    | 'piracy'
    | 'medical';

const NATURE_LABEL: Record<DistressNature, string> = {
    undesignated: 'Undesignated',
    fire: 'Fire / Explosion',
    flooding: 'Flooding',
    collision: 'Collision',
    grounding: 'Grounding',
    capsizing: 'Listing / Capsizing',
    sinking: 'Sinking',
    disabled: 'Disabled & Adrift',
    mob: 'Man Overboard',
    abandoning: 'Abandoning Ship',
    piracy: 'Piracy / Attack',
    medical: 'Medical Emergency',
};

const log = createLogger('RadioConsole');

const NATURE_SPOKEN: Record<DistressNature, string> = {
    undesignated: 'undesignated distress',
    fire: 'fire on board',
    flooding: 'flooding',
    collision: 'collision',
    grounding: 'grounded',
    capsizing: 'listing and may capsize',
    sinking: 'sinking',
    disabled: 'disabled and adrift, requesting tow',
    mob: 'Man Overboard',
    abandoning: 'abandoning ship',
    piracy: 'under piracy attack',
    medical: 'medical emergency on board',
};

/** Routine position readback (standard VHF position report). */
function buildRoutineText(
    vesselName: string | undefined,
    vesselType: EmergencyVesselType,
    phoneticName: string | undefined,
    callSign: string | undefined,
    mmsi: string | undefined,
    lat: number,
    lon: number,
    sogKts: number,
    cogDeg: number | null,
): string {
    const name = phoneticName || vesselName;
    const vesselKind = spokenVesselKind(vesselType);
    let report = name ? `This is ${vesselKind} ${name}. ` : `This is ${vesselKind}. Say your vessel name now. `;
    if (callSign) report += spokenCallSign(callSign);
    if (mmsi) report += spokenMmsi(mmsi);
    report += `Position. ${formatSpokenPosition(lat, lon)}. `;
    report += spokenSpeedOverGround(sogKts);
    if (cogDeg !== null) report += `Course. ${spokenBearing(cogDeg)}.`;
    return report.trim();
}

/** Pan-Pan urgency voice script — ITU-R M.1171 phraseology. */
function buildUrgencyText(
    vesselName: string | undefined,
    vesselType: EmergencyVesselType,
    callSign: string | undefined,
    mmsi: string | undefined,
    lat: number,
    lon: number,
    natureWords: string,
    mobSnapshot: MobSnapshot | null,
): string {
    const vesselKind = spokenVesselKind(vesselType);
    let out = 'Pan-Pan, Pan-Pan, Pan-Pan. ';
    out += 'All stations, all stations, all stations. ';
    out += vesselName
        ? `This is ${vesselKind} ${vesselName}, ${vesselName}, ${vesselName}. `
        : `This is ${vesselKind}. Say your vessel name three times now. `;
    if (callSign) out += spokenCallSign(callSign);
    if (mmsi) out += spokenMmsi(mmsi);
    out += `Current vessel position. ${formatSpokenPosition(lat, lon)}. `;
    if (mobSnapshot) out += mobDatumSpoken(mobSnapshot);
    out += `${natureWords}. Requesting assistance. Over.`;
    return out;
}

/** Mayday distress voice script — ITU-R M.1171 phraseology. */
function buildDistressText(
    vesselName: string | undefined,
    vesselType: EmergencyVesselType,
    callSign: string | undefined,
    mmsi: string | undefined,
    pob: number | undefined,
    currentPosition: { lat: number; lon: number } | null,
    natureSpoken: string,
    mobSnapshot: MobSnapshot | null,
): string {
    const vesselKind = spokenVesselKind(vesselType);
    let out = 'Mayday, Mayday, Mayday. ';
    out += vesselName
        ? `This is ${vesselKind} ${vesselName}, ${vesselName}, ${vesselName}. `
        : `This is ${vesselKind}. Say your vessel name three times now. `;
    if (callSign) out += spokenCallSign(callSign);
    if (mmsi) out += spokenMmsi(mmsi);
    out += 'Mayday. ';
    out += vesselName ? `This is ${vesselKind} ${vesselName}. ` : 'Say your vessel name once now. ';
    out += currentPosition
        ? `Current vessel position. ${formatSpokenPosition(currentPosition.lat, currentPosition.lon)}. `
        : 'Current vessel position is unavailable in this app. Say your current position from the chartplotter now. ';
    if (mobSnapshot) out += mobDatumSpoken(mobSnapshot);
    out += `Nature of distress: ${natureSpoken}. `;
    if (pob !== undefined) out += `${pob} persons on board. `;
    out += 'Requesting immediate assistance. Over.';
    return out;
}

/** Build a compact clipboard-friendly position string */
function buildClipboardText(
    vesselName: string | undefined,
    callSign: string | undefined,
    mmsi: string | undefined,
    rego: string | undefined,
    lat: number,
    lon: number,
    sogKts: number,
    cogDeg: number | null,
): string {
    const lines = vesselName ? [vesselName] : ['Vessel name not set — add your vessel name before sending'];
    if (callSign) lines.push(`CS: ${callSign}`);
    if (mmsi) lines.push(`MMSI: ${mmsi}`);
    if (rego) lines.push(`Rego: ${rego}`);
    lines.push(`Pos: ${formatLat(lat)} ${formatLon(lon)}`);
    lines.push(
        cogDeg === null ? `SOG: ${sogKts.toFixed(1)}kts` : `SOG: ${sogKts.toFixed(1)}kts  COG: ${Math.round(cogDeg)}°T`,
    );
    lines.push(`UTC: ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`);
    return lines.join('\n');
}

export const RadioConsolePage: React.FC<RadioConsolePageProps> = ({ onBack, onNavigate }) => {
    const { settings } = useSettings();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vessel = (settings as any)?.vessel;

    // ── GPS state ──
    const [position, setPosition] = useState<GpsPosition | null>(null);
    const [gpsAge, setGpsAge] = useState<string>('—');
    const [isSpeaking, setIsSpeaking] = useState(false);
    /** Calypso is synthesising and nothing is audible yet. Only reachable on
     *  the routine budget, which is long enough that silence would read as a
     *  dead button. */
    const [isPreparing, setIsPreparing] = useState(false);
    /** Engine that spoke the most-recent transcript — surfaced as a
     *  small caption so the skipper knows when they got the robotic
     *  fallback (network blip during a position report). */
    const [lastVoiceEngine, setLastVoiceEngine] = useState<'calypso' | 'native' | null>(null);
    const utteranceRef = useRef<SafetyUtteranceHandle | null>(null);
    const [copied, setCopied] = useState(false);
    const [speechError, setSpeechError] = useState<string | null>(null);
    const [copyFailureText, setCopyFailureText] = useState<string | null>(null);
    const [gpsError, setGpsError] = useState(false);
    const tickRef = useRef<ReturnType<typeof setInterval>>();

    // ── DSC state ──
    const [dscMode, setDscMode] = useState<DscMode>('routine');
    const [natureOfDistress, setNatureOfDistress] = useState<DistressNature>('undesignated');
    const [activeMobSnapshot, setActiveMobSnapshot] = useState<MobSnapshot | null>(
        () => MobService.currentState().active,
    );
    const [handoffMobSnapshot, setHandoffMobSnapshot] = useState<MobSnapshot | null>(null);
    const mobSnapshot = handoffMobSnapshot ?? activeMobSnapshot;
    // The one-shot handoff preserves a casualty datum, but only the live
    // device-authoritative service is allowed to claim the MOB is still active.
    const mobActive = activeMobSnapshot !== null;

    // Track MOB so Distress mode can default to "Man Overboard"
    useEffect(() => {
        const unsub = MobService.subscribe((state: MobState) => setActiveMobSnapshot(state.active));
        return () => {
            unsub();
        };
    }, []);

    // Honour an incoming "distress-mob" intent from MobPage
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const intentKey = authScopedStorageKey('thalassa_dsc_intent');
        const intent = readMobIntent(localStorage.getItem(intentKey));
        if (intent.matched) {
            setHandoffMobSnapshot(intent.snapshot ?? MobService.currentState().active);
            setDscMode('distress');
            setNatureOfDistress('mob');
            localStorage.removeItem(intentKey);
        }
    }, []);

    // When MOB goes active while we're in Distress mode, snap the nature
    useEffect(() => {
        if (mobActive && dscMode === 'distress') setNatureOfDistress('mob');
    }, [mobActive, dscMode]);

    // Why there is no position, when the OS already knows. The DSC/MOB screen
    // is the least acceptable place in the app for a spinner that cannot say
    // "you have not granted location access".
    const gpsHealth = useGpsHealth();
    const gpsBlocked = gpsHealth && !gpsHealth.usable ? gpsHealthMessage(gpsHealth.reason) : null;

    const requestGpsAccess = useCallback(async () => {
        const pos = await GpsService.requestCurrentForegroundPosition({ staleLimitMs: 10_000, timeoutSec: 8 });
        setPosition(pos);
        setGpsError(pos === null);
    }, []);

    // Poll an existing foreground grant every 3 seconds. Opening the radio
    // page itself must not initialize background tracking or raise a prompt;
    // the not-determined state below provides the explicit permission action.
    useEffect(() => {
        let active = true;
        const poll = () => {
            GpsService.getCurrentPositionIfGranted({ staleLimitMs: 10_000, timeoutSec: 8 })
                .then((pos) => {
                    if (!active) return;
                    setPosition(pos);
                    // NULL IS THE FAILURE SIGNAL HERE, not a rejection.
                    // getCurrentPosition never rejects — both its native and web
                    // paths swallow everything and resolve null (GpsService.ts)
                    // — so gpsError was permanently false and the "No Fix" chip
                    // below was unreachable dead code. On the screen used to
                    // read a position onto a VHF distress or MOB call, that is
                    // the last place a pulsing "Acquiring…" should be allowed to
                    // stand in for "we do not have your position".
                    setGpsError(pos === null);
                })
                .catch(() => {
                    if (active) setGpsError(true);
                });
        };

        poll(); // initial
        const id = setInterval(poll, 3000);
        return () => {
            active = false;
            clearInterval(id);
        };
    }, []);

    // Update GPS age ticker every second
    useEffect(() => {
        tickRef.current = setInterval(() => {
            if (position) {
                const ageSec = Math.floor((Date.now() - position.timestamp) / 1000);
                setGpsAge(ageSec < 5 ? 'LIVE' : `${ageSec}s ago`);
            }
        }, 1000);
        return () => clearInterval(tickRef.current);
    }, [position]);

    // ── SOG/COG from GPS ──
    const sogKts = position ? position.speed * 1.94384 : 0; // m/s to knots
    const cogDeg = validCourse(position?.heading);

    // ── Vessel identity ──
    const vesselName = emergencyIdentity(vessel?.name);
    const vesselType = emergencyVesselType(vessel?.type);
    const callSign = emergencyIdentity(vessel?.callSign);
    const mmsi = emergencyIdentity(vessel?.mmsi);
    const rego = emergencyIdentity(vessel?.registration);
    const phoneticName = emergencyIdentity(vessel?.phoneticName);
    const configuredPob = vessel?.crewCount as number | undefined;
    const pob =
        typeof configuredPob === 'number' && Number.isFinite(configuredPob) && configuredPob > 0
            ? Math.round(configuredPob)
            : undefined;

    // ── Current transcript derived from DSC mode ──
    const transcriptMobDatum = natureOfDistress === 'mob' ? mobSnapshot : null;
    const currentTranscript =
        dscMode === 'routine'
            ? position
                ? buildRoutineText(
                      vesselName,
                      vesselType,
                      phoneticName,
                      callSign,
                      mmsi,
                      position.latitude,
                      position.longitude,
                      sogKts,
                      cogDeg,
                  )
                : ''
            : dscMode === 'urgency'
              ? position
                  ? buildUrgencyText(
                        vesselName,
                        vesselType,
                        callSign,
                        mmsi,
                        position.latitude,
                        position.longitude,
                        NATURE_SPOKEN[natureOfDistress],
                        transcriptMobDatum,
                    )
                  : ''
              : position || transcriptMobDatum
                ? buildDistressText(
                      vesselName,
                      vesselType,
                      callSign,
                      mmsi,
                      pob,
                      position ? { lat: position.latitude, lon: position.longitude } : null,
                      NATURE_SPOKEN[natureOfDistress],
                      transcriptMobDatum,
                  )
                : '';

    // ── TTS ──
    const handleSpeak = useCallback(() => {
        if (!currentTranscript || isSpeaking) return;
        triggerHaptic(dscMode === 'routine' ? 'medium' : 'heavy');
        setSpeechError(null);

        // Cancel anything in-flight so a rapid tap doesn't stack
        // overlapping speeches.
        utteranceRef.current?.cancel();
        // Race Calypso first; fall back to native SpeechSynthesisUtterance
        // if Calypso can't deliver in time. Distress reports use a
        // slower rate (0.75) for the listener at the other end of the
        // VHF; routine ones a touch faster.
        try {
            const handle = speakSafetyMessage(currentTranscript, {
                /*
                 * A routine position read is not a distress transmission.
                 * Nothing is burning, the skipper pressed a button and is
                 * waiting to hear their own position, so it can afford to
                 * wait for the good voice. Holding it to the 4 s distress
                 * budget bought the worst of both: a spelled-out position is
                 * too long to synthesise that fast, so it fell to the robot
                 * every single time. Mayday and Pan-Pan keep the short
                 * budget — those must never stall — and are pre-warmed
                 * instead, which skips the race altogether.
                 */
                budgetMs: dscMode === 'routine' ? ROUTINE_TTS_BUDGET_MS : undefined,
                onSynthesisStart: () => setIsPreparing(true),
                // 0.7 across the board. The old 0.85 raced through a string
                // of single digits, which is the one thing this readout
                // exists to make copyable.
                nativeRate: dscMode === 'distress' ? 0.7 : 0.7,
                nativePitch: 0.9,
                // Calypso override: distress = extra-deliberate (slower
                // + most stable), routine = slightly slower than default
                // but still natural. Distress matches the MOB cadence
                // so a listener at the other end gets the same calm
                // measured delivery regardless of which surface fired.
                voiceSettings:
                    dscMode === 'distress' ? { speed: 0.875, stability: 0.8 } : { speed: 0.92, stability: 0.7 },
                onPlaybackStart: (engine) => {
                    setIsPreparing(false);
                    setIsSpeaking(true);
                    setLastVoiceEngine(engine);
                },
                onPlaybackEnd: () => setIsSpeaking(false),
                onError: () => {
                    setIsPreparing(false);
                    setIsSpeaking(false);
                    setSpeechError(
                        'Audio playback stopped or could not start. Read the visible transcript aloud; no complete playback was confirmed.',
                    );
                },
            });
            utteranceRef.current = handle;
        } catch (err) {
            // The message below is deliberately about the SKIPPER's next
            // action, not the fault — but swallowing the cause entirely is
            // how a mocked-away export once looked like a dead button for an
            // afternoon. Say what happened, then say what to do.
            log.warn('[RadioConsole] speakSafetyMessage failed', err);
            setIsPreparing(false);
            setIsSpeaking(false);
            setSpeechError(
                'Audio playback stopped or could not start. Read the visible transcript aloud; no complete playback was confirmed.',
            );
        }
    }, [currentTranscript, isSpeaking, dscMode]);

    /*
     * Pre-synthesise the EMERGENCY scripts the moment the skipper selects
     * that mode. Selecting Mayday or Pan-Pan is a deliberate act taken before
     * the transmission, so the audio can be waiting by the time the button is
     * pressed — and those two keep the 4 s budget, so without this they would
     * fall to the robot exactly as the routine read did.
     *
     * Routine is deliberately NOT pre-warmed: its text moves with every GPS
     * fix, so a warm cache would almost never be hit and every fix would cost
     * an API call for a button that may never be pressed. It gets the long
     * budget instead. Spend the quota where the seconds matter; spend the
     * seconds where the quota does.
     */
    useEffect(() => {
        if (dscMode === 'routine' || !currentTranscript) return;
        const t = setTimeout(() => prewarmSafetyMessage(currentTranscript), 400);
        return () => clearTimeout(t);
    }, [dscMode, currentTranscript]);

    // Cancel any in-flight TTS on unmount so navigating away mid-
    // playback doesn't leave the report still talking.
    useEffect(() => {
        return () => {
            utteranceRef.current?.cancel();
        };
    }, []);

    // ── Copy to clipboard ──
    const handleCopy = useCallback(() => {
        if (!currentTranscript) return;
        triggerHaptic('light');
        setCopied(false);
        setCopyFailureText(null);

        // Routine: keep the compact tabular format (sat-phone SMS friendly).
        // Urgency / Distress: copy the full voice transcript.
        const text =
            dscMode === 'routine' && position
                ? buildClipboardText(
                      vesselName,
                      callSign,
                      mmsi,
                      rego,
                      position.latitude,
                      position.longitude,
                      sogKts,
                      cogDeg,
                  )
                : currentTranscript;

        const failCopy = () => setCopyFailureText(text);
        try {
            if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
                failCopy();
                return;
            }
            void navigator.clipboard
                .writeText(text)
                .then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                })
                .catch(failCopy);
        } catch {
            failCopy();
        }
    }, [position, dscMode, currentTranscript, vesselName, callSign, mmsi, rego, sogKts, cogDeg]);

    const utcTime = new Date().toISOString().slice(11, 19);

    const gpsStatusClass = gpsError
        ? 'bg-red-500/10 border-red-500/30 text-red-400'
        : gpsAge === 'LIVE'
          ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
          : 'bg-amber-500/10 border-amber-500/30 text-amber-400';

    return (
        <div className="w-full h-full flex flex-col bg-slate-950 slide-up-enter overflow-y-auto">
            <PageHeader
                title="Radio Console"
                subtitle="Report Position"
                onBack={onBack}
                action={
                    <div
                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px] font-extrabold uppercase tracking-widest ${gpsStatusClass}`}
                    >
                        <span
                            className={`w-1.5 h-1.5 rounded-full bg-current ${gpsAge === 'LIVE' && !gpsError ? 'animate-pulse' : ''}`}
                        />
                        <span>{gpsError ? 'No Fix' : gpsAge}</span>
                    </div>
                }
            />

            {/* ── Vessel identity strip ── */}
            <div className="shrink-0 px-5 py-4 border-b border-white/[0.06]">
                <div className="text-2xl font-black text-white uppercase tracking-wide mb-2.5">
                    {vesselName ?? 'Vessel name not set'}
                </div>
                <div className="flex flex-wrap gap-2">
                    {callSign && (
                        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/[0.04] border border-white/[0.08]">
                            <span className="text-[9px] font-extrabold tracking-widest text-slate-500 uppercase">
                                CS
                            </span>
                            <span className="text-[13px] font-bold text-sky-400 tracking-wide">{callSign}</span>
                        </div>
                    )}
                    {mmsi && (
                        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/[0.04] border border-white/[0.08]">
                            <span className="text-[9px] font-extrabold tracking-widest text-slate-500 uppercase">
                                MMSI
                            </span>
                            <span className="text-[13px] font-bold text-sky-400 tracking-wide">{mmsi}</span>
                        </div>
                    )}
                    {rego && (
                        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/[0.04] border border-white/[0.08]">
                            <span className="text-[9px] font-extrabold tracking-widest text-slate-500 uppercase">
                                Rego
                            </span>
                            <span className="text-[13px] font-bold text-sky-400 tracking-wide">{rego}</span>
                        </div>
                    )}
                    {(!vesselName || (!callSign && !mmsi && !rego)) && (
                        <button
                            type="button"
                            onClick={() => {
                                localStorage.setItem(authScopedStorageKey('thalassa_settings_return_to'), 'radio');
                                onNavigate?.('settings');
                            }}
                            className="hit-target-44 px-2.5 py-1 rounded-md bg-white/[0.02] border border-dashed border-white/10 text-[11px] font-bold text-slate-500 hover:text-slate-400 hover:border-white/20 transition-colors inline-flex items-center gap-1.5"
                        >
                            <GearIcon className="w-3 h-3" />
                            <span>{vesselName ? 'Add radio identity in Vessel Settings →' : 'Set vessel name →'}</span>
                        </button>
                    )}
                </div>
                {!vesselName && (
                    <p
                        role="alert"
                        className="mt-2 rounded-lg border border-amber-400/30 bg-amber-500/10 px-2.5 py-2 text-[11px] font-semibold leading-relaxed text-amber-100"
                    >
                        The script will prompt you to say your vessel name. It will not read an app name or setup
                        placeholder as your identity.
                    </p>
                )}
            </div>

            {/* ── Position display ── */}
            <div className="shrink-0 px-5 py-7 bg-white/[0.02] border-b border-white/[0.06]">
                {position ? (
                    <div className="flex flex-col gap-3 font-mono">
                        <div className="flex items-baseline gap-3">
                            <span className="text-[11px] font-extrabold tracking-[0.2em] text-slate-500 w-8 shrink-0">
                                LAT
                            </span>
                            <span className="text-3xl sm:text-4xl font-black text-sky-400 tracking-tight">
                                {formatLat(position.latitude)}
                            </span>
                        </div>
                        <div className="flex items-baseline gap-3">
                            <span className="text-[11px] font-extrabold tracking-[0.2em] text-slate-500 w-8 shrink-0">
                                LON
                            </span>
                            <span className="text-3xl sm:text-4xl font-black text-sky-400 tracking-tight">
                                {formatLon(position.longitude)}
                            </span>
                        </div>
                    </div>
                ) : (
                    <div
                        className={`flex flex-col items-center justify-center gap-3 py-8 ${
                            gpsBlocked ? 'text-red-400' : 'text-slate-500'
                        }`}
                    >
                        <svg
                            width="32"
                            height="32"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={1.5}
                            className={gpsBlocked ? '' : 'animate-pulse'}
                        >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z"
                            />
                        </svg>
                        {/* On the screen a skipper reads a position off for a
                            VHF distress or MOB call, "no position" must never
                            be dressed as "nearly there". */}
                        <span className="text-[13px] font-bold tracking-wider uppercase">
                            {gpsBlocked ? gpsBlocked.title : 'Acquiring GPS Fix…'}
                        </span>
                        {gpsBlocked && (
                            <>
                                <span className="max-w-xs px-4 text-center text-[11px] font-medium normal-case leading-snug text-slate-400">
                                    {gpsBlocked.detail} Read your position from the chartplotter before transmitting.
                                </span>
                                {gpsHealth?.actionable && (
                                    <button
                                        onClick={
                                            gpsHealth.reason === 'not-determined'
                                                ? () => void requestGpsAccess()
                                                : openDeviceSettings
                                        }
                                        className="rounded-lg bg-sky-500/90 px-4 py-2 text-[11px] font-black uppercase tracking-widest text-white active:scale-95"
                                    >
                                        {gpsHealth.reason === 'not-determined' ? 'Allow Location' : 'Open Settings'}
                                    </button>
                                )}
                            </>
                        )}
                    </div>
                )}
            </div>

            {/* ── SOG / COG / UTC strip ── */}
            <div className="shrink-0 flex items-center px-5 py-4 border-b border-white/[0.06]">
                <div className="flex-1 text-center">
                    <div className="text-[9px] font-extrabold tracking-[0.2em] text-slate-500 uppercase mb-1">SOG</div>
                    <div className="text-[22px] font-black text-white font-mono">
                        {position ? sogKts.toFixed(1) : '—'}
                        <span className="text-[11px] font-bold text-slate-500 ml-0.5">kts</span>
                    </div>
                </div>
                <div className="w-px h-8 bg-white/[0.08] shrink-0" />
                <div className="flex-1 text-center">
                    <div className="text-[9px] font-extrabold tracking-[0.2em] text-slate-500 uppercase mb-1">COG</div>
                    <div className="text-[22px] font-black text-white font-mono">
                        {position && cogDeg !== null ? `${Math.round(cogDeg)}` : '—'}
                        <span className="text-[11px] font-bold text-slate-500 ml-0.5">°T</span>
                    </div>
                </div>
                <div className="w-px h-8 bg-white/[0.08] shrink-0" />
                <div className="flex-1 text-center">
                    <div className="text-[9px] font-extrabold tracking-[0.2em] text-slate-500 uppercase mb-1">UTC</div>
                    <div className="text-[18px] font-black text-white font-mono tracking-wider">{utcTime}</div>
                </div>
            </div>

            {/* ── DSC call-type selector ── */}
            <DscSelector mode={dscMode} onChange={setDscMode} mobActive={mobActive} />

            {/* ── Nature of distress (urgency & distress only) ── */}
            {dscMode !== 'routine' && <NatureSelector value={natureOfDistress} onChange={setNatureOfDistress} />}

            {dscMode !== 'routine' && natureOfDistress === 'mob' && mobSnapshot && (
                <div className="mx-5 mt-3 rounded-xl border border-red-400/35 bg-red-950/30 px-3 py-2.5">
                    <div className="text-[10px] font-extrabold tracking-[0.2em] uppercase text-red-300">
                        MOB datum · not current vessel position
                    </div>
                    <div className="mt-1 font-mono text-sm font-bold text-white">
                        {formatLat(mobSnapshot.fixLat)} {formatLon(mobSnapshot.fixLon)}
                    </div>
                    <div className="mt-1 text-[11px] font-semibold text-red-100/80">
                        Marked {new Date(mobSnapshot.activatedAt).toISOString().slice(11, 19)} UTC · ±
                        {Math.round(mobSnapshot.fixAccuracy)} m
                    </div>
                </div>
            )}

            {/* ── Instructions + transcript preview ── */}
            <DscInstructions mode={dscMode} transcript={currentTranscript} />

            {speechError && (
                <div
                    role="alert"
                    className="mx-5 mt-3 rounded-xl border border-red-400/45 bg-red-500/15 px-3 py-2 text-xs font-bold leading-relaxed text-red-100"
                >
                    {speechError}
                </div>
            )}

            {copyFailureText && (
                <div
                    role="alert"
                    className="mx-5 mt-3 rounded-xl border border-red-400/45 bg-red-500/15 px-3 py-2 text-xs font-bold leading-relaxed text-red-100"
                >
                    <p>Transcript was not copied. Select the text below and copy it manually.</p>
                    <textarea
                        aria-label="Manual radio transcript"
                        readOnly
                        value={copyFailureText}
                        onFocus={(event) => event.currentTarget.select()}
                        className="mt-2 min-h-28 w-full resize-y rounded-lg border border-white/15 bg-slate-950/80 p-2 font-mono text-[11px] font-medium leading-relaxed text-white"
                    />
                </div>
            )}

            {/* ── Action buttons ── */}
            <div
                className="flex gap-3 px-5 py-6 mt-auto"
                style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}
            >
                <button
                    onClick={handleSpeak}
                    disabled={!currentTranscript || isSpeaking || isPreparing}
                    className={`flex-1 flex items-center justify-center gap-2.5 py-4 px-5 rounded-2xl text-[13px] font-extrabold uppercase tracking-wider transition-all border disabled:opacity-30 disabled:cursor-not-allowed active:scale-[0.97] ${
                        isSpeaking || isPreparing
                            ? dscMode === 'distress'
                                ? 'bg-red-500/30 border-red-400/60 text-red-100 animate-pulse'
                                : dscMode === 'urgency'
                                  ? 'bg-amber-500/30 border-amber-400/60 text-amber-100 animate-pulse'
                                  : 'bg-sky-500/20 border-sky-500/40 text-sky-300 animate-pulse'
                            : dscMode === 'distress'
                              ? 'bg-red-500/15 border-red-400/40 text-red-300 hover:bg-red-500/25'
                              : dscMode === 'urgency'
                                ? 'bg-amber-500/15 border-amber-400/40 text-amber-300 hover:bg-amber-500/25'
                                : 'bg-sky-500/10 border-sky-500/30 text-sky-400 hover:bg-sky-500/15'
                    }`}
                    aria-label="Speak transcript aloud"
                >
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z"
                        />
                    </svg>
                    <div className="flex flex-col items-start leading-tight">
                        <span>
                            {isPreparing
                                ? 'Preparing voice…'
                                : isSpeaking
                                  ? 'Speaking…'
                                  : dscMode === 'distress'
                                    ? 'Speak Mayday'
                                    : dscMode === 'urgency'
                                      ? 'Speak Pan-Pan'
                                      : 'Read Position'}
                        </span>
                        {/* Engine indicator — only after first playback,
                         *  and only when not currently speaking. Keeps
                         *  the button compact during playback animation. */}
                        {lastVoiceEngine && !isSpeaking && !isPreparing && (
                            <span
                                className={`text-[9px] font-medium normal-case tracking-normal opacity-80 ${
                                    lastVoiceEngine === 'calypso' ? 'text-current' : 'text-amber-300'
                                }`}
                            >
                                {lastVoiceEngine === 'calypso' ? 'Calypso voice' : 'Fallback voice'}
                            </span>
                        )}
                    </div>
                </button>

                <button
                    onClick={handleCopy}
                    disabled={!currentTranscript}
                    className={`flex-1 flex items-center justify-center gap-2.5 py-4 px-5 rounded-2xl text-[13px] font-extrabold uppercase tracking-wider transition-all border disabled:opacity-30 disabled:cursor-not-allowed active:scale-[0.97] ${
                        copied
                            ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400'
                            : 'bg-white/[0.04] border-white/10 text-slate-300 hover:bg-white/[0.08]'
                    }`}
                    aria-label="Copy transcript to clipboard"
                >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                        {copied ? (
                            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                        ) : (
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184"
                            />
                        )}
                    </svg>
                    <span>{copied ? 'Copied!' : 'Copy'}</span>
                </button>
            </div>
        </div>
    );
};

// ── DSC sub-components ───────────────────────────────────────────────────────

const DscSelector: React.FC<{
    mode: DscMode;
    onChange: (m: DscMode) => void;
    mobActive: boolean;
}> = ({ mode, onChange, mobActive }) => {
    const pill = (m: DscMode, label: string, hint: string, activeClasses: string) => {
        const isActive = mode === m;
        return (
            <button
                type="button"
                onClick={() => {
                    triggerHaptic(m === 'distress' ? 'heavy' : 'light');
                    onChange(m);
                }}
                className={`flex-1 py-2.5 px-2 rounded-xl border text-center transition-all active:scale-[0.97] ${
                    isActive
                        ? activeClasses
                        : 'bg-white/[0.03] border-white/[0.08] text-slate-400 hover:bg-white/[0.06]'
                }`}
                aria-pressed={isActive}
            >
                <div className="text-[11px] font-extrabold tracking-widest uppercase">{label}</div>
                <div className="text-[9px] font-bold tracking-wider uppercase opacity-70 mt-0.5">{hint}</div>
            </button>
        );
    };
    return (
        <div className="shrink-0 px-5 pt-4">
            <div className="flex items-center gap-2 mb-2">
                <div className="text-[10px] font-extrabold tracking-[0.2em] uppercase text-slate-500">DSC Call</div>
                {mobActive && (
                    <div className="px-2 py-0.5 rounded-full bg-red-500/15 border border-red-400/30 text-red-300 text-[9px] font-extrabold tracking-widest uppercase animate-pulse">
                        MOB Active
                    </div>
                )}
            </div>
            <div className="flex gap-2">
                {pill('routine', 'Routine', 'Position', 'bg-sky-500/15 border-sky-500/40 text-sky-300')}
                {pill('urgency', 'Urgency', 'Pan-Pan', 'bg-amber-500/15 border-amber-400/40 text-amber-300')}
                {pill('distress', 'Distress', 'Mayday', 'bg-red-500/15 border-red-400/40 text-red-300')}
            </div>
        </div>
    );
};

const NatureSelector: React.FC<{
    value: DistressNature;
    onChange: (n: DistressNature) => void;
}> = ({ value, onChange }) => (
    <div className="shrink-0 px-5 pt-3">
        <label className="block text-[10px] font-extrabold tracking-[0.2em] uppercase text-slate-500 mb-1.5">
            Nature
        </label>
        <select
            value={value}
            onChange={(e) => onChange(e.target.value as DistressNature)}
            className="w-full px-3 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-white text-[13px] font-bold focus:outline-none focus:border-white/20"
        >
            {(Object.keys(NATURE_LABEL) as DistressNature[]).map((k) => (
                <option key={k} value={k} className="bg-slate-900">
                    {NATURE_LABEL[k]}
                </option>
            ))}
        </select>
    </div>
);

const DscInstructions: React.FC<{ mode: DscMode; transcript: string }> = ({ mode, transcript }) => {
    if (mode === 'routine') {
        return (
            <div className="shrink-0 px-5 pt-3">
                <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
                    <div className="text-[10px] font-extrabold tracking-[0.2em] uppercase text-slate-500 mb-1">
                        Transcript
                    </div>
                    <div className="text-[12px] text-slate-300 leading-relaxed">{transcript || 'Awaiting GPS…'}</div>
                </div>
            </div>
        );
    }

    const isDistress = mode === 'distress';
    const steps = isDistress
        ? [
              'Lift the red distress flap on your VHF.',
              'Press & hold the DSC DISTRESS button for 5 seconds.',
              'Wait for acknowledgement, then switch to Channel 16.',
              'Read this transcript slowly, twice if needed.',
          ]
        : [
              'Select DSC Urgency / All-Ships call on your VHF.',
              'Transmit on Channel 70 (DSC), then switch to Channel 16.',
              'Read this transcript slowly and clearly.',
          ];

    return (
        <div className="shrink-0 px-5 pt-3 space-y-3">
            <div
                className={`rounded-xl border px-3 py-2.5 ${
                    isDistress ? 'border-red-400/30 bg-red-950/30' : 'border-amber-400/30 bg-amber-950/20'
                }`}
            >
                <div
                    className={`text-[10px] font-extrabold tracking-[0.2em] uppercase mb-1.5 ${
                        isDistress ? 'text-red-300' : 'text-amber-300'
                    }`}
                >
                    On your VHF
                </div>
                <ol className="space-y-1 list-decimal list-inside text-[12px] text-slate-200 leading-relaxed">
                    {steps.map((s, i) => (
                        <li key={i}>{s}</li>
                    ))}
                </ol>
                <div
                    className={`mt-2 text-[10px] font-bold tracking-wide uppercase ${
                        isDistress ? 'text-red-400/80' : 'text-amber-400/80'
                    }`}
                >
                    This app does not transmit DSC — it prepares the voice script.
                </div>
            </div>

            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
                <div className="text-[10px] font-extrabold tracking-[0.2em] uppercase text-slate-500 mb-1">
                    Voice Transcript
                </div>
                <div className="text-[13px] text-white leading-relaxed font-medium">
                    {transcript || 'Awaiting GPS…'}
                </div>
            </div>
        </div>
    );
};
