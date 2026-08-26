/**
 * CrewManagement — Passage Planning orchestrator.
 *
 * Coordinates auth, passage selection, crew management, and readiness cards.
 * UI sections delegated to:
 *   - CrewRoster: crew list, invites, memberships
 *   - ReadinessCardStack: all 8 passage readiness cards
 *   - DelegationBadge: card delegation UI
 *   - InviteCrewModal: invite form
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { t } from '../theme';
import { useAuthStore } from '../stores/authStore';
import { useSettings } from '../context/SettingsContext';
import { ModalSheet } from './ui/ModalSheet';
import { UndoToast } from './ui/UndoToast';

import {
    type SharedRegister,
    type CrewMember,
    ALL_REGISTERS,
    PASSAGE_REGISTERS,
    REGISTER_ICONS,
    REGISTER_LABELS,
    inviteCrew,
    getMyCrew,
    removeCrew,
    disbandGroup,
    updateCrewPermissions,
    getMyInvites,
    getMyMemberships,
    acceptInvite,
    declineInvite,
    leaveVessel,
} from '../services/CrewService';
import { supabase } from '../services/supabase';
import { loadOwnedVesselFleet } from '../services/VesselFleetService';
import { vesselCrewAboard } from '../services/units';
import { triggerHaptic } from '../utils/system';
import { useUIStore } from '../stores/uiStore';
import { followCastOffRoute } from '../services/shiplog/followCastOffRoute';
import { peekCastOffHandoff, updateCastOffHandoff } from '../services/castOffHandoff';
import { toast } from './Toast';
import {
    adoptSavedRouteLink,
    createVoyage,
    getCachedActiveVoyage,
    getCachedDraftVoyages,
    getDraftVoyages,
    updateVoyage,
    type Voyage,
} from '../services/VoyageService';
import { fetchRoutesAndTracks } from '../services/shiplog/RoutesAndTracks';
import { formatPlannedRouteLabel, formatStoredPlannedRouteName } from '../services/shiplog/plannedRouteNaming';
import {
    buildTripPassageRollups,
    linkTraceToPassage,
    loadSavedTraces,
    saveTrace,
    stripLegBadge,
} from '../services/routeTracer';
import { savedRouteGeometryFingerprint } from '../services/savedRouteLibrary';
import { isSameCountry } from '../data/customsDb';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../services/authIdentityScope';
import {
    NO_PASSAGE_ACCESS,
    type PassageStatus,
    clearPassagePlan,
    getActivePassageId,
    getAuthorizedSharedVoyages,
    getPassageStatus,
    setActivePassage,
} from '../services/PassagePlanService';
import { SignInScreen } from './SignInScreen';
import { lazyRetry } from '../utils/lazyRetry';
import { UsersIcon, CompassIcon, CalendarGridIcon, AnchorIcon, AlertTriangleIcon, SosIcon } from './Icons';

// ── Extracted sub-components ──
import { InviteCrewModal } from './crew/InviteCrewModal';
import { CrewRoster } from './crew/CrewRoster';
import { ReadinessCardStack } from './crew/ReadinessCardStack';
import { PageHeader } from './ui/PageHeader';
import {
    departureOnLocalDate,
    derivePassageSummarySchedule,
    localDateValue,
    localDateTimeValue,
    nextDepartureSlot,
    routeDistanceNm,
} from '../services/passageSummarySchedule';

const CastOffPanel = lazyRetry(
    () => import('./vessel/CastOffPanel').then((m) => ({ default: m.CastOffPanel })),
    'CastOffPanel_Crew',
);

/**
 * VoyageRow — a Voyage augmented with departure/arrival coords AND
 * planned duration looked up from the matching logbook route. Used as
 * the dropdown's row type so Weather Windows + Ocean Currents cards
 * can run their analysis (need coords) and Voyage Provisioning can
 * auto-compute ETA from departure (needs duration). Lets us avoid a
 * voyages-table schema migration.
 */
export type VoyageRow = Voyage & {
    departureCoords?: { lat: number; lon: number };
    arrivalCoords?: { lat: number; lon: number };
    /** Full saved/planned geometry, in passage order. Kept on the row so
     *  Passage Summary does not have to guess from the global chart route. */
    routeCoordinates?: Array<{ lat: number; lon: number }>;
    /** Underlying planned-route log voyage. Distinct from this voyage-row ID. */
    plannedRouteId?: string;
    /** Distance supplied by this exact planned-route record, in NM. */
    distanceNm?: number;
    durationHours?: number;
    /** True when this voyage belongs to a captain who shared it with us. */
    isShared?: boolean;
    sharedOwnerEmail?: string;
};

const routeDayKey = (iso: string | null | undefined): string | null => {
    if (!iso) return null;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
};

/** Crew edits belong to the vessel currently selected by the skipper, not an arbitrary owned boat. */
async function activeOwnedBoatId(scope: AuthIdentityScope): Promise<string | null> {
    if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) return null;
    try {
        const fleet = await loadOwnedVesselFleet(scope);
        const active = fleet.vessels.find((vessel) => vessel.id === fleet.activeBoatId);
        if (active) return active.id;
    } catch {
        // Staged rollout fallback for environments whose fleet migration is
        // not yet applied; limiting avoids the old multi-row `maybeSingle`.
    }
    if (!supabase || !isAuthIdentityScopeCurrent(scope)) return null;
    const { data } = await supabase
        .from('boats')
        .select('id')
        .eq('owner_id', scope.userId)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    return typeof data?.id === 'string' ? data.id : null;
}

// These labels are generated exclusively by the Route Tracer's chained-leg
// flow. A pre-link build could leave such a mirror behind after its canonical
// leg disappeared; promote the surviving geometry back to a normal saved
// route instead of showing a nonsensical orphaned "2nd Leg" here.
const GENERATED_LEG_BADGE_ANYWHERE_RE = /\s*\(\d+(?:st|nd|rd|th) Leg\)/i;

function isLegacyGeneratedLeg(label: string): boolean {
    return GENERATED_LEG_BADGE_ANYWHERE_RE.test(label);
}

function legacyGeneratedLegName(label: string): string {
    // Preserve the whole human route label. A surviving “A → B (2nd Leg)” is
    // promoted to the first/only route, not silently reduced to just “A”.
    return stripLegBadge(
        label
            .replace(GENERATED_LEG_BADGE_ANYWHERE_RE, '')
            .replace(/\s+—\s+start\s*$/i, '')
            .trim(),
    );
}

/**
 * A planning row is eligible for Saved Routes when it carries the canonical
 * trace id itself, or when an older row is tied to that trace by the exact
 * immutable passage UUID. The latter is deliberately restricted to unlinked
 * rows: a conflicting saved_route_id must never be papered over by a stale
 * passage_voyage_id from another graph.
 */
/**
 * Split a route label into its two endpoints.
 *
 * Two separators are in circulation: routeAutoName builds "Newport - Lady
 * Musgrave" and logbook labels build "Newport → Lady Musgrave". A label with
 * neither (a hand-typed "Winter delivery run") has no endpoints to give, and
 * returning the whole string as the departure is worse than returning nothing
 * — it puts a route name where a port name is expected.
 */
/**
 * Carry already-attached route geometry forward onto a freshly-fetched row.
 *
 * reloadDropdown paints twice from bare DB `Voyage` objects before the phase
 * that attaches geometry runs. If that phase is cancelled — a concurrent
 * reload bumps the version guard — the rows are left downgraded, and the
 * Passage Planning summary shows "--" for Duration and Distance and
 * "Forecast unavailable" for Max Conditions, because every one of those is
 * derived from routeCoordinates.
 *
 * Merging instead of replacing means an aborted reload can only ever fail to
 * IMPROVE a row; it can never strip one. The fresh row still wins for every
 * server-owned field.
 */
function preserveRouteGeometry(fresh: VoyageRow, previous: VoyageRow | undefined): VoyageRow {
    if (!previous) return fresh;
    return {
        ...fresh,
        departureCoords: fresh.departureCoords ?? previous.departureCoords,
        arrivalCoords: fresh.arrivalCoords ?? previous.arrivalCoords,
        routeCoordinates: fresh.routeCoordinates ?? previous.routeCoordinates,
        plannedRouteId: fresh.plannedRouteId ?? previous.plannedRouteId,
        distanceNm: fresh.distanceNm ?? previous.distanceNm,
        durationHours: fresh.durationHours ?? previous.durationHours,
    };
}

function splitRouteEndpoints(label: string): [string | undefined, string | undefined] {
    for (const separator of [' → ', ' - ']) {
        const parts = label.split(separator);
        if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
            const departure = parts[0].trim();
            const arrival = parts[1].trim();
            // "x → x" is a naming artefact (multi-leg trace legs can carry
            // the leg title in both ports). A self-to-self passage isn't
            // real: keep the name as the departure and leave the
            // destination honestly empty rather than duplicating it into
            // Cast Off (Shane 2026-08-04: "newport 2nd leg - newport 2nd
            // leg??????").
            if (departure.toLocaleLowerCase() === arrival.toLocaleLowerCase()) return [departure, undefined];
            return [departure, arrival];
        }
    }
    return [undefined, undefined];
}

function isCanonicalSavedRouteDraft(
    draft: Voyage,
    canonicalIds: ReadonlySet<string>,
    canonicalPassageVoyageIds: ReadonlySet<string>,
): boolean {
    return Boolean(
        (draft.saved_route_id && canonicalIds.has(draft.saved_route_id)) ||
        (!draft.saved_route_id && canonicalPassageVoyageIds.has(draft.id)),
    );
}

function canonicalPassageVoyageIds(traces: ReturnType<typeof loadSavedTraces>): Set<string> {
    return new Set(
        traces
            .map((trace) => trace.passageVoyageId)
            .filter((passageVoyageId): passageVoyageId is string => Boolean(passageVoyageId && passageVoyageId.trim())),
    );
}

/**
 * Legacy saved traces stored their internal endpoint markers as the voyage
 * title. Keep matching against the original database fields, but never make
 * a skipper read "… start → … end" in the Saved Routes selector.
 */
function savedRouteDisplayName(voyage: Pick<Voyage, 'voyage_name' | 'departure_port' | 'destination_port'>): string {
    return (
        formatStoredPlannedRouteName(voyage.voyage_name) ??
        (voyage.departure_port || voyage.destination_port
            ? formatPlannedRouteLabel(voyage.departure_port, voyage.destination_port)
            : '? → ?')
    );
}

interface CrewManagementProps {
    onBack: () => void;
}

const DELEGATION_STORAGE_KEY = 'thalassa_card_delegations_v2';
type CardDelegationsByVoyage = Record<string, Record<string, string>>;

function readDelegations(scope: AuthIdentityScope): CardDelegationsByVoyage {
    try {
        // The old unscoped map has no owner marker. Never assign its crew
        // email addresses to whichever account happens to sign in next.
        const stored = localStorage.getItem(authScopedStorageKey(DELEGATION_STORAGE_KEY, scope));
        if (!stored) return {};
        const parsed: unknown = JSON.parse(stored);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

        const result: CardDelegationsByVoyage = {};
        for (const [voyageId, assignments] of Object.entries(parsed)) {
            if (!assignments || typeof assignments !== 'object' || Array.isArray(assignments)) continue;
            const validAssignments = Object.fromEntries(
                Object.entries(assignments).filter(
                    ([cardKey, email]) => Boolean(cardKey) && typeof email === 'string' && email.length > 0,
                ),
            ) as Record<string, string>;
            if (Object.keys(validAssignments).length > 0) result[voyageId] = validAssignments;
        }
        return result;
    } catch {
        return {};
    }
}

export const CrewManagement: React.FC<CrewManagementProps> = React.memo(({ onBack }) => {
    // Auth state comes from the global authStore — same source of truth
    // as the AuthGate at app boot. Removed the local getSession() +
    // onAuthStateChange duplicate that lived here previously: it raced
    // with the global store's initial check on cold mount and could
    // leave authChecked=false forever, which rendered the page as just
    // a header with an empty body (the "blank Passage Planning" bug).
    const authedUser = useAuthStore((s) => s.user);
    const setPage = useUIStore((st) => st.setPage);
    const authChecked = useAuthStore((s) => s.authChecked);
    const authUserId = authedUser?.id ?? null;
    const isAuthed = !!authedUser;
    const { settings } = useSettings();
    const [privateScopeKey, setPrivateScopeKey] = useState(() => getAuthIdentityScope().key);

    // Captain state
    const [myCrew, setMyCrew] = useState<CrewMember[]>([]);
    const [showInviteModal, setShowInviteModal] = useState(false);
    const [inviteEmail, setInviteEmail] = useState('');
    const [inviteRegisters, setInviteRegisters] = useState<SharedRegister[]>([]);
    const [inviteLoading, setInviteLoading] = useState(false);
    const [inviteError, setInviteError] = useState<string | null>(null);
    const [inviteSuccess, setInviteSuccess] = useState(false);

    // Crew state
    const [pendingInvites, setPendingInvites] = useState<CrewMember[]>([]);
    const [memberships, setMemberships] = useState<CrewMember[]>([]);
    const [membershipsLoaded, setMembershipsLoaded] = useState(false);

    // Edit permissions modal
    const [editTarget, setEditTarget] = useState<CrewMember | null>(null);
    const [editRegisters, setEditRegisters] = useState<SharedRegister[]>([]);
    // Byline parts (boat_members) — only meaningful once a crew member has
    // accepted; for pending invites the inputs render but are gated.
    const [editPrefix, setEditPrefix] = useState('');
    const [editFirstName, setEditFirstName] = useState('');
    const [editLastName, setEditLastName] = useState('');
    const [editNickname, setEditNickname] = useState('');
    const [editBoatMemberLoaded, setEditBoatMemberLoaded] = useState(false);

    // Loading
    const [loading, setLoading] = useState(true);
    // Soft-delete with undo
    const [deletedMember, setDeletedMember] = useState<{ member: CrewMember; mode: 'captain' | 'crew' } | null>(null);

    // Auth + Cast Off
    const [showAuth, setShowAuth] = useState(false);
    const [showCastOff, setShowCastOff] = useState(false);
    const [_activeVoyageName, setActiveVoyageName] = useState<string | null>(null);

    // Saved routes. VoyageRow extends the DB Voyage with
    // optional departure/arrival coords pulled from the matching
    // logbook route at fetch time. The cards downstream (Weather
    // Windows, Ocean Currents) need lat/lon to run their analysis but
    // the voyages-table schema doesn't carry coords; this is how we
    // bridge that gap without a migration.
    // Paint only canonical-backed rows synchronously. An unlinked planning
    // record could be a legitimate legacy mirror, but it could just as easily
    // be a stale row left behind by an interrupted old save; wait for the
    // exact logbook reconciliation below before presenting it as a route.
    const [draftVoyages, setDraftVoyages] = useState<VoyageRow[]>(() => {
        const canonicalTraces = loadSavedTraces();
        const canonicalIds = new Set(canonicalTraces.map((trace) => trace.id));
        const exactPassageVoyageIds = canonicalPassageVoyageIds(canonicalTraces);
        return getCachedDraftVoyages().filter((draft) =>
            isCanonicalSavedRouteDraft(draft, canonicalIds, exactPassageVoyageIds),
        );
    });
    const [savedRoutesLoading, setSavedRoutesLoading] = useState(() => {
        const canonicalTraces = loadSavedTraces();
        const canonicalIds = new Set(canonicalTraces.map((trace) => trace.id));
        const exactPassageVoyageIds = canonicalPassageVoyageIds(canonicalTraces);
        return getCachedDraftVoyages().every(
            (draft) => !isCanonicalSavedRouteDraft(draft, canonicalIds, exactPassageVoyageIds),
        );
    });
    // Once an account's route library has answered at least once, leave its
    // deliberate empty state on screen while background refreshes run. The
    // old flow reset this to `true` whenever an empty cache was re-read,
    // swapping the empty-state icon for the loading card on every route
    // event and making it visibly flash.
    const savedRoutesSettledGeneration = useRef<number | null>(null);
    const [selectedPassageId, setSelectedPassageId] = useState<string>(getActivePassageId() || '');
    const selectedPassageRef = useRef(selectedPassageId);
    selectedPassageRef.current = selectedPassageId;
    const [passageStatus, setPassageStatus] = useState<PassageStatus>(NO_PASSAGE_ACCESS);
    const [passageStatusLoading, setPassageStatusLoading] = useState(true);
    const passageSelectionVersion = useRef(0);
    const dropdownReloadVersion = useRef(0);
    // ETA-backfill writes are capped at one attempt per row per mount: the
    // 5-minute departure-slot clamp makes the derived schedule a moving
    // target for past departures, and per-reload retries turned that into
    // steady background PATCH traffic.
    const etaBackfillPatchedRef = useRef<Set<string>>(new Set());
    const departureUpdateVersion = useRef(0);
    const dataLoadVersion = useRef(0);
    const editLoadVersion = useRef(0);
    const inviteOperationVersion = useRef(0);
    const inviteSuccessTimer = useRef<number | null>(null);
    const dataLoadTimeouts = useRef(new Map<number, () => void>());

    // ── Readiness card states ──
    const [customsCleared, setCustomsCleared] = useState(false);
    const [customsProgress, setCustomsProgress] = useState<{ total: number; checked: number }>({
        total: 0,
        checked: 0,
    });
    // weatherReviewed state removed 2026-05-17 — the Pre-Departure
    // Weather card was deleted (duplicated Weather Windows above).
    // Window acceptance in PI-1 is now the canonical weather-
    // readiness gate via `weatherWindowReady`.
    const [reservesReady, setReservesReady] = useState(false);
    const [navAcknowledged, setNavAcknowledged] = useState(false);
    const [watchBriefed, setWatchBriefed] = useState(false);
    const [commsReady, setCommsReady] = useState(false);
    const [vesselChecked, setVesselChecked] = useState(false);
    const [medicalReady, setMedicalReady] = useState(false);

    // Passage Intelligence states
    const [vesselProfileReady, setVesselProfileReady] = useState(false);
    const [comfortProfileReady, setComfortProfileReady] = useState(false);
    const [weatherWindowReady, setWeatherWindowReady] = useState(false);
    const [currentsBriefed, setCurrentsBriefed] = useState(false);
    const [provisioningReady, setProvisioningReady] = useState(false);

    const resetReadinessState = useCallback(() => {
        setCustomsCleared(false);
        setCustomsProgress({ total: 0, checked: 0 });
        setReservesReady(false);
        setNavAcknowledged(false);
        setWatchBriefed(false);
        setCommsReady(false);
        setVesselChecked(false);
        setMedicalReady(false);
        setVesselProfileReady(false);
        setComfortProfileReady(false);
        setWeatherWindowReady(false);
        setCurrentsBriefed(false);
        setProvisioningReady(false);
        setDelegationMenuOpen(null);
        setShowCastOff(false);
    }, []);

    // Card delegation
    const [delegationState, setDelegationState] = useState<{
        scopeKey: string;
        byVoyage: CardDelegationsByVoyage;
    }>(() => {
        const scope = getAuthIdentityScope();
        return { scopeKey: scope.key, byVoyage: readDelegations(scope) };
    });
    const [delegationMenuOpen, setDelegationMenuOpen] = useState<string | null>(null);
    const renderScope = getAuthIdentityScope();
    const privateIdentityMatches = privateScopeKey === renderScope.key && renderScope.userId === authUserId;
    const delegationIdentityMatches = privateIdentityMatches && delegationState.scopeKey === renderScope.key;
    const cardDelegations =
        delegationIdentityMatches && selectedPassageId ? (delegationState.byVoyage[selectedPassageId] ?? {}) : {};

    const assignCard = useCallback(
        (cardKey: string, crewEmail: string | null) => {
            const scope = getAuthIdentityScope();
            if (
                !selectedPassageId ||
                !passageStatus.isOwner ||
                passageStatus.voyageId !== selectedPassageId ||
                passageStatus.ownerUserId !== scope.userId
            ) {
                return;
            }
            if (!scope.userId || scope.userId !== authedUser?.id) return;

            setDelegationState((previous) => {
                if (previous.scopeKey !== scope.key || !isAuthIdentityScopeCurrent(scope)) return previous;
                const voyageDelegations = { ...(previous.byVoyage[selectedPassageId] ?? {}) };
                if (crewEmail) {
                    voyageDelegations[cardKey] = crewEmail;
                } else {
                    delete voyageDelegations[cardKey];
                }
                const nextByVoyage = {
                    ...previous.byVoyage,
                    [selectedPassageId]: voyageDelegations,
                };
                try {
                    localStorage.setItem(
                        authScopedStorageKey(DELEGATION_STORAGE_KEY, scope),
                        JSON.stringify(nextByVoyage),
                    );
                } catch {
                    /* ignore */
                }
                return { scopeKey: scope.key, byVoyage: nextByVoyage };
            });
            setDelegationMenuOpen(null);
        },
        [authedUser?.id, passageStatus.isOwner, passageStatus.ownerUserId, passageStatus.voyageId, selectedPassageId],
    );

    // Disband group
    const [showDisbandConfirm, setShowDisbandConfirm] = useState(false);
    const [disbandConfirmText, setDisbandConfirmText] = useState('');
    const [disbanding, setDisbanding] = useState(false);
    // Planning panel state
    const [planDeparture, setPlanDeparture] = useState('');

    const resetPrivateIdentity = useCallback(
        (next: AuthIdentityScope) => {
            dataLoadVersion.current += 1;
            dropdownReloadVersion.current += 1;
            passageSelectionVersion.current += 1;
            editLoadVersion.current += 1;
            inviteOperationVersion.current += 1;
            for (const [timeoutId, settle] of dataLoadTimeouts.current) {
                window.clearTimeout(timeoutId);
                settle();
            }
            dataLoadTimeouts.current.clear();
            if (inviteSuccessTimer.current !== null) {
                window.clearTimeout(inviteSuccessTimer.current);
                inviteSuccessTimer.current = null;
            }

            const nextPassageId = next.userId ? getActivePassageId() || '' : '';
            selectedPassageRef.current = nextPassageId;
            setPrivateScopeKey(next.key);
            setMyCrew([]);
            setPendingInvites([]);
            setMemberships([]);
            setMembershipsLoaded(false);
            setDraftVoyages([]);
            // A different identity needs its own first, honest loading pass;
            // an empty result for the previous skipper must not suppress it.
            savedRoutesSettledGeneration.current = null;
            setSavedRoutesLoading(Boolean(next.userId));
            setSelectedPassageId(nextPassageId);
            setPassageStatus(NO_PASSAGE_ACCESS);
            setPassageStatusLoading(Boolean(next.userId));
            setLoading(Boolean(next.userId));
            setDeletedMember(null);
            setActiveVoyageName(null);
            setPlanDeparture('');

            setShowInviteModal(false);
            setInviteEmail('');
            setInviteRegisters([]);
            setInviteLoading(false);
            setInviteError(null);
            setInviteSuccess(false);

            setEditTarget(null);
            setEditRegisters([]);
            setEditPrefix('');
            setEditFirstName('');
            setEditLastName('');
            setEditNickname('');
            setEditBoatMemberLoaded(false);

            setShowDisbandConfirm(false);
            setDisbandConfirmText('');
            setDisbanding(false);
            setDelegationState({
                scopeKey: next.key,
                byVoyage: readDelegations(next),
            });
            resetReadinessState();
        },
        [resetReadinessState],
    );

    useEffect(
        () =>
            subscribeAuthIdentityScope((next) => {
                resetPrivateIdentity(next);
            }),
        [resetPrivateIdentity],
    );

    // The identity fence moves before authStore publishes its new user. This
    // reconciliation also covers a transition that occurred before the
    // subscription effect mounted.
    useEffect(() => {
        const scope = getAuthIdentityScope();
        if (scope.userId === authUserId && privateScopeKey !== scope.key) {
            resetPrivateIdentity(scope);
        }
    }, [authUserId, privateScopeKey, resetPrivateIdentity]);

    const scopeStillOwnsPage = useCallback(
        (scope: AuthIdentityScope) =>
            isAuthIdentityScopeCurrent(scope) && Boolean(scope.userId) && scope.userId === authUserId,
        [authUserId],
    );

    // Auth check — read once from the cached session (sync-ish, no
    // round-trip) AND subscribe to onAuthStateChange so we react to a
    // sign-in / sign-out that happened on another screen. Previous
    // version used `getUser()` (a network round-trip) and skipped the
    // subscription, so:
    //   1. On every navigation back to this page, the initial render
    //      saw isAuthed=false (default), painting the "Sign In Required"
    //      empty state for a few hundred ms before the await resolved.
    //   2. If you signed in via the Settings page while this component
    //      was already mounted (rare but possible), it never noticed.
    //
    // The `authChecked` gate suppresses the sign-in prompt until we've
    // actually finished checking, so users with a valid session never
    // Local _userEmail is derived from the same authStore. Some
    // callsites below still read user email synchronously and we keep
    // the variable for them — no setter needed because the global
    // store is the single writer.
    const _userEmail = authedUser?.email ?? null;
    void _userEmail; // referenced via authedUser in callers below

    // Load data.
    //
    // On a fresh-install first launch, one or more of these service
    // calls can hang on `supabase.auth.getUser()` — that method makes
    // a network round-trip to verify the JWT, and on the very first
    // boot after sign-in the auth client hasn't fully cached the
    // session yet. Promise.all never resolves → setLoading(false)
    // never fires → ReadinessCardStack (gated on !loading) never
    // renders, leaving Shane staring at just the Plan-a-Route
    // button and Active Passage selector. Restart fixed it because
    // the session was cached by then.
    //
    // Defense: Promise.allSettled so one slow/hanging service can't
    // hold the others hostage, finally{ setLoading(false) } so the
    // UI gate ALWAYS clears, and a 6 s timeout race so even a true
    // hang surrenders instead of leaving the page partially-rendered
    // forever.
    const loadData = useCallback(async () => {
        const scope = getAuthIdentityScope();
        if (!scopeStillOwnsPage(scope)) return;
        const requestVersion = ++dataLoadVersion.current;
        setLoading(true);
        setMembershipsLoaded(false);
        let timeoutId: number | null = null;
        const timeout = new Promise<'timeout'>((resolve) => {
            timeoutId = window.setTimeout(() => {
                if (timeoutId !== null) dataLoadTimeouts.current.delete(timeoutId);
                resolve('timeout');
            }, 6000);
            dataLoadTimeouts.current.set(timeoutId, () => resolve('timeout'));
        });
        const work = Promise.allSettled([getMyCrew(), getMyInvites(), getMyMemberships()]);
        try {
            const result = await Promise.race([work, timeout]);
            if (requestVersion !== dataLoadVersion.current || !scopeStillOwnsPage(scope)) return;
            if (result === 'timeout') {
                console.warn('[CrewManagement] loadData: timed out after 6s — leaving lists empty for now');
            } else {
                const [crewRes, invitesRes, shipsRes] = result;
                if (crewRes.status === 'fulfilled') setMyCrew(crewRes.value);
                if (invitesRes.status === 'fulfilled') setPendingInvites(invitesRes.value);
                if (shipsRes.status === 'fulfilled') {
                    setMemberships(shipsRes.value);
                    setMembershipsLoaded(true);
                }
            }
        } finally {
            if (timeoutId !== null) {
                window.clearTimeout(timeoutId);
                dataLoadTimeouts.current.delete(timeoutId);
            }
            if (requestVersion === dataLoadVersion.current && scopeStillOwnsPage(scope)) setLoading(false);
        }
    }, [scopeStillOwnsPage]);

    useEffect(() => {
        const scope = getAuthIdentityScope();
        if (authUserId && privateScopeKey === scope.key && scope.userId === authUserId) {
            void loadData();
        }
        return () => {
            dataLoadVersion.current += 1;
        };
    }, [authUserId, loadData, privateScopeKey]);

    useEffect(
        () => () => {
            for (const [timeoutId, settle] of dataLoadTimeouts.current) {
                window.clearTimeout(timeoutId);
                settle();
            }
            dataLoadTimeouts.current.clear();
            if (inviteSuccessTimer.current !== null) {
                window.clearTimeout(inviteSuccessTimer.current);
            }
        },
        [],
    );

    // Resolve owner/crew passage permissions independently from the roster
    // load. The selected localStorage ID is only navigation state; it is not
    // evidence that the current user owns the passage. Keep the readiness
    // surface fail-closed until PassagePlanService verifies ownership or an
    // applicable accepted membership.
    useEffect(() => {
        const scope = getAuthIdentityScope();
        if (!authUserId || !scopeStillOwnsPage(scope)) {
            setPassageStatus(NO_PASSAGE_ACCESS);
            setPassageStatusLoading(false);
            return;
        }

        let active = true;
        setPassageStatus(NO_PASSAGE_ACCESS);
        setPassageStatusLoading(true);

        void getPassageStatus(selectedPassageId || null)
            .then((status) => {
                if (!active || !scopeStillOwnsPage(scope)) return;
                setPassageStatus(status);
            })
            .catch(() => {
                if (active && scopeStillOwnsPage(scope)) setPassageStatus(NO_PASSAGE_ACCESS);
            })
            .finally(() => {
                if (active && scopeStillOwnsPage(scope)) setPassageStatusLoading(false);
            });

        return () => {
            active = false;
        };
    }, [authUserId, memberships, scopeStillOwnsPage, selectedPassageId]);

    useEffect(() => {
        const onPassageChanged = (event: Event) => {
            const scope = getAuthIdentityScope();
            if (!scopeStillOwnsPage(scope)) return;
            const nextId = ((event as CustomEvent<{ voyageId?: string | null }>).detail?.voyageId || '').trim();
            setSelectedPassageId((currentId) => {
                if (currentId !== nextId) resetReadinessState();
                return nextId;
            });
            selectedPassageRef.current = nextId;
            if (!nextId) {
                setActiveVoyageName(null);
                setPlanDeparture('');
            }
        };
        window.addEventListener('thalassa:passage-changed', onPassageChanged);
        return () => window.removeEventListener('thalassa:passage-changed', onPassageChanged);
    }, [resetReadinessState, scopeStillOwnsPage]);

    // Saved Routes has a fast path and a compatibility path. The small,
    // account-scoped voyage index paints first; legacy logbook geometry is
    // reconciled later without holding the picker hostage.
    const reloadDropdown = useCallback(async () => {
        const scope = getAuthIdentityScope();
        if (!scopeStillOwnsPage(scope)) return;
        const requestVersion = ++dropdownReloadVersion.current;
        const cachedCanonicalTraces = loadSavedTraces(scope);
        const cachedCanonicalIds = new Set(cachedCanonicalTraces.map((trace) => trace.id));
        const cachedPassageVoyageIds = canonicalPassageVoyageIds(cachedCanonicalTraces);
        const visibleCachedDrafts = getCachedDraftVoyages().filter((draft) =>
            isCanonicalSavedRouteDraft(draft, cachedCanonicalIds, cachedPassageVoyageIds),
        );
        if (visibleCachedDrafts.length > 0) {
            // Keep any verified shared passages while the skipper's own cached
            // routes appear immediately.
            setDraftVoyages((previous) => {
                const prior = new Map(previous.map((row) => [row.id, row] as const));
                return [
                    ...new Map(
                        [
                            ...visibleCachedDrafts.map((row) => preserveRouteGeometry(row, prior.get(row.id))),
                            ...previous.filter((row) => row.isShared),
                        ].map((row) => [row.id, row] as const),
                    ).values(),
                ];
            });
            setSavedRoutesLoading(false);
        } else if (savedRoutesSettledGeneration.current !== scope.generation) {
            // Show the initial load only. Once this identity has confirmed an
            // empty library, a background refresh should update silently so
            // the empty-state card does not blink in and out.
            setSavedRoutesLoading(true);
        }
        try {
            const { getCachedActiveVoyage } = await import('../services/VoyageService');
            if (requestVersion !== dropdownReloadVersion.current || !scopeStillOwnsPage(scope)) return;
            const v = getCachedActiveVoyage();
            if (v) setActiveVoyageName(savedRouteDisplayName(v));
        } catch {
            /* non-critical */
        }

        // The voyage index is a compact, indexed query. Render it before doing
        // the legacy scan; the old flow waited for as many as 10,000 log rows
        // before showing a single saved route.
        const fetchedDrafts = await getDraftVoyages().catch(() => visibleCachedDrafts);
        if (requestVersion !== dropdownReloadVersion.current || !scopeStillOwnsPage(scope)) return;
        // Keep every raw draft available for the exact-mirror matching pass;
        // only canonical rows paint in this early phase. This prevents a
        // deleted first leg's abandoned planning row from flashing in Saved
        // Routes while its former sibling is being normalised.
        const allDrafts = fetchedDrafts;
        const canonicalCachedDrafts = allDrafts.filter((draft) =>
            isCanonicalSavedRouteDraft(draft, cachedCanonicalIds, cachedPassageVoyageIds),
        );
        setDraftVoyages((previous) => {
            const prior = new Map(previous.map((row) => [row.id, row] as const));
            return [
                ...new Map(
                    [
                        ...canonicalCachedDrafts.map((row) => preserveRouteGeometry(row, prior.get(row.id))),
                        ...previous.filter((row) => row.isShared),
                    ].map((row) => [row.id, row] as const),
                ).values(),
            ];
        });
        savedRoutesSettledGeneration.current = scope.generation;
        setSavedRoutesLoading(false);

        // Do not force a refresh here. A cache or in-flight request is already
        // fresh enough to enrich the list, and force=true caused a second full
        // history download when crew membership finished loading.
        const [routesAndTracks, sharedResult, canonicalTraces] = await Promise.all([
            fetchRoutesAndTracks(),
            membershipsLoaded ? getAuthorizedSharedVoyages() : Promise.resolve({ voyages: [], complete: false }),
            import('../services/savedRoutesSync')
                .then(({ syncSavedRoutes }) => syncSavedRoutes())
                .catch(() => loadSavedTraces(scope)),
        ]);
        if (requestVersion !== dropdownReloadVersion.current || !scopeStillOwnsPage(scope)) return;
        const canonicalById = new Map(canonicalTraces.map((trace) => [trace.id, trace] as const));
        const canonicalIds = new Set(canonicalById.keys());
        const exactPassageVoyageIds = canonicalPassageVoyageIds(canonicalTraces);
        const canonicalByPlannedRouteId = new Map<string, (typeof canonicalTraces)[number]>();
        for (const trace of canonicalTraces) {
            if (trace.plannedRouteId) canonicalByPlannedRouteId.set(trace.plannedRouteId, trace);
        }
        // Backfill precise ids for pre-migration routes only when geometry is
        // one-to-one. A repeated name or same-day passage is not identity;
        // the metre-quantised full polyline is. This means existing saved
        // routes gain the same safe delete lifecycle as new saves without
        // risking a cross-link between two similar passages.
        const legacyRoutesByFingerprint = new Map<string, typeof routesAndTracks.routes>();
        for (const route of routesAndTracks.routes) {
            if (route.savedRouteId) continue;
            const fingerprint = savedRouteGeometryFingerprint(route.points);
            if (!fingerprint) continue;
            const matches = legacyRoutesByFingerprint.get(fingerprint) ?? [];
            matches.push(route);
            legacyRoutesByFingerprint.set(fingerprint, matches);
        }
        const canonicalByFingerprint = new Map<string, typeof canonicalTraces>();
        for (const trace of canonicalTraces) {
            const fingerprint = savedRouteGeometryFingerprint(trace.points);
            if (!fingerprint) continue;
            const matches = canonicalByFingerprint.get(fingerprint) ?? [];
            matches.push(trace);
            canonicalByFingerprint.set(fingerprint, matches);
        }
        for (const trace of canonicalTraces) {
            // Prefer every explicit identity available before considering the
            // geometry-only bridge for pre-migration records. A partial link
            // is still repairable: for example an old trace may know its
            // planned_* id but not its planning-row UUID yet.
            let route = trace.plannedRouteId
                ? routesAndTracks.routes.find((candidate) => candidate.id === trace.plannedRouteId)
                : undefined;
            if (!route && trace.passageVoyageId) {
                const matches = routesAndTracks.routes.filter(
                    (candidate) => candidate.linkedPlanId === trace.passageVoyageId,
                );
                if (matches.length === 1) route = matches[0];
            }
            if (!route) {
                const matches = routesAndTracks.routes.filter((candidate) => candidate.savedRouteId === trace.id);
                if (matches.length === 1) route = matches[0];
            }
            if (!route) {
                const fingerprint = savedRouteGeometryFingerprint(trace.points);
                const routeMatches = fingerprint ? (legacyRoutesByFingerprint.get(fingerprint) ?? []) : [];
                const traceMatches = fingerprint ? (canonicalByFingerprint.get(fingerprint) ?? []) : [];
                if (routeMatches.length !== 1 || traceMatches.length !== 1) continue;
                route = routeMatches[0];
            }
            const needsPlannedRouteId = !trace.plannedRouteId;
            const needsPassageVoyageId = !trace.passageVoyageId && Boolean(route.linkedPlanId);
            if (!needsPlannedRouteId && !needsPassageVoyageId) continue;
            const linked = linkTraceToPassage(
                trace.id,
                {
                    ...(needsPlannedRouteId ? { plannedRouteId: route.id } : {}),
                    ...(needsPassageVoyageId && route.linkedPlanId ? { passageVoyageId: route.linkedPlanId } : {}),
                },
                scope,
            );
            if (!linked) continue;
            canonicalById.set(linked.id, linked);
            canonicalByPlannedRouteId.set(route.id, linked);
            void import('../services/savedRouteGraph')
                .then(({ linkSavedRoutePassageGraph }) =>
                    linkSavedRoutePassageGraph(
                        linked.id,
                        { plannedRouteId: route.id, passageVoyageId: route.linkedPlanId },
                        scope,
                    ),
                )
                .catch(() => {});
        }
        // One cautious legacy repair: older builds created the exact
        // ship-log/voyage mirror but never persisted the canonical trace id.
        // A recognisable generated "2nd Leg" is not a user-authored route
        // name; its remaining geometry is promoted to a normal first route,
        // then all three stores are stamped with the new exact id. We do not
        // infer links for ordinary names — repeated island runs are common.
        for (const route of routesAndTracks.routes) {
            if (route.savedRouteId || !isLegacyGeneratedLeg(route.label) || route.points.length < 2) continue;
            const alreadyLinked = canonicalTraces.some(
                (trace) =>
                    trace.plannedRouteId === route.id ||
                    (route.linkedPlanId !== undefined && trace.passageVoyageId === route.linkedPlanId),
            );
            if (alreadyLinked) continue;
            const { trace, persisted } = saveTrace(legacyGeneratedLegName(route.label), route.points, {
                plannedRouteId: route.id,
                ...(route.linkedPlanId ? { passageVoyageId: route.linkedPlanId } : {}),
            });
            if (!persisted) continue;
            canonicalById.set(trace.id, trace);
            canonicalByPlannedRouteId.set(route.id, trace);
            void import('../services/savedRouteGraph')
                .then(({ linkSavedRoutePassageGraph }) =>
                    linkSavedRoutePassageGraph(
                        trace.id,
                        { plannedRouteId: route.id, passageVoyageId: route.linkedPlanId },
                        scope,
                    ),
                )
                .catch(() => {});
        }
        // A voyage row is not, on its own, a Saved Route. New rows carry a
        // canonical trace id; old rows need to be proven by an exact
        // planned-route mirror below. This one distinction keeps a deleted
        // route from surviving forever as an unlinked "second leg" in the
        // Passage Planning selector.
        const visibleDrafts = allDrafts.filter((draft) =>
            isCanonicalSavedRouteDraft(draft, canonicalIds, exactPassageVoyageIds),
        );
        const matchableDrafts = allDrafts.filter(
            (draft) => !draft.saved_route_id || canonicalById.has(draft.saved_route_id),
        );
        const visibleRoutes = routesAndTracks.routes.filter(
            (route) => !route.savedRouteId || canonicalById.has(route.savedRouteId),
        );
        const norm = (s: string) => s.trim().toLowerCase();
        const draftByName = new Map<string, Voyage[]>();
        for (const draft of matchableDrafts) {
            const key = norm(draft.voyage_name);
            const matches = draftByName.get(key) ?? [];
            matches.push(draft);
            draftByName.set(key, matches);
        }
        const matchedDraftIds = new Set<string>();

        // For each logbook route, surface a Voyage-shaped row. If a
        // matching draft already exists, use it (we have its real
        // UUID). Otherwise stub one out — the on-select handler
        // creates the actual voyages-table row when the user picks
        // it, so we don't pollute the table with rows for routes
        // the user never actually picks.
        //
        // We also attach the complete saved polyline (and its first/last
        // points) to the matching voyage row. PassageSummaryCard can then
        // render the actual sea path without guessing from PassageStore's
        // globally cached last chart route.
        const ownRows: VoyageRow[] = visibleRoutes.map((r) => {
            const first = r.points[0];
            const last = r.points[r.points.length - 1];
            const departureCoords = first ? { lat: first.lat, lon: first.lon } : undefined;
            const arrivalCoords = last ? { lat: last.lat, lon: last.lon } : undefined;
            const routeCoordinates = r.points.map((point) => ({ lat: point.lat, lon: point.lon }));
            const distanceNm = r.distanceNm > 0 ? r.distanceNm : undefined;
            const durationHours = r.durationHours;
            // The route's first-entry timestamp is what the user typed
            // as plan.departureDate at save time (PassagePlanSave seeds
            // entries[0].timestamp = depDate). Use it as the inferred
            // departure for stub rows AND as a fallback for matched
            // drafts that haven't had their date persisted yet.
            const inferredDeparture = new Date(r.timestamp).toISOString();
            const inferredEta = derivePassageSummarySchedule({
                routeCoordinates,
                fallbackDistanceNm: distanceNm,
                departureTime: inferredDeparture,
                cruisingSpeedKt: settings.vessel?.cruisingSpeed,
            }).eta;
            // New saves carry the immutable planning-record UUID on every
            // log row. That is the only authoritative link: route labels can
            // repeat (e.g. the same island run next season), so never let a
            // label-only match overwrite a different saved passage.
            const linkedDraft = r.linkedPlanId
                ? matchableDrafts.find((draft) => draft.id === r.linkedPlanId && !matchedDraftIds.has(draft.id))
                : undefined;

            // Older/offline routes predate linked_plan_id. Recover those only
            // when the label match is unambiguous, preferring the matching
            // departure day when the skipper has planned the same route more
            // than once. Ambiguity intentionally remains a separate logbook
            // row; showing a wrong curve is worse than asking for a re-save.
            const legacyCandidates = r.linkedPlanId
                ? []
                : (draftByName.get(norm(r.label)) ?? []).filter((draft) => !matchedDraftIds.has(draft.id));
            const sameDayCandidates = legacyCandidates.filter(
                (draft) => routeDayKey(draft.departure_time ?? draft.created_at) === routeDayKey(inferredDeparture),
            );
            const matched =
                linkedDraft ??
                (sameDayCandidates.length === 1
                    ? sameDayCandidates[0]
                    : legacyCandidates.length === 1
                      ? legacyCandidates[0]
                      : undefined);
            if (matched) {
                matchedDraftIds.add(matched.id);
                const canonicalName = r.savedRouteId
                    ? canonicalById.get(r.savedRouteId)?.name
                    : canonicalByPlannedRouteId.get(r.id)?.name;
                return {
                    ...matched,
                    ...(canonicalName
                        ? { voyage_name: canonicalName }
                        : { voyage_name: formatStoredPlannedRouteName(matched.voyage_name) ?? matched.voyage_name }),
                    // Fall back to the route-derived dates only when the
                    // matched draft hasn't been given them yet. Don't
                    // overwrite a date the user has explicitly set via
                    // the dropdown's date picker.
                    departure_time: matched.departure_time ?? inferredDeparture,
                    eta: matched.eta ?? inferredEta,
                    // Backfill the canonical trace link when the table row
                    // lacks it — a voyage materialised from a standalone
                    // logbook stub was created WITHOUT saved_route_id, and
                    // every re-pick after End Voyage broke geometry, the
                    // route check, auto-follow and the public publish at
                    // once (Shane 2026-08-26: "plan a route first. even
                    // though i have already added a route??").
                    saved_route_id:
                        matched.saved_route_id ?? r.savedRouteId ?? canonicalByPlannedRouteId.get(r.id)?.id ?? null,
                    departureCoords,
                    arrivalCoords,
                    routeCoordinates,
                    plannedRouteId: r.id,
                    distanceNm,
                    durationHours,
                };
            }
            // Route names are auto-generated as "A - B" by routeAutoName, while
            // logbook labels use "A → B". Splitting on the arrow alone left the
            // ENTIRE name in departure_port and nothing in destination_port for
            // every hyphen-named route (Shane 2026-07-29: "departure as the
            // entire route name eg: newport - lady musgrave").
            //
            // These stay PLACE NAMES rather than the pin coordinates, even
            // though the coordinates are authoritative and sit right there:
            // departure_port feeds isSameCountry() for customs clearance
            // (ReadinessCardStack.tsx:312) and names the leg in startLeg()
            // (VoyageService.ts:745). A lat/lon in that column would silently
            // break both. The coordinates ARE surfaced — as departureCoords
            // and arrivalCoords, which is what the passage cards read.
            const [depPart, arrPart] = splitRouteEndpoints(r.label);
            // Stub voyage — id starts with "logbook:" so the on-
            // select handler knows to find-or-create a real row
            // before calling setActivePassage.
            return {
                id: `logbook:${r.id}`,
                user_id: '',
                vessel_id: null,
                voyage_name:
                    (r.savedRouteId
                        ? canonicalById.get(r.savedRouteId)?.name
                        : canonicalByPlannedRouteId.get(r.id)?.name) ?? r.label,
                departure_port: (depPart ?? '').trim() || null,
                destination_port: (arrPart ?? '').trim() || null,
                departure_time: inferredDeparture,
                eta: inferredEta,
                // Seed from the vessel's standing complement, not a bare 1 —
                // this row becomes the voyage Cast Off and the float plan
                // read souls-on-board from (Shane 2026-08-04: "the vessel
                // profile shows two crew... that is not flowing through").
                crew_count: vesselCrewAboard(settings.vessel),
                status: 'planning',
                weather_master_id: null,
                notes: null,
                created_at: new Date(r.timestamp).toISOString(),
                updated_at: new Date(r.timestamp).toISOString(),
                // The canonical trace link rides the stub into createVoyage —
                // without it the materialised row had no saved_route_id and
                // every downstream consumer (geometry, route check, follow,
                // public publish) silently lost the route.
                // Old mirrors predate the savedRouteId column on their
                // rows — the planned-mirror map (geometry-backfilled for
                // pre-migration routes) is the authoritative bridge.
                saved_route_id: r.savedRouteId ?? canonicalByPlannedRouteId.get(r.id)?.id ?? null,
                departureCoords,
                arrivalCoords,
                routeCoordinates,
                plannedRouteId: r.id,
                distanceNm,
                durationHours,
            };
        });

        const attachCanonicalTraceGeometry = (draft: Voyage): VoyageRow => {
            const trace = draft.saved_route_id
                ? canonicalById.get(draft.saved_route_id)
                : Array.from(canonicalById.values()).find((candidate) => candidate.passageVoyageId === draft.id);
            const routeCoordinates = (trace?.points ?? []).filter(
                (point) => Number.isFinite(point.lat) && Number.isFinite(point.lon),
            );
            if (routeCoordinates.length < 2) return draft;
            const departureCoords = routeCoordinates[0];
            const arrivalCoords = routeCoordinates[routeCoordinates.length - 1];
            const distanceNm = routeDistanceNm(routeCoordinates) ?? undefined;
            const speedKt = settings.vessel?.cruisingSpeed || 5.5;
            return {
                ...draft,
                departureCoords,
                arrivalCoords,
                routeCoordinates,
                plannedRouteId: trace?.plannedRouteId,
                distanceNm,
                // The summary card shows Duration alongside Distance — this
                // path left it undefined and the card showed an em-dash.
                durationHours: distanceNm ? distanceNm / speedKt : undefined,
            };
        };

        // A canonical saved route is still valid when its historic logbook
        // mirror is delayed, archived, or absent. Deliberately do not append
        // unlinked voyage rows here: they have no chart route to open and are
        // the precise shape left behind by the old missing-root/second-leg
        // failure. Exact legacy mirrors above remain visible because they
        // matched a planned-route row by immutable ID (or one unambiguous
        // historical name/date pair).
        ownRows.push(
            ...visibleDrafts.filter((draft) => !matchedDraftIds.has(draft.id)).map(attachCanonicalTraceGeometry),
        );

        // ── ONE row per saved route (Shane 2026-08-27: "the list is
        // doubling up and sometimes even tripling up"). Every End-Voyage-
        // then-replan cycle leaves a planning row behind; they used to be
        // hidden as unlinked, and the 2026-08-26 link-healing resurrected
        // them all — same route, many rows. The picker keeps the best row
        // per canonical route: the skipper's current selection first, then
        // one that carries geometry, then a materialised voyage over a
        // logbook stub, then the most recently touched. Rows without a
        // route link (manual voyages) are untouched.
        {
            const rowScore = (row: VoyageRow): number => {
                let score = 0;
                if (row.id === selectedPassageRef.current) score += 8;
                if ((row.routeCoordinates?.length ?? 0) >= 2) score += 4;
                if (!row.id.startsWith('logbook:')) score += 2;
                return score;
            };
            const rowStamp = (row: VoyageRow): number => Date.parse(row.updated_at ?? row.created_at ?? '') || 0;
            // A row can name its route two ways: saved_route_id on the row,
            // or the trace's passageVoyageId back-link naming the row. The
            // remaining double was one of each — same route, different key
            // (Shane 2026-08-27 screenshot: two "(1st Leg)" rows).
            const traceByPassageVoyage = new Map<string, string>();
            for (const trace of canonicalById.values()) {
                if (trace.passageVoyageId) traceByPassageVoyage.set(trace.passageVoyageId, trace.id);
            }
            const routeKeyOf = (row: VoyageRow): string | undefined =>
                row.saved_route_id?.trim() || traceByPassageVoyage.get(row.id);
            const bestByRoute = new Map<string, VoyageRow>();
            for (const row of ownRows) {
                const key = routeKeyOf(row);
                if (!key) continue;
                const existing = bestByRoute.get(key);
                if (
                    !existing ||
                    rowScore(row) > rowScore(existing) ||
                    (rowScore(row) === rowScore(existing) && rowStamp(row) > rowStamp(existing))
                ) {
                    bestByRoute.set(key, row);
                }
            }
            const pruned = ownRows.filter((row) => {
                const key = routeKeyOf(row);
                return !key || bestByRoute.get(key) === row;
            });
            ownRows.length = 0;
            ownRows.push(...pruned);
        }

        // ── Derived "(Passage)" rows (Shane-approved design 2026-08-04) ──
        // One per multi-leg trip: the legs stitched, selectable exactly like
        // any other planning row. The `logbook:` id prefix reuses the same
        // materialise-on-select path below; saved_route_id is the trip's
        // FIRST leg (its id IS the tripId — a real trace), so the float plan
        // waypoints and the Cast Off destination seed both resolve. Skipped
        // once a materialised passage voyage exists for the trip.
        for (const rollup of buildTripPassageRollups(canonicalTraces)) {
            if (ownRows.some((row) => row.saved_route_id === rollup.tripId)) continue;
            const routeCoordinates = rollup.points.map((point) => ({ lat: point.lat, lon: point.lon }));
            const distanceNm = routeDistanceNm(routeCoordinates) ?? undefined;
            const speedKt = settings.vessel?.cruisingSpeed || 5.5;
            const durationHours = distanceNm ? distanceNm / speedKt : undefined;
            // DETERMINISTIC stamps (newest member leg), NOT Date.now(): a
            // fresh timestamp per reload made every pass produce a
            // "different" row, and downstream effects keyed on row content
            // re-fired on each one — churn this page cannot afford (see the
            // storm-proofing note on the reload listeners).
            const memberTraces = canonicalTraces.filter((trace) => (trace.tripId ?? trace.id) === rollup.tripId);
            const newestIso = memberTraces.reduce(
                (acc, trace) => {
                    const stamp = trace.updatedAt ?? trace.createdAt;
                    return stamp > acc ? stamp : acc;
                },
                memberTraces[0]?.createdAt ?? new Date(0).toISOString(),
            );
            const newestMs = Date.parse(newestIso);
            const eta =
                durationHours && Number.isFinite(newestMs)
                    ? new Date(newestMs + durationHours * 3_600_000).toISOString()
                    : null;
            ownRows.push({
                id: `logbook:${rollup.id}`,
                user_id: '',
                vessel_id: null,
                voyage_name: rollup.name,
                departure_port: rollup.originName,
                destination_port: rollup.destName,
                departure_time: newestIso,
                eta,
                crew_count: vesselCrewAboard(settings.vessel),
                status: 'planning',
                weather_master_id: null,
                notes: null,
                created_at: newestIso,
                updated_at: newestIso,
                saved_route_id: rollup.tripId,
                departureCoords: routeCoordinates[0],
                arrivalCoords: routeCoordinates[routeCoordinates.length - 1],
                routeCoordinates,
                distanceNm,
                durationHours,
            } as VoyageRow);
        }

        const activeId = getActivePassageId();

        // Keep an explicitly selected, still-valid own draft even when it has
        // no matching logbook route. This mirrors the shared-row rule below:
        // a missing polyline is not evidence that a voyage is unauthorized.
        const activeOwnDraft = activeId ? visibleDrafts.find((draft) => draft.id === activeId) : undefined;
        if (activeOwnDraft && !ownRows.some((row) => row.id === activeOwnDraft.id)) {
            ownRows.push(attachCanonicalTraceGeometry(activeOwnDraft));
        }

        // CAST-OFF RESCUE. The rescue above searches `visibleDrafts`, which
        // comes from getDraftVoyages() — hard-filtered to status 'planning'
        // (VoyageService.ts:707 and :712). castOff() flips the SAME voyage id
        // to 'active', so the moment a passage is under way it drops out of
        // every list here, `draftVoyages.find(v => v.id === selectedPassageId)`
        // in ReadinessCardStack returns undefined, and the whole card stack
        // reads blank: no departureCoords ("Plan a route first" from Weather
        // Windows and Ocean Currents), no distance, no duration, no ports.
        //
        // getPassageStatus() is status-agnostic, so the cards still MOUNT for
        // an owned active voyage — they just have nothing to render. Put the
        // row back, with geometry, so an under-way passage is as complete as a
        // planned one.
        if (activeId && !ownRows.some((row) => row.id === activeId)) {
            const cachedActive = getCachedActiveVoyage();
            if (cachedActive && cachedActive.id === activeId) {
                ownRows.push(attachCanonicalTraceGeometry(cachedActive));
            }
        }

        const sharedRows: VoyageRow[] = sharedResult.voyages.map(({ voyage, ownerEmail }) => ({
            ...voyage,
            isShared: true,
            sharedOwnerEmail: ownerEmail,
        }));
        const rows = [...new Map([...ownRows, ...sharedRows].map((row) => [row.id, row] as const)).values()];

        // A transient shared-voyage query failure must not make a valid row
        // disappear from the selector. Keep the last verified shared rows
        // until a complete refresh can replace them.
        setDraftVoyages((previous) => {
            if (sharedResult.complete) return rows;
            return [
                ...new Map(
                    [...rows, ...previous.filter((row) => row.isShared)].map((row) => [row.id, row] as const),
                ).values(),
            ];
        });

        const activeIdInRows = activeId ? rows.some((row) => row.id === activeId) : false;
        if (activeId && activeIdInRows) {
            const vMatch = rows.find((row) => row.id === activeId);
            if (vMatch?.departure_time) setPlanDeparture(localDateTimeValue(vMatch.departure_time));
            if (vMatch) setActiveVoyageName(savedRouteDisplayName(vMatch));
        } else if (activeId && membershipsLoaded && sharedResult.complete) {
            // Only heal after accepted memberships and every shared ownership
            // lookup have completed. Re-verify the exact active ID before
            // clearing it, and never substitute one of the user's routes for
            // a valid shared passage.
            const activeStatus = await getPassageStatus(activeId);
            if (requestVersion !== dropdownReloadVersion.current || !scopeStillOwnsPage(scope)) return;
            const activeWasDeletedSavedRoute = Boolean(
                activeId &&
                fetchedDrafts.some((draft) => draft.id === activeId && draft.saved_route_id) &&
                !visibleDrafts.some((draft) => draft.id === activeId),
            );
            if (!activeStatus.visible || activeWasDeletedSavedRoute) {
                console.warn(`[CrewManagement] clearing inaccessible active passage "${activeId}"`);
                clearPassagePlan();
                selectedPassageRef.current = '';
                setSelectedPassageId('');
                setActiveVoyageName(null);
                setPlanDeparture('');
                resetReadinessState();
            }
        }

        // Backfill/reconcile ETA from the actual saved curve and the vessel
        // profile. A historic logbook timestamp is not a duration source:
        // changing cruise speed or departure must move ETA deterministically.
        for (const row of rows) {
            if (row.id && !row.id.startsWith('logbook:') && !row.isShared && row.departure_time) {
                const schedule = derivePassageSummarySchedule({
                    routeCoordinates: row.routeCoordinates,
                    fallbackDistanceNm: row.distanceNm,
                    departureTime: row.departure_time,
                    cruisingSpeedKt: settings.vessel?.cruisingSpeed,
                });
                if (!schedule.eta || (row.eta === schedule.eta && row.departure_time === schedule.departureTime))
                    continue;
                if (etaBackfillPatchedRef.current.has(row.id)) continue;
                etaBackfillPatchedRef.current.add(row.id);
                const patch =
                    row.departure_time === schedule.departureTime
                        ? { eta: schedule.eta }
                        : { departure_time: schedule.departureTime, eta: schedule.eta };
                void updateVoyage(row.id, patch).then((result) => {
                    if (requestVersion !== dropdownReloadVersion.current || !scopeStillOwnsPage(scope)) return;
                    if (result.voyage) {
                        setDraftVoyages((prev) =>
                            prev.map((v) =>
                                v.id === row.id
                                    ? {
                                          ...result.voyage!,
                                          departureCoords: v.departureCoords,
                                          arrivalCoords: v.arrivalCoords,
                                          routeCoordinates: v.routeCoordinates,
                                          plannedRouteId: v.plannedRouteId,
                                          distanceNm: v.distanceNm,
                                          durationHours: v.durationHours,
                                      }
                                    : v,
                            ),
                        );
                    }
                });
            }
        }
    }, [
        membershipsLoaded,
        resetReadinessState,
        scopeStillOwnsPage,
        settings.vessel?.cruisingSpeed,
        settings.vessel?.crewCount,
    ]);

    useEffect(() => {
        // Wait for auth to land before the cloud refresh. The account-scoped
        // local cache has already painted synchronously where available.
        const scope = getAuthIdentityScope();
        if (!authUserId || privateScopeKey !== scope.key || !scopeStillOwnsPage(scope)) return;
        void reloadDropdown();
        // ── Storm-proofing (Shane 2026-08-04: planning page killed by an
        // IPC flood — "129 DrawingArea_AcceleratedAnimationDidStart" — then
        // rebooted to the Glass). These change events can arrive in bursts
        // (sync round-trips, repair cascades firing saved-routes-changed per
        // repaired row); each direct reload re-rendered the whole animated
        // row list. Coalesce to at most one reload per interval, trailing-
        // edge, so a burst of ANY size costs one repaint.
        const RELOAD_MIN_INTERVAL_MS = 1_500;
        let lastReloadAt = Date.now();
        let pendingReload: ReturnType<typeof setTimeout> | null = null;
        const scheduleReload = () => {
            if (pendingReload) return;
            const wait = Math.max(0, lastReloadAt + RELOAD_MIN_INTERVAL_MS - Date.now());
            pendingReload = setTimeout(() => {
                pendingReload = null;
                lastReloadAt = Date.now();
                void reloadDropdown();
            }, wait);
        };
        // Refresh when a passage plan is saved while this page is
        // already mounted — e.g. user saves on the Route Planner and
        // navigates straight here without unmounting. Without this,
        // the new route doesn't appear in the dropdown until the
        // component fully remounts.
        const onSaved = () => {
            scheduleReload();
        };
        // Also refresh when the departure time changes elsewhere
        // (RoutePlanner date input, WeatherWindowCard accept). Without
        // this the active voyage's date stays stale in the dropdown
        // and the Passage Summary card until the user manually
        // remounts the page.
        const onDepartureUpdate = (event: Event) => {
            const detail = (event as CustomEvent<{ source?: string }>).detail;
            // Summary/date/Weather Window writes already update the active row
            // optimistically. Refetching before Supabase confirms them can
            // briefly repaint the old ETA.
            if (detail?.source === 'crew-management') return;
            scheduleReload();
        };
        // Canonical trace deletion/rebase and its asynchronous Log/Voyage
        // cleanup can land while Passage Planning stays mounted. Both events
        // deliberately share this reload path so the selector never retains a
        // ghost after Plan has already removed it.
        const onSavedRoutesChanged = (event: Event) => {
            const detail = (event as CustomEvent<{ scopeKey?: string; scopeGeneration?: number }>).detail;
            const current = getAuthIdentityScope();
            if (
                detail?.scopeKey &&
                (detail.scopeKey !== current.key ||
                    (detail.scopeGeneration !== undefined && detail.scopeGeneration !== current.generation))
            ) {
                return;
            }
            scheduleReload();
        };
        if (typeof window !== 'undefined') {
            window.addEventListener('thalassa:passage-plan-saved', onSaved);
            window.addEventListener('thalassa:departure-time-updated', onDepartureUpdate);
            window.addEventListener('thalassa:saved-routes-changed', onSavedRoutesChanged);
            window.addEventListener('thalassa:passage-route-graph-changed', onSavedRoutesChanged);
            window.addEventListener('thalassa:routes-and-tracks-changed', onSavedRoutesChanged);
            return () => {
                dropdownReloadVersion.current += 1;
                if (pendingReload) clearTimeout(pendingReload);
                window.removeEventListener('thalassa:passage-plan-saved', onSaved);
                window.removeEventListener('thalassa:departure-time-updated', onDepartureUpdate);
                window.removeEventListener('thalassa:saved-routes-changed', onSavedRoutesChanged);
                window.removeEventListener('thalassa:passage-route-graph-changed', onSavedRoutesChanged);
                window.removeEventListener('thalassa:routes-and-tracks-changed', onSavedRoutesChanged);
            };
        }
        return undefined;
    }, [authUserId, privateScopeKey, reloadDropdown, scopeStillOwnsPage]);

    // ── Handlers ──

    const handleInvite = async () => {
        const scope = getAuthIdentityScope();
        if (!scopeStillOwnsPage(scope)) return;
        const requestVersion = ++inviteOperationVersion.current;
        const email = inviteEmail.trim();
        const registers = [...inviteRegisters];
        const passageId = selectedPassageId;
        if (!email || registers.length === 0) return;
        const includesPassageAccess = registers.some((register) => PASSAGE_REGISTERS.includes(register));
        const ownsSelectedPassage =
            Boolean(passageId) &&
            passageStatus.visible &&
            passageStatus.isOwner &&
            passageStatus.voyageId === passageId &&
            passageStatus.ownerUserId === scope.userId;
        if (includesPassageAccess && !ownsSelectedPassage) {
            setInviteError('Select one of your own passages before sharing passage access.');
            return;
        }

        setInviteLoading(true);
        setInviteError(null);
        setInviteSuccess(false);

        const result = await inviteCrew(email, registers, includesPassageAccess ? passageId : undefined);
        if (requestVersion !== inviteOperationVersion.current || !scopeStillOwnsPage(scope)) return;

        if (result.success) {
            setInviteSuccess(true);
            triggerHaptic('medium');
            if (inviteSuccessTimer.current !== null) window.clearTimeout(inviteSuccessTimer.current);
            inviteSuccessTimer.current = window.setTimeout(() => {
                inviteSuccessTimer.current = null;
                if (requestVersion !== inviteOperationVersion.current || !scopeStillOwnsPage(scope)) {
                    return;
                }
                setShowInviteModal(false);
                setInviteEmail('');
                setInviteRegisters([]);
                setInviteSuccess(false);
                void loadData();
            }, 1200);
        } else {
            setInviteError(result.error || 'Failed to send invite');
            triggerHaptic('heavy');
        }
        setInviteLoading(false);
    };

    const handleSoftDelete = (member: CrewMember, mode: 'captain' | 'crew') => {
        const scope = getAuthIdentityScope();
        if (!scopeStillOwnsPage(scope)) return;
        triggerHaptic('medium');
        if (mode === 'captain') {
            setMyCrew((prev) => prev.filter((m) => m.id !== member.id));
        } else {
            setMemberships((prev) => prev.filter((m) => m.id !== member.id));
        }
        setDeletedMember({ member, mode });
    };

    const handleDismissDelete = async () => {
        if (!deletedMember) return;
        const scope = getAuthIdentityScope();
        if (!scopeStillOwnsPage(scope)) return;
        const { member, mode } = deletedMember;
        setDeletedMember(null);
        try {
            const removed = mode === 'captain' ? await removeCrew(member.id) : await leaveVessel(member.id);
            if (!scopeStillOwnsPage(scope)) return;
            if (removed) return;
            throw new Error('Crew mutation was rejected');
        } catch {
            if (!scopeStillOwnsPage(scope)) return;
            toast.error(mode === 'captain' ? 'Failed to remove crew' : 'Failed to leave vessel');
            if (mode === 'captain') {
                setMyCrew((prev) => [...prev, member]);
            } else {
                setMemberships((prev) => [...prev, member]);
            }
        }
    };

    const handleDisbandGroup = async () => {
        const scope = getAuthIdentityScope();
        if (!scopeStillOwnsPage(scope)) return;
        const sharedSelectionToPreserve =
            selectedPassageId &&
            passageStatus.visible &&
            !passageStatus.isOwner &&
            passageStatus.voyageId === selectedPassageId
                ? selectedPassageId
                : null;
        setDisbanding(true);
        const result = await disbandGroup();
        if (!scopeStillOwnsPage(scope)) return;
        setDisbanding(false);
        setShowDisbandConfirm(false);
        setDisbandConfirmText('');

        if (result.success) {
            // disbandGroup clears legacy local passage state as part of its
            // owner cleanup. That must not eject this user from an unrelated
            // captain's still-authorized shared passage.
            if (sharedSelectionToPreserve) setActivePassage(sharedSelectionToPreserve);
            triggerHaptic('heavy');
            toast.success(
                `Group disbanded — ${result.removedCount} member${result.removedCount !== 1 ? 's' : ''} removed`,
            );
            setMyCrew([]);
        } else {
            toast.error('Failed to disband group');
        }
    };

    const handleUndoDelete = () => {
        const scope = getAuthIdentityScope();
        if (!scopeStillOwnsPage(scope)) return;
        if (deletedMember) {
            if (deletedMember.mode === 'captain') {
                setMyCrew((prev) => [...prev, deletedMember.member]);
            } else {
                setMemberships((prev) => [...prev, deletedMember.member]);
            }
            toast.success('Restored');
        }
        setDeletedMember(null);
    };

    const handleAccept = async (invite: CrewMember) => {
        const scope = getAuthIdentityScope();
        if (!scopeStillOwnsPage(scope)) return;
        triggerHaptic('medium');
        const ok = await acceptInvite(invite.id);
        if (!scopeStillOwnsPage(scope)) return;
        if (ok) {
            toast.success('Invite accepted!');
            void loadData();
        }
    };

    const handleDecline = async (invite: CrewMember) => {
        const scope = getAuthIdentityScope();
        if (!scopeStillOwnsPage(scope)) return;
        triggerHaptic('light');
        const ok = await declineInvite(invite.id);
        if (!scopeStillOwnsPage(scope)) return;
        if (ok) void loadData();
    };

    const handleSavePermissions = async () => {
        if (!editTarget) return;
        const scope = getAuthIdentityScope();
        if (!scopeStillOwnsPage(scope)) return;
        const requestVersion = editLoadVersion.current;
        const target = editTarget;
        const registers = [...editRegisters];
        const byline = {
            prefix: editPrefix.trim() || null,
            firstName: editFirstName.trim() || 'Crew',
            lastName: editLastName.trim() || null,
            nickname: editNickname.trim() || null,
        };
        const shouldSaveByline = editBoatMemberLoaded && Boolean(target.crew_user_id);
        const ok = await updateCrewPermissions(target.id, registers);
        if (requestVersion !== editLoadVersion.current || !scopeStillOwnsPage(scope)) return;
        if (!ok) {
            toast.error('Could not update permissions');
            return;
        }

        // Mirror byline edits to boat_members if the modal had loaded one
        // (i.e. accepted invite, crew member is on the boat). UNIQUE
        // constraint catches collisions; we surface that as a toast and
        // keep the modal open so the owner can pick a different byline.
        let bylineErr: string | null = null;
        if (shouldSaveByline && supabase && target.crew_user_id) {
            const { data: authData } = await supabase.auth.getUser();
            if (
                requestVersion !== editLoadVersion.current ||
                !scopeStillOwnsPage(scope) ||
                authData.user?.id !== scope.userId
            ) {
                return;
            }
            const myId = scope.userId;
            if (myId) {
                const boatId = await activeOwnedBoatId(scope);
                if (requestVersion !== editLoadVersion.current || !scopeStillOwnsPage(scope)) return;
                if (boatId) {
                    const { error } = await supabase
                        .from('boat_members')
                        .update({
                            prefix: byline.prefix,
                            first_name: byline.firstName,
                            last_name: byline.lastName,
                            nickname: byline.nickname,
                        })
                        .match({ boat_id: boatId, user_id: target.crew_user_id });
                    if (requestVersion !== editLoadVersion.current || !scopeStillOwnsPage(scope)) return;
                    if (error) {
                        bylineErr =
                            error.code === '23505'
                                ? 'That byline is already taken on this boat — try a nickname or surname.'
                                : 'Could not save byline.';
                    }
                }
            }
        }

        if (bylineErr) {
            toast.error(bylineErr);
            return; // Keep the modal open so the owner can retry.
        }
        setEditTarget(null);
        toast.success('Permissions updated');
        void loadData();
    };

    const handleEditMember = async (member: CrewMember) => {
        const scope = getAuthIdentityScope();
        if (!scopeStillOwnsPage(scope)) return;
        const requestVersion = ++editLoadVersion.current;
        setEditTarget(member);
        setEditRegisters([...member.shared_registers]);
        setEditPrefix('');
        setEditFirstName('');
        setEditLastName('');
        setEditNickname('');
        setEditBoatMemberLoaded(false);

        // The bridge row exists only for accepted crew.
        if (!supabase || !member.crew_user_id || member.status !== 'accepted') return;
        const { data: authData } = await supabase.auth.getUser();
        if (
            requestVersion !== editLoadVersion.current ||
            !scopeStillOwnsPage(scope) ||
            authData.user?.id !== scope.userId
        ) {
            return;
        }

        const boatId = await activeOwnedBoatId(scope);
        if (requestVersion !== editLoadVersion.current || !scopeStillOwnsPage(scope) || !boatId) return;

        const { data: boatMember } = await supabase
            .from('boat_members')
            .select('prefix, first_name, last_name, nickname')
            .eq('boat_id', boatId)
            .eq('user_id', member.crew_user_id)
            .maybeSingle();
        if (requestVersion !== editLoadVersion.current || !scopeStillOwnsPage(scope) || !boatMember) {
            return;
        }

        setEditPrefix(boatMember.prefix ?? '');
        setEditFirstName(boatMember.first_name ?? '');
        setEditLastName(boatMember.last_name ?? '');
        setEditNickname(boatMember.nickname ?? '');
        setEditBoatMemberLoaded(true);
    };

    const closeEditMember = () => {
        const scope = getAuthIdentityScope();
        if (!scopeStillOwnsPage(scope)) return;
        editLoadVersion.current += 1;
        setEditTarget(null);
        setEditRegisters([]);
        setEditBoatMemberLoaded(false);
    };

    /**
     * The one persistence path for every Passage Planning departure edit.
     * Summary time changes, date-picker changes, and Weather Window acceptance
     * all derive ETA from the same saved route + vessel cruise speed.
     */
    const handlePassageDepartureTimeChange = useCallback(
        (passageId: string, requestedDeparture: string, _providedEta?: string | null) => {
            const scope = getAuthIdentityScope();
            if (
                !scopeStillOwnsPage(scope) ||
                !passageId ||
                selectedPassageRef.current !== passageId ||
                !passageStatus.isOwner ||
                passageStatus.voyageId !== passageId ||
                passageStatus.ownerUserId !== scope.userId
            ) {
                return;
            }
            const row = draftVoyages.find((voyage) => voyage.id === passageId);
            if (!row || row.isShared || row.id.startsWith('logbook:')) return;

            const schedule = derivePassageSummarySchedule({
                routeCoordinates: row.routeCoordinates,
                fallbackDistanceNm: row.distanceNm,
                departureTime: requestedDeparture,
                cruisingSpeedKt: settings.vessel?.cruisingSpeed,
            });
            const version = ++departureUpdateVersion.current;
            const patch = { departure_time: schedule.departureTime, eta: schedule.eta };
            setPlanDeparture(localDateTimeValue(schedule.departureTime));
            setDraftVoyages((previous) =>
                previous.map((voyage) => (voyage.id === passageId ? { ...voyage, ...patch } : voyage)),
            );

            // The event keeps Weather Windows and any mounted Summary card in
            // lockstep without waiting for the network round-trip.
            try {
                const departureDate = new Date(schedule.departureTime);
                window.dispatchEvent(
                    new CustomEvent('thalassa:departure-time-updated', {
                        detail: {
                            voyageId: passageId,
                            hhmm: `${String(departureDate.getHours()).padStart(2, '0')}:${String(
                                departureDate.getMinutes(),
                            ).padStart(2, '0')}`,
                            iso: schedule.departureTime,
                            source: 'crew-management',
                            scopeKey: scope.key,
                            generation: scope.generation,
                        },
                    }),
                );
            } catch {
                /* SSR / legacy WebView safety */
            }

            void updateVoyage(passageId, patch).then((result) => {
                if (
                    version !== departureUpdateVersion.current ||
                    !scopeStillOwnsPage(scope) ||
                    selectedPassageRef.current !== passageId ||
                    !result.voyage
                ) {
                    return;
                }
                setDraftVoyages((previous) =>
                    previous.map((voyage) =>
                        voyage.id === passageId
                            ? {
                                  ...result.voyage!,
                                  departureCoords: voyage.departureCoords,
                                  arrivalCoords: voyage.arrivalCoords,
                                  routeCoordinates: voyage.routeCoordinates,
                                  plannedRouteId: voyage.plannedRouteId,
                                  distanceNm: voyage.distanceNm,
                                  durationHours: voyage.durationHours,
                              }
                            : voyage,
                    ),
                );
            });
        },
        [draftVoyages, passageStatus, scopeStillOwnsPage, settings.vessel?.cruisingSpeed],
    );

    const handleDepartureDateChange = (value: string) => {
        const scope = getAuthIdentityScope();
        const passageId = selectedPassageId;
        if (
            !scopeStillOwnsPage(scope) ||
            !passageId ||
            !passageStatus.isOwner ||
            passageStatus.voyageId !== passageId ||
            passageStatus.ownerUserId !== scope.userId
        ) {
            return;
        }
        if (!value) {
            setPlanDeparture('');
            return;
        }
        const row = draftVoyages.find((voyage) => voyage.id === passageId);
        const departureIso = departureOnLocalDate(value, row?.departure_time, new Date());
        if (!departureIso) return;
        handlePassageDepartureTimeChange(passageId, departureIso);
    };

    const toggleRegister = (
        register: SharedRegister,
        list: SharedRegister[],
        setList: (v: SharedRegister[]) => void,
    ) => {
        if (list.includes(register)) {
            setList(list.filter((r) => r !== register));
        } else {
            setList([...list, register]);
        }
    };

    const handlePassageSelection = useCallback(
        async (id: string) => {
            const scope = getAuthIdentityScope();
            if (!scopeStillOwnsPage(scope)) return;
            const requestVersion = ++passageSelectionVersion.current;

            if (!id) {
                setPassageStatus(NO_PASSAGE_ACCESS);
                setPassageStatusLoading(false);
                clearPassagePlan();
                selectedPassageRef.current = '';
                setSelectedPassageId('');
                setActiveVoyageName(null);
                setPlanDeparture('');
                resetReadinessState();
                return;
            }

            let realId = id;
            let row = draftVoyages.find((voyage) => voyage.id === id);

            // A logbook-only row has no authoritative voyage UUID yet.
            // Materialise it before changing either React state or localStorage
            // so an in-flight create can never leave the two sources split.
            if (id.startsWith('logbook:') && row) {
                const { voyage, error } = await createVoyage({
                    voyage_name: row.voyage_name,
                    departure_port: row.departure_port,
                    destination_port: row.destination_port,
                    // Standing complement from the vessel profile — the stub
                    // row already carries it, but never trust a stale stub
                    // over live settings at materialisation time.
                    crew_count:
                        settings.vessel?.crewCount != null
                            ? vesselCrewAboard(settings.vessel)
                            : Math.max(row.crew_count ?? vesselCrewAboard(settings.vessel), 1),
                    departure_time: row.departure_time,
                    eta: row.eta,
                    // Passage rollup rows carry the trip's first-leg trace id;
                    // leg/standalone stubs have none (linked elsewhere).
                    saved_route_id: row.saved_route_id ?? undefined,
                });
                if (requestVersion !== passageSelectionVersion.current || !scopeStillOwnsPage(scope)) return;
                if (!voyage) {
                    toast.error(error || 'Could not activate passage');
                    return;
                }

                realId = voyage.id;
                const promoted: VoyageRow = {
                    ...voyage,
                    departureCoords: row.departureCoords,
                    arrivalCoords: row.arrivalCoords,
                    routeCoordinates: row.routeCoordinates,
                    plannedRouteId: row.plannedRouteId,
                    distanceNm: row.distanceNm,
                    durationHours: row.durationHours,
                };
                row = promoted;
                setDraftVoyages((previous) =>
                    previous.map((candidate) => (candidate.id === id ? promoted : candidate)),
                );
            }

            if (!row || requestVersion !== passageSelectionVersion.current || !scopeStillOwnsPage(scope)) {
                return;
            }

            // Heal the table row: a voyage created before saved_route_id (or
            // by the old stub path) adopts the canonical trace link the
            // picker resolved. The service guard (`saved_route_id IS NULL`)
            // makes this a no-op for already-linked rows.
            if (!id.startsWith('logbook:') && !row.isShared && row.saved_route_id) {
                void adoptSavedRouteLink(realId, row.saved_route_id);
            }

            setPassageStatus(NO_PASSAGE_ACCESS);
            setPassageStatusLoading(true);
            resetReadinessState();
            setActivePassage(realId);
            selectedPassageRef.current = realId;
            setSelectedPassageId(realId);
            setActiveVoyageName(savedRouteDisplayName(row));
            setPlanDeparture(row.departure_time ? localDateTimeValue(row.departure_time) : '');
            triggerHaptic('light');
        },
        [draftVoyages, resetReadinessState, scopeStillOwnsPage, settings.vessel?.crewCount],
    );

    // Filter out declined invites older than 7 days
    const visibleCrew = (privateIdentityMatches ? myCrew : []).filter((m) => {
        if (m.status !== 'declined') return true;
        const declinedAge = Date.now() - new Date(m.updated_at).getTime();
        return declinedAge < 7 * 24 * 60 * 60 * 1000;
    });
    const verifiedPassageStatus =
        selectedPassageId && passageStatus.voyageId === selectedPassageId ? passageStatus : NO_PASSAGE_ACCESS;
    const isSelectedPassageOwner =
        Boolean(selectedPassageId) && verifiedPassageStatus.visible && verifiedPassageStatus.isOwner;
    const selectedVoyage = draftVoyages.find((voyage) => voyage.id === selectedPassageId);
    const selectedPassageIsDomestic = Boolean(
        selectedVoyage?.departure_port &&
        selectedVoyage.destination_port &&
        isSameCountry(selectedVoyage.departure_port, selectedVoyage.destination_port),
    );
    // All readiness cards green → Cast Off unlocked. Domestic passages have
    // no customs task, but that exemption must not masquerade as a completed
    // Departure Brief item. It removes the requirement here only.
    const allCardsReady =
        (selectedPassageIsDomestic || customsCleared) &&
        weatherWindowReady &&
        currentsBriefed &&
        (!verifiedPassageStatus.canViewMeals || provisioningReady) &&
        vesselProfileReady &&
        reservesReady &&
        navAcknowledged &&
        watchBriefed &&
        commsReady &&
        vesselChecked &&
        medicalReady;
    const selectedPassageCrew = isSelectedPassageOwner
        ? visibleCrew.filter((member) => member.voyage_id === null || member.voyage_id === selectedPassageId)
        : [];
    // Souls aboard = the vessel's standing crew PLUS anyone invited to this
    // passage.
    //
    // This used to be `invited + 1` — the skipper, and nobody else, unless
    // crew had been invited through the app. So a boat that always sails
    // two-up provisioned for one and got a single-handed watch briefing until
    // the skipper thought to invite their own partner. Settings → Vessel has
    // carried "Crew Aboard (incl. Skipper)" all along, and its helper text
    // already promised it was "used for provisioning and watch scheduling in
    // passage plans". It was never wired to anything.
    //
    // That field INCLUDES the skipper, so it replaces the old +1 rather than
    // adding to it: 2 aboard with 2 invited is 4 (Shane 2026-07-29), not 5.
    // Invitees are additive because they are people joining the boat, not a
    // restatement of who is already on it.
    // Read through vesselCrewAboard, never the raw field: an unset
    // crewCount DISPLAYS as 2 in Settings, so 2 is what the skipper
    // believes they set — `?? 1` here briefed a two-up boat as
    // single-handed (Shane 2026-08-04 and again 2026-08-25).
    const standingCrewAboard = vesselCrewAboard(settings.vessel);
    const selectedPassageCrewCount = isSelectedPassageOwner
        ? standingCrewAboard + selectedPassageCrew.length
        : Math.max(selectedVoyage?.crew_count ?? 1, 1);
    const ownVoyageCount = draftVoyages.filter((voyage) => !voyage.isShared).length;
    const sharedVoyageCount = draftVoyages.length - ownVoyageCount;

    // ── Auth check in flight ──
    // Don't paint anything until we've actually checked the session.
    // Otherwise the (default-false) isAuthed would flash the "Sign In
    // Required" empty state every time the page mounts, even for
    // already-signed-in users.
    if (!authChecked) {
        return (
            <div className={`h-full ${t.colors.bg.base} flex flex-col`}>
                <PageHeader title="Passage Planning" onBack={onBack} />
                <div className="flex-1" />
            </div>
        );
    }

    // authStore intentionally publishes the new user after the synchronous
    // identity fence moves. Never paint the previous account's private state
    // during that hand-off, even for a single React commit.
    if (isAuthed && !privateIdentityMatches) {
        return (
            <div className={`h-full ${t.colors.bg.base} flex flex-col`}>
                <PageHeader title="Passage Planning" onBack={onBack} />
                <div className="flex-1" />
            </div>
        );
    }

    // ── Not authenticated ──
    if (!isAuthed) {
        return (
            <div className={`h-full ${t.colors.bg.base} flex flex-col`}>
                <PageHeader title="Passage Planning" onBack={onBack} />
                <div className="flex-1 flex items-center justify-center p-8">
                    <div className="text-center">
                        <div className="mb-4 flex justify-center text-sky-300/70">
                            <UsersIcon className="w-12 h-12" />
                        </div>
                        <h2 className="text-lg font-bold text-white mb-2">Sign In Required</h2>
                        <p className="text-sm text-gray-400 max-w-xs mb-6">
                            Sign in to save routes, prepare the passage with your crew, and privately share its float
                            plan.
                        </p>
                        <button
                            onClick={() => setShowAuth(true)}
                            className="px-6 py-3 bg-white text-slate-900 font-bold rounded-xl shadow-lg hover:bg-gray-100 transition-all active:scale-95"
                        >
                            Sign In
                        </button>
                    </div>
                </div>
                <SignInScreen
                    isOpen={showAuth}
                    onClose={() => {
                        setShowAuth(false);
                        // No need to re-poll auth — the global authStore's
                        // onAuthStateChange listener fires when sign-in
                        // completes, and our isAuthed is derived from
                        // that store so we re-render automatically.
                    }}
                    prompt="Sign in to plan passages with crew and sync across devices."
                />
            </div>
        );
    }

    return (
        <div className={`h-full ${t.colors.bg.base} flex flex-col overflow-hidden`}>
            <PageHeader title="Passage Planning" onBack={onBack} />
            {/* The "+ Invite Crew" action lives inside the My Crew section
                header below — it was crowding the page title in the
                PageHeader's action slot. */}

            {/* Content */}
            <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-24" style={{ WebkitOverflowScrolling: 'touch' }}>
                {/* ── CREW ROSTER — pinned to the top so My Crew is the
                    first thing the skipper sees when opening this page.
                    The "+ Invite Crew" button lives inside the section
                    header (passed via onInviteClick) so it doesn't fight
                    the page title for space. */}
                <CrewRoster
                    visibleCrew={visibleCrew}
                    pendingInvites={pendingInvites}
                    memberships={memberships}
                    standingCrewAboard={standingCrewAboard}
                    loading={loading}
                    onSoftDeleteCaptain={(m) => handleSoftDelete(m, 'captain')}
                    onSoftDeleteCrew={(m) => handleSoftDelete(m, 'crew')}
                    onEditMember={handleEditMember}
                    onAcceptInvite={handleAccept}
                    onDeclineInvite={handleDecline}
                    onDisbandClick={() => {
                        if (scopeStillOwnsPage(renderScope)) setShowDisbandConfirm(true);
                    }}
                    onInviteClick={() => {
                        if (!scopeStillOwnsPage(renderScope)) return;
                        setShowInviteModal(true);
                        setInviteError(null);
                        setInviteSuccess(false);
                    }}
                />

                {/* ── SAVED ROUTES SELECTOR ── */}
                <div className="mb-4">
                    <label className="text-[11px] uppercase font-bold text-violet-400/60 tracking-wider mb-1.5 flex items-center gap-1.5">
                        <CompassIcon className="w-3 h-3" rotation={0} />
                        <span>Saved Routes</span>
                    </label>
                    {draftVoyages.length > 0 ? (
                        <select
                            aria-label="Saved Routes"
                            value={selectedPassageId}
                            onChange={(event) => void handlePassageSelection(event.target.value)}
                            className="w-full bg-white/[0.06] border border-white/[0.12] rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-violet-500/40 appearance-none cursor-pointer"
                            style={{
                                backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%23a78bfa'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'/%3E%3C/svg%3E")`,
                                backgroundRepeat: 'no-repeat',
                                backgroundPosition: 'right 0.75rem center',
                                backgroundSize: '1rem',
                            }}
                        >
                            <option value="" style={{ background: '#1e293b' }}>
                                Choose a saved route…
                            </option>
                            {draftVoyages.map((v) => (
                                <option key={v.id} value={v.id} style={{ background: '#1e293b' }}>
                                    {savedRouteDisplayName(v)}
                                    {v.isShared ? ` — Shared by ${v.sharedOwnerEmail || 'skipper'}` : ''}
                                </option>
                            ))}
                        </select>
                    ) : savedRoutesLoading ? (
                        <div
                            role="status"
                            aria-live="polite"
                            className="bg-white/[0.03] border border-dashed border-white/[0.10] rounded-lg px-3 py-4 text-center"
                        >
                            <p className="text-xs font-semibold text-slate-200">Loading saved routes…</p>
                            <p className="mt-0.5 text-[11px] text-slate-400 leading-relaxed">
                                Your on-device routes appear first, then this library checks for updates.
                            </p>
                        </div>
                    ) : (
                        // Empty state is deliberate: a route only enters this
                        // library after the skipper saves it, never as a
                        // placeholder passage.
                        <div className="bg-white/[0.03] border border-dashed border-white/[0.10] rounded-lg px-3 py-4 text-center">
                            <div className="w-9 h-9 mx-auto mb-2 rounded-full bg-sky-500/[0.08] border border-sky-500/15 flex items-center justify-center">
                                <svg
                                    className="w-4 h-4 text-sky-400/70"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={1.8}
                                    aria-hidden="true"
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"
                                    />
                                </svg>
                            </div>
                            <p className="text-xs font-semibold text-slate-200 mb-0.5">No saved routes yet</p>
                            <p className="text-[11px] text-slate-400 leading-relaxed">
                                Plan a route from the Plan tab; saved routes will appear here.
                            </p>
                        </div>
                    )}

                    {/* A compact count is enough context here. Route removal
                        lives in the dedicated Saved Routes library (Vessel →
                        Saved Routes), where each route is reviewed and
                        confirmed individually. */}
                    <div className="mt-1.5 flex items-center justify-between gap-2 px-1">
                        <span className="text-[10px] text-gray-500 font-mono">
                            {ownVoyageCount} yours
                            {sharedVoyageCount > 0 ? ` · ${sharedVoyageCount} shared` : ''}
                        </span>
                    </div>
                </div>

                {/* ── DEPARTURE DATE + CAST OFF (single row) ── */}
                {selectedPassageId && isSelectedPassageOwner && (
                    <div className="mb-4 flex items-end gap-2">
                        {/* Departure date — date only, time decided later */}
                        <div className="flex-1 min-w-0">
                            <label className="text-[11px] uppercase font-bold text-slate-500 tracking-widest mb-1 flex items-center gap-1.5">
                                <CalendarGridIcon className="w-3 h-3" />
                                <span>Departure Date</span>
                            </label>
                            <input
                                type="date"
                                aria-label="Departure Date"
                                value={planDeparture ? planDeparture.slice(0, 10) : ''}
                                min={localDateValue(nextDepartureSlot())}
                                onChange={(event) => handleDepartureDateChange(event.target.value)}
                                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-violet-500/30 transition-colors [color-scheme:dark]"
                            />
                        </div>

                        {/* Cast Off CTA */}
                        <button
                            onClick={() => {
                                if (!scopeStillOwnsPage(renderScope)) return;
                                setShowCastOff(true);
                                triggerHaptic('medium');
                            }}
                            // THE gate, and the ONLY gate (Shane 2026-08-26:
                            // "happy for the cast off not to be green until
                            // all of the below cards are green. i just dont
                            // want any other hold up once the cast off button
                            // is ready to push"). Readiness cards lock this
                            // button; once it lights up, everything after it
                            // — route check, GPS — is advisory or automatic.
                            disabled={!allCardsReady}
                            className={`shrink-0 px-5 py-2.5 rounded-xl text-xs font-bold uppercase tracking-widest border transition-all active:scale-[0.97] disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-1.5 ${
                                allCardsReady
                                    ? 'bg-gradient-to-r from-emerald-500/10 to-teal-500/10 border-emerald-500/20 text-emerald-300 hover:from-emerald-500/20 hover:to-teal-500/20'
                                    : 'bg-white/[0.03] border-white/[0.08] text-gray-500'
                            } inline-flex items-center justify-center gap-2`}
                        >
                            <AnchorIcon className="w-4 h-4" />
                            <span>Cast Off</span>
                        </button>
                    </div>
                )}
                {selectedPassageId && verifiedPassageStatus.visible && !verifiedPassageStatus.isOwner && (
                    <p className="mb-4 rounded-xl border border-sky-500/15 bg-sky-500/[0.05] px-3 py-2 text-[11px] text-sky-200/80">
                        Shared passage — departure and Cast Off stay with the skipper.
                    </p>
                )}

                {/* CrewRoster moved to the top of the scroll content. */}

                {/* ── READINESS CARDS ── always render the stack so the
                    three group headers stay visible. The cards inside each
                    group are gated on selectedPassageId by the stack
                    itself — when no passage is picked, just the headers
                    show (rolled up) with a hint above pointing the user
                    at the passage selector. */}
                {!loading && passageStatusLoading && (
                    <div
                        role="status"
                        aria-live="polite"
                        className="mb-4 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-center"
                    >
                        <p className="text-sm text-gray-400">Checking passage access…</p>
                    </div>
                )}
                {!loading && !passageStatusLoading && (
                    <ReadinessCardStack
                        key={selectedPassageId || 'no-passage'}
                        selectedPassageId={selectedPassageId}
                        passageStatus={verifiedPassageStatus}
                        draftVoyages={draftVoyages}
                        visibleCrew={selectedPassageCrew}
                        planCrewCount={selectedPassageCrewCount}
                        standingCrewAboard={standingCrewAboard}
                        reservesReady={reservesReady}
                        vesselChecked={vesselChecked}
                        medicalReady={medicalReady}
                        watchBriefed={watchBriefed}
                        commsReady={commsReady}
                        customsCleared={customsCleared}
                        navAcknowledged={navAcknowledged}
                        customsProgress={customsProgress}
                        onReservesChange={(value) => {
                            if (scopeStillOwnsPage(renderScope) && selectedPassageRef.current === selectedPassageId) {
                                setReservesReady(value);
                            }
                        }}
                        onVesselCheckChange={(value) => {
                            if (scopeStillOwnsPage(renderScope) && selectedPassageRef.current === selectedPassageId) {
                                setVesselChecked(value);
                            }
                        }}
                        onMedicalChange={(value) => {
                            if (scopeStillOwnsPage(renderScope) && selectedPassageRef.current === selectedPassageId) {
                                setMedicalReady(value);
                            }
                        }}
                        onWatchChange={(value) => {
                            if (scopeStillOwnsPage(renderScope) && selectedPassageRef.current === selectedPassageId) {
                                setWatchBriefed(value);
                            }
                        }}
                        onCommsChange={(value) => {
                            if (scopeStillOwnsPage(renderScope) && selectedPassageRef.current === selectedPassageId) {
                                setCommsReady(value);
                            }
                        }}
                        onCustomsChange={(total, checked) => {
                            if (!scopeStillOwnsPage(renderScope) || selectedPassageRef.current !== selectedPassageId) {
                                return;
                            }
                            // Bail out on unchanged values. A fresh object here
                            // re-rendered the whole planning tree, which rebuilt
                            // CustomsClearanceCard's props, which re-fired its
                            // notify effect — an unbounded render loop on any
                            // international passage.
                            setCustomsProgress((prev) =>
                                prev.total === total && prev.checked === checked ? prev : { total, checked },
                            );
                            setCustomsCleared(total > 0 && checked >= total);
                        }}
                        onNavChange={(value) => {
                            if (scopeStillOwnsPage(renderScope) && selectedPassageRef.current === selectedPassageId) {
                                setNavAcknowledged(value);
                            }
                        }}
                        cardDelegations={cardDelegations}
                        delegationMenuOpen={delegationMenuOpen}
                        onDelegationMenuToggle={(cardKey) => {
                            if (scopeStillOwnsPage(renderScope)) setDelegationMenuOpen(cardKey);
                        }}
                        onAssignCard={assignCard}
                        vesselProfileReady={vesselProfileReady}
                        comfortProfileReady={comfortProfileReady}
                        weatherWindowReady={weatherWindowReady}
                        currentsBriefed={currentsBriefed}
                        onVesselProfileChange={(value) => {
                            if (scopeStillOwnsPage(renderScope) && selectedPassageRef.current === selectedPassageId) {
                                setVesselProfileReady(value);
                            }
                        }}
                        onComfortProfileChange={(value) => {
                            if (scopeStillOwnsPage(renderScope) && selectedPassageRef.current === selectedPassageId) {
                                setComfortProfileReady(value);
                            }
                        }}
                        onWeatherWindowChange={(value) => {
                            if (scopeStillOwnsPage(renderScope) && selectedPassageRef.current === selectedPassageId) {
                                setWeatherWindowReady(value);
                            }
                        }}
                        onCurrentsChange={(value) => {
                            if (scopeStillOwnsPage(renderScope) && selectedPassageRef.current === selectedPassageId) {
                                setCurrentsBriefed(value);
                            }
                        }}
                        onProvisionedChange={(value) => {
                            if (scopeStillOwnsPage(renderScope) && selectedPassageRef.current === selectedPassageId) {
                                setProvisioningReady(value);
                            }
                        }}
                        onDepartureTimeChange={handlePassageDepartureTimeChange}
                    />
                )}
            </div>

            {/* ── INVITE MODAL ── */}
            <ModalSheet
                isOpen={showInviteModal}
                onClose={() => {
                    if (!scopeStillOwnsPage(renderScope)) return;
                    inviteOperationVersion.current += 1;
                    if (inviteSuccessTimer.current !== null) {
                        window.clearTimeout(inviteSuccessTimer.current);
                        inviteSuccessTimer.current = null;
                    }
                    setShowInviteModal(false);
                    setInviteLoading(false);
                    setInviteEmail('');
                    setInviteRegisters([]);
                    setInviteError(null);
                    setInviteSuccess(false);
                }}
                title="Invite Crew Member"
            >
                <InviteCrewModal
                    inviteEmail={inviteEmail}
                    inviteRegisters={inviteRegisters}
                    inviteLoading={inviteLoading}
                    inviteError={inviteError}
                    inviteSuccess={inviteSuccess}
                    onEmailChange={(value) => {
                        if (scopeStillOwnsPage(renderScope)) setInviteEmail(value);
                    }}
                    onToggleRegister={(register) => {
                        if (scopeStillOwnsPage(renderScope)) {
                            toggleRegister(register, inviteRegisters, setInviteRegisters);
                        }
                    }}
                    onInvite={handleInvite}
                />
            </ModalSheet>

            {/* ── EDIT PERMISSIONS MODAL ── */}
            <ModalSheet
                isOpen={!!editTarget}
                onClose={closeEditMember}
                title={`Edit Access — ${editTarget?.crew_email || ''}`}
            >
                <div className="p-6 space-y-5">
                    {/* Byline parts — shown only once the crew member has
                        accepted (boat_members row exists). Drives the
                        "by Emma" chip on the public voyage log. */}
                    {editBoatMemberLoaded ? (
                        <div>
                            <label className="text-[11px] uppercase font-bold text-gray-400 mb-2 ml-1 block tracking-wide">
                                Byline on the Voyage Log
                            </label>
                            <div className="grid grid-cols-5 gap-2">
                                <input
                                    type="text"
                                    value={editPrefix}
                                    onChange={(event) => {
                                        if (scopeStillOwnsPage(renderScope)) setEditPrefix(event.target.value);
                                    }}
                                    placeholder="Capt."
                                    aria-label="Title prefix (optional)"
                                    className="col-span-2 w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white focus:border-sky-500 outline-none text-sm placeholder:text-gray-500"
                                />
                                <input
                                    type="text"
                                    value={editFirstName}
                                    onChange={(event) => {
                                        if (scopeStillOwnsPage(renderScope)) setEditFirstName(event.target.value);
                                    }}
                                    placeholder="First *"
                                    aria-label="First name"
                                    className="col-span-3 w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white focus:border-sky-500 outline-none text-sm placeholder:text-gray-500"
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-2 mt-2">
                                <input
                                    type="text"
                                    value={editLastName}
                                    onChange={(event) => {
                                        if (scopeStillOwnsPage(renderScope)) setEditLastName(event.target.value);
                                    }}
                                    placeholder="Surname"
                                    aria-label="Surname"
                                    className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white focus:border-sky-500 outline-none text-sm placeholder:text-gray-500"
                                />
                                <input
                                    type="text"
                                    value={editNickname}
                                    onChange={(event) => {
                                        if (scopeStillOwnsPage(renderScope)) setEditNickname(event.target.value);
                                    }}
                                    placeholder="Nickname"
                                    aria-label="Nickname"
                                    className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white focus:border-sky-500 outline-none text-sm placeholder:text-gray-500"
                                />
                            </div>
                            <p className="text-[10px] text-gray-500 mt-1.5 ml-1">
                                Renders as:{' '}
                                <span className="text-sky-300 font-bold">
                                    {[
                                        editPrefix.trim(),
                                        editFirstName.trim(),
                                        editNickname.trim() && `"${editNickname.trim()}"`,
                                        editLastName.trim(),
                                    ]
                                        .filter(Boolean)
                                        .join(' ') || '—'}
                                </span>
                            </p>
                        </div>
                    ) : editTarget?.status === 'pending' ? (
                        <div className="bg-amber-500/5 border border-amber-500/15 rounded-xl p-3 text-[11px] text-amber-300/90">
                            Byline editing unlocks once this crew member accepts the invite.
                        </div>
                    ) : null}

                    <div>
                        <label className="text-[11px] uppercase font-bold text-gray-400 mb-2 ml-1 block tracking-wide">
                            Shared Registers
                        </label>
                        <div className="grid grid-cols-2 gap-2">
                            {ALL_REGISTERS.map((reg) => {
                                const selected = editRegisters.includes(reg);
                                return (
                                    <button
                                        aria-label="Register new crew member"
                                        key={reg}
                                        type="button"
                                        onClick={() => {
                                            if (scopeStillOwnsPage(renderScope)) {
                                                toggleRegister(reg, editRegisters, setEditRegisters);
                                            }
                                        }}
                                        className={`p-3 rounded-xl border text-left transition-all active:scale-95 ${
                                            selected
                                                ? 'bg-sky-500/15 border-sky-500/40'
                                                : 'bg-white/[0.03] border-white/[0.06] hover:bg-white/[0.05]'
                                        }`}
                                    >
                                        <div className="flex items-center gap-2">
                                            <span className="text-lg">{REGISTER_ICONS[reg]}</span>
                                            <p
                                                className={`text-xs font-bold ${selected ? 'text-sky-300' : 'text-white'}`}
                                            >
                                                {REGISTER_LABELS[reg]}
                                            </p>
                                        </div>
                                        <div
                                            className={`mt-2 w-4 h-4 rounded-md border-2 flex items-center justify-center ${selected ? 'bg-sky-500 border-sky-500' : 'border-white/20'}`}
                                        >
                                            {selected && (
                                                <svg
                                                    className="w-2.5 h-2.5 text-white"
                                                    fill="none"
                                                    viewBox="0 0 24 24"
                                                    stroke="currentColor"
                                                    strokeWidth={3}
                                                >
                                                    <path
                                                        strokeLinecap="round"
                                                        strokeLinejoin="round"
                                                        d="M4.5 12.75l6 6 9-13.5"
                                                    />
                                                </svg>
                                            )}
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    <button
                        aria-label="Save crew management changes"
                        onClick={handleSavePermissions}
                        disabled={editRegisters.length === 0}
                        className={`w-full py-3.5 bg-white text-slate-900 font-bold rounded-xl shadow-lg transition-all active:scale-95 ${editRegisters.length === 0 ? 'opacity-50' : 'hover:bg-gray-100'}`}
                    >
                        Save Changes
                    </button>
                </div>
            </ModalSheet>

            {/* ── UNDO TOAST ── */}
            <UndoToast
                isOpen={!!deletedMember}
                message={
                    deletedMember?.mode === 'captain'
                        ? `"${deletedMember?.member.crew_email}" removed`
                        : `Left "${deletedMember?.member.owner_email}"`
                }
                onUndo={handleUndoDelete}
                onDismiss={handleDismissDelete}
            />

            {/* ── DISBAND GROUP CONFIRMATION ── */}
            <ModalSheet
                isOpen={showDisbandConfirm}
                onClose={() => {
                    if (!scopeStillOwnsPage(renderScope)) return;
                    setShowDisbandConfirm(false);
                    setDisbandConfirmText('');
                }}
                title="Disband Group"
            >
                <div className="space-y-4">
                    <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4">
                        <p className="text-sm text-red-300 font-bold mb-2 inline-flex items-center gap-1.5">
                            <AlertTriangleIcon className="w-4 h-4" />
                            <span>This action cannot be undone</span>
                        </p>
                        <p className="text-[11px] text-red-300/70 leading-relaxed">
                            This will permanently remove{' '}
                            <strong>
                                all {visibleCrew.length} crew member{visibleCrew.length !== 1 ? 's' : ''}
                            </strong>{' '}
                            from your group. They will lose access to all shared registers and passage planning modules.
                        </p>
                    </div>

                    <div>
                        <label className="text-[11px] uppercase font-bold text-gray-400 mb-2 block tracking-wide">
                            Type DISBAND to confirm
                        </label>
                        <input
                            value={disbandConfirmText}
                            onChange={(event) => {
                                if (scopeStillOwnsPage(renderScope)) {
                                    setDisbandConfirmText(event.target.value.toUpperCase());
                                }
                            }}
                            placeholder="DISBAND"
                            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500/40"
                        />
                    </div>

                    <button
                        aria-label="Confirm Disband"
                        onClick={handleDisbandGroup}
                        disabled={disbandConfirmText !== 'DISBAND' || disbanding}
                        className={`w-full py-3.5 rounded-xl font-bold text-sm transition-all active:scale-95 inline-flex items-center justify-center gap-2 ${
                            disbandConfirmText === 'DISBAND' && !disbanding
                                ? 'bg-red-600 text-white hover:bg-red-700 shadow-lg shadow-red-500/20'
                                : 'bg-white/[0.04] text-gray-500 cursor-not-allowed'
                        }`}
                    >
                        {disbanding ? (
                            'Disbanding…'
                        ) : (
                            <>
                                <SosIcon className="w-4 h-4" />
                                <span>Disband Entire Group</span>
                            </>
                        )}
                    </button>
                </div>
            </ModalSheet>

            {/* ── CAST OFF PANEL ── */}
            {showCastOff && isSelectedPassageOwner && (
                <CastOffPanel
                    onClose={() => {
                        if (scopeStillOwnsPage(renderScope)) setShowCastOff(false);
                    }}
                    onOpenLog={() => {
                        if (!scopeStillOwnsPage(renderScope)) return;
                        setShowCastOff(false);
                        setPage('details');
                    }}
                    initialVoyageId={selectedPassageId || undefined}
                    onCastOff={(voyage) => {
                        if (!scopeStillOwnsPage(renderScope)) return;
                        setActiveVoyageName(savedRouteDisplayName(voyage));
                        setShowCastOff(false);
                        // Cast Off ends where the Log page's slide-to-start
                        // ends (Shane 2026-08-25: "they end up in the same
                        // place, but just took a detour through the passage
                        // planning page"). Tracking is already verified live
                        // by the panel. The passage IS its route, so follow
                        // it and put the line on the public page without
                        // asking a one-answer question — the verification
                        // gate inside refuses anything unproven, and the Log
                        // page's own follow sheet stays as the fallback ask.
                        {
                            // The handoff carries the SELECTED row's canonical
                            // trace link, which is backfilled even when the
                            // table row predates saved_route_id.
                            const handoff = peekCastOffHandoff();
                            void followCastOffRoute(
                                voyage.id,
                                handoff?.savedRouteId ?? voyage.saved_route_id,
                                handoff?.publishRoute ?? true,
                                voyage.voyage_name,
                            ).then((reason) => {
                                // Silent failures cost a night of guessing —
                                // record why the line is not up so the Log
                                // page can SAY it (Shane 2026-08-26: "it is
                                // not showing the route").
                                if (reason) updateCastOffHandoff({ followNote: reason });
                            });
                        }
                        // 'details' is the Log tab's registry key — there is
                        // no 'log' view. The old 'log' literal rendered the
                        // blank search-bar chrome App.tsx keeps for
                        // unregistered views (Shane's 2026-08-26 screenshot);
                        // tests/ViewKeysExist.test.ts now outlaws the class.
                        setPage('details');
                    }}
                />
            )}
        </div>
    );
});
