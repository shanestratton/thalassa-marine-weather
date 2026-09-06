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
import { useUtcClock } from '../../hooks/useUtcClock';
import { formatLatDegMin, formatLonDegMin } from '../../utils/formatDegMin';

interface RadioConsolePageProps {
    onBack: () => void;
    onNavigate?: (page: string) => void;
}

type EmergencyVesselType = 'sail' | 'power' | 'observer' | undefined;

// ── Coordinate formatting ─────────────────────────────────────────────────
/** Convert decimal degrees to degrees°minutes.decimal′ N/S/E/W format */
const formatLat = (dec: number): string => formatLatDegMin(dec);

const formatLon = (dec: number): string => formatLonDegMin(dec);

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

export const RadioConsolePage: React.FC<RadioConsolePageProps> = ({ onBack, onNavigate }) => {
    const { settings } = useSettings();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vessel = (settings as any)?.vessel;

    // ── GPS state ──
    const [position, setPosition] = useState<GpsPosition | null>(null);
    const [gpsAge, setGpsAge] = useState<string>('—');
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

    // Update GPS age ticker every second. The interval is created ONCE and
    // reads the latest position through a ref: depending on `position` tore
    // the ticker down and rebuilt it on every 3 s poll.
    const positionRef = useRef(position);
    positionRef.current = position;
    useEffect(() => {
        tickRef.current = setInterval(() => {
            const p = positionRef.current;
            if (p) {
                const ageSec = Math.floor((Date.now() - p.timestamp) / 1000);
                setGpsAge(ageSec < 5 ? 'LIVE' : `${ageSec}s ago`);
            }
        }, 1000);
        return () => clearInterval(tickRef.current);
    }, []);

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

    // Ticks every second — a MAYDAY time is read aloud, so it must be live.
    const utcTime = useUtcClock();

    const gpsStatusClass = gpsError
        ? 'bg-red-500/10 border-red-500/30 text-red-400'
        : gpsAge === 'LIVE'
          ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
          : 'bg-amber-500/10 border-amber-500/30 text-amber-400';

    return (
        // One screen, no page scroll (Shane 2026-09-06): a stressed operator
        // must never have to scroll to find the call buttons. The transcript
        // owns the middle and scrolls inside itself; LAT/LON, SOG/COG/UTC sit
        // directly under it; the channel line and the three call buttons are
        // pinned 8 px above the tab bar and never move.
        <div className="w-full h-full flex flex-col bg-slate-950 slide-up-enter overflow-hidden">
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
            <div className="shrink-0 px-5 py-3 border-b border-white/6">
                <div className="text-xl font-black text-white uppercase tracking-wide mb-2">
                    {vesselName ?? 'Vessel name not set'}
                </div>
                <div className="flex flex-wrap gap-2">
                    {callSign && (
                        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/4 border border-white/8">
                            <span className="text-[9px] font-extrabold tracking-widest text-slate-500 uppercase">
                                CS
                            </span>
                            <span className="text-[13px] font-bold text-sky-400 tracking-wide">{callSign}</span>
                        </div>
                    )}
                    {mmsi && (
                        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/4 border border-white/8">
                            <span className="text-[9px] font-extrabold tracking-widest text-slate-500 uppercase">
                                MMSI
                            </span>
                            <span className="text-[13px] font-bold text-sky-400 tracking-wide">{mmsi}</span>
                        </div>
                    )}
                    {rego && (
                        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/4 border border-white/8">
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
                            className="hit-target-44 px-2.5 py-1 rounded-md bg-white/2 border border-dashed border-white/10 text-[11px] font-bold text-slate-500 hover:text-slate-400 hover:border-white/20 transition-colors inline-flex items-center gap-1.5"
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

            {/* ── Middle: transcript box, readouts, nature, steps. Scrolls only
                   on a screen too short to hold it; the footer below never does. ── */}
            <div className="flex-1 min-h-0 flex flex-col gap-3 px-5 pt-3 pb-2 overflow-y-auto">
                {/* ── Transcript — the deliverable, front and centre ── */}
                <div
                    className={`flex-1 min-h-[150px] flex flex-col rounded-2xl border px-4 py-3 ${
                        dscMode === 'distress'
                            ? 'border-red-400/35 bg-red-950/25'
                            : dscMode === 'urgency'
                              ? 'border-amber-400/35 bg-amber-950/20'
                              : 'border-white/8 bg-white/3'
                    }`}
                >
                    <div className="shrink-0 flex items-center justify-between gap-2 mb-2">
                        <div className="text-[10px] font-extrabold tracking-[0.2em] uppercase text-slate-500">
                            {dscMode === 'routine' ? 'Transcript' : 'Voice Transcript'}
                        </div>
                        <div
                            className={`px-2 py-0.5 rounded-full border text-[9px] font-extrabold tracking-widest uppercase ${
                                dscMode === 'distress'
                                    ? 'border-red-400/40 bg-red-500/15 text-red-300'
                                    : dscMode === 'urgency'
                                      ? 'border-amber-400/40 bg-amber-500/15 text-amber-300'
                                      : 'border-sky-500/40 bg-sky-500/15 text-sky-300'
                            }`}
                        >
                            {dscMode === 'distress' ? 'Mayday' : dscMode === 'urgency' ? 'Pan-Pan' : 'Position report'}
                        </div>
                    </div>
                    <div className="flex-1 min-h-0 overflow-y-auto">
                        <div
                            data-testid="dsc-transcript"
                            className="text-[17px] font-semibold leading-relaxed text-white select-text"
                        >
                            {currentTranscript || 'Awaiting GPS…'}
                        </div>
                        {!position && (
                            <div
                                className={`mt-3 flex flex-col items-start gap-2 ${
                                    gpsBlocked ? 'text-red-400' : 'text-slate-500'
                                }`}
                            >
                                {/* On the screen a skipper reads a position off for a
                                    VHF distress or MOB call, "no position" must never
                                    be dressed as "nearly there". */}
                                <span className="text-[12px] font-bold tracking-wider uppercase">
                                    {gpsBlocked ? gpsBlocked.title : 'Acquiring GPS Fix…'}
                                </span>
                                {gpsBlocked && (
                                    <>
                                        <span className="text-[11px] font-medium normal-case leading-snug text-slate-400">
                                            {gpsBlocked.detail} Read your position from the chartplotter before
                                            transmitting.
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
                                                {gpsHealth.reason === 'not-determined'
                                                    ? 'Allow Location'
                                                    : 'Open Settings'}
                                            </button>
                                        )}
                                    </>
                                )}
                            </div>
                        )}
                        {dscMode !== 'routine' && natureOfDistress === 'mob' && mobSnapshot && (
                            <div className="mt-3 rounded-xl border border-red-400/35 bg-red-950/30 px-3 py-2">
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
                    </div>
                </div>

                {/* ── Readouts — directly under the transcript ── */}
                <div className="shrink-0 rounded-xl border border-white/6 bg-white/2 px-4 py-3 font-mono">
                    <div className="flex items-baseline justify-between gap-3">
                        <div className="flex items-baseline gap-2 min-w-0">
                            <span className="text-[10px] font-extrabold tracking-[0.2em] text-slate-500">LAT</span>
                            <span className="text-[19px] font-black text-sky-400 tracking-tight">
                                {position ? formatLat(position.latitude) : '—'}
                            </span>
                        </div>
                        <div className="flex items-baseline gap-2 min-w-0">
                            <span className="text-[10px] font-extrabold tracking-[0.2em] text-slate-500">LON</span>
                            <span className="text-[19px] font-black text-sky-400 tracking-tight">
                                {position ? formatLon(position.longitude) : '—'}
                            </span>
                        </div>
                    </div>
                    <div className="mt-2 flex items-center border-t border-white/6 pt-2">
                        <div className="flex-1 text-center">
                            <div className="text-[9px] font-extrabold tracking-[0.2em] text-slate-500 uppercase">
                                SOG
                            </div>
                            <div className="text-[18px] font-black text-white">
                                {position ? sogKts.toFixed(1) : '—'}
                                <span className="text-[10px] font-bold text-slate-500 ml-0.5">kts</span>
                            </div>
                        </div>
                        <div className="w-px h-7 bg-white/8 shrink-0" />
                        <div className="flex-1 text-center">
                            <div className="text-[9px] font-extrabold tracking-[0.2em] text-slate-500 uppercase">
                                COG
                            </div>
                            <div className="text-[18px] font-black text-white">
                                {position && cogDeg !== null ? `${Math.round(cogDeg)}` : '—'}
                                <span className="text-[10px] font-bold text-slate-500 ml-0.5">°T</span>
                            </div>
                        </div>
                        <div className="w-px h-7 bg-white/8 shrink-0" />
                        <div className="flex-1 text-center">
                            <div className="text-[9px] font-extrabold tracking-[0.2em] text-slate-500 uppercase">
                                UTC
                            </div>
                            <div className="text-[16px] font-black text-white tracking-wider">{utcTime}</div>
                        </div>
                    </div>
                </div>

                {/* ── Nature of distress (urgency & distress only) ── */}
                {dscMode !== 'routine' && <NatureSelector value={natureOfDistress} onChange={setNatureOfDistress} />}

                {/* ── On your VHF — the DSC steps (urgency & distress only) ── */}
                {dscMode !== 'routine' && <DscSteps mode={dscMode} />}

                {/*
                 * Speak and Copy are gone (Shane 2026-08-28: "i am just not happy
                 * with the voice Claude, best we remove them. people will just
                 * have to read it out"). The transcript IS the deliverable: a
                 * radio script exists to be read aloud by whoever holds the
                 * handset, and it is selectable text as the fallback for the
                 * sat-phone SMS path the file header mentions.
                 */}
            </div>

            {/* ── Pinned footer: channel line + the three call buttons.
                   8 px above the tab bar, outside the scroll region — they
                   never move (Shane 2026-09-06). ── */}
            <div
                className="shrink-0 px-5 pt-2 border-t border-white/6 bg-slate-950"
                style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}
            >
                <ChannelStrip mode={dscMode} />
                <DscSelector mode={dscMode} onChange={setDscMode} mobActive={mobActive} />
            </div>
        </div>
    );
};

// ── DSC sub-components ───────────────────────────────────────────────────────

/**
 * Which channel to be on, VHF and HF, for the selected call (Shane
 * 2026-09-06: "we should let the punter know what channel they should be on,
 * vhf and hf"). The HF figures are the ITU GMDSS distress and safety
 * frequencies (Radio Regulations Appendix 15): DSC alert 8414.5 / 6312 /
 * 4207.5 kHz, then voice on the paired 8291 / 6215 / 4125 kHz. Routine HF
 * traffic has no single answer — coast stations publish their own working
 * frequencies — so the strip says so rather than guess.
 */
const ChannelStrip: React.FC<{ mode: DscMode }> = ({ mode }) => {
    const rows =
        mode === 'routine'
            ? [
                  ['VHF', 'Call on Ch 16, then shift to a working channel'],
                  ['HF', "Your coast station's published working frequency"],
              ]
            : [
                  ['VHF', `DSC ${mode === 'distress' ? 'Distress' : 'Urgency'} on Ch 70, then voice on Ch 16`],
                  ['HF', 'DSC 8414.5 / 6312 / 4207.5 kHz, then voice 8291 / 6215 / 4125 kHz'],
              ];
    const tone = mode === 'distress' ? 'text-red-300' : mode === 'urgency' ? 'text-amber-300' : 'text-sky-300';
    return (
        <div className="mb-2 space-y-0.5" role="note" aria-label="Which channel to use">
            {rows.map(([band, text]) => (
                <div key={band} className="flex items-baseline gap-2">
                    <span className={`w-7 shrink-0 text-[10px] font-extrabold tracking-[0.2em] ${tone}`}>{band}</span>
                    <span className="text-[11px] font-semibold leading-snug text-slate-200">{text}</span>
                </div>
            ))}
        </div>
    );
};

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
                    isActive ? activeClasses : 'bg-white/3 border-white/8 text-slate-400 hover:bg-white/6'
                }`}
                aria-pressed={isActive}
            >
                <div className="text-[11px] font-extrabold tracking-widest uppercase">{label}</div>
                <div className="text-[9px] font-bold tracking-wider uppercase mt-0.5">{hint}</div>
            </button>
        );
    };
    return (
        <div className="shrink-0">
            <div className="flex items-center gap-2 mb-1.5">
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
    <div className="shrink-0 flex items-center gap-3">
        <label className="shrink-0 text-[10px] font-extrabold tracking-[0.2em] uppercase text-slate-500">Nature</label>
        <select
            value={value}
            onChange={(e) => onChange(e.target.value as DistressNature)}
            className="flex-1 min-w-0 px-3 py-2 rounded-xl bg-white/4 border border-white/8 text-white text-[13px] font-bold focus:outline-hidden focus:border-white/20"
        >
            {(Object.keys(NATURE_LABEL) as DistressNature[]).map((k) => (
                <option key={k} value={k} className="bg-slate-900">
                    {NATURE_LABEL[k]}
                </option>
            ))}
        </select>
    </div>
);

const DscSteps: React.FC<{ mode: DscMode }> = ({ mode }) => {
    const isDistress = mode === 'distress';
    const steps = isDistress
        ? [
              'Lift the red distress flap on your VHF.',
              'Press & hold the DSC DISTRESS button for 5 seconds.',
              'Wait for acknowledgement, then switch to Channel 16.',
              'Read the transcript slowly, twice if needed.',
          ]
        : [
              'Select DSC Urgency / All-Ships call on your VHF.',
              'Transmit on Channel 70 (DSC), then switch to Channel 16.',
              'Read the transcript slowly and clearly.',
          ];
    return (
        <div
            className={`shrink-0 rounded-xl border px-3 py-2 ${
                isDistress ? 'border-red-400/30 bg-red-950/30' : 'border-amber-400/30 bg-amber-950/20'
            }`}
        >
            <div
                className={`text-[10px] font-extrabold tracking-[0.2em] uppercase mb-1 ${
                    isDistress ? 'text-red-300' : 'text-amber-300'
                }`}
            >
                On your VHF
            </div>
            <ol className="space-y-0.5 list-decimal list-inside text-[12px] text-slate-200 leading-snug">
                {steps.map((s, i) => (
                    <li key={i}>{s}</li>
                ))}
            </ol>
            <div className={`mt-1.5 text-[11px] font-bold ${isDistress ? 'text-red-300' : 'text-amber-300'}`}>
                This app does not transmit DSC — it prepares the voice script.
            </div>
        </div>
    );
};
