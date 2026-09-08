/**
 * VesselTab — Vessel configuration: type, name, dimensions, performance, capacity.
 * Extracted from SettingsModal monolith (63 lines → standalone component).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { closeHauledDegFor } from '../../services/sailing/pointOfSail';
import { Section, Row, type SettingsTabProps } from './SettingsPrimitives';
import { LengthUnit, WeightUnit, VolumeUnit, VesselDimensionUnits, VesselProfile } from '../../types';
import type { PolarData } from '../../types/navigation';
import type { ComfortParams } from '../../types/settings';
import { YachtDatabaseSearch } from './YachtDatabaseSearch';
import type { PolarDatabaseEntry } from '../../data/polarDatabase';
import { saveIdentity } from '../../services/VesselIdentityService';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../../services/authIdentityScope';
import { vesselCrewAboard, vesselCruisingSpeedKts, vesselMaxWaveHeightFt } from '../../services/units';
import { FLOAT_PLAN_ROLES } from '../../services/floatPlanCrew';
import type { VesselCrewPerson } from '../../types/vessel';
import { useSettingsStore } from '../../stores/settingsStore';
import { AlertTriangleIcon, AnchorIcon, EyeIcon, CheckIcon, PlusSquareIcon, RefreshIcon, TrashIcon } from '../Icons';
import { triggerHaptic } from '../../utils/system';
import { useKeyboardOffset } from '../../hooks/useKeyboardOffset';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { OverlayPortal } from '../ui/OverlayPortal';
import { JoinVessel } from '../crew/JoinVessel';
// Types only: the tab stays decoupled from the fleet service at runtime (see
// FleetStoreSurface below) and merely agrees on the release vocabulary.
import type { ReleaseReason, ReleaseVesselResult, UndoReleaseResult } from '../../services/VesselFleetService';
import { ReleaseVesselDialog } from './ReleaseVesselDialog';
import { ReleaseResultDialog, type ReleaseOutcome } from './ReleaseResultDialog';

/**
 * The fleet store is deliberately read through this small compatibility
 * surface.  VesselTab ships alongside the fleet-store migration, so older
 * app builds (and isolated component tests) can still render the legacy
 * single-vessel profile while the new store is not present.
 *
 * Keep this adapter local: the canonical runtime/store types live with the
 * fleet service. This component only needs enough shape to render a selector
 * and call the public actions.
 */
interface FleetProfilePatch {
    profile?: Partial<VesselProfile>;
    vesselUnits?: Partial<VesselDimensionUnits>;
    comfortParams?: Partial<ComfortParams>;
    polarData?: PolarData | null;
    setPolarData?: boolean;
    polarBoatModel?: string | null;
    setPolarBoatModel?: boolean;
    polarSourceType?: 'database' | 'file_import' | 'manual' | null;
    setPolarSourceType?: boolean;
}

type FleetProfileUpdate = Partial<VesselProfile> | FleetProfilePatch;

interface FleetStoreSurface {
    vesselFleet?: unknown;
    activeVesselId?: unknown;
    vesselFleetStatus?: unknown;
    selectActiveVessel?: (vesselId: string) => unknown;
    createVesselProfile?: (profile: VesselProfile) => unknown;
    archiveVesselProfile?: (vesselId: string) => unknown;
    patchActiveVesselProfile?: (patch: FleetProfileUpdate) => unknown;
    syncVesselFleet?: () => unknown;
    // 2026-09-08 vessel release decision. All optional so a tab built ahead
    // of the store (or an isolated test) degrades to the archive-only surface.
    releaseVesselProfile?: (vesselId: string, reason: ReleaseReason) => unknown;
    undoVesselRelease?: (vesselId: string) => unknown;
    releasedVessels?: unknown;
    vesselClaimConflict?: unknown;
    dismissVesselClaimConflict?: () => void;
    releaseBlockedReason?: () => string | null;
}

interface FleetVesselOption {
    id: string;
    vessel: Partial<VesselProfile>;
    archived: boolean;
    /**
     * The cloud's claim verdict for this hull's MMSI (claimFlow step 5): false
     * means another active Thalassa boat holds it. null when the row predates
     * the column, so the advisory stays silent rather than guessing.
     */
    mmsiClaimed: boolean | null;
}

interface ReleasedVesselOption {
    boatId: string;
    name: string;
    releasedAt: string;
    releaseReason: ReleaseReason;
}

type FleetBusyAction = 'add' | 'archive' | 'release' | 'undo' | 'sync' | null;

interface FleetStatusDisplay {
    label: string;
    detail: string | null;
    tone: 'green' | 'blue' | 'amber' | 'red' | 'slate';
    busy: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function firstString(...values: unknown[]): string | null {
    for (const value of values) {
        const stringValue = nonEmptyString(value);
        if (stringValue) return stringValue;
    }
    return null;
}

function fleetOptionFromUnknown(value: unknown): FleetVesselOption | null {
    if (!isRecord(value)) return null;

    const id = firstString(value.id, value.vessel_id, value.vesselId, value.boat_id, value.boatId);
    if (!id) return null;

    const nestedProfile = isRecord(value.profile)
        ? value.profile
        : isRecord(value.vessel)
          ? value.vessel
          : isRecord(value.specs)
            ? value.specs
            : value;
    const archived =
        value.archived === true ||
        value.is_archived === true ||
        value.isArchived === true ||
        typeof value.archived_at === 'string' ||
        typeof value.archivedAt === 'string';
    const claimed = value.mmsiClaimed ?? value.mmsi_claimed;

    return {
        id,
        vessel: nestedProfile as Partial<VesselProfile>,
        archived,
        mmsiClaimed: typeof claimed === 'boolean' ? claimed : null,
    };
}

function fleetOptionsFromUnknown(value: unknown): FleetVesselOption[] {
    if (!Array.isArray(value)) return [];
    return value
        .map(fleetOptionFromUnknown)
        .filter((option): option is FleetVesselOption => option !== null)
        .filter((option) => !option.archived);
}

function fleetActionResultId(value: unknown): string | null {
    if (!isRecord(value)) return null;
    return firstString(value.id, value.vessel_id, value.vesselId, value.boat_id, value.boatId);
}

// ── Release / Undo / MMSI claim (2026-09-08 decision) ────────────────────────
// Read through the same tolerant adapters as the fleet rows: the store is the
// source of truth, and an older store simply yields nothing here.

function releaseReasonFromUnknown(value: unknown): ReleaseReason {
    return value === 'sold' || value === 'delivery_complete' ? value : 'other';
}

function releasedVesselsFromUnknown(value: unknown): ReleasedVesselOption[] {
    if (!Array.isArray(value)) return [];
    const rows: ReleasedVesselOption[] = [];
    for (const raw of value) {
        if (!isRecord(raw)) continue;
        const boatId = firstString(raw.boatId, raw.boat_id, raw.id);
        const releasedAt = firstString(raw.releasedAt, raw.released_at);
        if (!boatId || !releasedAt) continue;
        rows.push({
            boatId,
            name: firstString(raw.name, isRecord(raw.profile) ? raw.profile.name : null) ?? 'Unnamed vessel',
            releasedAt,
            releaseReason: releaseReasonFromUnknown(raw.releaseReason ?? raw.release_reason),
        });
    }
    return rows;
}

function claimConflictFromUnknown(value: unknown): { vesselName: string; mmsi: string } | null {
    if (!isRecord(value)) return null;
    const vesselName = firstString(value.vesselName, value.vessel_name);
    if (!vesselName) return null;
    return { vesselName, mmsi: mmsiDigits(value.mmsi) };
}

function finiteCount(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function releaseResultFromUnknown(value: unknown): ReleaseVesselResult | null {
    if (!isRecord(value)) return null;
    return {
        released: value.released !== false,
        remainingActiveBoats: finiteCount(value.remainingActiveBoats),
        nextActiveBoatId: firstString(value.nextActiveBoatId),
        crewRemoved: finiteCount(value.crewRemoved),
        invitesRevoked: finiteCount(value.invitesRevoked),
        relaysRemoved: finiteCount(value.relaysRemoved),
        relaysUnmatched: finiteCount(value.relaysUnmatched),
        telemetryCleared: finiteCount(value.telemetryCleared),
        publicPagesDisabled: finiteCount(value.publicPagesDisabled),
    };
}

function undoResultFromUnknown(value: unknown): UndoReleaseResult | null {
    if (!isRecord(value)) return null;
    return { restored: value.restored !== false, claimLost: value.claimLost === true };
}

/** The radio labels, lower-cased for 'You released Serene Summer on 8 Sep 2026 (sold)'. */
function releaseReasonLabel(reason: ReleaseReason): string {
    if (reason === 'sold') return 'sold';
    if (reason === 'delivery_complete') return 'delivery finished';
    return 'something else';
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '8 Sep 2026' in the device's local day — hand-rolled so ICU's 'Sept' never creeps in. */
function formatReleaseDate(iso: string): string {
    const time = Date.parse(iso);
    if (!Number.isFinite(time)) return iso;
    const date = new Date(time);
    return `${date.getDate()} ${SHORT_MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

function mmsiDigits(value: unknown): string {
    return typeof value === 'string' ? value.replace(/\D/g, '') : '';
}

interface MmsiClaimBannerProps {
    conflict: { vesselName: string; mmsi: string };
    /** Set once the crew code was redeemed, so the banner can point at the remaining step. */
    joinedCrewOf: string | null;
    busy: boolean;
    onEnterCrewCode: () => void;
    onSaveWithoutMmsi: () => void;
    onDismiss: () => void;
}

/**
 * claimFlow step 4 (2026-09-08): the automatic bootstrap was refused because
 * another ACTIVE Thalassa boat holds this MMSI. Centred and focus-trapped
 * like every dialog. The two escapes are the design's: a crew code (the only
 * way onto someone else's hull) or saving without the MMSI (the boat then
 * bootstraps unclaimed). The name shown is the claiming BOAT's, which AIS
 * already broadcasts beside the MMSI; the owner is never disclosed.
 */
function MmsiClaimBanner({
    conflict,
    joinedCrewOf,
    busy,
    onEnterCrewCode,
    onSaveWithoutMmsi,
    onDismiss,
}: MmsiClaimBannerProps) {
    const crewCodeRef = useRef<HTMLButtonElement>(null);
    const trapRef = useFocusTrap<HTMLDivElement>(true, { initialFocusRef: crewCodeRef, onEscape: onDismiss });
    const { vesselName, mmsi } = conflict;
    const lead = mmsi
        ? `${vesselName} (MMSI ${mmsi}) is already on Thalassa.`
        : `${vesselName} is already on Thalassa with this MMSI.`;

    return (
        <OverlayPortal
            className="flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mmsi-claim-title"
            aria-describedby="mmsi-claim-body"
            ref={trapRef}
        >
            <div className="absolute inset-0 bg-black/60" role="presentation" onClick={onDismiss} />
            <div
                data-testid="mmsi-claim-panel"
                className="relative w-full max-w-sm max-h-[80dvh] overflow-y-auto rounded-2xl border border-amber-400/25 bg-slate-900 p-5 shadow-2xl animate-in fade-in zoom-in-95 duration-200"
            >
                <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-amber-500/15 text-amber-300">
                    <AlertTriangleIcon className="h-5 w-5" />
                </div>
                <h2 id="mmsi-claim-title" className="text-center text-lg font-black text-white">
                    Already on Thalassa
                </h2>
                <p id="mmsi-claim-body" className="mt-2 text-center text-[13px] leading-relaxed text-slate-300">
                    {lead} Joining her crew? Ask the skipper for a crew code. Bought her? Ask them to release her in
                    Settings &gt; Vessel.
                </p>
                {joinedCrewOf && (
                    <p
                        role="status"
                        className="mt-3 rounded-xl border border-emerald-400/25 bg-emerald-500/10 px-3 py-2 text-[12px] leading-relaxed text-emerald-100"
                    >
                        You&apos;ve joined {joinedCrewOf}&apos;s crew. Save without MMSI so your own profile stops
                        trying to claim her.
                    </p>
                )}
                <div className="mt-5 space-y-2">
                    <button
                        ref={crewCodeRef}
                        type="button"
                        onClick={onEnterCrewCode}
                        disabled={busy}
                        className="w-full min-h-[44px] rounded-xl border border-amber-500/30 bg-linear-to-r from-amber-500/25 to-orange-500/25 py-3 text-sm font-black uppercase tracking-widest text-amber-200 transition-colors hover:from-amber-500/35 hover:to-orange-500/35 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        Enter crew code
                    </button>
                    <button
                        type="button"
                        onClick={onSaveWithoutMmsi}
                        disabled={busy}
                        className="w-full min-h-[44px] rounded-xl border border-white/10 bg-white/5 py-3 text-sm font-bold text-slate-100 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        Save without MMSI
                    </button>
                    <button
                        type="button"
                        onClick={onDismiss}
                        className="w-full min-h-[44px] rounded-xl py-2 text-[11px] font-bold uppercase tracking-wide text-slate-400 transition-colors hover:text-slate-200"
                    >
                        Not now
                    </button>
                </div>
            </div>
        </OverlayPortal>
    );
}

function fleetStatusDisplay(value: unknown, fleetAvailable: boolean): FleetStatusDisplay {
    if (!fleetAvailable) {
        return {
            label: 'Local profile',
            detail: 'Fleet cloud sync is not available in this build yet.',
            tone: 'slate',
            busy: false,
        };
    }

    if (value === null || value === undefined) {
        return {
            label: 'Ready to sync',
            detail: 'The fleet service is ready; run a cloud check after making changes.',
            tone: 'slate',
            busy: false,
        };
    }

    const record = isRecord(value) ? value : null;
    const raw =
        typeof value === 'string' ? value : (firstString(record?.state, record?.status, record?.phase) ?? 'idle');
    const status = raw.toLowerCase().replace(/[\s_-]+/g, '');
    const error = firstString(record?.error, record?.message, record?.lastError);
    const lastSyncedAt = firstString(record?.lastSyncedAt, record?.last_synced_at, record?.syncedAt);
    const syncedDetail = lastSyncedAt ? `Last cloud check ${new Date(lastSyncedAt).toLocaleString()}` : null;

    if (error || status.includes('error') || status.includes('failed') || status.includes('conflict')) {
        return {
            label: 'Needs attention',
            detail: error ?? 'The fleet could not sync to the cloud.',
            tone: 'red',
            busy: false,
        };
    }
    if (status.includes('offline') || status.includes('queued') || status.includes('pending')) {
        return {
            label: 'Saved offline',
            detail: error ?? 'This device will send the vessel changes when it is back online.',
            tone: 'amber',
            busy: false,
        };
    }
    if (status.includes('sync') || status.includes('load') || status.includes('refresh')) {
        return { label: 'Syncing fleet', detail: 'Checking the cloud copy of your vessels.', tone: 'blue', busy: true };
    }
    if (status === 'idle') {
        return {
            label: 'Ready to sync',
            detail: 'The fleet service is ready; run a cloud check after making changes.',
            tone: 'slate',
            busy: false,
        };
    }
    if (status.includes('saved') || status.includes('synced') || status.includes('ready')) {
        return {
            label: 'Cloud synced',
            detail: syncedDetail ?? 'Your active vessel is available on your signed-in devices.',
            tone: 'green',
            busy: false,
        };
    }

    return { label: 'Fleet status unknown', detail: syncedDetail, tone: 'slate', busy: false };
}

function defaultFleetVessel(index: number): VesselProfile {
    return {
        name: `Vessel ${index}`,
        type: 'sail',
        length: 30,
        beam: 10,
        draft: 5,
        displacement: 10000,
        maxWaveHeight: 6,
        cruisingSpeed: 6,
        fuelCapacity: 0,
        waterCapacity: 0,
    };
}

// Pure constant — module scope so the ~8 MetricInputs on this tab don't each
// rebuild ten objects and thirty closures on every keystroke in any field.
const UNIT_CONVERSIONS: Record<string, Record<string, (n: number) => number>> = {
    ft: { m: (n) => n * 0.3048, ft: (n) => n },
    m: { ft: (n) => n / 0.3048, m: (n) => n },
    lbs: { kg: (n) => n * 0.453592, tonnes: (n) => n * 0.000453592, lbs: (n) => n },
    kg: { lbs: (n) => n / 0.453592, tonnes: (n) => n / 1000, kg: (n) => n },
    tonnes: { lbs: (n) => n / 0.000453592, kg: (n) => n * 1000, tonnes: (n) => n },
    kts: { mph: (n) => n * 1.15078, kmh: (n) => n * 1.852, kts: (n) => n },
    mph: { kts: (n) => n / 1.15078, kmh: (n) => n * 1.60934, mph: (n) => n },
    kmh: { kts: (n) => n / 1.852, mph: (n) => n / 1.60934, kmh: (n) => n },
    gal: { l: (n) => n * 3.78541, gal: (n) => n },
    l: { gal: (n) => n / 3.78541, l: (n) => n },
};

// ── MetricInput (vessel-specific helper) ─────────────────────
function MetricInput({
    label,
    valInStandard,
    unitType,
    standardUnit,
    unitOptions,
    onChangeValue,
    onChangeUnit,
    placeholder,
    isEstimated,
}: {
    label: string;
    valInStandard: number;
    unitType: string;
    standardUnit: string;
    unitOptions: string[];
    onChangeValue: (v: number) => void;
    onChangeUnit: (u: string) => void;
    placeholder?: string;
    isEstimated?: boolean;
}) {
    // Convert from standard (stored) unit → display unit
    const toDisplay = UNIT_CONVERSIONS[standardUnit]?.[unitType];
    const displayVal = toDisplay ? toDisplay(valInStandard) : valInStandard;

    const [localVal, setLocalVal] = useState(displayVal > 0 ? String(Math.round(displayVal * 100) / 100) : '');
    // Track whether the user is mid-edit so we never overwrite their
    // half-typed value with a re-derived display number from props.
    const isFocusedRef = useRef(false);

    // Sync localVal whenever displayVal changes from outside (unit
    // toggle, external save, yacht-database auto-fill). Without this,
    // switching the unit dropdown left localVal stuck at the previous
    // unit's number — the input visibly said "55" while the dropdown
    // said "m", and any subsequent blur converted "55 m" → 180 ft into
    // storage, silently corrupting the vessel record. The
    // user-reported "555 ft" Tayana 55 was downstream of this exact
    // round-trip after several unit toggles.
    //
    // Only sync when not focused — typing into the field shouldn't
    // get clobbered by a parent re-render.
    useEffect(() => {
        if (isFocusedRef.current) return;
        const next = displayVal > 0 ? String(Math.round(displayVal * 100) / 100) : '';
        setLocalVal((prev) => (prev === next ? prev : next));
    }, [displayVal]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => setLocalVal(e.target.value);

    const handleBlur = () => {
        isFocusedRef.current = false;
        const numericVal = parseFloat(localVal);
        if (isNaN(numericVal)) return;
        // Convert from display unit → standard (stored) unit
        const toStandard = UNIT_CONVERSIONS[unitType]?.[standardUnit];
        if (toStandard) {
            onChangeValue(Math.round(toStandard(numericVal) * 100) / 100);
        } else {
            onChangeValue(numericVal);
        }
    };

    return (
        <div>
            <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                {label}
                {isEstimated && <span className="text-amber-400/70 ml-1 text-[11px]">(est.)</span>}
            </label>
            <div className="flex gap-1.5 min-w-0">
                <input
                    type="number"
                    inputMode="decimal"
                    value={localVal}
                    onFocus={() => {
                        isFocusedRef.current = true;
                    }}
                    onChange={handleChange}
                    onBlur={handleBlur}
                    placeholder={placeholder}
                    className={`flex-1 min-w-0 bg-white/5 border rounded-xl px-2.5 py-2.5 text-white text-sm font-medium outline-hidden transition-colors ${isEstimated ? 'border-amber-500/30 focus:border-amber-400' : 'border-white/10 focus:border-sky-500'}`}
                />
                <select
                    value={unitType}
                    onChange={(e) => onChangeUnit(e.target.value)}
                    className="bg-white/5 border border-white/10 rounded-xl px-1.5 py-2.5 text-[11px] text-gray-400 font-bold uppercase outline-hidden focus:border-sky-500 shrink-0"
                >
                    {unitOptions.map((u) => (
                        <option key={u} value={u}>
                            {u}
                        </option>
                    ))}
                </select>
            </div>
        </div>
    );
}

export const VesselTab: React.FC<SettingsTabProps> = ({ settings, onSave }) => {
    const fleetSurface = useSettingsStore((state) => state as unknown as FleetStoreSurface);
    const fleet = useMemo(() => fleetOptionsFromUnknown(fleetSurface.vesselFleet), [fleetSurface.vesselFleet]);
    const activeVesselId = firstString(fleetSurface.activeVesselId);
    const activeFleetVessel =
        fleet.find((candidate) => candidate.id === activeVesselId) ?? (fleet.length === 1 ? fleet[0] : undefined);
    // The store projects the selected cloud boat into `settings` immediately
    // for legacy consumers. Prefer that projection here too: fleet writes are
    // local-first, while the fleet array is refreshed only after the cloud
    // acknowledgement. Falling back to the row keeps isolated legacy tests
    // and pre-refresh renders safe.
    const vessel = settings.vessel ?? activeFleetVessel?.vessel;
    // The store always exposes fleet actions, including while browsing
    // anonymously. Do not advertise a cloud fleet until there is an account
    // to own it; anonymous vessel onboarding remains a normal local profile.
    const signedIn = Boolean(getAuthIdentityScope().userId);
    const fleetAvailable =
        signedIn &&
        (Array.isArray(fleetSurface.vesselFleet) ||
            typeof fleetSurface.selectActiveVessel === 'function' ||
            typeof fleetSurface.createVesselProfile === 'function' ||
            typeof fleetSurface.archiveVesselProfile === 'function' ||
            typeof fleetSurface.patchActiveVesselProfile === 'function' ||
            typeof fleetSurface.syncVesselFleet === 'function');
    const canPatchActiveFleetVessel = fleetAvailable && typeof fleetSurface.patchActiveVesselProfile === 'function';
    const syncStatus = useMemo(
        () => fleetStatusDisplay(fleetSurface.vesselFleetStatus, fleetAvailable),
        [fleetSurface.vesselFleetStatus, fleetAvailable],
    );

    const [saved, setSaved] = useState(false);
    const [fleetBusyAction, setFleetBusyAction] = useState<FleetBusyAction>(null);
    const [fleetActionError, setFleetActionError] = useState<string | null>(null);
    const [archiveCandidate, setArchiveCandidate] = useState<FleetVesselOption | null>(null);
    // 2026-09-08 vessel release decision — Release / Undo / MMSI claim state.
    const [releaseCandidate, setReleaseCandidate] = useState<FleetVesselOption | null>(null);
    const [releaseOutcome, setReleaseOutcome] = useState<ReleaseOutcome | null>(null);
    const [joinVesselOpen, setJoinVesselOpen] = useState(false);
    const [joinedCrewOf, setJoinedCrewOf] = useState<string | null>(null);
    // releaseBlockedReason() reads navigator.onLine synchronously; re-render
    // when the connection flips so the disabled Release button and its helper
    // text follow it without a tap.
    const [, setConnectivityTick] = useState(0);
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const bump = () => setConnectivityTick((tick) => tick + 1);
        window.addEventListener('online', bump);
        window.addEventListener('offline', bump);
        return () => {
            window.removeEventListener('online', bump);
            window.removeEventListener('offline', bump);
        };
    }, []);
    const releasedVessels = useMemo(
        () => releasedVesselsFromUnknown(fleetSurface.releasedVessels),
        [fleetSurface.releasedVessels],
    );
    const claimConflict = useMemo(
        () => claimConflictFromUnknown(fleetSurface.vesselClaimConflict),
        [fleetSurface.vesselClaimConflict],
    );
    // 'Not now' on the claim banner (2026-09-08): dismissing clears the store's
    // conflict, which re-arms the one-shot bootstrap — and the profile patch
    // path bootstraps too, so the very next keystroke in the form re-confirms
    // the same conflict and would re-open a modal over the field being typed
    // in. Remember which conflict was dismissed and show a one-line inline
    // reminder under the MMSI field instead, until the MMSI changes or the
    // skipper asks for the options again. The two real escapes are untouched.
    const [snoozedConflictKey, setSnoozedConflictKey] = useState<string | null>(null);
    const claimConflictKey = claimConflict ? `${claimConflict.vesselName}|${claimConflict.mmsi}` : null;
    const claimConflictSnoozed = claimConflict !== null && claimConflictKey === snoozedConflictKey;
    const releaseAvailable = fleetAvailable && typeof fleetSurface.releaseVesselProfile === 'function';
    const releaseBlockedReason = releaseAvailable ? (fleetSurface.releaseBlockedReason?.() ?? null) : null;
    // claimFlow step 5: PATCH is advisory. Speak only once the cloud has
    // acknowledged the current profile (green) — the local fleet row keeps the
    // previous claim verdict until the patch RPC's reply replaces it.
    const localMmsi = mmsiDigits(vessel?.mmsi);
    const mmsiClaimAdvisory =
        fleetAvailable &&
        syncStatus.tone === 'green' &&
        /^\d{9}$/.test(localMmsi) &&
        activeFleetVessel?.mmsiClaimed === false &&
        mmsiDigits(activeFleetVessel.vessel.mmsi) === localMmsi;
    const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isObserver = vessel?.type === 'observer';
    const keyboardHeight = useKeyboardOffset();

    useEffect(
        () => () => {
            if (savedTimer.current) clearTimeout(savedTimer.current);
        },
        [],
    );

    const showSavedConfirmation = useCallback(() => {
        setSaved(true);
        if (savedTimer.current) clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setSaved(false), 2600);
    }, []);

    const reportFleetError = useCallback((message: string) => {
        setFleetActionError(message);
        setSaved(false);
    }, []);

    const callFleetAction = useCallback(
        async (kind: Exclude<FleetBusyAction, null>, action: () => unknown) => {
            setFleetBusyAction(kind);
            setFleetActionError(null);
            try {
                return await Promise.resolve(action());
            } catch (error) {
                reportFleetError(error instanceof Error ? error.message : 'Could not update your vessel fleet.');
                return null;
            } finally {
                setFleetBusyAction(null);
            }
        },
        [reportFleetError],
    );

    const updateActiveFleetProfile = useCallback(
        (patch: FleetProfileUpdate) => {
            const patchProfile = fleetSurface.patchActiveVesselProfile;
            if (!canPatchActiveFleetVessel || !patchProfile) return false;
            void Promise.resolve(patchProfile(patch)).catch((error: unknown) => {
                reportFleetError(error instanceof Error ? error.message : 'Could not save this vessel change.');
            });
            return true;
        },
        [canPatchActiveFleetVessel, fleetSurface.patchActiveVesselProfile, reportFleetError],
    );

    const updateVesselUnits = useCallback(
        (patch: Partial<VesselDimensionUnits>) => {
            if (updateActiveFleetProfile({ vesselUnits: patch })) return;
            onSave({
                vesselUnits: {
                    ...settings.vesselUnits,
                    ...patch,
                } as VesselDimensionUnits,
            });
        },
        [onSave, settings.vesselUnits, updateActiveFleetProfile],
    );

    const updateComfortParams = useCallback(
        (patch: Partial<ComfortParams>) => {
            if (updateActiveFleetProfile({ comfortParams: patch })) return;
            onSave({ comfortParams: { ...settings.comfortParams, ...patch } });
        },
        [onSave, settings.comfortParams, updateActiveFleetProfile],
    );

    const vesselWithDefaults = useCallback(
        (patch: Partial<VesselProfile> = {}): VesselProfile => ({
            name: 'My Boat',
            type: 'sail',
            length: 30,
            beam: 10,
            draft: 5,
            displacement: 10000,
            maxWaveHeight: 6,
            cruisingSpeed: 6,
            fuelCapacity: 0,
            waterCapacity: 0,
            ...(vessel || {}),
            ...patch,
        }),
        [vessel],
    );

    // Mirror the identity-relevant vessel fields into the `vessel_identity`
    // table. Settings only persist to device-local Capacitor Preferences, so
    // without this the public Voyage Log API (and the handle generator) never
    // see the vessel's name. Debounced so typing doesn't fire an upsert per
    // keystroke.
    const vesselName = vessel?.name;
    const vesselType = vessel?.type;
    const vesselModel = vessel?.model;
    useEffect(() => {
        // The fleet service owns per-vessel identity. Keep the legacy identity
        // mirror only for pre-fleet builds so editing a second vessel cannot
        // overwrite the account's old singleton identity row.
        if (fleetAvailable || !vesselName) return;
        const t = setTimeout(() => {
            void saveIdentity({
                vessel_name: vesselName,
                vessel_type: vesselType === 'power' ? 'power' : vesselType === 'observer' ? 'observer' : 'sail',
                ...(vesselModel ? { model: vesselModel } : {}),
            });
        }, 1200);
        return () => clearTimeout(t);
    }, [fleetAvailable, vesselName, vesselType, vesselModel]);

    /** One row per person aboard, padded to the crew count (rank defaults: Skipper first, Crew after). */
    const crewRosterRows: VesselCrewPerson[] = Array.from({ length: vesselCrewAboard(vessel) }, (_, i) => {
        const row = vessel?.crewRoster?.[i];
        return { name: row?.name ?? '', age: row?.age, rank: row?.rank || (i === 0 ? 'Skipper' : 'Crew') };
    });
    const updateVesselRoster = (index: number, change: Partial<VesselCrewPerson>) => {
        const next = crewRosterRows.map((row, i) => (i === index ? { ...row, ...change } : row));
        const patch = { crewRoster: next } as Partial<VesselProfile>;
        if (updateActiveFleetProfile({ profile: patch })) return;
        onSave({ vessel: vesselWithDefaults(patch) });
    };

    const updateVessel = (field: string, value: string | number) => {
        let newEstimatedFields = vessel?.estimatedFields;
        if (newEstimatedFields && newEstimatedFields.includes(field)) {
            newEstimatedFields = newEstimatedFields.filter((f) => f !== field);
        }
        const patch = { estimatedFields: newEstimatedFields, [field]: value } as Partial<VesselProfile>;
        if (updateActiveFleetProfile({ profile: patch })) return;
        onSave({
            vessel: vesselWithDefaults(patch),
        });
    };

    const handleYachtSelect = (entry: PolarDatabaseEntry) => {
        // Update vessel model + LOA. Missing dimensions use explicit rough
        // ratios, and their provenance must survive the save: draft safety
        // code treats a positive value as measured unless estimatedFields says
        // otherwise. A later manual edit clears the flag in updateVessel().
        const currentVessel: Partial<VesselProfile> = vessel || {};
        const estimatedFields = new Set(currentVessel.estimatedFields ?? []);
        const shouldEstimate = (field: 'beam' | 'draft' | 'displacement') =>
            !(Number(currentVessel[field]) > 0) || estimatedFields.has(field);
        const estimateBeam = shouldEstimate('beam');
        const estimateDraft = shouldEstimate('draft');
        const estimateDisplacement = shouldEstimate('displacement');
        if (estimateBeam) estimatedFields.add('beam');
        if (estimateDraft) estimatedFields.add('draft');
        if (estimateDisplacement) estimatedFields.add('displacement');
        estimatedFields.delete('length');

        const nextVessel = vesselWithDefaults({
            beam: estimateBeam ? Math.round(entry.loa * 0.32) : currentVessel.beam,
            draft: estimateDraft ? Math.round(entry.loa * 0.16) : currentVessel.draft,
            displacement: estimateDisplacement ? Math.round(Math.pow(entry.loa, 3) / 2.5) : currentVessel.displacement,
            // Derived from the NEW length, not the old one: picking a
            // different yacht has to move these. The previous
            // `currentVessel.x || …` guards pinned them to whatever the first
            // selection produced, and the local copies also ignored hull type,
            // so a catamaran got a monohull's wave ceiling.
            maxWaveHeight: vesselMaxWaveHeightFt({ ...currentVessel, length: entry.loa, maxWaveHeight: undefined }),
            cruisingSpeed: vesselCruisingSpeedKts({ ...currentVessel, length: entry.loa, cruisingSpeed: undefined }),
            fuelCapacity: currentVessel.fuelCapacity || 0,
            waterCapacity: currentVessel.waterCapacity || 0,
            model: entry.model,
            length: entry.loa,
            estimatedFields: estimatedFields.size > 0 ? [...estimatedFields] : undefined,
        });
        const usedFleetProfile = updateActiveFleetProfile({
            profile: nextVessel,
            polarData: entry.polar,
            setPolarData: true,
            polarBoatModel: entry.model,
            setPolarBoatModel: true,
            polarSourceType: 'database',
            setPolarSourceType: true,
        });
        if (usedFleetProfile) return;
        // Legacy-only fallback. In fleet mode the single patch above updates
        // both the selected vessel and the compatibility view atomically;
        // issuing a second generic-settings write here can race it.
        onSave({
            vessel: nextVessel,
            polarData: entry.polar,
            polarBoatModel: entry.model,
            polarSource_type: 'database',
        });
    };

    const selectFleetVessel = (nextVesselId: string) => {
        const selectActiveVessel = fleetSurface.selectActiveVessel;
        if (!selectActiveVessel || !nextVesselId || nextVesselId === activeVesselId) return;
        void callFleetAction('sync', () => selectActiveVessel(nextVesselId));
    };

    const addFleetVessel = () => {
        const createVesselProfile = fleetSurface.createVesselProfile;
        if (!createVesselProfile || fleet.length >= 5) return;
        void (async () => {
            const result = await callFleetAction('add', () =>
                createVesselProfile(defaultFleetVessel(fleet.length + 1)),
            );
            const createdId = fleetActionResultId(result);
            const selectActiveVessel = fleetSurface.selectActiveVessel;
            if (createdId && selectActiveVessel) {
                await callFleetAction('sync', () => selectActiveVessel(createdId));
            }
        })();
    };

    const archiveFleetVessel = () => {
        const archiveVesselProfile = fleetSurface.archiveVesselProfile;
        if (!archiveCandidate || !archiveVesselProfile || fleet.length <= 1) return;
        const target = archiveCandidate;
        setArchiveCandidate(null);
        void callFleetAction('archive', () => archiveVesselProfile(target.id));
    };

    // ── Release / Undo / MMSI claim (2026-09-08 decision) ─────────────────
    const openReleaseDialog = () => {
        if (!activeFleetVessel || !releaseAvailable) return;
        setFleetActionError(null);
        setReleaseCandidate(activeFleetVessel);
    };

    const releaseFleetVessel = (reason: ReleaseReason) => {
        const release = fleetSurface.releaseVesselProfile;
        const target = releaseCandidate;
        if (!target || !release) return;
        const scope = getAuthIdentityScope();
        void (async () => {
            const result = await callFleetAction('release', () => release(target.id, reason));
            if (!isAuthIdentityScopeCurrent(scope)) return;
            const parsed = releaseResultFromUnknown(result);
            // null: the store refused (tracking, offline, server). Its sentence
            // is already in the dialog via fleetActionError; leave her open.
            if (!parsed) return;
            setReleaseCandidate(null);
            setReleaseOutcome({
                kind: 'released',
                vesselName: target.vessel.name?.trim() || 'Your vessel',
                result: parsed,
            });
        })();
    };

    const undoFleetRelease = (row: ReleasedVesselOption) => {
        const undo = fleetSurface.undoVesselRelease;
        if (!undo) return;
        const scope = getAuthIdentityScope();
        void (async () => {
            const result = await callFleetAction('undo', () => undo(row.boatId));
            if (!isAuthIdentityScopeCurrent(scope)) return;
            const parsed = undoResultFromUnknown(result);
            if (!parsed) return;
            setReleaseOutcome({ kind: 'restored', vesselName: row.name, result: parsed });
        })();
    };

    const saveWithoutMmsi = () => {
        // The existing save path: in fleet mode the store clears the conflict
        // itself when the MMSI changes and the next sync bootstraps her
        // unclaimed; the explicit dismiss covers the legacy onSave fallback.
        updateVessel('mmsi', '');
        fleetSurface.dismissVesselClaimConflict?.();
        setSnoozedConflictKey(null);
        setJoinedCrewOf(null);
    };

    const dismissClaimBanner = () => {
        setSnoozedConflictKey(claimConflictKey);
        fleetSurface.dismissVesselClaimConflict?.();
    };

    const syncFleet = () => {
        const syncVesselFleet = fleetSurface.syncVesselFleet;
        if (!syncVesselFleet) {
            reportFleetError('Fleet cloud sync is not available in this build yet.');
            return;
        }
        void (async () => {
            const result = await callFleetAction('sync', syncVesselFleet);
            if (result === null) return;

            // syncVesselFleet deliberately absorbs a transient network failure
            // and records `offline`/`error` in the store so edits can be
            // replayed later. Read its settled state before displaying a green
            // confirmation; a resolved promise alone does not mean cloud sync
            // actually succeeded.
            const storeWithGetState = useSettingsStore as unknown as {
                getState?: () => FleetStoreSurface;
            };
            const settledStatus = storeWithGetState.getState?.().vesselFleetStatus;
            if (fleetStatusDisplay(settledStatus, true).tone === 'green') showSavedConfirmation();
        })();
    };

    const syncToneClass: Record<FleetStatusDisplay['tone'], string> = {
        green: 'border-emerald-500/20 bg-emerald-500/8 text-emerald-200',
        blue: 'border-sky-500/20 bg-sky-500/8 text-sky-200',
        amber: 'border-amber-500/20 bg-amber-500/8 text-amber-200',
        red: 'border-red-500/20 bg-red-500/8 text-red-200',
        slate: 'border-white/10 bg-white/3 text-slate-300',
    };
    const syncDotClass: Record<FleetStatusDisplay['tone'], string> = {
        green: 'bg-emerald-400',
        blue: 'bg-sky-400 animate-pulse',
        amber: 'bg-amber-400',
        red: 'bg-red-400',
        slate: 'bg-slate-400',
    };
    const selectedFleetId = activeVesselId ?? activeFleetVessel?.id ?? '';

    return (
        <div
            className="w-full max-w-2xl mx-auto animate-in fade-in slide-in-from-right-4 duration-300"
            style={{ paddingBottom: keyboardHeight > 0 ? `${keyboardHeight + 120}px` : 120 }}
        >
            {/* Observer upgrade banner */}
            {isObserver && (
                <div className="mx-4 mb-4 bg-sky-500/6 border border-sky-500/15 rounded-2xl p-4 animate-in fade-in slide-in-from-top-2">
                    <div className="flex items-start gap-3">
                        <EyeIcon className="w-6 h-6 text-sky-300 shrink-0" />
                        <div>
                            <h4 className="text-sm font-bold text-sky-300 mb-1">Crew Member Mode Active</h4>
                            <p className="text-[11px] text-gray-400 leading-relaxed">
                                You're currently in crew member mode — weather only, no vessel features. Select{' '}
                                <strong className="text-white">Sail</strong> or{' '}
                                <strong className="text-white">Power</strong> below to unlock Passage Planning, Polars,
                                and hydrostatics.
                            </p>
                        </div>
                    </div>
                </div>
            )}

            {fleetAvailable && (
                <section className="mx-4 mb-5 rounded-2xl border border-cyan-400/20 bg-linear-to-br from-cyan-500/10 via-slate-950/40 to-slate-950/10 p-4 shadow-[0_12px_32px_rgba(8,145,178,0.08)]">
                    <div className="flex items-start justify-between gap-3">
                        <div>
                            <p className="text-[11px] font-black uppercase tracking-[0.16em] text-cyan-300">
                                Your Fleet
                            </p>
                            <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                                Choose the yacht this device is planning and publishing for. Each profile keeps its own
                                hull, performance and safety details.
                            </p>
                        </div>
                        <span className="shrink-0 rounded-full border border-cyan-300/20 bg-cyan-300/8 px-2.5 py-1 text-[10px] font-black uppercase tracking-wide text-cyan-200">
                            {fleet.length}/5 vessels
                        </span>
                    </div>

                    <div className="mt-4 flex gap-2">
                        <div className="min-w-0 flex-1">
                            <label htmlFor="active-vessel-profile" className="sr-only">
                                Active vessel profile
                            </label>
                            <select
                                id="active-vessel-profile"
                                value={selectedFleetId}
                                onChange={(event) => selectFleetVessel(event.target.value)}
                                disabled={fleet.length === 0 || fleetBusyAction !== null}
                                className="w-full rounded-xl border border-white/10 bg-slate-950/75 px-3 py-3 text-sm font-bold text-white outline-hidden transition-colors focus:border-cyan-400 disabled:cursor-not-allowed disabled:opacity-55"
                            >
                                {!selectedFleetId && <option value="">Select a vessel</option>}
                                {fleet.map((candidate) => {
                                    const candidateName = candidate.vessel.name?.trim() || 'Unnamed vessel';
                                    const type = candidate.vessel.type;
                                    const typeLabel =
                                        type === 'power' ? 'Power' : type === 'observer' ? 'Crew' : 'Sail';
                                    return (
                                        <option key={candidate.id} value={candidate.id}>
                                            {candidateName} · {typeLabel}
                                        </option>
                                    );
                                })}
                            </select>
                        </div>
                        <button
                            type="button"
                            aria-label="Add vessel profile"
                            onClick={addFleetVessel}
                            disabled={
                                fleet.length >= 5 || !fleetSurface.createVesselProfile || fleetBusyAction !== null
                            }
                            title={
                                fleet.length >= 5 ? 'A skipper can keep up to five vessel profiles.' : 'Add a vessel'
                            }
                            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-cyan-300/25 bg-cyan-400/12 px-3 text-xs font-black uppercase tracking-wide text-cyan-100 transition-colors hover:bg-cyan-400/20 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 disabled:cursor-not-allowed disabled:opacity-45"
                        >
                            <PlusSquareIcon className="h-4 w-4" />
                            Add
                        </button>
                    </div>

                    <div
                        className={`mt-3 rounded-xl border px-3 py-2.5 ${syncToneClass[syncStatus.tone]}`}
                        aria-live="polite"
                    >
                        <div className="flex items-center gap-2">
                            <span
                                className={`h-2 w-2 shrink-0 rounded-full ${syncDotClass[syncStatus.tone]}`}
                                aria-hidden="true"
                            />
                            <span className="text-xs font-bold">{syncStatus.label}</span>
                            {syncStatus.busy && (
                                <span className="text-[10px] font-bold uppercase tracking-wide opacity-70">
                                    Please wait
                                </span>
                            )}
                            <button
                                type="button"
                                aria-label="Sync vessel fleet now"
                                onClick={syncFleet}
                                disabled={!fleetSurface.syncVesselFleet || fleetBusyAction !== null || syncStatus.busy}
                                className="hit-target-44 ml-auto inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wide opacity-85 transition-opacity hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                                <RefreshIcon
                                    className={`h-3.5 w-3.5 ${fleetBusyAction === 'sync' ? 'animate-spin' : ''}`}
                                />
                                Sync now
                            </button>
                        </div>
                        {syncStatus.detail && (
                            <p className="mt-1 pl-4 text-[10px] leading-relaxed opacity-75">{syncStatus.detail}</p>
                        )}
                    </div>

                    {fleetActionError && (
                        <p
                            role="alert"
                            className="mt-3 rounded-xl border border-red-400/25 bg-red-500/10 px-3 py-2 text-[11px] leading-relaxed text-red-200"
                        >
                            {fleetActionError}
                        </p>
                    )}

                    {archiveCandidate ? (
                        <div className="mt-3 rounded-xl border border-amber-400/25 bg-amber-500/8 p-3">
                            <p className="text-xs font-bold text-amber-100">
                                Archive {archiveCandidate.vessel.name?.trim() || 'this vessel'}?
                            </p>
                            <p className="mt-1 text-[10px] leading-relaxed text-amber-100/70">
                                Its historic voyages stay intact, but it will no longer be available for new planning or
                                tracking.
                            </p>
                            <div className="mt-3 flex justify-end gap-2">
                                <button
                                    type="button"
                                    onClick={() => setArchiveCandidate(null)}
                                    className="rounded-lg px-3 py-1.5 min-h-[44px] text-[10px] font-black uppercase tracking-wide text-slate-300 hover:bg-white/6"
                                >
                                    Keep
                                </button>
                                <button
                                    type="button"
                                    onClick={archiveFleetVessel}
                                    disabled={fleetBusyAction !== null}
                                    className="rounded-lg border border-red-400/25 bg-red-500/15 px-3 py-1.5 min-h-[44px] text-[10px] font-black uppercase tracking-wide text-red-100 hover:bg-red-500/22 disabled:cursor-not-allowed disabled:opacity-45"
                                >
                                    Archive
                                </button>
                            </div>
                        </div>
                    ) : (
                        activeFleetVessel && (
                            <div className="mt-3">
                                <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
                                    <button
                                        type="button"
                                        aria-label={`Archive ${activeFleetVessel.vessel.name?.trim() || 'active vessel'}`}
                                        onClick={() => setArchiveCandidate(activeFleetVessel)}
                                        disabled={
                                            fleet.length <= 1 ||
                                            !fleetSurface.archiveVesselProfile ||
                                            fleetBusyAction !== null
                                        }
                                        title={
                                            fleet.length <= 1
                                                ? 'Keep at least one vessel profile active.'
                                                : 'Archive this vessel profile'
                                        }
                                        className="inline-flex min-h-[44px] items-center gap-1.5 text-[10px] font-black uppercase tracking-wide text-slate-400 transition-colors hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-40"
                                    >
                                        <TrashIcon className="h-3.5 w-3.5" />
                                        Archive active vessel
                                    </button>
                                    {/* Unlike Archive, Release works on a single-boat fleet: the
                                        sold-only-boat case is exactly what it exists for
                                        (2026-09-08 decision). Its only gates are the store's two
                                        shore-side ones, shown as helper text below. */}
                                    {releaseAvailable && (
                                        <button
                                            type="button"
                                            aria-label={`Release ${activeFleetVessel.vessel.name?.trim() || 'active vessel'}`}
                                            onClick={openReleaseDialog}
                                            disabled={fleetBusyAction !== null || releaseBlockedReason !== null}
                                            title={
                                                releaseBlockedReason ??
                                                'Release this vessel — sold, or a delivery finished'
                                            }
                                            className="inline-flex min-h-[44px] items-center gap-1.5 text-[10px] font-black uppercase tracking-wide text-slate-400 transition-colors hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-40"
                                        >
                                            <AnchorIcon className="h-3.5 w-3.5" />
                                            Release this vessel
                                        </button>
                                    )}
                                </div>
                                {releaseAvailable && releaseBlockedReason && (
                                    <p role="status" className="mt-1 text-[10px] leading-relaxed text-amber-200/85">
                                        {releaseBlockedReason}
                                    </p>
                                )}
                            </div>
                        )
                    )}

                    {/* releaseFlow step 8: the 'oops' path for 30 days. Undo brings the
                        boat back but not crew, Pi or public page — the result dialog says so. */}
                    {releasedVessels.length > 0 && (
                        <ul aria-label="Released vessels" className="mt-3 space-y-2">
                            {releasedVessels.map((row) => (
                                <li
                                    key={row.boatId}
                                    className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/3 px-3 py-2.5"
                                >
                                    <p className="min-w-0 text-[11px] leading-relaxed text-slate-300">
                                        You released <strong className="text-white">{row.name}</strong> on{' '}
                                        {formatReleaseDate(row.releasedAt)} ({releaseReasonLabel(row.releaseReason)})
                                    </p>
                                    <button
                                        type="button"
                                        aria-label={`Undo release of ${row.name}`}
                                        onClick={() => undoFleetRelease(row)}
                                        disabled={fleetBusyAction !== null || !fleetSurface.undoVesselRelease}
                                        className="inline-flex min-h-[44px] shrink-0 items-center gap-1 rounded-lg border border-cyan-300/25 bg-cyan-400/12 px-3 text-[10px] font-black uppercase tracking-wide text-cyan-100 transition-colors hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-45"
                                    >
                                        <RefreshIcon
                                            className={`h-3.5 w-3.5 ${fleetBusyAction === 'undo' ? 'animate-spin' : ''}`}
                                        />
                                        Undo release
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            )}

            {/* Metric inputs intentionally remount when a different boat is selected.
                Their local edit buffers must never carry a half-typed value or a
                display-unit conversion from one vessel into another. */}
            <React.Fragment key={`vessel-form-${selectedFleetId || 'legacy'}`}>
                <Section title="Vessel Configuration">
                    <Row>
                        <div>
                            <label className="text-sm text-white font-medium block">Vessel Type</label>
                        </div>
                        <div className="flex bg-black/40 p-1 rounded-lg border border-white/10">
                            <button
                                aria-label="Set vessel type to sail"
                                onClick={() => updateVessel('type', 'sail')}
                                className={`px-4 py-2 rounded-lg text-xs font-bold uppercase transition-all ${vessel?.type === 'sail' ? 'bg-sky-600 text-white' : 'text-gray-400'}`}
                            >
                                Sail
                            </button>
                            <button
                                aria-label="Set vessel type to power"
                                onClick={() => updateVessel('type', 'power')}
                                className={`px-4 py-2 rounded-lg text-xs font-bold uppercase transition-all ${vessel?.type === 'power' ? 'bg-sky-600 text-white' : 'text-gray-400'}`}
                            >
                                Power
                            </button>
                        </div>
                    </Row>
                    <Row>
                        <div className={`w-full ${isObserver ? 'opacity-40' : ''}`}>
                            <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-2">
                                Vessel Name
                            </label>
                            <input
                                type="text"
                                value={isObserver ? '' : vessel?.name || ''}
                                onChange={(e) => updateVessel('name', e.target.value)}
                                placeholder={isObserver ? 'Select Sail or Power first' : 'e.g. Black Pearl'}
                                disabled={isObserver}
                                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:border-sky-500 outline-hidden text-sm font-medium disabled:cursor-not-allowed"
                            />
                        </div>
                    </Row>
                </Section>

                {/* Vessel Identity */}
                <div className="mx-4 mb-4">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-1 h-4 rounded-full bg-purple-500" />
                        <span className="text-[11px] font-bold text-purple-400 uppercase tracking-widest">
                            Vessel Identity
                        </span>
                    </div>
                    <div className="bg-white/3 border border-white/6 rounded-2xl p-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4">
                            <div>
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                                    Registration No.
                                </label>
                                <input
                                    type="text"
                                    value={vessel?.registration || ''}
                                    onChange={(e) => updateVessel('registration', e.target.value)}
                                    placeholder="e.g. ABC-1234"
                                    className="w-full bg-white/5 border border-white/10 rounded-xl px-2.5 py-2.5 text-white text-sm font-medium outline-hidden transition-colors focus:border-sky-500"
                                />
                            </div>
                            <div>
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                                    MMSI
                                </label>
                                <input
                                    type="text"
                                    inputMode="numeric"
                                    maxLength={9}
                                    value={vessel?.mmsi || ''}
                                    onChange={(e) =>
                                        updateVessel('mmsi', e.target.value.replace(/\D/g, '').slice(0, 9))
                                    }
                                    placeholder="9-digit number"
                                    className="w-full bg-white/5 border border-white/10 rounded-xl px-2.5 py-2.5 text-white text-sm font-medium outline-hidden transition-colors focus:border-sky-500"
                                />
                                {mmsiClaimAdvisory && (
                                    <p role="status" className="mt-1.5 text-[11px] leading-relaxed text-amber-200/90">
                                        Another Thalassa boat already carries this MMSI — your profile keeps it, but she
                                        is claimed by them.
                                    </p>
                                )}
                                {claimConflictSnoozed && claimConflict && (
                                    <p role="status" className="mt-1.5 text-[11px] leading-relaxed text-amber-200/90">
                                        {claimConflict.vesselName} is already on Thalassa with this MMSI — she cannot
                                        join your fleet until you enter a crew code or save without the MMSI.{' '}
                                        <button
                                            type="button"
                                            onClick={() => setSnoozedConflictKey(null)}
                                            className="font-black uppercase tracking-wide text-amber-100 underline-offset-2 hover:underline"
                                        >
                                            Show options
                                        </button>
                                    </p>
                                )}
                            </div>
                            <div>
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                                    Call Sign
                                </label>
                                <input
                                    type="text"
                                    value={vessel?.callSign || ''}
                                    onChange={(e) => updateVessel('callSign', e.target.value.toUpperCase())}
                                    placeholder="e.g. VH2ABC"
                                    className="w-full bg-white/5 border border-white/10 rounded-xl px-2.5 py-2.5 text-white text-sm font-medium outline-hidden transition-colors focus:border-sky-500 uppercase"
                                />
                            </div>
                        </div>
                        <p className="text-[11px] text-gray-400 mt-3">
                            Used for AIS identification and vessel documentation
                        </p>
                    </div>
                </div>

                {/* SAFETY & SAR — entered once here rather than per voyage, then
                    pulled into the float plan. Deliberately NOT shown on the
                    public tracking page: the beacon hex is a credential AMSA
                    verifies against, and raft/flare detail is an inventory of
                    portable gear attached to a live position. */}
                <div className="mx-4 mb-4">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-1 h-4 rounded-full bg-rose-500" />
                        <span className="text-[11px] font-bold text-rose-400 uppercase tracking-widest">
                            Safety &amp; Rescue
                        </span>
                    </div>
                    <div className="bg-white/3 border border-white/6 rounded-2xl p-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4">
                            <div className="sm:col-span-2">
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                                    EPIRB Hex ID
                                </label>
                                <input
                                    type="text"
                                    inputMode="text"
                                    maxLength={15}
                                    value={vessel?.epirbHexId || ''}
                                    onChange={(e) =>
                                        updateVessel(
                                            'epirbHexId',
                                            e.target.value
                                                .toUpperCase()
                                                .replace(/[^0-9A-F]/g, '')
                                                .slice(0, 15),
                                        )
                                    }
                                    placeholder="15 characters, from your AMSA registration"
                                    className="w-full bg-white/5 border border-white/10 rounded-xl px-2.5 py-2.5 text-white text-sm font-mono outline-hidden transition-colors focus:border-rose-500"
                                />
                            </div>
                            <div>
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                                    Liferaft Capacity
                                </label>
                                <input
                                    type="text"
                                    inputMode="numeric"
                                    value={vessel?.liferaftCapacity ? String(vessel.liferaftCapacity) : ''}
                                    onChange={(e) => {
                                        const n = parseInt(e.target.value.replace(/\D/g, ''), 10);
                                        updateVessel('liferaftCapacity', Number.isFinite(n) ? n : 0);
                                    }}
                                    placeholder="persons"
                                    className="w-full bg-white/5 border border-white/10 rounded-xl px-2.5 py-2.5 text-white text-sm font-medium outline-hidden transition-colors focus:border-rose-500"
                                />
                            </div>
                            <div>
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                                    Raft Serviced
                                </label>
                                <input
                                    type="date"
                                    value={vessel?.liferaftServiceDate || ''}
                                    onChange={(e) => updateVessel('liferaftServiceDate', e.target.value)}
                                    className="w-full bg-white/5 border border-white/10 rounded-xl px-2.5 py-2.5 text-white text-sm font-medium outline-hidden transition-colors scheme-dark focus:border-rose-500"
                                />
                            </div>
                            <div>
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                                    Flares Expire
                                </label>
                                <input
                                    type="date"
                                    value={vessel?.flaresExpiry || ''}
                                    onChange={(e) => updateVessel('flaresExpiry', e.target.value)}
                                    className="w-full bg-white/5 border border-white/10 rounded-xl px-2.5 py-2.5 text-white text-sm font-medium outline-hidden transition-colors scheme-dark focus:border-rose-500"
                                />
                            </div>
                        </div>
                        {/* USCG-style SAR identification (2026-08-26): what a
                            search aircraft LOOKS for and how the boat can be
                            raised. Float-plan only; never public. COLLAPSED by
                            default (Shane: 'not compulsory... so as not to
                            overwhelm the punters') — the float plan simply
                            prefills from whatever is here. */}
                        <details className="mt-4 group">
                            <summary className="flex cursor-pointer list-none items-center justify-between rounded-xl border border-white/10 bg-white/3 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
                                <span className="text-xs font-bold text-gray-300 uppercase tracking-widest">
                                    Advanced Boat Details
                                </span>
                                <span className="text-[11px] text-gray-500">
                                    Optional · prefills your float plan
                                    <span className="ml-2 inline-block transition-transform group-open:rotate-180">
                                        ⌄
                                    </span>
                                </span>
                            </summary>
                            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4">
                                <div>
                                    <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                                        Hailing Port
                                    </label>
                                    <input
                                        type="text"
                                        value={vessel?.hailingPort || ''}
                                        onChange={(e) => updateVessel('hailingPort', e.target.value)}
                                        placeholder="Newport, QLD"
                                        className="w-full bg-white/5 border border-white/10 rounded-xl px-2.5 py-2.5 text-white text-sm font-medium outline-hidden transition-colors focus:border-rose-500"
                                    />
                                </div>
                                <div>
                                    <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                                        Hull Material
                                    </label>
                                    <input
                                        type="text"
                                        value={vessel?.hullMaterial || ''}
                                        onChange={(e) => updateVessel('hullMaterial', e.target.value)}
                                        placeholder="fibreglass / steel / aluminium"
                                        className="w-full bg-white/5 border border-white/10 rounded-xl px-2.5 py-2.5 text-white text-sm font-medium outline-hidden transition-colors focus:border-rose-500"
                                    />
                                </div>
                                <div>
                                    <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                                        Trim / Deck Colour
                                    </label>
                                    <input
                                        type="text"
                                        value={vessel?.trimColor || ''}
                                        onChange={(e) => updateVessel('trimColor', e.target.value)}
                                        placeholder="e.g. blue trim, teak decks"
                                        className="w-full bg-white/5 border border-white/10 rounded-xl px-2.5 py-2.5 text-white text-sm font-medium outline-hidden transition-colors focus:border-rose-500"
                                    />
                                </div>
                                <div>
                                    <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                                        Radios Monitored
                                    </label>
                                    <input
                                        type="text"
                                        value={vessel?.radiosMonitored || ''}
                                        onChange={(e) => updateVessel('radiosMonitored', e.target.value)}
                                        placeholder="VHF 16 + 67; HF 8291"
                                        className="w-full bg-white/5 border border-white/10 rounded-xl px-2.5 py-2.5 text-white text-sm font-medium outline-hidden transition-colors focus:border-rose-500"
                                    />
                                </div>
                                <div>
                                    <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                                        Sat Phone
                                    </label>
                                    <input
                                        type="text"
                                        value={vessel?.satPhone || ''}
                                        onChange={(e) => updateVessel('satPhone', e.target.value)}
                                        placeholder="+870 …"
                                        className="w-full bg-white/5 border border-white/10 rounded-xl px-2.5 py-2.5 text-white text-sm font-medium outline-hidden transition-colors focus:border-rose-500"
                                    />
                                </div>
                                <div>
                                    <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                                        Tender / Dinghy
                                    </label>
                                    <input
                                        type="text"
                                        value={vessel?.tenderDescription || ''}
                                        onChange={(e) => updateVessel('tenderDescription', e.target.value)}
                                        placeholder="grey 2.6 m RIB, 5 hp outboard"
                                        className="w-full bg-white/5 border border-white/10 rounded-xl px-2.5 py-2.5 text-white text-sm font-medium outline-hidden transition-colors focus:border-rose-500"
                                    />
                                </div>
                                <div className="sm:col-span-2">
                                    <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                                        Prominent Features
                                    </label>
                                    <input
                                        type="text"
                                        value={vessel?.prominentFeatures || ''}
                                        onChange={(e) => updateVessel('prominentFeatures', e.target.value)}
                                        placeholder="hard dodger, wind generator, tan sail covers"
                                        className="w-full bg-white/5 border border-white/10 rounded-xl px-2.5 py-2.5 text-white text-sm font-medium outline-hidden transition-colors focus:border-rose-500"
                                    />
                                </div>
                                {/* The two people a shore contact rings before escalating. Named
                                    people are the difference between "ask anyone who might have heard"
                                    and something a frightened person can act on at 2am — and this is
                                    the step that heads off most false alarms, because usually somebody
                                    has already heard from the boat. Float plan only, never public. */}
                                <div className="sm:col-span-2">
                                    <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                                        Shore Contact 1
                                    </label>
                                    <input
                                        type="text"
                                        value={vessel?.shoreContact1 || ''}
                                        onChange={(e) => updateVessel('shoreContact1', e.target.value)}
                                        placeholder="Jane Stratton — 0412 345 678"
                                        className="w-full bg-white/5 border border-white/10 rounded-xl px-2.5 py-2.5 text-white text-sm font-medium outline-hidden transition-colors focus:border-rose-500"
                                    />
                                </div>
                                <div className="sm:col-span-2">
                                    <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                                        Shore Contact 2
                                    </label>
                                    <input
                                        type="text"
                                        value={vessel?.shoreContact2 || ''}
                                        onChange={(e) => updateVessel('shoreContact2', e.target.value)}
                                        placeholder="Redcliffe Marina office — 07 3269 1234"
                                        className="w-full bg-white/5 border border-white/10 rounded-xl px-2.5 py-2.5 text-white text-sm font-medium outline-hidden transition-colors focus:border-rose-500"
                                    />
                                </div>
                            </div>
                        </details>
                        <div className="mt-3">
                            <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                                Skipper Mobile
                            </label>
                            <input
                                type="tel"
                                value={vessel?.contactPhone || ''}
                                onChange={(e) => updateVessel('contactPhone', e.target.value)}
                                placeholder="04xx xxx xxx"
                                className="w-full bg-white/5 border border-white/10 rounded-xl px-2.5 py-2.5 text-white text-sm font-medium outline-hidden transition-colors focus:border-rose-500"
                            />
                        </div>
                        <div className="mt-3">
                            <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                                Other Safety Gear
                            </label>
                            <textarea
                                value={vessel?.safetyNotes || ''}
                                onChange={(e) => updateVessel('safetyNotes', e.target.value)}
                                placeholder="PLB ×2, drogue, grab bag, Starlink…"
                                rows={2}
                                className="w-full bg-white/5 border border-white/10 rounded-xl px-2.5 py-2.5 text-white text-sm font-medium outline-hidden transition-colors focus:border-rose-500 resize-none"
                            />
                        </div>
                        <p className="text-[11px] text-gray-400 mt-3">
                            Goes into your float plan, which you send to one person ashore. Never shown on your public
                            page.
                        </p>
                    </div>
                </div>

                <Section title="Hull & Keel">
                    <Row>
                        <div className="w-full">
                            <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-2">
                                Hull Type
                            </label>
                            <div className="flex bg-black/40 p-1 rounded-lg border border-white/10 gap-0.5">
                                {(['monohull', 'catamaran', 'trimaran'] as const).map((ht) => (
                                    <button
                                        aria-label={`Hull type: ${ht}`}
                                        aria-pressed={vessel?.hullType === ht}
                                        key={ht}
                                        onClick={() => updateVessel('hullType', ht)}
                                        className={`flex-1 px-2 py-2 rounded-lg text-xs font-bold uppercase transition-all ${vessel?.hullType === ht ? 'bg-sky-600 text-white' : 'text-gray-400'}`}
                                    >
                                        {ht === 'monohull' ? 'Mono' : ht === 'catamaran' ? 'Cat' : 'Tri'}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </Row>
                    <Row>
                        <div className="w-full">
                            <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-2">
                                Keel Type
                            </label>
                            <div className="grid grid-cols-3 bg-black/40 p-1 rounded-lg border border-white/10 gap-0.5">
                                {(['fin', 'full', 'wing', 'skeg', 'centerboard', 'bilge'] as const).map((kt) => (
                                    <button
                                        aria-label={`Keel type: ${kt}`}
                                        aria-pressed={vessel?.keelType === kt}
                                        key={kt}
                                        onClick={() => updateVessel('keelType', kt)}
                                        className={`px-2 py-2 rounded-lg text-xs font-bold uppercase transition-all ${vessel?.keelType === kt ? 'bg-sky-600 text-white' : 'text-gray-400'}`}
                                    >
                                        {kt === 'centerboard' ? 'C/Board' : kt}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </Row>
                </Section>

                {/* Yacht Database Search — replaces the old Make/Model text input */}
                <div className="mx-4 mb-4">
                    <YachtDatabaseSearch
                        selectedModel={settings.polarBoatModel || vessel?.model}
                        onSelect={handleYachtSelect}
                    />
                    {(vessel?.estimatedFields ?? []).some((field) =>
                        ['beam', 'draft', 'displacement'].includes(field),
                    ) && (
                        <div
                            className="mt-3 rounded-xl border border-amber-400/25 bg-amber-400/10 p-3 text-xs leading-relaxed text-amber-100"
                            role="status"
                        >
                            Amber values are rough estimates derived from vessel length, not manufacturer measurements.
                            Edit a value to replace the estimate. Until then, estimated draft is treated as unknown by
                            depth guidance.
                        </div>
                    )}
                </div>

                {/* Hull Dimensions */}
                <div className="mx-4 mb-4">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-1 h-4 rounded-full bg-sky-500" />
                        <span className="text-[11px] font-bold text-sky-400 uppercase tracking-widest">
                            Hull Dimensions
                        </span>
                    </div>
                    <div className="bg-white/3 border border-white/6 rounded-2xl p-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4">
                            <MetricInput
                                label="Length"
                                valInStandard={vessel?.length || 0}
                                standardUnit="ft"
                                unitType={settings.vesselUnits?.length || 'ft'}
                                unitOptions={['ft', 'm']}
                                onChangeValue={(v) => updateVessel('length', v)}
                                onChangeUnit={(u) => updateVesselUnits({ length: u as LengthUnit })}
                                placeholder="30"
                                isEstimated={vessel?.estimatedFields?.includes('length')}
                            />
                            <MetricInput
                                label="Beam"
                                valInStandard={vessel?.beam || 0}
                                standardUnit="ft"
                                unitType={settings.vesselUnits?.beam || 'ft'}
                                unitOptions={['ft', 'm']}
                                onChangeValue={(v) => updateVessel('beam', v)}
                                onChangeUnit={(u) => updateVesselUnits({ beam: u as LengthUnit })}
                                placeholder="10"
                                isEstimated={vessel?.estimatedFields?.includes('beam')}
                            />
                            <MetricInput
                                label="Draft"
                                valInStandard={vessel?.draft || 0}
                                standardUnit="ft"
                                unitType={settings.vesselUnits?.draft || 'ft'}
                                unitOptions={['ft', 'm']}
                                onChangeValue={(v) => updateVessel('draft', v)}
                                onChangeUnit={(u) => updateVesselUnits({ draft: u as LengthUnit })}
                                placeholder="5"
                                isEstimated={vessel?.estimatedFields?.includes('draft')}
                            />
                            <MetricInput
                                label="Displacement"
                                valInStandard={vessel?.displacement || 0}
                                standardUnit="lbs"
                                unitType={settings.vesselUnits?.displacement || 'lbs'}
                                unitOptions={['lbs', 'kg', 'tonnes']}
                                onChangeValue={(v) => updateVessel('displacement', v)}
                                onChangeUnit={(u) => updateVesselUnits({ displacement: u as WeightUnit })}
                                placeholder="10000"
                                isEstimated={vessel?.estimatedFields?.includes('displacement')}
                            />
                            <MetricInput
                                label="Air Draft"
                                valInStandard={vessel?.airDraft || 0}
                                standardUnit="ft"
                                unitType={settings.vesselUnits?.length || 'ft'}
                                unitOptions={['ft', 'm']}
                                onChangeValue={(v) => updateVessel('airDraft', v)}
                                onChangeUnit={(u) => updateVesselUnits({ length: u as LengthUnit })}
                                placeholder="50"
                            />
                        </div>
                    </div>
                </div>

                {/* Performance (auto-calculated — read-only) */}
                <div className="mx-4 mb-4">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-1 h-4 rounded-full bg-emerald-500" />
                        <span className="text-[11px] font-bold text-emerald-400 uppercase tracking-widest">
                            Performance
                        </span>
                        <span className="text-[11px] text-gray-400 ml-auto">Auto unless you set it</span>
                    </div>
                    <div className="bg-white/3 border border-white/6 rounded-2xl p-4">
                        {/* Derived from LOA and hull type, but OVERRIDABLE: the
                            formulas are a starting guess and the skipper knows
                            the boat. A stored positive value wins in every
                            consumer (see vesselCruisingSpeedKts /
                            vesselMaxWaveHeightFt); storing 0 means "absent", so
                            Reset hands the figure back to the formula. */}
                        <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
                            <div>
                                <MetricInput
                                    label="Cruising Speed"
                                    valInStandard={
                                        Number(vessel?.cruisingSpeed) > 0 ? Number(vessel?.cruisingSpeed) : 0
                                    }
                                    standardUnit="kts"
                                    // Knots only, deliberately. VesselDimensionUnits has no
                                    // speed member, and adding one would ripple through the
                                    // settings store and the fleet profile that owns vessel
                                    // data — for a figure every skipper already thinks about
                                    // in knots.
                                    unitType="kts"
                                    unitOptions={['kts']}
                                    onChangeValue={(v) => updateVessel('cruisingSpeed', v)}
                                    onChangeUnit={() => {}}
                                    placeholder={String(Math.round(vesselCruisingSpeedKts(vessel) * 10) / 10)}
                                />
                                {Number(vessel?.cruisingSpeed) > 0 && (
                                    <button
                                        type="button"
                                        onClick={() => updateVessel('cruisingSpeed', 0)}
                                        className="mt-1.5 min-h-[44px] text-[11px] font-bold text-sky-400 hover:text-sky-300"
                                    >
                                        ↻ Reset to auto (
                                        {Math.round(vesselCruisingSpeedKts({ ...vessel, cruisingSpeed: 0 }) * 10) / 10}{' '}
                                        kts)
                                    </button>
                                )}
                            </div>
                            <div>
                                <MetricInput
                                    label="Max Wave Height"
                                    valInStandard={
                                        Number(vessel?.maxWaveHeight) > 0 ? Number(vessel?.maxWaveHeight) : 0
                                    }
                                    standardUnit="ft"
                                    unitType={settings.vesselUnits?.length || 'ft'}
                                    unitOptions={['ft', 'm']}
                                    onChangeValue={(v) => updateVessel('maxWaveHeight', v)}
                                    onChangeUnit={(u) => updateVesselUnits({ length: u as LengthUnit })}
                                    placeholder={String(Math.round(vesselMaxWaveHeightFt(vessel) * 10) / 10)}
                                />
                                {Number(vessel?.maxWaveHeight) > 0 && (
                                    <button
                                        type="button"
                                        onClick={() => updateVessel('maxWaveHeight', 0)}
                                        className="mt-1.5 min-h-[44px] text-[11px] font-bold text-sky-400 hover:text-sky-300"
                                    >
                                        ↻ Reset to auto (
                                        {Math.round(vesselMaxWaveHeightFt({ ...vessel, maxWaveHeight: 0 }) * 10) / 10}{' '}
                                        ft)
                                    </button>
                                )}
                            </div>
                        </div>
                        <p className="mt-3 text-[11px] text-gray-400">
                            Started from your length and hull type. Type over either one if you know better — the
                            passage planner, ETAs and tide windows all use what you set here.
                        </p>
                    </div>
                </div>

                {/* Comfort Zone — Safety Parameters */}
                <div className="mx-4 mb-4">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-1 h-4 rounded-full bg-red-500" />
                        <span className="text-[11px] font-bold text-red-400 uppercase tracking-widest">
                            Comfort Zone
                        </span>
                        <span className="text-[11px] text-gray-400 ml-auto">Passage Safety Limits</span>
                    </div>
                    <div className="bg-red-500/3 border border-red-500/10 rounded-2xl p-4 space-y-5">
                        <p className="text-[11px] text-gray-400 leading-relaxed">
                            Set your crew's comfort thresholds. The passage planner will route around zones that exceed
                            these limits, treating them as obstacles.
                        </p>

                        {/* Max Wind Speed */}
                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">
                                    Max Wind
                                </label>
                                <span
                                    className={`text-sm font-bold tabular-nums ${(settings.comfortParams?.maxWindKts ?? 60) >= 60 ? 'text-gray-400' : 'text-red-400'}`}
                                >
                                    {(settings.comfortParams?.maxWindKts ?? 60) >= 60
                                        ? 'OFF'
                                        : `${settings.comfortParams?.maxWindKts} kts`}
                                </span>
                            </div>
                            <input
                                type="range"
                                min={10}
                                max={60}
                                step={1}
                                value={settings.comfortParams?.maxWindKts ?? 60}
                                onChange={(e) => {
                                    const v = parseInt(e.target.value);
                                    updateComfortParams({ maxWindKts: v >= 60 ? undefined : v });
                                }}
                                className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-red-500"
                                style={{
                                    background: `linear-gradient(to right, #ef4444 0%, #ef4444 ${(((settings.comfortParams?.maxWindKts ?? 60) - 10) / 50) * 100}%, rgba(255,255,255,0.1) ${(((settings.comfortParams?.maxWindKts ?? 60) - 10) / 50) * 100}%)`,
                                }}
                            />
                            <div className="flex justify-between text-[11px] text-gray-500 mt-1">
                                <span>10 kts</span>
                                <span>25</span>
                                <span>40</span>
                                <span>OFF</span>
                            </div>
                        </div>

                        {/* Max Wave Height */}
                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">
                                    Max Wave Height
                                </label>
                                <span
                                    className={`text-sm font-bold tabular-nums ${(settings.comfortParams?.maxWaveM ?? 8) >= 8 ? 'text-gray-400' : 'text-red-400'}`}
                                >
                                    {(settings.comfortParams?.maxWaveM ?? 8) >= 8
                                        ? 'OFF'
                                        : `${settings.comfortParams?.maxWaveM?.toFixed(1)} m`}
                                </span>
                            </div>
                            <input
                                type="range"
                                min={0.5}
                                max={8}
                                step={0.5}
                                value={settings.comfortParams?.maxWaveM ?? 8}
                                onChange={(e) => {
                                    const v = parseFloat(e.target.value);
                                    updateComfortParams({ maxWaveM: v >= 8 ? undefined : v });
                                }}
                                className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-red-500"
                                style={{
                                    background: `linear-gradient(to right, #ef4444 0%, #ef4444 ${(((settings.comfortParams?.maxWaveM ?? 8) - 0.5) / 7.5) * 100}%, rgba(255,255,255,0.1) ${(((settings.comfortParams?.maxWaveM ?? 8) - 0.5) / 7.5) * 100}%)`,
                                }}
                            />
                            <div className="flex justify-between text-[11px] text-gray-500 mt-1">
                                <span>0.5 m</span>
                                <span>2.5</span>
                                <span>5.0</span>
                                <span>OFF</span>
                            </div>
                        </div>

                        {/* Max Gust */}
                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">
                                    Max Gust
                                </label>
                                <span
                                    className={`text-sm font-bold tabular-nums ${(settings.comfortParams?.maxGustKts ?? 80) >= 80 ? 'text-gray-400' : 'text-red-400'}`}
                                >
                                    {(settings.comfortParams?.maxGustKts ?? 80) >= 80
                                        ? 'OFF'
                                        : `${settings.comfortParams?.maxGustKts} kts`}
                                </span>
                            </div>
                            <input
                                type="range"
                                min={15}
                                max={80}
                                step={1}
                                value={settings.comfortParams?.maxGustKts ?? 80}
                                onChange={(e) => {
                                    const v = parseInt(e.target.value);
                                    updateComfortParams({ maxGustKts: v >= 80 ? undefined : v });
                                }}
                                className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-red-500"
                                style={{
                                    background: `linear-gradient(to right, #ef4444 0%, #ef4444 ${(((settings.comfortParams?.maxGustKts ?? 80) - 15) / 65) * 100}%, rgba(255,255,255,0.1) ${(((settings.comfortParams?.maxGustKts ?? 80) - 15) / 65) * 100}%)`,
                                }}
                            />
                            <div className="flex justify-between text-[11px] text-gray-500 mt-1">
                                <span>15 kts</span>
                                <span>35</span>
                                <span>55</span>
                                <span>OFF</span>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Routing Data Fidelity */}
                <div className="mx-4 mb-4">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-1 h-4 rounded-full bg-cyan-500" />
                        <span className="text-[11px] font-bold text-cyan-400 uppercase tracking-widest">
                            Routing Data
                        </span>
                    </div>
                    <div className="bg-white/3 border border-white/6 rounded-2xl p-4">
                        {/* NRT Currents Toggle —
                        OSCAR near-real-time vs monthly climatology in the
                        isochrone router's set/drift advection. NRT is
                        5-day-old but reflects actual eddies/meanders.
                        Climatology is steady-state monthly averages —
                        good enough for most routes. */}
                        <div className="flex items-start justify-between gap-3">
                            <div className="flex-1 min-w-0">
                                <div className="text-sm font-bold text-white">High-fidelity ocean currents</div>
                                <p className="text-[11px] text-gray-400 mt-0.5">
                                    Use OSCAR near-real-time data (5-day-old, actual eddies) instead of monthly
                                    climatology. Helps on Gulf Stream / Agulhas timing-critical passages.
                                </p>
                            </div>
                            <button
                                type="button"
                                role="switch"
                                aria-checked={settings.currentNrtEnabled === true}
                                aria-label="Toggle high-fidelity ocean currents"
                                onClick={() => onSave({ currentNrtEnabled: !settings.currentNrtEnabled })}
                                className={`hit-target-44 shrink-0 relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-hidden ${
                                    settings.currentNrtEnabled ? 'bg-cyan-500' : 'bg-slate-700'
                                }`}
                            >
                                <span
                                    aria-hidden="true"
                                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${
                                        settings.currentNrtEnabled ? 'translate-x-5' : 'translate-x-0'
                                    }`}
                                />
                            </button>
                        </div>
                    </div>
                </div>

                {/* Capacity */}
                <div className="mx-4 mb-4">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-1 h-4 rounded-full bg-amber-500" />
                        <span className="text-[11px] font-bold text-amber-400 uppercase tracking-widest">Capacity</span>
                    </div>
                    <div className="bg-white/3 border border-white/6 rounded-2xl p-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4">
                            <MetricInput
                                label="Fuel Cap."
                                valInStandard={vessel?.fuelCapacity || 0}
                                standardUnit="gal"
                                unitType={settings.vesselUnits?.volume || 'gal'}
                                unitOptions={['gal', 'l']}
                                onChangeValue={(v) => updateVessel('fuelCapacity', v)}
                                onChangeUnit={(u) => updateVesselUnits({ volume: u as VolumeUnit })}
                                placeholder="0"
                            />
                            <MetricInput
                                label="Water Cap."
                                valInStandard={vessel?.waterCapacity || 0}
                                standardUnit="gal"
                                unitType={settings.vesselUnits?.volume || 'gal'}
                                unitOptions={['gal', 'l']}
                                onChangeValue={(v) => updateVessel('waterCapacity', v)}
                                onChangeUnit={(u) => updateVesselUnits({ volume: u as VolumeUnit })}
                                placeholder="0"
                            />
                        </div>
                        <div className="mt-4">
                            <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                                Crew Aboard (incl. Skipper)
                            </label>
                            <input
                                type="number"
                                min="1"
                                max="99"
                                value={vesselCrewAboard(vessel)}
                                onChange={(e) => updateVessel('crewCount', parseInt(e.target.value) || 2)}
                                placeholder="2"
                                className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm font-medium outline-hidden transition-colors focus:border-sky-500"
                            />
                            <p className="text-[11px] text-gray-400 mt-1">
                                Used for provisioning and watch scheduling in passage plans
                            </p>
                        </div>
                        {/* One row per person aboard — name, age, rank — straight
                            under the count (Shane 2026-09-09: "the same amount of
                            area to add a punters name and age and rank … those
                            names should auto xfer across to the float plan"). The
                            Float Plan seeds its persons roster from these first. */}
                        <div className="mt-3 space-y-2" data-testid="vessel-crew-roster">
                            {crewRosterRows.map((person, index) => (
                                <div
                                    key={index}
                                    className="grid grid-cols-[minmax(0,1fr)_3.75rem_7rem] gap-2 items-center"
                                >
                                    <input
                                        type="text"
                                        aria-label={`Person ${index + 1} name`}
                                        value={person.name}
                                        onChange={(e) => updateVesselRoster(index, { name: e.target.value })}
                                        placeholder={index === 0 ? 'Skipper’s name' : `Person ${index + 1}`}
                                        className="min-w-0 bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm font-medium outline-hidden transition-colors focus:border-sky-500"
                                    />
                                    <input
                                        type="number"
                                        inputMode="numeric"
                                        min="0"
                                        max="120"
                                        aria-label={`Person ${index + 1} age`}
                                        value={
                                            typeof person.age === 'number' && Number.isFinite(person.age)
                                                ? person.age
                                                : ''
                                        }
                                        onChange={(e) => {
                                            const n = parseInt(e.target.value, 10);
                                            updateVesselRoster(index, {
                                                age: Number.isFinite(n) && n > 0 ? n : undefined,
                                            });
                                        }}
                                        placeholder="Age"
                                        className="min-w-0 bg-white/5 border border-white/10 rounded-xl px-2 py-2.5 text-white text-sm font-medium outline-hidden transition-colors focus:border-sky-500 tabular-nums"
                                    />
                                    <select
                                        aria-label={`Person ${index + 1} rank`}
                                        value={person.rank || (index === 0 ? 'Skipper' : 'Crew')}
                                        onChange={(e) => updateVesselRoster(index, { rank: e.target.value })}
                                        className="min-w-0 bg-white/5 border border-white/10 rounded-xl px-2 py-2.5 text-white text-sm font-medium outline-hidden transition-colors focus:border-sky-500"
                                    >
                                        {FLOAT_PLAN_ROLES.map((role) => (
                                            <option key={role} value={role}>
                                                {role}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            ))}
                            <p className="text-[11px] text-gray-400">These names carry across to the Float Plan.</p>
                        </div>
                        {vessel?.type === 'sail' && (
                            <div className="mt-4">
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                                    Closest to the wind (° true)
                                </label>
                                <input
                                    type="number"
                                    min="25"
                                    max="70"
                                    step="1"
                                    value={Number.isFinite(vessel?.closeHauledTwa) ? vessel.closeHauledTwa : ''}
                                    onChange={(e) => {
                                        const n = parseInt(e.target.value, 10);
                                        updateVessel('closeHauledTwa', Number.isFinite(n) ? n : Number.NaN);
                                    }}
                                    placeholder={String(closeHauledDegFor(vessel))}
                                    className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm font-medium outline-hidden transition-colors focus:border-sky-500"
                                />
                                <p className="text-[11px] text-gray-400 mt-1">
                                    The Instrument Panel calls “In irons” and “Pinching” against this. Blank uses the
                                    default for her rig ({closeHauledDegFor(vessel)}°).
                                </p>
                            </div>
                        )}
                    </div>
                </div>
            </React.Fragment>

            {/* Release / Undo / MMSI claim dialogs (2026-09-08 decision). All centred,
                all focus-trapped; nothing here is a toast or a bottom sheet. */}
            {releaseCandidate && (
                <ReleaseVesselDialog
                    isOpen
                    boatId={releaseCandidate.id}
                    vesselName={releaseCandidate.vessel.name?.trim() || 'this vessel'}
                    blockedReason={releaseBlockedReason}
                    busy={fleetBusyAction === 'release'}
                    errorMessage={fleetActionError}
                    onKeep={() => {
                        if (fleetBusyAction !== 'release') setReleaseCandidate(null);
                    }}
                    onRelease={releaseFleetVessel}
                />
            )}
            <ReleaseResultDialog outcome={releaseOutcome} onClose={() => setReleaseOutcome(null)} />
            {claimConflict && !claimConflictSnoozed && (
                <MmsiClaimBanner
                    conflict={claimConflict}
                    joinedCrewOf={joinedCrewOf}
                    busy={fleetBusyAction !== null}
                    onEnterCrewCode={() => setJoinVesselOpen(true)}
                    onSaveWithoutMmsi={saveWithoutMmsi}
                    onDismiss={dismissClaimBanner}
                />
            )}
            {/* JoinVessel paints its own full-screen, centred, focus-trapped form;
                Settings has no other route to it, so it opens here on the nested
                overlay layer above the banner. */}
            {joinVesselOpen && (
                <OverlayPortal layer="nested">
                    <JoinVessel
                        onJoined={(name) => {
                            setJoinVesselOpen(false);
                            setJoinedCrewOf(name);
                        }}
                        onClose={() => setJoinVesselOpen(false)}
                    />
                </OverlayPortal>
            )}
            {/* Save CTA — fixed 8px above the 72px tab bar. In fleet mode this
                is a real cloud flush, not the old cosmetic green state. */}
            <div
                className="fixed left-0 right-0 z-20 px-4"
                style={{
                    bottom: 'calc(72px + 8px + env(safe-area-inset-bottom))',
                }}
            >
                <div className="max-w-2xl mx-auto">
                    <button
                        type="button"
                        aria-label={
                            fleetAvailable ? 'Sync vessel fleet to cloud' : 'Acknowledge locally saved vessel profile'
                        }
                        onClick={() => {
                            void triggerHaptic('medium');
                            if (fleetAvailable) syncFleet();
                            else showSavedConfirmation();
                        }}
                        disabled={
                            fleetAvailable &&
                            (!fleetSurface.syncVesselFleet || fleetBusyAction !== null || syncStatus.busy)
                        }
                        className={`w-full py-3.5 rounded-xl text-sm font-black uppercase tracking-[0.15em] transition-all active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 ${
                            fleetBusyAction === 'sync' || syncStatus.busy
                                ? 'bg-linear-to-r from-sky-700 to-cyan-700 text-white shadow-lg shadow-sky-500/20'
                                : saved && (!fleetAvailable || syncStatus.tone !== 'red')
                                  ? 'bg-linear-to-r from-emerald-600 to-emerald-600 text-white shadow-lg shadow-emerald-500/20'
                                  : 'bg-linear-to-r from-sky-600 to-sky-600 text-white shadow-lg shadow-sky-500/20 hover:from-sky-500 hover:to-sky-500'
                        }`}
                    >
                        {fleetBusyAction === 'sync' || syncStatus.busy ? (
                            <span className="inline-flex items-center gap-1.5 justify-center">
                                <RefreshIcon className="w-4 h-4 animate-spin" />
                                <span>Syncing Fleet</span>
                            </span>
                        ) : saved ? (
                            <span className="inline-flex items-center gap-1.5 justify-center">
                                <CheckIcon className="w-4 h-4" />
                                <span>{fleetAvailable ? 'Cloud Check Complete' : 'Profile Saved Locally'}</span>
                            </span>
                        ) : (
                            <span className="inline-flex items-center gap-1.5 justify-center">
                                {fleetAvailable && <RefreshIcon className="w-4 h-4" />}
                                <span>{fleetAvailable ? 'Sync Vessel Fleet' : 'Profile Saved Locally'}</span>
                            </span>
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
};
