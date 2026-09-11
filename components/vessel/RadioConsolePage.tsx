/**
 * RadioConsolePage — "Report Position" high-contrast screen.
 *
 * Designed for 0300 VHF position reports:
 *  - Navy dark background with amber/gold text (night-vision safe)
 *  - Live GPS position in nautical degrees-minutes format
 *  - Vessel identity (name, call sign, MMSI, rego)
 *  - SOG/COG from GPS
 *  - Instructions followed by a stable, full-pane voice script
 *  - Honest boat/device fix provenance and last-known position retention
 */
import React, { useState, useEffect, useCallback, useSyncExternalStore } from 'react';
import { useRadioPosition, type RadioPositionFix } from '../../hooks/useRadioPosition';
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
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
import { useUtcClock } from '../../hooks/useUtcClock';
import { formatLatDegMin, formatLonDegMin } from '../../utils/formatDegMin';
import { RadioInstructionsDialog, RadioTranscriptDialog } from './RadioConsoleDialogs';
import { useRadioSelectorAnchor } from './useRadioSelectorAnchor';

interface RadioConsolePageProps {
    onBack: () => void;
    onNavigate?: (page: string) => void;
}

type EmergencyVesselType = 'sail' | 'power' | 'observer' | undefined;

// ── Coordinate formatting ─────────────────────────────────────────────────
/** Convert decimal degrees to degrees°minutes.decimal′ N/S/E/W format */
const formatLat = (dec: number): string => formatLatDegMin(dec);

const formatLon = (dec: number): string => formatLonDegMin(dec);

function fixAge(timestamp: number): string {
    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    return `${Math.floor(seconds / 3600)}h ago`;
}

/** Timestamp every reading, including a live one, so it remains honest while
 * the operator reads a frozen script. A phone is not automatically the boat. */
function positionSpeech(position: RadioPositionFix | null, held: boolean): string {
    if (!position) {
        return 'Position unavailable in this app. State your position from another reliable source, or your last known position and time. ';
    }
    const time = new Date(position.timestamp).toISOString();
    const source = position.isVessel ? 'vessel' : 'device GPS';
    const prefix = held
        ? `Last known ${source} position`
        : position.isVessel
          ? 'Vessel position'
          : 'Position from this device’s GPS';
    const date = ` on ${time.slice(0, 10)}`;
    return `${prefix}, recorded at ${spellDigits(time.slice(11, 16).replace(':', ''))}, U T C${date}. ${formatSpokenPosition(position.latitude, position.longitude)}. `;
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
    positionWords: string,
    sogKts: number | null,
    cogDeg: number | null,
): string {
    const name = phoneticName || vesselName;
    const vesselKind = spokenVesselKind(vesselType);
    let report = name ? `This is ${vesselKind} ${name}. ` : `This is ${vesselKind}. Say your vessel name now. `;
    if (callSign) report += spokenCallSign(callSign);
    if (mmsi) report += spokenMmsi(mmsi);
    report += `\n\n${positionWords}`;
    if (sogKts !== null) report += spokenSpeedOverGround(sogKts);
    if (cogDeg !== null) report += `Course. ${spokenBearing(cogDeg)}.`;
    return `${report.trim()} Over.`;
}

/** Pan-Pan urgency voice script — ITU-R M.1171 phraseology. */
function buildUrgencyText(
    vesselName: string | undefined,
    vesselType: EmergencyVesselType,
    callSign: string | undefined,
    mmsi: string | undefined,
    positionWords: string,
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
    out += `\n\n${positionWords}`;
    if (mobSnapshot) out += mobDatumSpoken(mobSnapshot);
    out += `\n\n${natureWords}. Requesting assistance. Over.`;
    return out;
}

/** Mayday distress voice script — ITU-R M.1171 phraseology. */
function buildDistressText(
    vesselName: string | undefined,
    vesselType: EmergencyVesselType,
    callSign: string | undefined,
    mmsi: string | undefined,
    pob: number | undefined,
    positionWords: string,
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
    out += `\n\n${positionWords}`;
    if (mobSnapshot) out += mobDatumSpoken(mobSnapshot);
    out += `\n\nNature of distress: ${natureSpoken}. `;
    out += pob !== undefined ? `${pob} persons on board. ` : 'State the number of persons on board. ';
    out += 'Requesting immediate assistance. Over.';
    return out;
}

const subscribeIdentity = (notify: () => void) => subscribeAuthIdentityScope(() => notify());

/** Identity changes discard the previous operator's frozen script and MOB handoff. */
export const RadioConsolePage: React.FC<RadioConsolePageProps> = (props) => {
    const identity = useSyncExternalStore(subscribeIdentity, getAuthIdentityScope, getAuthIdentityScope);
    const { activeVesselId } = useSettings();
    return <RadioConsole key={`${identity.key}:${identity.generation}:${activeVesselId ?? 'none'}`} {...props} />;
};

const RadioConsole: React.FC<RadioConsolePageProps> = ({ onBack, onNavigate }) => {
    const { settings, activeVesselId } = useSettings();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vessel = (settings as any)?.vessel;

    const radio = useRadioPosition();
    const { position, requestGpsAccess } = radio;
    const [dialogStep, setDialogStep] = useState<'instructions' | 'transcript' | null>('instructions');
    const [readback, setReadback] = useState<{ text: string; fix: RadioPositionFix | null } | null>(null);
    const [confirmedReceiver, setConfirmedReceiver] = useState<string | null>(null);
    const closeDialog = useCallback(() => setDialogStep(null), []);
    const { selectorRef, anchor: selectorAnchor } = useRadioSelectorAnchor();

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
    const gpsBlocked =
        !position?.isVessel && gpsHealth && !gpsHealth.usable ? gpsHealthMessage(gpsHealth.reason) : null;

    // ── SOG/COG from GPS ──
    // Cloud boat_id is an account-selection fence, not physical receiver
    // attestation. Every receiver needs the operator's check before readback.
    const receiverMatchesSelection = !position?.vesselId || position.vesselId === activeVesselId;
    const receiverVerified =
        !!position && receiverMatchesSelection && !!position.receiverKey && confirmedReceiver === position.receiverKey;
    const scriptPosition = receiverVerified ? position : null;
    const sogKts = radio.isLive && scriptPosition?.speed != null ? scriptPosition.speed * 1.94384 : null;
    const cogDeg = radio.isLive && scriptPosition ? validCourse(scriptPosition.heading) : null;

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
    const positionWords =
        position && !receiverVerified
            ? 'Position not verified for this vessel. State your position from another reliable source, or your last known position and time. '
            : positionSpeech(scriptPosition, !radio.isFresh || radio.error);
    const currentTranscript =
        dscMode === 'routine'
            ? buildRoutineText(vesselName, vesselType, phoneticName, callSign, mmsi, positionWords, sogKts, cogDeg)
            : dscMode === 'urgency'
              ? buildUrgencyText(
                    vesselName,
                    vesselType,
                    callSign,
                    mmsi,
                    positionWords,
                    NATURE_SPOKEN[natureOfDistress],
                    transcriptMobDatum,
                )
              : buildDistressText(
                    vesselName,
                    vesselType,
                    callSign,
                    mmsi,
                    pob,
                    positionWords,
                    NATURE_SPOKEN[natureOfDistress],
                    transcriptMobDatum,
                );

    const captureTranscript = () => {
        setReadback({ text: currentTranscript, fix: scriptPosition ? { ...scriptPosition } : null });
        setDialogStep('transcript');
    };
    const chooseMode = (mode: DscMode) => {
        setDscMode(mode);
        setDialogStep('instructions');
    };

    // The UTC/readback-age tick continues while the script's coordinates stay
    // stable. Only an explicit Update position recaptures the written script.
    const utcTime = useUtcClock();

    const gpsStatusClass =
        !position && radio.error
            ? 'bg-red-500/10 border-red-500/30 text-red-400'
            : radio.isLive
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
              : 'bg-amber-500/10 border-amber-500/30 text-amber-400';
    const gpsLabel = position
        ? `${position.sourceLabel} · ${!radio.isFresh || radio.error ? 'Last known · ' : ''}${fixAge(position.timestamp)}`
        : radio.acquiring
          ? 'Finding a GPS position…'
          : (gpsBlocked?.title ?? 'GPS position unavailable');
    const gpsNotice = (
        <div
            data-testid="radio-position-status"
            className={`rounded-xl border p-3 text-micro ${gpsStatusClass}`}
            role="status"
        >
            <p className="font-bold">{gpsLabel}</p>
            {position && (
                <p className="mt-1 font-mono font-bold">
                    {formatLat(position.latitude)} {formatLon(position.longitude)}
                </p>
            )}
            {position && !position.isVessel && (
                <p className="mt-1">
                    Device GPS, not a verified vessel fix. Confirm this device is aboard before using it for the boat.
                </p>
            )}
            {!position && (
                <p className="mt-1">
                    Do not wait for the app to get a fix before calling for help. State a position from another reliable
                    source, or your last known position and time.
                </p>
            )}
            {gpsBlocked && <p className="mt-1">{gpsBlocked.detail}</p>}
            {gpsBlocked && gpsHealth?.actionable && (
                <button
                    type="button"
                    onClick={gpsHealth.reason === 'not-determined' ? () => void requestGpsAccess() : openDeviceSettings}
                    className="mt-2 min-h-11 rounded-lg bg-sky-600 px-4 py-2 font-bold text-white"
                >
                    {gpsHealth.reason === 'not-determined' ? 'Allow Location' : 'Open Settings'}
                </button>
            )}
        </div>
    );

    return (
        // One screen, no page scroll (Shane 2026-09-06): a stressed operator
        // must never have to scroll to find the call buttons. Instructions
        // precede a separate full-pane script; closing it returns here.
        <div
            data-testid="radio-console-page"
            aria-hidden={dialogStep !== null}
            className="w-full h-full flex flex-col bg-slate-950 slide-up-enter overflow-hidden"
        >
            <PageHeader
                title="Radio Console"
                subtitle="Report Position"
                onBack={onBack}
                action={
                    <div
                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px] font-extrabold uppercase tracking-widest ${gpsStatusClass}`}
                    >
                        <span
                            className={`w-1.5 h-1.5 rounded-full bg-current ${radio.isLive ? 'animate-pulse' : ''}`}
                        />
                        <span>
                            {radio.isLive ? 'LIVE' : position ? 'Last fix' : radio.acquiring ? 'Finding GPS' : 'No fix'}
                        </span>
                    </div>
                }
            />

            {/* Call type stays above all variable-height/scrolling content. */}
            <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-3">
                <div ref={selectorRef}>
                    <DscSelector mode={dscMode} onChange={chooseMode} mobActive={mobActive} />
                </div>
            </div>

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

            {/* ── Middle: entry point and readouts. Scrolls only
                   on a screen too short to hold it; call type above never does. ── */}
            <div
                data-testid="radio-console-body"
                className="flex-1 min-h-0 flex flex-col gap-3 px-5 pt-3 overflow-y-auto"
                style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}
            >
                {dialogStep !== 'instructions' && gpsNotice}
                <button
                    type="button"
                    onClick={() => setDialogStep('instructions')}
                    className="shrink-0 rounded-2xl border border-sky-400/40 bg-sky-500/15 px-4 py-5 text-left text-white"
                >
                    <span className="block text-lg font-bold">Prepare voice call</span>
                    <span className="block mt-1 text-sm text-slate-300">
                        VHF instructions, then a full-screen script to read aloud.
                    </span>
                </button>

                {/* ── Live / last-known readouts ── */}
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
                                {sogKts !== null ? sogKts.toFixed(1) : '—'}
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

                {dscMode !== 'routine' && natureOfDistress === 'mob' && mobSnapshot && (
                    <div className="rounded-xl border border-red-400/35 bg-red-950/30 p-3">
                        <p className="text-micro font-bold text-red-200">MOB datum · not current vessel position</p>
                        <p className="mt-1 font-mono text-sm text-white">
                            {formatLat(mobSnapshot.fixLat)} {formatLon(mobSnapshot.fixLon)}
                        </p>
                        <p className="mt-1 text-micro text-red-100">
                            Marked {new Date(mobSnapshot.activatedAt).toISOString().slice(11, 19)} UTC · ±
                            {Math.round(mobSnapshot.fixAccuracy)} m
                        </p>
                    </div>
                )}

                {/*
                 * Speak and Copy are gone (Shane 2026-08-28: "i am just not happy
                 * with the voice Claude, best we remove them. people will just
                 * have to read it out"). The transcript IS the deliverable: a
                 * radio script exists to be read aloud by whoever holds the
                 * handset, and it is selectable text as the fallback for the
                 * sat-phone SMS path the file header mentions.
                 */}
            </div>

            {dialogStep === 'instructions' && (
                <RadioInstructionsDialog
                    onClose={closeDialog}
                    onContinue={captureTranscript}
                    selectorAnchor={selectorAnchor}
                    selectors={<DscSelector mode={dscMode} onChange={setDscMode} mobActive={mobActive} />}
                >
                    {dscMode !== 'routine' && (
                        <NatureSelector value={natureOfDistress} onChange={setNatureOfDistress} />
                    )}
                    <DscSteps mode={dscMode} />
                    {gpsNotice}
                    {position && receiverMatchesSelection && (
                        <label className="flex items-start gap-3 rounded-xl border border-amber-400/30 bg-amber-500/10 p-3 text-sm text-slate-200">
                            <input
                                type="checkbox"
                                aria-label="Confirm position receiver is aboard this vessel"
                                className="mt-1 h-5 w-5 shrink-0"
                                checked={!!receiverVerified}
                                onChange={(event) =>
                                    setConfirmedReceiver(event.target.checked ? (position.receiverKey ?? null) : null)
                                }
                            />
                            <span>
                                I have checked these coordinates are for{' '}
                                <strong>{vesselName ?? 'the vessel I am calling from'}</strong>
                                {!position.isVessel && ', and this phone or tablet is aboard'}. Use this receiver’s
                                position in my call.
                                <span className="block mt-1 text-micro">
                                    Leave unchecked if unsure. You can still continue and state the position yourself.
                                </span>
                            </span>
                        </label>
                    )}
                    <p className="text-sm text-slate-200">
                        Check the vessel identity, position and actual number of people aboard before speaking. These
                        controls only prepare text; operate the radio itself to call.
                    </p>
                    <details className="text-micro text-slate-300">
                        <summary className="cursor-pointer font-bold py-2">VHF / HF channel reference</summary>
                        <ChannelStrip mode={dscMode} />
                    </details>
                </RadioInstructionsDialog>
            )}
            {dialogStep === 'transcript' && readback && (
                <RadioTranscriptDialog
                    text={readback.text}
                    selectorAnchor={selectorAnchor}
                    selectors={<DscSelector mode={dscMode} onChange={chooseMode} mobActive={mobActive} />}
                    onClose={closeDialog}
                    onInstructions={() => setDialogStep('instructions')}
                    onUpdate={() => {
                        if (position && !receiverVerified) setDialogStep('instructions');
                        else captureTranscript();
                    }}
                    status={
                        <div data-testid="radio-script-position-status">
                            <p className="font-bold text-sky-200">
                                {dscMode === 'routine'
                                    ? 'On the agreed working channel'
                                    : 'Read aloud on VHF Channel 16'}{' '}
                                · Not transmitted by this app
                            </p>
                            <p className="mt-1">
                                {readback.fix
                                    ? `Script fix: ${readback.fix.sourceLabel} · ${fixAge(readback.fix.timestamp)}`
                                    : 'No GPS position in this script — state your position yourself.'}{' '}
                                Position stays fixed while you read; Update position uses the latest fix.
                            </p>
                        </div>
                    }
                />
            )}
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
        <div role="group" aria-label="Call type" data-testid="radio-call-selector" className="shrink-0">
            <div className="flex items-center gap-2 mb-1.5">
                <div className="text-[10px] font-extrabold tracking-[0.2em] uppercase text-slate-500">Call type</div>
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
            aria-label="Nature of distress"
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
    const steps =
        mode === 'routine'
            ? [
                  'Listen on Channel 16, then call the intended station and identify your vessel.',
                  'Once answered, move to the agreed working channel for your position report.',
                  'Read the script clearly. Release the talk button and listen for a reply.',
              ]
            : isDistress
              ? [
                    'MAYDAY is for grave and imminent danger requiring immediate assistance.',
                    'If DSC-equipped, follow your radio’s DISTRESS button hold/countdown until it confirms sending.',
                    'Select and monitor Channel 16 for the voice Mayday, following your radio’s prompts. Without DSC, use voice on Channel 16.',
                    'Read the script clearly, then release the talk button and listen. Do not wait for this app’s GPS before calling.',
                ]
              : [
                    'PAN-PAN is for urgent safety concerns below grave and imminent danger.',
                    'If DSC-equipped, you can use the Urgency / All-Ships menu — not the red DISTRESS button — then use voice on Channel 16.',
                    'Without DSC, use voice on Channel 16. Read the script clearly, then release the talk button and listen.',
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
            <ol className="space-y-2 list-decimal list-inside text-sm text-slate-200 leading-snug">
                {steps.map((s, i) => (
                    <li key={i}>{s}</li>
                ))}
            </ol>
            <div className={`mt-3 text-micro font-bold ${isDistress ? 'text-red-300' : 'text-amber-300'}`}>
                Channel 70 is DSC only — never voice. This app does not transmit or confirm an alert. Continue opens the
                script.
            </div>
        </div>
    );
};
