/**
 * VesselTab — Vessel configuration: type, name, dimensions, performance, capacity.
 * Extracted from SettingsModal monolith (63 lines → standalone component).
 */
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { closeHauledDegFor } from '../../services/sailing/pointOfSail';
import { FIELD_LABEL_CLASS, Section, SubSection, Toggle, type SettingsTabProps } from './SettingsPrimitives';
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
                        className="w-full min-h-[44px] rounded-xl py-2 text-xs font-bold uppercase tracking-wide text-slate-400 transition-colors hover:text-slate-200"
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

/** How a stored unit key reads on screen, where the key alone is unclear. */
const UNIT_LABEL: Record<string, string> = { l: 'L' };

// One field language for the whole form (UX scorecard run 7). Selects take the
// Preferences / Clock zone recipe — WebKit ignores a native select's height
// without appearance-none, so the Rank select sat at 23 pt beside a 44 pt Age
// box — and number fields drop the native spinners, as Notifications' value
// wells do.
const FIELD_CLASS =
    'w-full min-w-0 min-h-11 bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm font-medium outline-hidden transition-colors';
const SELECT_CLASS = 'thalassa-select appearance-none cursor-pointer pr-9';
const NO_SPINNER_CLASS =
    '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none';
// The one field-label style (FIELD_LABEL_CLASS, small grey capitals above the
// field) comes from SettingsPrimitives, shared with Preferences: the two pages
// used three label treatments between them (UX scorecard run 8).

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
    autoInStandard,
    decimals = 2,
}: {
    label: string;
    valInStandard: number;
    unitType: string;
    standardUnit: string;
    unitOptions: string[];
    onChangeValue: (v: number) => void;
    onChangeUnit: (u: string) => void;
    /** What an empty field shows. '--', not an example figure: '30' under an
     *  'm' select read as her length (UX scorecard run 7). */
    placeholder?: string;
    isEstimated?: boolean;
    /** The derived figure (in the standard unit) used while nothing is stored.
     *  Shown as the placeholder in the DISPLAY unit, flagged with an "Auto" chip. */
    autoInStandard?: number;
    /** Decimals shown in the display unit. A converted weight is whole kg or
     *  lbs: '6350.29 kg' was a lbs→kg artefact, not a measurement (UX scorecard run 7). */
    decimals?: number;
}) {
    const inputId = useId();
    // Convert from standard (stored) unit → display unit
    const toDisplay = UNIT_CONVERSIONS[standardUnit]?.[unitType];
    const displayVal = toDisplay ? toDisplay(valInStandard) : valInStandard;
    // No length yet means nothing to derive from: say '--', not a made-up 0.
    const hasAuto = autoInStandard !== undefined && autoInStandard > 0;
    const isAuto = hasAuto && !(valInStandard > 0);
    const autoPlaceholder =
        autoInStandard === undefined
            ? undefined
            : hasAuto
              ? String(Math.round((toDisplay ? toDisplay(autoInStandard) : autoInStandard) * 10) / 10)
              : '--';

    const scale = 10 ** decimals;
    const shownVal = displayVal > 0 ? String(Math.round(displayVal * scale) / scale) : '';
    const [localVal, setLocalVal] = useState(shownVal);
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
        setLocalVal((prev) => (prev === shownVal ? prev : shownVal));
    }, [shownVal]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => setLocalVal(e.target.value);

    const handleBlur = () => {
        isFocusedRef.current = false;
        const numericVal = parseFloat(localVal);
        if (isNaN(numericVal)) return;
        // Untouched: hand back the stored figure, not a round trip through the
        // rounded one on screen — a whole-kg display must not nudge stored lbs.
        if (localVal === shownVal) {
            onChangeValue(valInStandard);
            return;
        }
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
            <label
                htmlFor={inputId}
                className="text-xs font-bold text-gray-400 uppercase tracking-wider flex flex-wrap items-center gap-1.5 mb-1.5"
            >
                {label}
                {isEstimated && <span className="text-amber-400/70 text-xs normal-case tracking-normal">(est.)</span>}
                {/* The placeholder alone read as a typed value in a disabled field. */}
                {isAuto && (
                    <span
                        id={`${inputId}-auto`}
                        className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-1.5 text-xs font-bold normal-case tracking-normal text-emerald-300"
                    >
                        Auto
                    </span>
                )}
            </label>
            <div className="flex gap-1.5 min-w-0">
                <input
                    id={inputId}
                    aria-label={label}
                    aria-describedby={
                        [isAuto ? `${inputId}-auto` : '', unitOptions.length > 1 ? '' : `${inputId}-unit`]
                            .filter(Boolean)
                            .join(' ') || undefined
                    }
                    type="number"
                    inputMode="decimal"
                    value={localVal}
                    onFocus={() => {
                        isFocusedRef.current = true;
                    }}
                    onChange={handleChange}
                    onBlur={handleBlur}
                    placeholder={autoPlaceholder ?? placeholder}
                    className={`flex-1 min-w-0 min-h-11 bg-white/5 border rounded-xl px-2.5 py-2.5 text-white text-sm font-medium outline-hidden transition-colors ${NO_SPINNER_CLASS} ${isEstimated ? 'border-amber-500/30 focus:border-amber-400' : 'border-white/10 focus:border-sky-500'}`}
                />
                {unitOptions.length > 1 ? (
                    <select
                        aria-label={`${label} unit`}
                        value={unitType}
                        onChange={(e) => onChangeUnit(e.target.value)}
                        className={`${SELECT_CLASS} min-h-11 shrink-0 bg-white/5 border border-white/10 rounded-xl pl-2.5 text-sm text-gray-300 font-bold outline-hidden focus:border-sky-500`}
                    >
                        {/* Units in their own case — 'kg', 'm', 'L' — not 'KG' beside a
                            lower-case 'kts' suffix. */}
                        {unitOptions.map((u) => (
                            <option key={u} value={u}>
                                {UNIT_LABEL[u] ?? u}
                            </option>
                        ))}
                    </select>
                ) : (
                    // One unit is a fact, not a choice: a static suffix, no picker chevrons.
                    <span
                        id={`${inputId}-unit`}
                        className="flex min-h-11 shrink-0 items-center px-1.5 text-sm font-bold text-gray-400"
                    >
                        {UNIT_LABEL[unitType] ?? unitType}
                    </span>
                )}
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
    // Ties each visible label to its field (htmlFor / id) so no field is named by its placeholder.
    const fid = useId();

    // A unit select with nothing stored yet follows Settings → Preferences →
    // Units instead of a hard 'ft'. Display only: stored figures stay ft / lbs /
    // gal, and nothing is written until the skipper picks a unit.
    const lengthUnit = settings.vesselUnits?.length || settings.units?.length || 'ft';
    const beamUnit = settings.vesselUnits?.beam || settings.units?.length || 'ft';
    const draftUnit = settings.vesselUnits?.draft || settings.units?.length || 'ft';
    const displacementUnit = settings.vesselUnits?.displacement || (settings.units?.length === 'm' ? 'kg' : 'lbs');
    const volumeUnit = settings.vesselUnits?.volume || settings.units?.volume || 'gal';
    // The hull wave limit's select writes the vessel LENGTH unit (as before);
    // until one is chosen it follows the Seas preference, like the Comfort Zone.
    const hullWaveUnit = settings.vesselUnits?.length || settings.units?.waveHeight || 'ft';
    const hullWaveAutoFt = vesselMaxWaveHeightFt({ ...vessel, maxWaveHeight: 0 });
    // The Reset hint speaks the unit beside the field (it used to say 'ft' under a metre select).
    const hullWaveAutoDisplay = Math.round((hullWaveUnit === 'm' ? hullWaveAutoFt * 0.3048 : hullWaveAutoFt) * 10) / 10;

    // Local profile: every edit is already on the phone, so the page says so
    // for a moment after each one — a slim status line, not a bar that looked
    // like a Save button and only re-showed its own label (UX scorecard run 7).
    const [localSaved, setLocalSaved] = useState(false);
    const localSavedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(
        () => () => {
            if (savedTimer.current) clearTimeout(savedTimer.current);
            if (localSavedTimer.current) clearTimeout(localSavedTimer.current);
        },
        [],
    );

    const showSavedConfirmation = useCallback(() => {
        setSaved(true);
        if (savedTimer.current) clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setSaved(false), 2600);
    }, []);

    /** onSave, plus the transient "Saved on this phone" line. */
    const saveLocally = useCallback(
        (patch: Parameters<typeof onSave>[0]) => {
            onSave(patch);
            setLocalSaved(true);
            if (localSavedTimer.current) clearTimeout(localSavedTimer.current);
            localSavedTimer.current = setTimeout(() => setLocalSaved(false), 2600);
        },
        [onSave],
    );

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
            saveLocally({
                vesselUnits: {
                    ...settings.vesselUnits,
                    ...patch,
                } as VesselDimensionUnits,
            });
        },
        [saveLocally, settings.vesselUnits, updateActiveFleetProfile],
    );

    const updateComfortParams = useCallback(
        (patch: Partial<ComfortParams>) => {
            if (updateActiveFleetProfile({ comfortParams: patch })) return;
            saveLocally({ comfortParams: { ...settings.comfortParams, ...patch } });
        },
        [saveLocally, settings.comfortParams, updateActiveFleetProfile],
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

    const crewAboard = vesselCrewAboard(vessel);
    /** One row per person aboard, padded to the crew count (rank defaults: Skipper first, Crew after). */
    const crewRosterRows: VesselCrewPerson[] = Array.from({ length: vesselCrewAboard(vessel) }, (_, i) => {
        const row = vessel?.crewRoster?.[i];
        return { name: row?.name ?? '', age: row?.age, rank: row?.rank || (i === 0 ? 'Skipper' : 'Crew') };
    });
    const updateVesselRoster = (index: number, change: Partial<VesselCrewPerson>) => {
        const next = crewRosterRows.map((row, i) => (i === index ? { ...row, ...change } : row));
        const patch = { crewRoster: next } as Partial<VesselProfile>;
        if (updateActiveFleetProfile({ profile: patch })) return;
        saveLocally({ vessel: vesselWithDefaults(patch) });
    };

    const updateVessel = (field: string, value: string | number) => {
        let newEstimatedFields = vessel?.estimatedFields;
        if (newEstimatedFields && newEstimatedFields.includes(field)) {
            newEstimatedFields = newEstimatedFields.filter((f) => f !== field);
        }
        const patch = { estimatedFields: newEstimatedFields, [field]: value } as Partial<VesselProfile>;
        if (updateActiveFleetProfile({ profile: patch })) return;
        saveLocally({
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
        saveLocally({
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

    const comfortWind = settings.comfortParams?.maxWindKts ?? 60;
    const comfortWave = settings.comfortParams?.maxWaveM ?? 8;
    const comfortGust = settings.comfortParams?.maxGustKts ?? 80;

    return (
        <div
            // No entry animation here: `animate-in` leaves a transform on the wrapper,
            // which makes it the containing block for the FIXED bars below — the
            // bar then scrolled away with the form (UX scorecard 2026-09-25).
            // SettingsModal's scroller ends at the tab bar and pads 80px. In fleet
            // mode the fixed sync bar (80px + safe area up, ~64px tall, 16px top
            // fade) overlaps that port by ~95px, so the last field needs 24px more
            // to clear it; the local profile has no bar and needs nothing extra.
            className={`w-full max-w-2xl mx-auto ${fleetAvailable ? 'pb-6' : ''}`}
            style={keyboardHeight > 0 ? { paddingBottom: `${keyboardHeight + 120}px` } : undefined}
        >
            {/* Observer upgrade banner */}
            {isObserver && (
                <div className="mb-6 bg-sky-500/6 border border-sky-500/15 rounded-2xl p-4 animate-in fade-in slide-in-from-top-2">
                    <div className="flex items-start gap-3">
                        <EyeIcon className="w-6 h-6 text-sky-300 shrink-0" />
                        <div>
                            <p className="text-sm font-bold text-sky-300 mb-1">Crew member mode</p>
                            <p className="text-xs text-gray-400 leading-relaxed">
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
                <Section title="Your fleet">
                    <div className="p-4">
                        <div className="flex items-start justify-between gap-3">
                            <p className="text-xs leading-relaxed text-gray-400">
                                Choose the yacht this device is planning and publishing for. Each profile keeps its own
                                hull, performance and safety details.
                            </p>
                            <span className="shrink-0 rounded-full border border-cyan-300/20 bg-cyan-300/8 px-2.5 py-1 text-xs font-bold text-cyan-200">
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
                                    className={`${FIELD_CLASS} ${SELECT_CLASS} font-bold focus:border-cyan-400 disabled:cursor-not-allowed disabled:opacity-55`}
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
                                    fleet.length >= 5
                                        ? 'A skipper can keep up to five vessel profiles.'
                                        : 'Add a vessel'
                                }
                                className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl border border-cyan-300/25 bg-cyan-400/12 px-3 text-sm font-bold text-cyan-100 transition-colors hover:bg-cyan-400/20 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 disabled:cursor-not-allowed disabled:opacity-45"
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
                                {syncStatus.busy && <span className="text-xs font-bold opacity-80">Please wait</span>}
                                <button
                                    type="button"
                                    aria-label="Sync vessel fleet now"
                                    onClick={syncFleet}
                                    disabled={
                                        !fleetSurface.syncVesselFleet || fleetBusyAction !== null || syncStatus.busy
                                    }
                                    className="hit-target-44 ml-auto inline-flex items-center gap-1 text-xs font-bold opacity-90 transition-opacity hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                    <RefreshIcon
                                        className={`h-3.5 w-3.5 ${fleetBusyAction === 'sync' ? 'animate-spin' : ''}`}
                                    />
                                    Sync now
                                </button>
                            </div>
                            {syncStatus.detail && (
                                <p className="mt-1 pl-4 text-xs leading-relaxed opacity-80">{syncStatus.detail}</p>
                            )}
                        </div>

                        {fleetActionError && (
                            <p
                                role="alert"
                                className="mt-3 rounded-xl border border-red-400/25 bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-200"
                            >
                                {fleetActionError}
                            </p>
                        )}

                        {archiveCandidate ? (
                            <div className="mt-3 rounded-xl border border-amber-400/25 bg-amber-500/8 p-3">
                                <p className="text-xs font-bold text-amber-100">
                                    Archive {archiveCandidate.vessel.name?.trim() || 'this vessel'}?
                                </p>
                                <p className="mt-1 text-xs leading-relaxed text-amber-100/80">
                                    Its historic voyages stay intact, but it will no longer be available for new
                                    planning or tracking.
                                </p>
                                <div className="mt-3 flex justify-end gap-2">
                                    <button
                                        type="button"
                                        onClick={() => setArchiveCandidate(null)}
                                        className="rounded-lg px-3 py-1.5 min-h-[44px] text-sm font-bold text-slate-300 hover:bg-white/6"
                                    >
                                        Keep
                                    </button>
                                    <button
                                        type="button"
                                        onClick={archiveFleetVessel}
                                        disabled={fleetBusyAction !== null}
                                        className="rounded-lg border border-red-400/25 bg-red-500/15 px-3 py-1.5 min-h-[44px] text-sm font-bold text-red-100 hover:bg-red-500/22 disabled:cursor-not-allowed disabled:opacity-45"
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
                                            className="inline-flex min-h-[44px] items-center gap-1.5 text-xs font-bold text-slate-400 transition-colors hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-40"
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
                                                className="inline-flex min-h-[44px] items-center gap-1.5 text-xs font-bold text-slate-400 transition-colors hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-40"
                                            >
                                                <AnchorIcon className="h-3.5 w-3.5" />
                                                Release this vessel
                                            </button>
                                        )}
                                    </div>
                                    {releaseAvailable && releaseBlockedReason && (
                                        <p role="status" className="mt-1 text-xs leading-relaxed text-amber-200/90">
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
                                        <p className="min-w-0 text-xs leading-relaxed text-slate-300">
                                            You released <strong className="text-white">{row.name}</strong> on{' '}
                                            {formatReleaseDate(row.releasedAt)} ({releaseReasonLabel(row.releaseReason)}
                                            )
                                        </p>
                                        <button
                                            type="button"
                                            aria-label={`Undo release of ${row.name}`}
                                            onClick={() => undoFleetRelease(row)}
                                            disabled={fleetBusyAction !== null || !fleetSurface.undoVesselRelease}
                                            className="inline-flex min-h-[44px] shrink-0 items-center gap-1 rounded-lg border border-cyan-300/25 bg-cyan-400/12 px-3 text-xs font-bold text-cyan-100 transition-colors hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-45"
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
                    </div>
                </Section>
            )}

            {/* Metric inputs intentionally remount when a different boat is selected.
                Their local edit buffers must never carry a half-typed value or a
                display-unit conversion from one vessel into another.

                Five groups, every one a shared Section (one heading style, one card
                width) with h3 sub-sections inside, in the order a skipper fills
                them in: the boat, her safety kit, her hull, the limits the router
                keeps, then tanks and crew. The hand-built blocks used to be inset
                16 pt with a different coloured bar each (UX scorecard run 7). */}
            <React.Fragment key={`vessel-form-${selectedFleetId || 'legacy'}`}>
                <Section title="Boat & identity">
                    <SubSection>
                        <div className="flex items-center justify-between gap-4">
                            <p id={`${fid}-type`} className="text-xs font-bold text-gray-400 uppercase tracking-wider">
                                Vessel type
                            </p>
                            <div
                                role="group"
                                aria-labelledby={`${fid}-type`}
                                className="flex bg-black/40 p-1 rounded-lg border border-white/10"
                            >
                                {/* Named by the word on the button ('Sail'); the group's
                                    label says what it sets, aria-pressed which is on. */}
                                <button
                                    type="button"
                                    aria-pressed={vessel?.type === 'sail'}
                                    onClick={() => updateVessel('type', 'sail')}
                                    className={`min-h-11 min-w-16 px-4 rounded-lg text-xs font-bold uppercase transition-all ${vessel?.type === 'sail' ? 'bg-sky-600 text-white' : 'text-gray-400'}`}
                                >
                                    Sail
                                </button>
                                <button
                                    type="button"
                                    aria-pressed={vessel?.type === 'power'}
                                    onClick={() => updateVessel('type', 'power')}
                                    className={`min-h-11 min-w-16 px-4 rounded-lg text-xs font-bold uppercase transition-all ${vessel?.type === 'power' ? 'bg-sky-600 text-white' : 'text-gray-400'}`}
                                >
                                    Power
                                </button>
                            </div>
                        </div>
                        <div className={`mt-4 ${isObserver ? 'opacity-40' : ''}`}>
                            <label htmlFor={`${fid}-name`} className={FIELD_LABEL_CLASS}>
                                Vessel name
                            </label>
                            <input
                                id={`${fid}-name`}
                                type="text"
                                value={isObserver ? '' : vessel?.name || ''}
                                onChange={(e) => updateVessel('name', e.target.value)}
                                placeholder={isObserver ? 'Select Sail or Power first' : 'e.g. Black Pearl'}
                                disabled={isObserver}
                                className={`${FIELD_CLASS} focus:border-sky-500 disabled:cursor-not-allowed`}
                            />
                        </div>
                    </SubSection>

                    <SubSection title="Identity">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4">
                            <div>
                                <label htmlFor={`${fid}-registration`} className={FIELD_LABEL_CLASS}>
                                    Registration No.
                                </label>
                                <input
                                    id={`${fid}-registration`}
                                    type="text"
                                    value={vessel?.registration || ''}
                                    onChange={(e) => updateVessel('registration', e.target.value)}
                                    placeholder="e.g. ABC-1234"
                                    className={`${FIELD_CLASS} focus:border-sky-500`}
                                />
                            </div>
                            <div>
                                <label htmlFor={`${fid}-mmsi`} className={FIELD_LABEL_CLASS}>
                                    MMSI
                                </label>
                                <input
                                    id={`${fid}-mmsi`}
                                    type="text"
                                    inputMode="numeric"
                                    maxLength={9}
                                    value={vessel?.mmsi || ''}
                                    onChange={(e) =>
                                        updateVessel('mmsi', e.target.value.replace(/\D/g, '').slice(0, 9))
                                    }
                                    placeholder="9-digit number"
                                    className={`${FIELD_CLASS} focus:border-sky-500`}
                                />
                                {mmsiClaimAdvisory && (
                                    <p role="status" className="mt-1.5 text-xs leading-relaxed text-amber-200/90">
                                        Another Thalassa boat already carries this MMSI — your profile keeps it, but she
                                        is claimed by them.
                                    </p>
                                )}
                                {claimConflictSnoozed && claimConflict && (
                                    <p role="status" className="mt-1.5 text-xs leading-relaxed text-amber-200/90">
                                        {claimConflict.vesselName} is already on Thalassa with this MMSI — she cannot
                                        join your fleet until you enter a crew code or save without the MMSI.{' '}
                                        <button
                                            type="button"
                                            onClick={() => setSnoozedConflictKey(null)}
                                            className="min-h-11 font-bold text-amber-100 underline underline-offset-2"
                                        >
                                            Show options
                                        </button>
                                    </p>
                                )}
                            </div>
                            <div>
                                <label htmlFor={`${fid}-callsign`} className={FIELD_LABEL_CLASS}>
                                    Call sign
                                </label>
                                {/* The value is stored in capitals; the example stays as typed
                                    ('e.g. VH2ABC', not 'E.G. VH2ABC'). */}
                                <input
                                    id={`${fid}-callsign`}
                                    type="text"
                                    value={vessel?.callSign || ''}
                                    onChange={(e) => updateVessel('callSign', e.target.value.toUpperCase())}
                                    placeholder="e.g. VH2ABC"
                                    className={`${FIELD_CLASS} focus:border-sky-500 uppercase placeholder:normal-case`}
                                />
                            </div>
                        </div>
                        <p className="text-xs text-gray-400 mt-3">
                            Used for AIS identification and vessel documentation
                        </p>
                    </SubSection>
                </Section>

                {/* SAFETY & SAR — entered once here rather than per voyage, then
                    pulled into the float plan. Deliberately NOT shown on the
                    public tracking page: the beacon hex is a credential AMSA
                    verifies against, and raft/flare detail is an inventory of
                    portable gear attached to a live position. */}
                <Section title="Safety & rescue">
                    <SubSection>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4">
                            <div className="sm:col-span-2">
                                <label htmlFor={`${fid}-epirb`} className={FIELD_LABEL_CLASS}>
                                    EPIRB Hex ID
                                </label>
                                <input
                                    id={`${fid}-epirb`}
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
                                    placeholder="15 characters, from AMSA"
                                    className={`${FIELD_CLASS} font-mono placeholder:font-sans focus:border-rose-500`}
                                />
                            </div>
                            <div>
                                <label htmlFor={`${fid}-raftcap`} className={FIELD_LABEL_CLASS}>
                                    Liferaft capacity
                                </label>
                                <input
                                    id={`${fid}-raftcap`}
                                    type="text"
                                    inputMode="numeric"
                                    value={vessel?.liferaftCapacity ? String(vessel.liferaftCapacity) : ''}
                                    onChange={(e) => {
                                        const n = parseInt(e.target.value.replace(/\D/g, ''), 10);
                                        updateVessel('liferaftCapacity', Number.isFinite(n) ? n : 0);
                                    }}
                                    placeholder="persons"
                                    className={`${FIELD_CLASS} focus:border-rose-500`}
                                />
                            </div>
                            <div>
                                <label htmlFor={`${fid}-raftserviced`} className={FIELD_LABEL_CLASS}>
                                    Raft serviced
                                </label>
                                <input
                                    id={`${fid}-raftserviced`}
                                    type="date"
                                    value={vessel?.liferaftServiceDate || ''}
                                    onChange={(e) => updateVessel('liferaftServiceDate', e.target.value)}
                                    className={`${FIELD_CLASS} scheme-dark focus:border-rose-500`}
                                />
                            </div>
                            <div>
                                <label htmlFor={`${fid}-flares`} className={FIELD_LABEL_CLASS}>
                                    Flares expire
                                </label>
                                <input
                                    id={`${fid}-flares`}
                                    type="date"
                                    value={vessel?.flaresExpiry || ''}
                                    onChange={(e) => updateVessel('flaresExpiry', e.target.value)}
                                    className={`${FIELD_CLASS} scheme-dark focus:border-rose-500`}
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
                            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/3 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
                                <span className="text-xs font-bold text-gray-300 uppercase tracking-widest">
                                    Advanced Boat Details
                                </span>
                                <span className="inline-flex items-center gap-2 text-xs text-gray-400">
                                    Optional · prefills your float plan
                                    <svg
                                        aria-hidden="true"
                                        className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={2}
                                    >
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
                                    </svg>
                                </span>
                            </summary>
                            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4">
                                <div>
                                    <label htmlFor={`${fid}-hailing`} className={FIELD_LABEL_CLASS}>
                                        Hailing port
                                    </label>
                                    <input
                                        id={`${fid}-hailing`}
                                        type="text"
                                        value={vessel?.hailingPort || ''}
                                        onChange={(e) => updateVessel('hailingPort', e.target.value)}
                                        placeholder="Newport, QLD"
                                        className={`${FIELD_CLASS} focus:border-rose-500`}
                                    />
                                </div>
                                <div>
                                    <label htmlFor={`${fid}-hullmaterial`} className={FIELD_LABEL_CLASS}>
                                        Hull material
                                    </label>
                                    <input
                                        id={`${fid}-hullmaterial`}
                                        type="text"
                                        value={vessel?.hullMaterial || ''}
                                        onChange={(e) => updateVessel('hullMaterial', e.target.value)}
                                        placeholder="fibreglass / steel / aluminium"
                                        className={`${FIELD_CLASS} focus:border-rose-500`}
                                    />
                                </div>
                                <div>
                                    <label htmlFor={`${fid}-trim`} className={FIELD_LABEL_CLASS}>
                                        Trim / deck colour
                                    </label>
                                    <input
                                        id={`${fid}-trim`}
                                        type="text"
                                        value={vessel?.trimColor || ''}
                                        onChange={(e) => updateVessel('trimColor', e.target.value)}
                                        placeholder="e.g. blue trim, teak decks"
                                        className={`${FIELD_CLASS} focus:border-rose-500`}
                                    />
                                </div>
                                <div>
                                    <label htmlFor={`${fid}-radios`} className={FIELD_LABEL_CLASS}>
                                        Radios monitored
                                    </label>
                                    <input
                                        id={`${fid}-radios`}
                                        type="text"
                                        value={vessel?.radiosMonitored || ''}
                                        onChange={(e) => updateVessel('radiosMonitored', e.target.value)}
                                        placeholder="VHF 16 + 67; HF 8291"
                                        className={`${FIELD_CLASS} focus:border-rose-500`}
                                    />
                                </div>
                                <div>
                                    <label htmlFor={`${fid}-satphone`} className={FIELD_LABEL_CLASS}>
                                        Sat phone
                                    </label>
                                    <input
                                        id={`${fid}-satphone`}
                                        type="text"
                                        value={vessel?.satPhone || ''}
                                        onChange={(e) => updateVessel('satPhone', e.target.value)}
                                        placeholder="+870 …"
                                        className={`${FIELD_CLASS} focus:border-rose-500`}
                                    />
                                </div>
                                <div>
                                    <label htmlFor={`${fid}-tender`} className={FIELD_LABEL_CLASS}>
                                        Tender / dinghy
                                    </label>
                                    <input
                                        id={`${fid}-tender`}
                                        type="text"
                                        value={vessel?.tenderDescription || ''}
                                        onChange={(e) => updateVessel('tenderDescription', e.target.value)}
                                        placeholder="grey 2.6 m RIB, 5 hp outboard"
                                        className={`${FIELD_CLASS} focus:border-rose-500`}
                                    />
                                </div>
                                <div className="sm:col-span-2">
                                    <label htmlFor={`${fid}-features`} className={FIELD_LABEL_CLASS}>
                                        Prominent features
                                    </label>
                                    <input
                                        id={`${fid}-features`}
                                        type="text"
                                        value={vessel?.prominentFeatures || ''}
                                        onChange={(e) => updateVessel('prominentFeatures', e.target.value)}
                                        placeholder="hard dodger, wind generator, tan sail covers"
                                        className={`${FIELD_CLASS} focus:border-rose-500`}
                                    />
                                </div>
                                {/* The two people a shore contact rings before escalating. Named
                                    people are the difference between "ask anyone who might have heard"
                                    and something a frightened person can act on at 2am — and this is
                                    the step that heads off most false alarms, because usually somebody
                                    has already heard from the boat. Float plan only, never public. */}
                                <div className="sm:col-span-2">
                                    <label htmlFor={`${fid}-shore1`} className={FIELD_LABEL_CLASS}>
                                        Shore contact 1
                                    </label>
                                    <input
                                        id={`${fid}-shore1`}
                                        type="text"
                                        value={vessel?.shoreContact1 || ''}
                                        onChange={(e) => updateVessel('shoreContact1', e.target.value)}
                                        placeholder="Jane Stratton — 0412 345 678"
                                        className={`${FIELD_CLASS} focus:border-rose-500`}
                                    />
                                </div>
                                <div className="sm:col-span-2">
                                    <label htmlFor={`${fid}-shore2`} className={FIELD_LABEL_CLASS}>
                                        Shore contact 2
                                    </label>
                                    <input
                                        id={`${fid}-shore2`}
                                        type="text"
                                        value={vessel?.shoreContact2 || ''}
                                        onChange={(e) => updateVessel('shoreContact2', e.target.value)}
                                        placeholder="Redcliffe Marina office — 07 3269 1234"
                                        className={`${FIELD_CLASS} focus:border-rose-500`}
                                    />
                                </div>
                            </div>
                        </details>
                        <div className="mt-4">
                            <label htmlFor={`${fid}-mobile`} className={FIELD_LABEL_CLASS}>
                                Skipper mobile
                            </label>
                            <input
                                id={`${fid}-mobile`}
                                type="tel"
                                value={vessel?.contactPhone || ''}
                                onChange={(e) => updateVessel('contactPhone', e.target.value)}
                                placeholder="04xx xxx xxx"
                                className={`${FIELD_CLASS} focus:border-rose-500`}
                            />
                        </div>
                        <div className="mt-4">
                            <label htmlFor={`${fid}-safetygear`} className={FIELD_LABEL_CLASS}>
                                Other safety gear
                            </label>
                            <textarea
                                id={`${fid}-safetygear`}
                                value={vessel?.safetyNotes || ''}
                                onChange={(e) => updateVessel('safetyNotes', e.target.value)}
                                placeholder="PLB ×2, drogue, grab bag, Starlink…"
                                rows={2}
                                className={`${FIELD_CLASS} focus:border-rose-500 resize-none`}
                            />
                        </div>
                        <p className="text-xs text-gray-400 mt-3">
                            Goes into your float plan, which you send to one person ashore. Never shown on your public
                            page.
                        </p>
                    </SubSection>
                </Section>

                <Section title="Hull & performance">
                    <SubSection title="Hull & keel">
                        <p id={`${fid}-hull`} className={FIELD_LABEL_CLASS}>
                            Hull type
                        </p>
                        <div
                            role="group"
                            aria-labelledby={`${fid}-hull`}
                            className="flex bg-black/40 p-1 rounded-lg border border-white/10 gap-0.5"
                        >
                            {(['monohull', 'catamaran', 'trimaran'] as const).map((ht) => (
                                <button
                                    type="button"
                                    aria-label={
                                        ht === 'monohull' ? 'Monohull' : ht === 'catamaran' ? 'Catamaran' : 'Trimaran'
                                    }
                                    aria-pressed={vessel?.hullType === ht}
                                    key={ht}
                                    onClick={() => updateVessel('hullType', ht)}
                                    className={`flex-1 min-h-11 px-2 py-2 rounded-lg text-xs font-bold transition-all ${vessel?.hullType === ht ? 'bg-sky-600 text-white' : 'text-gray-400'}`}
                                >
                                    {ht === 'monohull' ? 'Mono' : ht === 'catamaran' ? 'Cat' : 'Tri'}
                                </button>
                            ))}
                        </div>
                        <p id={`${fid}-keel`} className={`${FIELD_LABEL_CLASS} mt-4`}>
                            Keel type
                        </p>
                        {/* Title Case, not uppercase: 'CENTREBOARD' in capitals overflows a
                            third of a phone-width row. The stored key stays 'centerboard'. */}
                        <div
                            role="group"
                            aria-labelledby={`${fid}-keel`}
                            className="grid grid-cols-3 bg-black/40 p-1 rounded-lg border border-white/10 gap-0.5"
                        >
                            {(['fin', 'full', 'wing', 'skeg', 'centerboard', 'bilge'] as const).map((kt) => {
                                const keelLabel =
                                    kt === 'centerboard' ? 'Centreboard' : kt.charAt(0).toUpperCase() + kt.slice(1);
                                return (
                                    <button
                                        type="button"
                                        aria-pressed={vessel?.keelType === kt}
                                        key={kt}
                                        onClick={() => updateVessel('keelType', kt)}
                                        className={`min-h-11 px-1 py-2 rounded-lg text-xs font-bold transition-all ${vessel?.keelType === kt ? 'bg-sky-600 text-white' : 'text-gray-400'}`}
                                    >
                                        {keelLabel}
                                    </button>
                                );
                            })}
                        </div>
                    </SubSection>

                    {/* Yacht Database Search — replaces the old Make/Model text input */}
                    <SubSection title="Boat design">
                        <YachtDatabaseSearch
                            embedded
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
                                Amber values are rough estimates derived from vessel length, not manufacturer
                                measurements. Edit a value to replace the estimate. Until then, estimated draft is
                                treated as unknown by depth guidance.
                            </div>
                        )}
                    </SubSection>

                    <SubSection title="Dimensions">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4">
                            <MetricInput
                                label="Length"
                                valInStandard={vessel?.length || 0}
                                standardUnit="ft"
                                unitType={lengthUnit}
                                unitOptions={['ft', 'm']}
                                onChangeValue={(v) => updateVessel('length', v)}
                                onChangeUnit={(u) => updateVesselUnits({ length: u as LengthUnit })}
                                placeholder="--"
                                isEstimated={vessel?.estimatedFields?.includes('length')}
                            />
                            <MetricInput
                                label="Beam"
                                valInStandard={vessel?.beam || 0}
                                standardUnit="ft"
                                unitType={beamUnit}
                                unitOptions={['ft', 'm']}
                                onChangeValue={(v) => updateVessel('beam', v)}
                                onChangeUnit={(u) => updateVesselUnits({ beam: u as LengthUnit })}
                                placeholder="--"
                                isEstimated={vessel?.estimatedFields?.includes('beam')}
                            />
                            <MetricInput
                                label="Draft"
                                valInStandard={vessel?.draft || 0}
                                standardUnit="ft"
                                unitType={draftUnit}
                                unitOptions={['ft', 'm']}
                                onChangeValue={(v) => updateVessel('draft', v)}
                                onChangeUnit={(u) => updateVesselUnits({ draft: u as LengthUnit })}
                                placeholder="--"
                                isEstimated={vessel?.estimatedFields?.includes('draft')}
                            />
                            <MetricInput
                                label="Displacement"
                                valInStandard={vessel?.displacement || 0}
                                standardUnit="lbs"
                                unitType={displacementUnit}
                                unitOptions={['lbs', 'kg', 'tonnes']}
                                onChangeValue={(v) => updateVessel('displacement', v)}
                                onChangeUnit={(u) => updateVesselUnits({ displacement: u as WeightUnit })}
                                placeholder="--"
                                isEstimated={vessel?.estimatedFields?.includes('displacement')}
                                decimals={displacementUnit === 'tonnes' ? 2 : 0}
                            />
                            <MetricInput
                                label="Air draft"
                                valInStandard={vessel?.airDraft || 0}
                                standardUnit="ft"
                                unitType={lengthUnit}
                                unitOptions={['ft', 'm']}
                                onChangeValue={(v) => updateVessel('airDraft', v)}
                                onChangeUnit={(u) => updateVesselUnits({ length: u as LengthUnit })}
                                placeholder="--"
                            />
                        </div>
                    </SubSection>

                    {/* Derived from LOA and hull type, but OVERRIDABLE: the formulas
                        are a starting guess and the skipper knows the boat. A stored
                        positive value wins in every consumer (see
                        vesselCruisingSpeedKts / vesselMaxWaveHeightFt); storing 0
                        means "absent", so Reset hands the figure back to the formula. */}
                    <SubSection title="Performance" aside="Auto unless you set it">
                        <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
                            <div>
                                <MetricInput
                                    label="Cruising speed"
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
                                    autoInStandard={vesselCruisingSpeedKts({ ...vessel, cruisingSpeed: 0 })}
                                />
                                {Number(vessel?.cruisingSpeed) > 0 && (
                                    <button
                                        type="button"
                                        onClick={() => updateVessel('cruisingSpeed', 0)}
                                        className="mt-1.5 inline-flex min-h-[44px] items-center gap-1.5 text-xs font-bold text-sky-400 hover:text-sky-300"
                                    >
                                        <RefreshIcon className="h-3.5 w-3.5" />
                                        Reset to auto (
                                        {Math.round(vesselCruisingSpeedKts({ ...vessel, cruisingSpeed: 0 }) * 10) /
                                            10}{' '}
                                        kts)
                                    </button>
                                )}
                            </div>
                            <div>
                                {/* 'Biggest sea for this hull', not 'Max Wave Height': the
                                    Comfort zone has its own Max Wave Height (the crew's
                                    limit), and two controls with one name read as a
                                    duplicate. 'Hull Wave Limit' was designer's jargon
                                    (UX scorecard run 7). */}
                                <MetricInput
                                    label="Biggest sea for this hull"
                                    valInStandard={
                                        Number(vessel?.maxWaveHeight) > 0 ? Number(vessel?.maxWaveHeight) : 0
                                    }
                                    standardUnit="ft"
                                    unitType={hullWaveUnit}
                                    unitOptions={['ft', 'm']}
                                    onChangeValue={(v) => updateVessel('maxWaveHeight', v)}
                                    onChangeUnit={(u) => updateVesselUnits({ length: u as LengthUnit })}
                                    autoInStandard={hullWaveAutoFt}
                                />
                                {Number(vessel?.maxWaveHeight) > 0 && (
                                    <button
                                        type="button"
                                        onClick={() => updateVessel('maxWaveHeight', 0)}
                                        className="mt-1.5 inline-flex min-h-[44px] items-center gap-1.5 text-xs font-bold text-sky-400 hover:text-sky-300"
                                    >
                                        <RefreshIcon className="h-3.5 w-3.5" />
                                        Reset to auto ({hullWaveAutoDisplay} {hullWaveUnit})
                                    </button>
                                )}
                            </div>
                            {vessel?.type === 'sail' && (
                                <div className="sm:col-span-2">
                                    {/* A true wind ANGLE, not a bearing: 'Closest to the wind
                                        (° true)' read like a compass course (UX scorecard run 7). */}
                                    <label htmlFor={`${fid}-closehauled`} className={FIELD_LABEL_CLASS}>
                                        Closest true wind angle (°)
                                    </label>
                                    <input
                                        id={`${fid}-closehauled`}
                                        type="number"
                                        inputMode="numeric"
                                        min="25"
                                        max="70"
                                        step="1"
                                        value={Number.isFinite(vessel?.closeHauledTwa) ? vessel.closeHauledTwa : ''}
                                        onChange={(e) => {
                                            const n = parseInt(e.target.value, 10);
                                            updateVessel('closeHauledTwa', Number.isFinite(n) ? n : Number.NaN);
                                        }}
                                        placeholder={String(closeHauledDegFor(vessel))}
                                        className={`${FIELD_CLASS} ${NO_SPINNER_CLASS} focus:border-sky-500`}
                                    />
                                    <p className="text-xs text-gray-400 mt-1">
                                        How close to the wind she sails. The Instrument Panel calls “In irons” and
                                        “Pinching” against this. Blank uses the default for her rig (
                                        {closeHauledDegFor(vessel)}°).
                                    </p>
                                </div>
                            )}
                        </div>
                        <p className="mt-3 text-xs text-gray-400">
                            Started from your length and hull type. Type over either one if you know better — the
                            passage planner, ETAs and tide windows all use what you set here.
                        </p>
                    </SubSection>
                </Section>

                {/* The limits the passage planner keeps: the crew's comfort zone
                    and which ocean currents it routes on. */}
                <Section title="Routing limits">
                    <SubSection title="Comfort zone">
                        <div className="space-y-5">
                            <p className="text-xs text-gray-400 leading-relaxed">
                                Set your crew's comfort thresholds. The passage planner will route around zones that
                                exceed these limits, treating them as obstacles.
                            </p>

                            {/* Max Wind Speed */}
                            <div>
                                <div className="flex items-center justify-between mb-2">
                                    <label
                                        htmlFor={`${fid}-comfortwind`}
                                        className="text-xs font-bold text-gray-400 uppercase tracking-wider"
                                    >
                                        Max wind
                                    </label>
                                    <span
                                        className={`text-sm font-bold tabular-nums ${comfortWind >= 60 ? 'text-gray-400' : 'text-red-400'}`}
                                    >
                                        {comfortWind >= 60 ? 'OFF' : `${settings.comfortParams?.maxWindKts} kts`}
                                    </span>
                                </div>
                                <input
                                    id={`${fid}-comfortwind`}
                                    // The top stop means no limit: say so, not the raw number.
                                    aria-valuetext={
                                        comfortWind >= 60 ? 'Off' : `${settings.comfortParams?.maxWindKts} kts`
                                    }
                                    aria-label="Max wind"
                                    type="range"
                                    min={10}
                                    max={60}
                                    step={1}
                                    value={comfortWind}
                                    onChange={(e) => {
                                        const v = parseInt(e.target.value);
                                        updateComfortParams({ maxWindKts: v >= 60 ? undefined : v });
                                    }}
                                    className={`thalassa-range w-full h-2 rounded-full appearance-none cursor-pointer ${comfortWind >= 60 ? 'accent-slate-500' : 'accent-red-500'}`}
                                    style={{
                                        background: `linear-gradient(to right, ${comfortWind >= 60 ? '#64748b' : '#ef4444'} 0%, ${comfortWind >= 60 ? '#64748b' : '#ef4444'} ${((comfortWind - 10) / 50) * 100}%, rgba(255,255,255,0.1) ${((comfortWind - 10) / 50) * 100}%)`,
                                        // Paint the 8px track only: the 44px touch floor on every range
                                        // input otherwise spread this fill into a fat bar (UX scorecard run 7).
                                        backgroundClip: 'content-box',
                                        paddingBlock: 18,
                                    }}
                                />
                                <div className="flex justify-between text-xs text-gray-400 mt-1" aria-hidden="true">
                                    <span>10 kts</span>
                                    <span>25</span>
                                    <span>40</span>
                                    <span>OFF</span>
                                </div>
                            </div>

                            {/* Max Wave Height */}
                            <div>
                                <div className="flex items-center justify-between mb-2">
                                    <label
                                        htmlFor={`${fid}-comfortwave`}
                                        className="text-xs font-bold text-gray-400 uppercase tracking-wider"
                                    >
                                        Max wave height
                                    </label>
                                    <span
                                        className={`text-sm font-bold tabular-nums ${comfortWave >= 8 ? 'text-gray-400' : 'text-red-400'}`}
                                    >
                                        {comfortWave >= 8 ? 'OFF' : `${settings.comfortParams?.maxWaveM?.toFixed(1)} m`}
                                    </span>
                                </div>
                                <input
                                    id={`${fid}-comfortwave`}
                                    // The top stop means no limit: say so, not the raw number.
                                    aria-valuetext={
                                        comfortWave >= 8 ? 'Off' : `${settings.comfortParams?.maxWaveM?.toFixed(1)} m`
                                    }
                                    aria-label="Max wave height"
                                    type="range"
                                    min={0.5}
                                    max={8}
                                    step={0.5}
                                    value={comfortWave}
                                    onChange={(e) => {
                                        const v = parseFloat(e.target.value);
                                        updateComfortParams({ maxWaveM: v >= 8 ? undefined : v });
                                    }}
                                    className={`thalassa-range w-full h-2 rounded-full appearance-none cursor-pointer ${comfortWave >= 8 ? 'accent-slate-500' : 'accent-red-500'}`}
                                    style={{
                                        background: `linear-gradient(to right, ${comfortWave >= 8 ? '#64748b' : '#ef4444'} 0%, ${comfortWave >= 8 ? '#64748b' : '#ef4444'} ${((comfortWave - 0.5) / 7.5) * 100}%, rgba(255,255,255,0.1) ${((comfortWave - 0.5) / 7.5) * 100}%)`,
                                        // Paint the 8px track only: the 44px touch floor on every range
                                        // input otherwise spread this fill into a fat bar (UX scorecard run 7).
                                        backgroundClip: 'content-box',
                                        paddingBlock: 18,
                                    }}
                                />
                                <div className="flex justify-between text-xs text-gray-400 mt-1" aria-hidden="true">
                                    <span>0.5 m</span>
                                    <span>2.5</span>
                                    <span>5.0</span>
                                    <span>OFF</span>
                                </div>
                            </div>

                            {/* Max Gust */}
                            <div>
                                <div className="flex items-center justify-between mb-2">
                                    <label
                                        htmlFor={`${fid}-comfortgust`}
                                        className="text-xs font-bold text-gray-400 uppercase tracking-wider"
                                    >
                                        Max gust
                                    </label>
                                    <span
                                        className={`text-sm font-bold tabular-nums ${comfortGust >= 80 ? 'text-gray-400' : 'text-red-400'}`}
                                    >
                                        {comfortGust >= 80 ? 'OFF' : `${settings.comfortParams?.maxGustKts} kts`}
                                    </span>
                                </div>
                                <input
                                    id={`${fid}-comfortgust`}
                                    // The top stop means no limit: say so, not the raw number.
                                    aria-valuetext={
                                        comfortGust >= 80 ? 'Off' : `${settings.comfortParams?.maxGustKts} kts`
                                    }
                                    aria-label="Max gust"
                                    type="range"
                                    min={15}
                                    max={80}
                                    step={1}
                                    value={comfortGust}
                                    onChange={(e) => {
                                        const v = parseInt(e.target.value);
                                        updateComfortParams({ maxGustKts: v >= 80 ? undefined : v });
                                    }}
                                    className={`thalassa-range w-full h-2 rounded-full appearance-none cursor-pointer ${comfortGust >= 80 ? 'accent-slate-500' : 'accent-red-500'}`}
                                    style={{
                                        background: `linear-gradient(to right, ${comfortGust >= 80 ? '#64748b' : '#ef4444'} 0%, ${comfortGust >= 80 ? '#64748b' : '#ef4444'} ${((comfortGust - 15) / 65) * 100}%, rgba(255,255,255,0.1) ${((comfortGust - 15) / 65) * 100}%)`,
                                        // Paint the 8px track only: the 44px touch floor on every range
                                        // input otherwise spread this fill into a fat bar (UX scorecard run 7).
                                        backgroundClip: 'content-box',
                                        paddingBlock: 18,
                                    }}
                                />
                                <div className="flex justify-between text-xs text-gray-400 mt-1" aria-hidden="true">
                                    <span>15 kts</span>
                                    <span>35</span>
                                    <span>55</span>
                                    <span>OFF</span>
                                </div>
                            </div>
                        </div>
                    </SubSection>

                    {/* NRT Currents Toggle — OSCAR near-real-time vs monthly
                        climatology in the isochrone router's set/drift advection.
                        NRT is 5-day-old but reflects actual eddies/meanders.
                        Climatology is steady-state monthly averages — good enough
                        for most routes. */}
                    <SubSection>
                        <div className="flex items-start justify-between gap-3">
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-bold text-white">High-fidelity ocean currents</p>
                                <p className="text-xs text-gray-400 mt-0.5">
                                    Use recent ocean currents (about 5 days old) instead of monthly averages. Helps
                                    where a strong current decides your timing.
                                </p>
                            </div>
                            {/* The shared settings switch (60x43, sky when on), not a
                                cyan one of its own (UX scorecard run 7). */}
                            <Toggle
                                label="High-fidelity ocean currents"
                                checked={settings.currentNrtEnabled === true}
                                onChange={(on) => saveLocally({ currentNrtEnabled: on })}
                            />
                        </div>
                    </SubSection>
                </Section>

                <Section title="Tanks & crew">
                    <SubSection title="Tanks">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4">
                            <MetricInput
                                label="Fuel capacity"
                                valInStandard={vessel?.fuelCapacity || 0}
                                standardUnit="gal"
                                unitType={volumeUnit}
                                unitOptions={['gal', 'l']}
                                onChangeValue={(v) => updateVessel('fuelCapacity', v)}
                                onChangeUnit={(u) => updateVesselUnits({ volume: u as VolumeUnit })}
                                placeholder="--"
                            />
                            <MetricInput
                                label="Water capacity"
                                valInStandard={vessel?.waterCapacity || 0}
                                standardUnit="gal"
                                unitType={volumeUnit}
                                unitOptions={['gal', 'l']}
                                onChangeValue={(v) => updateVessel('waterCapacity', v)}
                                onChangeUnit={(u) => updateVesselUnits({ volume: u as VolumeUnit })}
                                placeholder="--"
                            />
                        </div>
                    </SubSection>
                    <SubSection title="Crew">
                        {/* A −/+ stepper with 44 pt buttons, not a full-width
                            number field that needed the keyboard for one digit
                            (UX scorecard run 8). Same field, same 1–99 range. */}
                        <p id={`${fid}-crew-label`} className={FIELD_LABEL_CLASS}>
                            Crew aboard (incl. skipper)
                        </p>
                        <div
                            role="group"
                            aria-labelledby={`${fid}-crew-label`}
                            aria-describedby={`${fid}-crew-help`}
                            className="inline-flex h-11 items-center rounded-xl border border-white/10 bg-white/5"
                        >
                            <button
                                type="button"
                                aria-label="One fewer aboard"
                                disabled={crewAboard <= 1}
                                onClick={() => updateVessel('crewCount', Math.max(1, crewAboard - 1))}
                                className="flex h-11 w-11 items-center justify-center rounded-l-xl text-xl font-light text-gray-300 hover:bg-white/5 active:bg-white/10 disabled:opacity-40"
                            >
                                −
                            </button>
                            {/* A polite live span, not <output>: that is a second
                                role=status on a page whose status line is the
                                fleet's own. */}
                            <span
                                id={`${fid}-crew`}
                                aria-live="polite"
                                aria-atomic="true"
                                className="min-w-12 px-2 text-center text-base font-bold tabular-nums text-white"
                            >
                                {crewAboard}
                            </span>
                            <button
                                type="button"
                                aria-label="One more aboard"
                                disabled={crewAboard >= 99}
                                onClick={() => updateVessel('crewCount', Math.min(99, crewAboard + 1))}
                                className="flex h-11 w-11 items-center justify-center rounded-r-xl text-xl font-light text-gray-300 hover:bg-white/5 active:bg-white/10 disabled:opacity-40"
                            >
                                +
                            </button>
                        </div>
                        <p id={`${fid}-crew-help`} className="text-xs text-gray-400 mt-1.5">
                            Used for provisioning and watch scheduling in passage plans
                        </p>
                        {/* One row per person aboard — name, age, rank — straight
                            under the count (Shane 2026-09-09: "the same amount of
                            area to add a punters name and age and rank … those
                            names should auto xfer across to the float plan"). The
                            Float Plan seeds its persons roster from these first. */}
                        <div className="mt-3 space-y-3" data-testid="vessel-crew-roster">
                            {crewRosterRows.map((person, index) => (
                                <div
                                    key={index}
                                    // Stacked, not three across (Shane 2026-09-09: "just stack
                                    // them claude. never enough space"): the name gets the whole
                                    // line, age and rank share the one below. No card of its own
                                    // (it sat three levels deep) and visible labels, not
                                    // placeholder-only fields (UX scorecard run 6).
                                    className={`space-y-2 ${index > 0 ? 'border-t border-white/5 pt-3' : ''}`}
                                    data-testid={`vessel-crew-person-${index + 1}`}
                                >
                                    {/* Each block says whose it is, and every name field
                                        asks the same way: 'Skipper's name' against
                                        'Person 2', with no heading on the second block,
                                        read as two patterns (UX scorecard run 8). */}
                                    <h4 className="text-sm font-semibold text-gray-300">
                                        {index === 0 ? 'Skipper' : `Crew ${index + 1}`}
                                    </h4>
                                    <label className="block">
                                        <span className={FIELD_LABEL_CLASS}>Name</span>
                                        <input
                                            type="text"
                                            aria-label={`Person ${index + 1} name`}
                                            value={person.name}
                                            onChange={(e) => updateVesselRoster(index, { name: e.target.value })}
                                            placeholder="Full name"
                                            className={`${FIELD_CLASS} focus:border-sky-500`}
                                        />
                                    </label>
                                    {/* Age and Rank share one 44 pt height and one field
                                        look (UX scorecard run 7). */}
                                    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2">
                                        <label className="block min-w-0">
                                            <span className={FIELD_LABEL_CLASS}>Age</span>
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
                                                placeholder="--"
                                                className={`${FIELD_CLASS} ${NO_SPINNER_CLASS} tabular-nums focus:border-sky-500`}
                                            />
                                        </label>
                                        <label className="block min-w-0">
                                            <span className={FIELD_LABEL_CLASS}>Rank</span>
                                            <select
                                                aria-label={`Person ${index + 1} rank`}
                                                value={person.rank || (index === 0 ? 'Skipper' : 'Crew')}
                                                onChange={(e) => updateVesselRoster(index, { rank: e.target.value })}
                                                className={`${FIELD_CLASS} ${SELECT_CLASS} focus:border-sky-500`}
                                            >
                                                {FLOAT_PLAN_ROLES.map((role) => (
                                                    <option key={role} value={role}>
                                                        {role}
                                                    </option>
                                                ))}
                                            </select>
                                        </label>
                                    </div>
                                </div>
                            ))}
                            <p className="text-xs text-gray-400">These names carry across to the Float Plan.</p>
                        </div>
                    </SubSection>
                </Section>
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

            {fleetAvailable ? (
                // Fleet mode: a real cloud flush, fixed 8px above the 72px tab bar.
                <div
                    className="fixed left-0 right-0 z-20 px-4 pt-2 pb-2"
                    style={{
                        bottom: 'calc(72px + 8px + env(safe-area-inset-bottom))',
                        // Fully opaque (daylight: the white surface token): at 0.96 the
                        // Max Gust slider still ghosted through the bar (UX scorecard
                        // 2026-09-25, run 5).
                        background: 'var(--day-ui-surface, rgb(2, 6, 23))',
                        boxShadow: '0 -10px 18px -10px rgba(0, 0, 0, 0.45)',
                    }}
                >
                    {/* Scroll fade on the bar's top edge, so a field scrolling under it
                        fades out instead of being sliced. It lives here, not as a
                        mask on SettingsModal's scroller: this bar is position:fixed
                        INSIDE that scroller, and a mask there would fade the bar too. */}
                    <div
                        aria-hidden="true"
                        className="pointer-events-none absolute left-0 right-0 bottom-full h-4"
                        style={{
                            background: 'linear-gradient(to bottom, transparent, var(--day-ui-surface, rgb(2, 6, 23)))',
                        }}
                    />
                    <div className="max-w-2xl mx-auto">
                        <button
                            type="button"
                            aria-label="Sync vessel fleet to cloud"
                            onClick={() => {
                                void triggerHaptic('medium');
                                syncFleet();
                            }}
                            disabled={!fleetSurface.syncVesselFleet || fleetBusyAction !== null || syncStatus.busy}
                            className={`w-full min-h-11 py-3.5 rounded-xl text-sm font-bold transition-all active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 ${
                                fleetBusyAction === 'sync' || syncStatus.busy
                                    ? 'bg-linear-to-r from-sky-700 to-cyan-700 text-white shadow-lg shadow-sky-500/20'
                                    : saved && syncStatus.tone !== 'red'
                                      ? 'bg-linear-to-r from-emerald-600 to-emerald-600 text-white shadow-lg shadow-emerald-500/20'
                                      : 'bg-linear-to-r from-sky-600 to-sky-600 text-white shadow-lg shadow-sky-500/20 hover:from-sky-500 hover:to-sky-500'
                            }`}
                        >
                            {fleetBusyAction === 'sync' || syncStatus.busy ? (
                                <span className="inline-flex items-center gap-1.5 justify-center">
                                    <RefreshIcon className="w-4 h-4 animate-spin" />
                                    <span>Syncing fleet</span>
                                </span>
                            ) : saved ? (
                                <span className="inline-flex items-center gap-1.5 justify-center">
                                    <CheckIcon className="w-4 h-4" />
                                    <span>Cloud check complete</span>
                                </span>
                            ) : (
                                <span className="inline-flex items-center gap-1.5 justify-center">
                                    <RefreshIcon className="w-4 h-4" />
                                    <span>Sync vessel fleet</span>
                                </span>
                            )}
                        </button>
                    </div>
                </div>
            ) : (
                // Local profile: nothing to press — edits are on the phone the moment
                // they are made. A slim line says so for a moment after each edit,
                // and is gone again (UX scorecard run 7: the permanent bordered bar
                // read as a Save button and took ~62 pt of the port).
                <div
                    role="status"
                    className="pointer-events-none fixed left-0 right-0 z-20 flex justify-center px-4"
                    style={{ bottom: 'calc(var(--thalassa-tabbar-height, 72px) + 12px)' }}
                >
                    {localSaved && (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-slate-900 px-4 py-2 text-sm font-bold text-emerald-200 shadow-lg shadow-black/40 animate-in fade-in duration-200">
                            <CheckIcon className="h-4 w-4" />
                            Saved on this phone
                        </span>
                    )}
                </div>
            )}
        </div>
    );
};
