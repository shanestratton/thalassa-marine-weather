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
import { ConfirmDialog } from './ui/ConfirmDialog';
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
import { triggerHaptic } from '../utils/system';
import { toast } from './Toast';
import { createVoyage, getDraftVoyages, updateVoyage, type Voyage } from '../services/VoyageService';
import { fetchRoutesAndTracks } from '../services/shiplog/RoutesAndTracks';
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
import { useUI } from '../context/UIContext';
import { PageHeader } from './ui/PageHeader';
import { DataFreshness } from './ui/DataFreshness';

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
    durationHours?: number;
    /** True when this voyage belongs to a captain who shared it with us. */
    isShared?: boolean;
    sharedOwnerEmail?: string;
};

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
    const authChecked = useAuthStore((s) => s.authChecked);
    const authUserId = authedUser?.id ?? null;
    const isAuthed = !!authedUser;
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

    // Navigation hook — used by the "Plan a route" button at the
    // top of the page to take the skipper to the standalone Route
    // Planner. We tried embedding the form inline; it was visually
    // overwhelming. A button is the right move — single tap into a
    // focused planning surface, save → bounces back here ready to
    // plan crew/provisioning.
    const { setPage } = useUI();

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
    // Last-successful-sync timestamp + last-attempt error for the
    // DataFreshness pill that sits in the PageHeader action slot.
    // Crew + invites + memberships come from Supabase; users
    // waiting on an invite acceptance benefit from "synced 30s ago"
    // visibility so they know whether to pull again.
    const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
    const [syncError, setSyncError] = useState<string | null>(null);

    // Soft-delete with undo
    const [deletedMember, setDeletedMember] = useState<{ member: CrewMember; mode: 'captain' | 'crew' } | null>(null);

    // Auth + Cast Off
    const [showAuth, setShowAuth] = useState(false);
    const [showCastOff, setShowCastOff] = useState(false);
    const [_activeVoyageName, setActiveVoyageName] = useState<string | null>(null);

    // Draft passage plans. VoyageRow extends the DB Voyage with
    // optional departure/arrival coords pulled from the matching
    // logbook route at fetch time. The cards downstream (Weather
    // Windows, Ocean Currents) need lat/lon to run their analysis but
    // the voyages-table schema doesn't carry coords; this is how we
    // bridge that gap without a migration.
    const [draftVoyages, setDraftVoyages] = useState<VoyageRow[]>([]);
    const [selectedPassageId, setSelectedPassageId] = useState<string>(getActivePassageId() || '');
    const selectedPassageRef = useRef(selectedPassageId);
    selectedPassageRef.current = selectedPassageId;
    const [passageStatus, setPassageStatus] = useState<PassageStatus>(NO_PASSAGE_ACCESS);
    const [passageStatusLoading, setPassageStatusLoading] = useState(true);
    const passageSelectionVersion = useRef(0);
    const dropdownReloadVersion = useRef(0);
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

    // All readiness cards green → Cast Off unlocked.
    // weatherReviewed removed 2026-05-17; weatherWindowReady (window
    // acceptance from PI-1) is the canonical weather gate now.
    const allCardsReady =
        customsCleared &&
        weatherWindowReady &&
        reservesReady &&
        navAcknowledged &&
        watchBriefed &&
        commsReady &&
        vesselChecked &&
        medicalReady;

    // Disband group
    const [showDisbandConfirm, setShowDisbandConfirm] = useState(false);
    const [disbandConfirmText, setDisbandConfirmText] = useState('');
    const [disbanding, setDisbanding] = useState(false);
    const [clearPassagesRequest, setClearPassagesRequest] = useState<{
        scope: AuthIdentityScope;
        count: number;
        visibleNames: string;
    } | null>(null);
    const clearPassagesInFlight = useRef(false);

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
            setSelectedPassageId(nextPassageId);
            setPassageStatus(NO_PASSAGE_ACCESS);
            setPassageStatusLoading(Boolean(next.userId));
            setLoading(Boolean(next.userId));
            setLastSyncedAt(null);
            setSyncError(null);
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
            clearPassagesInFlight.current = false;
            setClearPassagesRequest(null);
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
        setSyncError(null);
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
                setSyncError('Sync timed out — tap retry');
            } else {
                const [crewRes, invitesRes, shipsRes] = result;
                if (crewRes.status === 'fulfilled') setMyCrew(crewRes.value);
                if (invitesRes.status === 'fulfilled') setPendingInvites(invitesRes.value);
                if (shipsRes.status === 'fulfilled') {
                    setMemberships(shipsRes.value);
                    setMembershipsLoaded(true);
                }
                // Surface the freshness signal — even if some lists
                // failed, the user gets a "synced 2m ago" pill so
                // they know their view isn't stale-by-default.
                setLastSyncedAt(Date.now());
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

    // Populate the dropdown from two independently verified sources:
    // the user's own logbook routes and voyage rows shared by an accepted
    // membership. Shared rows deliberately remain useful without logbook
    // coordinates; route-derived cards can show their normal unavailable
    // state while meals/checklists/chat still receive the correct voyage ID.
    const reloadDropdown = useCallback(async () => {
        const scope = getAuthIdentityScope();
        if (!scopeStillOwnsPage(scope)) return;
        const requestVersion = ++dropdownReloadVersion.current;
        try {
            const { getCachedActiveVoyage } = await import('../services/VoyageService');
            if (requestVersion !== dropdownReloadVersion.current || !scopeStillOwnsPage(scope)) return;
            const v = getCachedActiveVoyage();
            if (v) setActiveVoyageName(v.voyage_name);
        } catch {
            /* non-critical */
        }
        // Force-refresh so a stale 60s RoutesAndTracks cache can't
        // miss a just-saved route or include a just-deleted one.
        const [routesAndTracks, allDrafts, sharedResult] = await Promise.all([
            fetchRoutesAndTracks(true),
            getDraftVoyages(),
            membershipsLoaded ? getAuthorizedSharedVoyages() : Promise.resolve({ voyages: [], complete: false }),
        ]);
        if (requestVersion !== dropdownReloadVersion.current || !scopeStillOwnsPage(scope)) return;
        const norm = (s: string) => s.trim().toLowerCase();
        const draftByName = new Map(allDrafts.map((d) => [norm(d.voyage_name), d] as const));

        // For each logbook route, surface a Voyage-shaped row. If a
        // matching draft already exists, use it (we have its real
        // UUID). Otherwise stub one out — the on-select handler
        // creates the actual voyages-table row when the user picks
        // it, so we don't pollute the table with rows for routes
        // the user never actually picks.
        //
        // We also attach the route's first/last polyline points as
        // departureCoords/arrivalCoords so downstream cards (Weather
        // Windows, Ocean Currents) can light up — they need lat/lon to
        // run, and the voyages-table schema doesn't carry them. Pulling
        // from the logbook route is the path of least resistance: the
        // coords are already there from the original passage save.
        const ownRows: VoyageRow[] = routesAndTracks.routes.map((r) => {
            const first = r.points[0];
            const last = r.points[r.points.length - 1];
            const departureCoords = first ? { lat: first.lat, lon: first.lon } : undefined;
            const arrivalCoords = last ? { lat: last.lat, lon: last.lon } : undefined;
            const durationHours = r.durationHours;
            // The route's first-entry timestamp is what the user typed
            // as plan.departureDate at save time (PassagePlanSave seeds
            // entries[0].timestamp = depDate). Use it as the inferred
            // departure for stub rows AND as a fallback for matched
            // drafts that haven't had their date persisted yet.
            const inferredDeparture = new Date(r.timestamp).toISOString();
            const inferredEta =
                durationHours && durationHours > 0
                    ? new Date(r.timestamp + durationHours * 3_600_000).toISOString()
                    : null;
            const matched = draftByName.get(norm(r.label));
            if (matched) {
                return {
                    ...matched,
                    // Fall back to the route-derived dates only when the
                    // matched draft hasn't been given them yet. Don't
                    // overwrite a date the user has explicitly set via
                    // the dropdown's date picker.
                    departure_time: matched.departure_time ?? inferredDeparture,
                    eta: matched.eta ?? inferredEta,
                    departureCoords,
                    arrivalCoords,
                    durationHours,
                };
            }
            const [depPart, arrPart] = r.label.split(' → ');
            // Stub voyage — id starts with "logbook:" so the on-
            // select handler knows to find-or-create a real row
            // before calling setActivePassage.
            return {
                id: `logbook:${r.id}`,
                user_id: '',
                vessel_id: null,
                voyage_name: r.label,
                departure_port: (depPart ?? '').trim() || null,
                destination_port: (arrPart ?? '').trim() || null,
                departure_time: inferredDeparture,
                eta: inferredEta,
                crew_count: 1,
                status: 'planning',
                weather_master_id: null,
                notes: null,
                created_at: new Date(r.timestamp).toISOString(),
                updated_at: new Date(r.timestamp).toISOString(),
                departureCoords,
                arrivalCoords,
                durationHours,
            };
        });

        const activeId = getActivePassageId();

        // Keep an explicitly selected, still-valid own draft even when it has
        // no matching logbook route. This mirrors the shared-row rule below:
        // a missing polyline is not evidence that a voyage is unauthorized.
        const activeOwnDraft = activeId ? allDrafts.find((draft) => draft.id === activeId) : undefined;
        if (activeOwnDraft && !ownRows.some((row) => row.id === activeOwnDraft.id)) {
            ownRows.push(activeOwnDraft);
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
            if (vMatch?.departure_time) setPlanDeparture(vMatch.departure_time.slice(0, 16));
            if (vMatch) setActiveVoyageName(vMatch.voyage_name);
        } else if (activeId && membershipsLoaded && sharedResult.complete) {
            // Only heal after accepted memberships and every shared ownership
            // lookup have completed. Re-verify the exact active ID before
            // clearing it, and never substitute one of the user's routes for
            // a valid shared passage.
            const activeStatus = await getPassageStatus(activeId);
            if (requestVersion !== dropdownReloadVersion.current || !scopeStillOwnsPage(scope)) return;
            if (!activeStatus.visible) {
                console.warn(`[CrewManagement] clearing inaccessible active passage "${activeId}"`);
                clearPassagePlan();
                selectedPassageRef.current = '';
                setSelectedPassageId('');
                setActiveVoyageName(null);
                setPlanDeparture('');
                resetReadinessState();
            }
        }

        // Backfill ETA on any voyage where departure_time is set but eta
        // is missing AND we have a durationHours from the logbook route.
        // This rescues voyages saved before the auto-ETA-on-pick fix
        // (they have departure but no eta, which leaves the GalleyCard
        // meal planner blocked). Runs once per row that needs it; the
        // setDraftVoyages above already rendered the dropdown, so this
        // is a quiet background cleanup that lights up downstream cards
        // on the next render.
        for (const row of rows) {
            if (
                row.id &&
                !row.id.startsWith('logbook:') &&
                !row.isShared &&
                row.departure_time &&
                !row.eta &&
                row.durationHours &&
                row.durationHours > 0
            ) {
                const etaIso = new Date(Date.parse(row.departure_time) + row.durationHours * 3_600_000).toISOString();
                updateVoyage(row.id, { eta: etaIso }).then((result) => {
                    if (requestVersion !== dropdownReloadVersion.current || !scopeStillOwnsPage(scope)) return;
                    if (result.voyage) {
                        setDraftVoyages((prev) =>
                            prev.map((v) =>
                                v.id === row.id
                                    ? {
                                          ...result.voyage!,
                                          departureCoords: v.departureCoords,
                                          arrivalCoords: v.arrivalCoords,
                                          durationHours: v.durationHours,
                                      }
                                    : v,
                            ),
                        );
                    }
                });
            }
        }
    }, [membershipsLoaded, resetReadinessState, scopeStillOwnsPage]);

    useEffect(() => {
        // Wait for auth to land before fetching — fetchRoutesAndTracks
        // and getDraftVoyages both return [] when supabase has no user.
        // The auth-check useEffect above runs in parallel, so on first
        // mount this dropdown loader was firing too early, getting
        // empty results, and never refreshing. That's why the user saw
        // "No draft passages yet" even when ship_logs had their saved
        // routes — it was a race between auth-check and dropdown-load,
        // and dropdown-load was winning.
        const scope = getAuthIdentityScope();
        if (!authUserId || privateScopeKey !== scope.key || !scopeStillOwnsPage(scope)) return;
        void reloadDropdown();
        // Refresh when a passage plan is saved while this page is
        // already mounted — e.g. user saves on the Route Planner and
        // navigates straight here without unmounting. Without this,
        // the new route doesn't appear in the dropdown until the
        // component fully remounts.
        const onSaved = () => {
            void reloadDropdown();
        };
        // Also refresh when the departure time changes elsewhere
        // (RoutePlanner date input, WeatherWindowCard accept). Without
        // this the active voyage's date stays stale in the dropdown
        // and the Passage Summary card until the user manually
        // remounts the page.
        const onDepartureUpdate = () => {
            void reloadDropdown();
        };
        if (typeof window !== 'undefined') {
            window.addEventListener('thalassa:passage-plan-saved', onSaved);
            window.addEventListener('thalassa:departure-time-updated', onDepartureUpdate);
            return () => {
                dropdownReloadVersion.current += 1;
                window.removeEventListener('thalassa:passage-plan-saved', onSaved);
                window.removeEventListener('thalassa:departure-time-updated', onDepartureUpdate);
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
                const { data: boat } = await supabase.from('boats').select('id').eq('owner_id', myId).maybeSingle();
                if (requestVersion !== editLoadVersion.current || !scopeStillOwnsPage(scope)) return;
                if (boat?.id) {
                    const { error } = await supabase
                        .from('boat_members')
                        .update({
                            prefix: byline.prefix,
                            first_name: byline.firstName,
                            last_name: byline.lastName,
                            nickname: byline.nickname,
                        })
                        .match({ boat_id: boat.id, user_id: target.crew_user_id });
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

        const { data: boat } = await supabase.from('boats').select('id').eq('owner_id', scope.userId).maybeSingle();
        if (requestVersion !== editLoadVersion.current || !scopeStillOwnsPage(scope) || !boat?.id) return;

        const { data: boatMember } = await supabase
            .from('boat_members')
            .select('prefix, first_name, last_name, nickname')
            .eq('boat_id', boat.id)
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

    const requestClearAllPassages = () => {
        const scope = getAuthIdentityScope();
        if (!scopeStillOwnsPage(scope) || clearPassagesInFlight.current) return;
        const ownRows = draftVoyages.filter((voyage) => !voyage.isShared);
        if (ownRows.length === 0) return;
        const visibleNames = ownRows
            .slice(0, 5)
            .map((voyage) => voyage.voyage_name || '?')
            .join(', ');
        const overflow = ownRows.length > 5 ? `, and ${ownRows.length - 5} more` : '';
        setClearPassagesRequest({
            scope,
            count: ownRows.length,
            visibleNames: `${visibleNames}${overflow}`,
        });
    };

    const handleClearAllPassages = async () => {
        const request = clearPassagesRequest;
        if (!request || clearPassagesInFlight.current || !scopeStillOwnsPage(request.scope)) {
            setClearPassagesRequest(null);
            return;
        }

        clearPassagesInFlight.current = true;
        triggerHaptic('medium');
        try {
            const { ShipLogService } = await import('../services/ShipLogService');
            if (!scopeStillOwnsPage(request.scope)) return;
            const fresh = await fetchRoutesAndTracks(true);
            if (!scopeStillOwnsPage(request.scope)) return;
            for (const route of fresh.routes) {
                if (!scopeStillOwnsPage(request.scope)) return;
                await ShipLogService.deleteVoyage(route.id);
                if (!scopeStillOwnsPage(request.scope)) return;
            }

            const remainingDrafts = await getDraftVoyages();
            if (!scopeStillOwnsPage(request.scope)) return;
            for (const draft of remainingDrafts) {
                if (!scopeStillOwnsPage(request.scope)) return;
                if (!draft.voyage_name.includes('→')) continue;
                const { deleteDraftVoyagesByNameAndDay } = await import('../services/VoyageService');
                if (!scopeStillOwnsPage(request.scope)) return;
                await deleteDraftVoyagesByNameAndDay(draft.voyage_name, draft.created_at.slice(0, 10));
            }
            if (!scopeStillOwnsPage(request.scope)) return;

            setDraftVoyages((previous) => previous.filter((voyage) => voyage.isShared));
            clearPassagePlan();
            selectedPassageRef.current = '';
            setSelectedPassageId('');
            setActiveVoyageName(null);
            setPlanDeparture('');
            setPassageStatus(NO_PASSAGE_ACCESS);
            resetReadinessState();
            toast.success('All saved passages cleared');
        } catch (error) {
            if (!scopeStillOwnsPage(request.scope)) return;
            console.error('[CrewManagement] cleanup failed:', error);
            toast.error('Cleanup failed — try again');
        } finally {
            clearPassagesInFlight.current = false;
            if (scopeStillOwnsPage(request.scope)) setClearPassagesRequest(null);
        }
    };

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

        setPlanDeparture(value);
        if (!value) return;
        const departureIso = new Date(value).toISOString();
        const row = draftVoyages.find((voyage) => voyage.id === passageId);
        const update: Parameters<typeof updateVoyage>[1] = {
            departure_time: departureIso,
        };
        if (row?.durationHours && row.durationHours > 0) {
            update.eta = new Date(Date.parse(departureIso) + row.durationHours * 3_600_000).toISOString();
        }

        void updateVoyage(passageId, update).then((result) => {
            if (!scopeStillOwnsPage(scope) || selectedPassageRef.current !== passageId || !result.voyage) {
                return;
            }
            setDraftVoyages((previous) =>
                previous.map((voyage) =>
                    voyage.id === passageId
                        ? {
                              ...result.voyage!,
                              departureCoords: voyage.departureCoords,
                              arrivalCoords: voyage.arrivalCoords,
                              durationHours: voyage.durationHours,
                          }
                        : voyage,
                ),
            );
        });
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
                    crew_count: 1,
                    departure_time: row.departure_time,
                    eta: row.eta,
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

            setPassageStatus(NO_PASSAGE_ACCESS);
            setPassageStatusLoading(true);
            resetReadinessState();
            setActivePassage(realId);
            selectedPassageRef.current = realId;
            setSelectedPassageId(realId);
            setActiveVoyageName(row.voyage_name || `${row.departure_port || '?'} → ${row.destination_port || '?'}`);
            setPlanDeparture(row.departure_time ? row.departure_time.slice(0, 16) : '');
            triggerHaptic('light');
        },
        [draftVoyages, resetReadinessState, scopeStillOwnsPage],
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
    const selectedPassageCrew = isSelectedPassageOwner
        ? visibleCrew.filter((member) => member.voyage_id === null || member.voyage_id === selectedPassageId)
        : [];
    const selectedPassageCrewCount = isSelectedPassageOwner
        ? Math.max(selectedPassageCrew.length + 1, 2)
        : Math.max(selectedVoyage?.crew_count ?? 2, 2);
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
                            Sign in to share your vessel registers with crew members.
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
            <PageHeader
                title="Passage Planning"
                onBack={onBack}
                action={
                    // DataFreshness pill — wired 2026-05-17 (the
                    // component was built earlier today and was
                    // genuinely unused; this was one of the honest
                    // score deductions). Lives in the PageHeader's
                    // action slot. Surfaces when crew + invites +
                    // memberships were last pulled, lets the user
                    // tap to refresh. Useful when a skipper is
                    // waiting on an invitee to accept.
                    <DataFreshness
                        lastUpdatedAt={lastSyncedAt}
                        isLoading={loading}
                        error={syncError}
                        onRefresh={() => void loadData()}
                    />
                }
            />
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

                {/* ── PLAN A ROUTE — primary CTA into the standalone
                    Route Planner page. Used to be an inline accordion
                    embedding the full form, which was visually
                    overwhelming on the same page as the readiness
                    cards. A button is the right primitive — single
                    tap, focused planning surface, the back button
                    brings the user back here ready to plan crew /
                    provisioning. */}
                <button
                    type="button"
                    onClick={() => {
                        setPage('route');
                        triggerHaptic('light');
                    }}
                    className="w-full mb-4 flex items-center justify-between gap-2 px-4 py-3.5 rounded-xl bg-gradient-to-r from-sky-500/15 to-cyan-500/10 border border-sky-500/25 hover:from-sky-500/25 hover:to-cyan-500/20 active:scale-[0.98] transition-all"
                >
                    <span className="flex items-center gap-3 min-w-0">
                        <CompassIcon className="w-5 h-5 text-sky-300" rotation={0} />
                        <span className="flex flex-col items-start min-w-0">
                            <span className="text-sm font-bold text-sky-200 tracking-wide">Plan a route</span>
                            <span className="text-[11px] text-sky-300/70">Origin · destination · departure</span>
                        </span>
                    </span>
                    <svg
                        className="w-4 h-4 text-sky-300/70 shrink-0"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                    >
                        <path d="M9 5l7 7-7 7" />
                    </svg>
                </button>

                {/* ── ACTIVE PASSAGE SELECTOR ── */}
                <div className="mb-4">
                    <label className="text-[11px] uppercase font-bold text-violet-400/60 tracking-wider mb-1.5 flex items-center gap-1.5">
                        <CompassIcon className="w-3 h-3" rotation={0} />
                        <span>Active Passage</span>
                    </label>
                    {draftVoyages.length > 0 ? (
                        <select
                            aria-label="Active Passage"
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
                                Select a passage…
                            </option>
                            {draftVoyages.map((v) => (
                                <option key={v.id} value={v.id} style={{ background: '#1e293b' }}>
                                    {v.voyage_name || `${v.departure_port || '?'} → ${v.destination_port || '?'}`}
                                    {v.isShared ? ` — Shared by ${v.sharedOwnerEmail || 'skipper'}` : ''}
                                </option>
                            ))}
                        </select>
                    ) : (
                        // No draft passages — bumped 2026-05-17 from a bare
                        // dashed grey box to a proper empty-state-style
                        // card. Still compact (lives inside the dropdown
                        // popover) but now has an icon + title + brighter
                        // copy so it reads as intentional rather than as
                        // "something failed to load".
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
                            <p className="text-xs font-semibold text-slate-200 mb-0.5">No passages drafted</p>
                            <p className="text-[11px] text-slate-400 leading-relaxed">
                                Tap <strong className="text-sky-300">Plan a route</strong> above to draft your first
                                one.
                            </p>
                        </div>
                    )}

                    {/* ── Diagnostic + nuke controls ─────────────────────── */}
                    {/* Surfaces what's actually populating the dropdown so a */}
                    {/* "ghost" passage (in DB but no longer in your logbook) */}
                    {/* can be wiped without poking around in Supabase. */}
                    <div className="mt-1.5 flex items-center justify-between gap-2 px-1">
                        <span className="text-[10px] text-gray-500 font-mono">
                            {ownVoyageCount} yours
                            {sharedVoyageCount > 0 ? ` · ${sharedVoyageCount} shared` : ''}
                        </span>
                        {ownVoyageCount > 0 && (!selectedPassageId || isSelectedPassageOwner) && (
                            <button
                                type="button"
                                onClick={requestClearAllPassages}
                                className="text-[10px] uppercase font-bold tracking-widest text-red-400/70 hover:text-red-400 transition-colors"
                            >
                                Clear all
                            </button>
                        )}
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
                            setCustomsProgress({ total, checked });
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

            <ConfirmDialog
                isOpen={clearPassagesRequest !== null}
                title="Clear all saved passages?"
                message={
                    clearPassagesRequest
                        ? `This will delete ${clearPassagesRequest.count} saved passage route${
                              clearPassagesRequest.count === 1 ? '' : 's'
                          } from your logbook (${clearPassagesRequest.visibleNames}). Recorded tracks of voyages you actually sailed will not be touched.`
                        : ''
                }
                confirmLabel="Clear all"
                destructive
                onConfirm={handleClearAllPassages}
                onCancel={() => {
                    if (!clearPassagesInFlight.current) setClearPassagesRequest(null);
                }}
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
                    initialVoyageId={selectedPassageId || undefined}
                    onCastOff={(voyage) => {
                        if (!scopeStillOwnsPage(renderScope)) return;
                        setActiveVoyageName(voyage.voyage_name);
                        setShowCastOff(false);
                    }}
                />
            )}
        </div>
    );
});
