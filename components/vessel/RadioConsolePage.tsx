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
import { MobService } from '../../services/MobService';
import { useSettings } from '../../context/SettingsContext';
import { triggerHaptic } from '../../utils/system';
import { PageHeader } from '../ui/PageHeader';

interface RadioConsolePageProps {
    onBack: () => void;
    onNavigate?: (page: string) => void;
}

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

function formatSpokenPosition(lat: number, lon: number): string {
    const absLat = Math.abs(lat);
    const latDeg = Math.floor(absLat);
    const latMin = ((absLat - latDeg) * 60).toFixed(1);
    const latDir = lat >= 0 ? 'North' : 'South';
    const absLon = Math.abs(lon);
    const lonDeg = Math.floor(absLon);
    const lonMin = ((absLon - lonDeg) * 60).toFixed(1);
    const lonDir = lon >= 0 ? 'East' : 'West';
    return `${latDeg} degrees ${latMin} minutes ${latDir}, ${lonDeg} degrees ${lonMin} minutes ${lonDir}`;
}

/** Routine position readback (standard VHF position report). */
function buildRoutineText(
    vesselName: string,
    phoneticName: string | undefined,
    callSign: string | undefined,
    mmsi: string | undefined,
    lat: number,
    lon: number,
    sogKts: number,
    cogDeg: number,
): string {
    const name = phoneticName || vesselName || 'vessel';
    let report = `This is sailing vessel ${name}. `;
    if (callSign) report += `Call sign ${callSign.split('').join(' ')}. `;
    if (mmsi) report += `MMSI ${mmsi.split('').join(' ')}. `;
    report += `Position: ${formatSpokenPosition(lat, lon)}. `;
    report += `Speed over ground ${sogKts.toFixed(1)} knots. `;
    report += `Course ${Math.round(cogDeg)} degrees true.`;
    return report;
}

/** Pan-Pan urgency voice script — ITU-R M.1171 phraseology. */
function buildUrgencyText(
    vesselName: string,
    callSign: string | undefined,
    mmsi: string | undefined,
    lat: number,
    lon: number,
    natureWords: string,
): string {
    let out = 'Pan-Pan, Pan-Pan, Pan-Pan. ';
    out += 'All stations, all stations, all stations. ';
    out += `This is sailing vessel ${vesselName}, ${vesselName}, ${vesselName}. `;
    if (callSign) out += `Call sign ${callSign.split('').join(' ')}. `;
    if (mmsi) out += `MMSI ${mmsi.split('').join(' ')}. `;
    out += `Position ${formatSpokenPosition(lat, lon)}. `;
    out += `${natureWords}. Requesting assistance. Over.`;
    return out;
}

/** Mayday distress voice script — ITU-R M.1171 phraseology. */
function buildDistressText(
    vesselName: string,
    callSign: string | undefined,
    mmsi: string | undefined,
    pob: number | undefined,
    lat: number,
    lon: number,
    natureSpoken: string,
): string {
    let out = 'Mayday, Mayday, Mayday. ';
    out += `This is sailing vessel ${vesselName}, ${vesselName}, ${vesselName}. `;
    if (callSign) out += `Call sign ${callSign.split('').join(' ')}. `;
    if (mmsi) out += `MMSI ${mmsi.split('').join(' ')}. `;
    out += 'Mayday. ';
    out += `This is sailing vessel ${vesselName}. `;
    out += `Position ${formatSpokenPosition(lat, lon)}. `;
    out += `Nature of distress: ${natureSpoken}. `;
    if (pob !== undefined) out += `${pob} persons on board. `;
    out += 'Requesting immediate assistance. Over.';
    return out;
}

/** Build a compact clipboard-friendly position string */
function buildClipboardText(
    vesselName: string,
    callSign: string | undefined,
    mmsi: string | undefined,
    rego: string | undefined,
    lat: number,
    lon: number,
    sogKts: number,
    cogDeg: number,
): string {
    const lines = [vesselName];
    if (callSign) lines.push(`CS: ${callSign}`);
    if (mmsi) lines.push(`MMSI: ${mmsi}`);
    if (rego) lines.push(`Rego: ${rego}`);
    lines.push(`Pos: ${formatLat(lat)} ${formatLon(lon)}`);
    lines.push(`SOG: ${sogKts.toFixed(1)}kts  COG: ${Math.round(cogDeg)}°T`);
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
    const [copied, setCopied] = useState(false);
    const [gpsError, setGpsError] = useState(false);
    const tickRef = useRef<ReturnType<typeof setInterval>>();

    // ── DSC state ──
    const [dscMode, setDscMode] = useState<DscMode>('routine');
    const [natureOfDistress, setNatureOfDistress] = useState<DistressNature>('undesignated');
    const [mobActive, setMobActive] = useState<boolean>(() => MobService.isActive());

    // Track MOB so Distress mode can default to "Man Overboard"
    useEffect(() => {
        const unsub = MobService.subscribe((s) => setMobActive(s.active !== null));
        return () => {
            unsub();
        };
    }, []);

    // Honour an incoming "distress-mob" intent from MobPage
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const intent = localStorage.getItem('thalassa_dsc_intent');
        if (intent === 'distress-mob') {
            setDscMode('distress');
            setNatureOfDistress('mob');
            localStorage.removeItem('thalassa_dsc_intent');
        }
    }, []);

    // When MOB goes active while we're in Distress mode, snap the nature
    useEffect(() => {
        if (mobActive && dscMode === 'distress') setNatureOfDistress('mob');
    }, [mobActive, dscMode]);

    // Poll GPS every 3 seconds
    useEffect(() => {
        let active = true;
        const poll = () => {
            GpsService.getCurrentPosition({ staleLimitMs: 10_000, timeoutSec: 8 })
                .then((pos) => {
                    if (active) {
                        setPosition(pos);
                        setGpsError(false);
                    }
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
    const cogDeg = position?.heading ?? 0;

    // ── Vessel identity ──
    const vesselName = vessel?.name || 'Not Set';
    const callSign = vessel?.callSign || undefined;
    const mmsi = vessel?.mmsi || undefined;
    const rego = vessel?.registration || undefined;
    const phoneticName = vessel?.phoneticName || undefined;
    const pob = (vessel?.crewCount as number | undefined) ?? undefined;

    // ── Current transcript derived from DSC mode ──
    const currentTranscript = position
        ? dscMode === 'routine'
            ? buildRoutineText(
                  vesselName,
                  phoneticName,
                  callSign,
                  mmsi,
                  position.latitude,
                  position.longitude,
                  sogKts,
                  cogDeg,
              )
            : dscMode === 'urgency'
              ? buildUrgencyText(
                    vesselName,
                    callSign,
                    mmsi,
                    position.latitude,
                    position.longitude,
                    NATURE_SPOKEN[natureOfDistress],
                )
              : buildDistressText(
                    vesselName,
                    callSign,
                    mmsi,
                    pob,
                    position.latitude,
                    position.longitude,
                    NATURE_SPOKEN[natureOfDistress],
                )
        : '';

    // ── TTS ──
    const handleSpeak = useCallback(() => {
        if (!currentTranscript || isSpeaking) return;
        triggerHaptic(dscMode === 'routine' ? 'medium' : 'heavy');

        const utterance = new SpeechSynthesisUtterance(currentTranscript);
        utterance.rate = dscMode === 'distress' ? 0.75 : 0.85;
        utterance.pitch = 0.9;
        utterance.onstart = () => setIsSpeaking(true);
        utterance.onend = () => setIsSpeaking(false);
        utterance.onerror = () => setIsSpeaking(false);
        speechSynthesis.speak(utterance);
    }, [currentTranscript, isSpeaking, dscMode]);

    // ── Copy to clipboard ──
    const handleCopy = useCallback(() => {
        if (!position) return;
        triggerHaptic('light');

        // Routine: keep the compact tabular format (sat-phone SMS friendly).
        // Urgency / Distress: copy the full voice transcript.
        const text =
            dscMode === 'routine'
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

        navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
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
                <div className="text-2xl font-black text-white uppercase tracking-wide mb-2.5">{vesselName}</div>
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
                    {!callSign && !mmsi && !rego && (
                        <button
                            onClick={() => {
                                localStorage.setItem('thalassa_settings_return_to', 'radio');
                                onNavigate?.('settings');
                            }}
                            className="px-2.5 py-1 rounded-md bg-white/[0.02] border border-dashed border-white/10 text-[11px] font-bold text-slate-500 hover:text-slate-400 hover:border-white/20 transition-colors"
                        >
                            ⚙️ Set identity in Vessel Settings →
                        </button>
                    )}
                </div>
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
                    <div className="flex flex-col items-center justify-center gap-3 py-8 text-slate-500">
                        <svg
                            width="32"
                            height="32"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={1.5}
                            className="animate-pulse"
                        >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z"
                            />
                        </svg>
                        <span className="text-[13px] font-bold tracking-wider uppercase">Acquiring GPS Fix…</span>
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
                        {position ? `${Math.round(cogDeg)}` : '—'}
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

            {/* ── Instructions + transcript preview ── */}
            <DscInstructions mode={dscMode} transcript={currentTranscript} />

            {/* ── Action buttons ── */}
            <div
                className="flex gap-3 px-5 py-6 mt-auto"
                style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}
            >
                <button
                    onClick={handleSpeak}
                    disabled={!position || isSpeaking}
                    className={`flex-1 flex items-center justify-center gap-2.5 py-4 px-5 rounded-2xl text-[13px] font-extrabold uppercase tracking-wider transition-all border disabled:opacity-30 disabled:cursor-not-allowed active:scale-[0.97] ${
                        isSpeaking
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
                    <span>
                        {isSpeaking
                            ? 'Speaking…'
                            : dscMode === 'distress'
                              ? 'Speak Mayday'
                              : dscMode === 'urgency'
                                ? 'Speak Pan-Pan'
                                : 'Read Position'}
                    </span>
                </button>

                <button
                    onClick={handleCopy}
                    disabled={!position}
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
