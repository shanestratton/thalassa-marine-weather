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

import React, { useState, useEffect, useCallback } from 'react';
import { t } from '../theme';
import { ModalSheet } from './ui/ModalSheet';
import { UndoToast } from './ui/UndoToast';

import {
    type SharedRegister,
    type CrewMember,
    ALL_REGISTERS,
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
import { setActivePassage, getActivePassageId } from '../services/PassagePlanService';
import { AuthModal } from './AuthModal';
import { lazyRetry } from '../utils/lazyRetry';

// ── Extracted sub-components ──
import { InviteCrewModal } from './crew/InviteCrewModal';
import { CrewRoster } from './crew/CrewRoster';
import { ReadinessCardStack } from './crew/ReadinessCardStack';
import { useUI } from '../context/UIContext';
import { PageHeader } from './ui/PageHeader';

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
};

interface CrewManagementProps {
    onBack: () => void;
}

export const CrewManagement: React.FC<CrewManagementProps> = React.memo(({ onBack }) => {
    const [isAuthed, setIsAuthed] = useState(false);

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

    // ── Readiness card states ──
    const [customsCleared, setCustomsCleared] = useState(false);
    const [customsProgress, setCustomsProgress] = useState<{ total: number; checked: number }>({
        total: 0,
        checked: 0,
    });
    const [weatherReviewed, setWeatherReviewed] = useState(false);
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

    // Card delegation
    const DELEGATION_STORAGE_KEY = 'thalassa_card_delegations';
    const [cardDelegations, setCardDelegations] = useState<Record<string, string>>(() => {
        try {
            const stored = localStorage.getItem(DELEGATION_STORAGE_KEY);
            return stored ? JSON.parse(stored) : {};
        } catch {
            return {};
        }
    });
    const [delegationMenuOpen, setDelegationMenuOpen] = useState<string | null>(null);

    const assignCard = useCallback((cardKey: string, crewEmail: string | null) => {
        setCardDelegations((prev) => {
            const next = { ...prev };
            if (crewEmail) {
                next[cardKey] = crewEmail;
            } else {
                delete next[cardKey];
            }
            try {
                localStorage.setItem(DELEGATION_STORAGE_KEY, JSON.stringify(next));
            } catch {
                /* ignore */
            }
            return next;
        });
        setDelegationMenuOpen(null);
    }, []);

    // All readiness cards green → Cast Off unlocked
    const allCardsReady =
        customsCleared &&
        weatherReviewed &&
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

    // Planning panel state
    const [planDeparture, setPlanDeparture] = useState('');

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
    // see the prompt flash.
    const [_userEmail, setUserEmail] = useState<string | null>(null);
    const [authChecked, setAuthChecked] = useState(false);
    useEffect(() => {
        if (!supabase) {
            setAuthChecked(true);
            return;
        }
        let cancelled = false;
        void supabase.auth.getSession().then(({ data }) => {
            if (cancelled) return;
            setIsAuthed(!!data.session?.user);
            setUserEmail(data.session?.user?.email ?? null);
            setAuthChecked(true);
        });
        const {
            data: { subscription },
        } = supabase.auth.onAuthStateChange((_event, session) => {
            if (cancelled) return;
            setIsAuthed(!!session?.user);
            setUserEmail(session?.user?.email ?? null);
            setAuthChecked(true);
        });
        return () => {
            cancelled = true;
            subscription.unsubscribe();
        };
    }, []);

    // Load data
    const loadData = useCallback(async () => {
        setLoading(true);
        const [crew, invites, ships] = await Promise.all([getMyCrew(), getMyInvites(), getMyMemberships()]);
        setMyCrew(crew);
        setPendingInvites(invites);
        setMemberships(ships);
        setLoading(false);
    }, []);

    useEffect(() => {
        if (isAuthed) loadData();
    }, [isAuthed, loadData]);

    // Load voyage status + populate the dropdown DIRECTLY from logbook
    // routes. The voyages-table drafts are no longer the source of truth
    // for what shows here — they're only the receipt of which one the
    // user selected as active. This eliminates the filter/auto-heal
    // dance entirely:
    //
    //   - In the logbook → in the dropdown.
    //   - Not in the logbook → not in the dropdown.
    //
    // No drift possible because there's only one source.
    //
    // Existing voyages-table drafts that line up by name (case + trim
    // insensitive) get merged in so we already have a UUID for them
    // when the user selects (no creation roundtrip). New routes get a
    // UUID on first select via the on-select handler.
    const reloadDropdown = useCallback(async () => {
        try {
            const { getCachedActiveVoyage } = await import('../services/VoyageService');
            const v = getCachedActiveVoyage();
            if (v) setActiveVoyageName(v.voyage_name);
        } catch {
            /* non-critical */
        }
        // Force-refresh so a stale 60s RoutesAndTracks cache can't
        // miss a just-saved route or include a just-deleted one.
        const [routesAndTracks, allDrafts] = await Promise.all([fetchRoutesAndTracks(true), getDraftVoyages()]);
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
        const rows: VoyageRow[] = routesAndTracks.routes.map((r) => {
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

        setDraftVoyages(rows);

        // ── Orphan auto-heal at parent level ──────────────────────
        // selectedPassageId / getActivePassageId may point to a
        // voyage that no longer has a matching logbook route (e.g.
        // user deleted the route, or the voyage was created via Cast
        // Off without a planned route). The dropdown rows are built
        // FROM logbook routes, so the orphan is invisible there but
        // CastOffPanel still picks it up via initialVoyageId =
        // selectedPassageId, leading to "Newport → Perth"-style
        // stale-data confusion.
        //
        // If the current active id isn't in the new rows AND there's
        // at least one row with a real logbook route, switch the
        // active passage to the first row and update both:
        //   - setActivePassage (the localStorage cache)
        //   - selectedPassageId (this component's React state)
        // The rest of the app (CastOffPanel, GalleyCard) reads the
        // corrected id and shows the right voyage.
        const activeId = getActivePassageId();
        const activeIdInRows = activeId ? rows.some((r) => r.id === activeId) : false;
        if (activeId && !activeIdInRows && rows.length > 0) {
            const replacement = rows.find((r) => !r.id.startsWith('logbook:')) ?? rows[0];
            console.warn(
                `[CrewManagement] orphan auto-heal — active passage "${activeId}" has no matching row, switching to "${replacement.voyage_name}" (${replacement.id})`,
            );
            setActivePassage(replacement.id);
            setSelectedPassageId(replacement.id);
            setActiveVoyageName(replacement.voyage_name);
            if (replacement.departure_time) setPlanDeparture(replacement.departure_time.slice(0, 16));
        } else if (activeId) {
            const vMatch = rows.find((d) => d.id === activeId);
            if (vMatch?.departure_time) setPlanDeparture(vMatch.departure_time.slice(0, 16));
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
                row.departure_time &&
                !row.eta &&
                row.durationHours &&
                row.durationHours > 0
            ) {
                const etaIso = new Date(Date.parse(row.departure_time) + row.durationHours * 3_600_000).toISOString();
                updateVoyage(row.id, { eta: etaIso }).then((result) => {
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
    }, []);

    useEffect(() => {
        // Wait for auth to land before fetching — fetchRoutesAndTracks
        // and getDraftVoyages both return [] when supabase has no user.
        // The auth-check useEffect above runs in parallel, so on first
        // mount this dropdown loader was firing too early, getting
        // empty results, and never refreshing. That's why the user saw
        // "No draft passages yet" even when ship_logs had their saved
        // routes — it was a race between auth-check and dropdown-load,
        // and dropdown-load was winning.
        if (!isAuthed) return;
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
                window.removeEventListener('thalassa:passage-plan-saved', onSaved);
                window.removeEventListener('thalassa:departure-time-updated', onDepartureUpdate);
            };
        }
        return undefined;
    }, [reloadDropdown, isAuthed]);

    // ── Handlers ──

    const handleInvite = async () => {
        if (!inviteEmail.trim() || inviteRegisters.length === 0) return;
        setInviteLoading(true);
        setInviteError(null);
        setInviteSuccess(false);

        const result = await inviteCrew(inviteEmail, inviteRegisters);

        if (result.success) {
            setInviteSuccess(true);
            triggerHaptic('medium');
            setTimeout(() => {
                setShowInviteModal(false);
                setInviteEmail('');
                setInviteRegisters([]);
                setInviteSuccess(false);
                loadData();
            }, 1200);
        } else {
            setInviteError(result.error || 'Failed to send invite');
            triggerHaptic('heavy');
        }
        setInviteLoading(false);
    };

    const handleSoftDelete = (member: CrewMember, mode: 'captain' | 'crew') => {
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
        const { member, mode } = deletedMember;
        setDeletedMember(null);
        try {
            if (mode === 'captain') {
                await removeCrew(member.id);
            } else {
                await leaveVessel(member.id);
            }
        } catch {
            toast.error(mode === 'captain' ? 'Failed to remove crew' : 'Failed to leave vessel');
            if (mode === 'captain') {
                setMyCrew((prev) => [...prev, member]);
            } else {
                setMemberships((prev) => [...prev, member]);
            }
        }
    };

    const handleDisbandGroup = async () => {
        setDisbanding(true);
        const result = await disbandGroup();
        setDisbanding(false);
        setShowDisbandConfirm(false);
        setDisbandConfirmText('');

        if (result.success) {
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
        triggerHaptic('medium');
        const ok = await acceptInvite(invite.id);
        if (ok) {
            toast.success('Invite accepted!');
            loadData();
        }
    };

    const handleDecline = async (invite: CrewMember) => {
        triggerHaptic('light');
        const ok = await declineInvite(invite.id);
        if (ok) loadData();
    };

    const handleSavePermissions = async () => {
        if (!editTarget) return;
        const ok = await updateCrewPermissions(editTarget.id, editRegisters);

        // Mirror byline edits to boat_members if the modal had loaded one
        // (i.e. accepted invite, crew member is on the boat). UNIQUE
        // constraint catches collisions; we surface that as a toast and
        // keep the modal open so the owner can pick a different byline.
        let bylineErr: string | null = null;
        if (ok && editBoatMemberLoaded && supabase && editTarget.crew_user_id) {
            const { data: authData } = await supabase.auth.getUser();
            const myId = authData.user?.id;
            if (myId) {
                const { data: boat } = await supabase.from('boats').select('id').eq('owner_id', myId).maybeSingle();
                if (boat?.id) {
                    const { error } = await supabase
                        .from('boat_members')
                        .update({
                            prefix: editPrefix.trim() || null,
                            first_name: editFirstName.trim() || 'Crew',
                            last_name: editLastName.trim() || null,
                            nickname: editNickname.trim() || null,
                        })
                        .match({ boat_id: boat.id, user_id: editTarget.crew_user_id });
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
        if (ok) {
            setEditTarget(null);
            toast.success('Permissions updated');
            loadData();
        }
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

    // Filter out declined invites older than 7 days
    const visibleCrew = myCrew.filter((m) => {
        if (m.status !== 'declined') return true;
        const declinedAge = Date.now() - new Date(m.updated_at).getTime();
        return declinedAge < 7 * 24 * 60 * 60 * 1000;
    });

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

    // ── Not authenticated ──
    if (!isAuthed) {
        return (
            <div className={`h-full ${t.colors.bg.base} flex flex-col`}>
                <PageHeader title="Passage Planning" onBack={onBack} />
                <div className="flex-1 flex items-center justify-center p-8">
                    <div className="text-center">
                        <div className="text-4xl mb-4">👥</div>
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
                <AuthModal
                    isOpen={showAuth}
                    onClose={() => {
                        setShowAuth(false);
                        if (supabase) {
                            supabase.auth.getUser().then(({ data }) => {
                                setIsAuthed(!!data.user);
                                setUserEmail(data.user?.email || null);
                            });
                        }
                    }}
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
                    loading={loading}
                    onSoftDeleteCaptain={(m) => handleSoftDelete(m, 'captain')}
                    onSoftDeleteCrew={(m) => handleSoftDelete(m, 'crew')}
                    onEditMember={async (m) => {
                        setEditTarget(m);
                        setEditRegisters([...m.shared_registers]);
                        // Reset byline state until we know whether boat_members exists.
                        setEditPrefix('');
                        setEditFirstName('');
                        setEditLastName('');
                        setEditNickname('');
                        setEditBoatMemberLoaded(false);
                        // Look up the crew's boat_members row on the captain's boat.
                        // Only valid for accepted invites (the bridge trigger creates
                        // boat_members on status='accepted').
                        if (supabase && m.crew_user_id && m.status === 'accepted') {
                            const { data: authData } = await supabase.auth.getUser();
                            const myId = authData.user?.id;
                            if (myId) {
                                const { data: boat } = await supabase
                                    .from('boats')
                                    .select('id')
                                    .eq('owner_id', myId)
                                    .maybeSingle();
                                if (boat?.id) {
                                    const { data: bm } = await supabase
                                        .from('boat_members')
                                        .select('prefix, first_name, last_name, nickname')
                                        .eq('boat_id', boat.id)
                                        .eq('user_id', m.crew_user_id)
                                        .maybeSingle();
                                    if (bm) {
                                        setEditPrefix(bm.prefix ?? '');
                                        setEditFirstName(bm.first_name ?? '');
                                        setEditLastName(bm.last_name ?? '');
                                        setEditNickname(bm.nickname ?? '');
                                        setEditBoatMemberLoaded(true);
                                    }
                                }
                            }
                        }
                    }}
                    onAcceptInvite={handleAccept}
                    onDeclineInvite={handleDecline}
                    onDisbandClick={() => setShowDisbandConfirm(true)}
                    onInviteClick={() => {
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
                        <span className="text-base">🧭</span>
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
                    <label className="text-[11px] uppercase font-bold text-violet-400/60 tracking-wider mb-1.5 block">
                        🧭 Active Passage
                    </label>
                    {draftVoyages.length > 0 ? (
                        <select
                            value={selectedPassageId}
                            onChange={async (e) => {
                                const id = e.target.value;
                                setSelectedPassageId(id);
                                if (!id) {
                                    setActiveVoyageName(null);
                                    return;
                                }

                                // Stub rows from the logbook have id
                                // prefixed `logbook:`. Materialise a real
                                // voyages-table row before activating so
                                // setActivePassage gets a UUID it can
                                // resolve back to a voyage downstream.
                                let realId = id;
                                let row = draftVoyages.find((v) => v.id === id);
                                if (id.startsWith('logbook:') && row) {
                                    const { voyage } = await createVoyage({
                                        voyage_name: row.voyage_name,
                                        departure_port: row.departure_port,
                                        destination_port: row.destination_port,
                                        crew_count: 1,
                                        // Persist the route-inferred dates
                                        // when promoting a stub. Without
                                        // this, picking a logbook route in
                                        // the dropdown for the first time
                                        // creates a voyage with null dates
                                        // and the user has to re-pick.
                                        departure_time: row.departure_time,
                                        eta: row.eta,
                                    });
                                    if (voyage) {
                                        realId = voyage.id;
                                        // Replace the stub with the real
                                        // row so future selects in this
                                        // session use the UUID directly.
                                        // Carry over the coords + duration
                                        // from the logbook lookup so the
                                        // readiness cards (Weather Windows,
                                        // Ocean Currents) can still find
                                        // their departure point AND voyage
                                        // provisioning can auto-compute ETA.
                                        const promoted: VoyageRow = {
                                            ...voyage,
                                            departureCoords: row.departureCoords,
                                            arrivalCoords: row.arrivalCoords,
                                            durationHours: row.durationHours,
                                        };
                                        row = promoted;
                                        setDraftVoyages((prev) => prev.map((d) => (d.id === id ? promoted : d)));
                                        setSelectedPassageId(voyage.id);
                                    }
                                }

                                setActivePassage(realId);
                                triggerHaptic('light');
                                if (row) {
                                    setActiveVoyageName(
                                        row.voyage_name ||
                                            `${row.departure_port || '?'} → ${row.destination_port || '?'}`,
                                    );
                                    setPlanDeparture(row.departure_time ? row.departure_time.slice(0, 16) : '');
                                }
                            }}
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
                                </option>
                            ))}
                        </select>
                    ) : (
                        <div className="bg-white/[0.03] border border-dashed border-white/[0.08] rounded-lg p-3 text-center">
                            <p className="text-[11px] text-gray-400">
                                No draft passages yet. Tap <strong>Plan a route</strong> above to create one.
                            </p>
                        </div>
                    )}

                    {/* ── Diagnostic + nuke controls ─────────────────────── */}
                    {/* Surfaces what's actually populating the dropdown so a */}
                    {/* "ghost" passage (in DB but no longer in your logbook) */}
                    {/* can be wiped without poking around in Supabase. */}
                    <div className="mt-1.5 flex items-center justify-between gap-2 px-1">
                        <span className="text-[10px] text-gray-500 font-mono">{draftVoyages.length} from logbook</span>
                        {draftVoyages.length > 0 && (
                            <button
                                type="button"
                                onClick={async () => {
                                    const visibleNames = draftVoyages.map((v) => v.voyage_name || '?').join(', ');
                                    if (
                                        !window.confirm(
                                            `This will delete ALL saved passage routes from your logbook ` +
                                                `(${draftVoyages.length} item${draftVoyages.length === 1 ? '' : 's'}: ${visibleNames}).\n\n` +
                                                `Recorded tracks (actual sailed voyages) will NOT be touched. ` +
                                                `Continue?`,
                                        )
                                    ) {
                                        return;
                                    }
                                    triggerHaptic('medium');
                                    try {
                                        const { ShipLogService } = await import('../services/ShipLogService');
                                        // Pull a fresh route list (force = true) and delete each
                                        // by voyageId — the existing deleteVoyage cascades to
                                        // both ship_log rows + the matching voyages-table draft.
                                        const fresh = await fetchRoutesAndTracks(true);
                                        for (const r of fresh.routes) {
                                            await ShipLogService.deleteVoyage(r.id);
                                        }
                                        // Also cull any draft voyages whose name doesn't
                                        // correspond to a remaining ship_log route — picks up
                                        // pre-existing orphans that the cascade can't reach
                                        // because there are no entries left to link them.
                                        const remainingDrafts = await getDraftVoyages();
                                        for (const d of remainingDrafts) {
                                            if (!d.voyage_name.includes('→')) continue;
                                            const day = d.created_at.slice(0, 10);
                                            const { deleteDraftVoyagesByNameAndDay } =
                                                await import('../services/VoyageService');
                                            await deleteDraftVoyagesByNameAndDay(d.voyage_name, day);
                                        }
                                        setDraftVoyages([]);
                                        setSelectedPassageId('');
                                        setActiveVoyageName(null);
                                        toast.success('All saved passages cleared');
                                    } catch (err) {
                                        console.error('[CrewManagement] cleanup failed:', err);
                                        toast.error('Cleanup failed — try again');
                                    }
                                }}
                                className="text-[10px] uppercase font-bold tracking-widest text-red-400/70 hover:text-red-400 transition-colors"
                            >
                                Clear all
                            </button>
                        )}
                    </div>
                </div>

                {/* ── DEPARTURE DATE + CAST OFF (single row) ── */}
                {selectedPassageId && (
                    <div className="mb-4 flex items-end gap-2">
                        {/* Departure date — date only, time decided later */}
                        <div className="flex-1 min-w-0">
                            <label className="text-[11px] uppercase font-bold text-slate-500 tracking-widest mb-1 block">
                                📅 Departure Date
                            </label>
                            <input
                                type="date"
                                value={planDeparture ? planDeparture.slice(0, 10) : ''}
                                onChange={(e) => {
                                    const val = e.target.value;
                                    setPlanDeparture(val);
                                    // Auto-save to voyage AND auto-compute
                                    // ETA = departure + planned duration.
                                    // The duration came from the logbook
                                    // route's entry-timestamp spread (see
                                    // RoutesAndTracks.durationHours), which
                                    // round-trips back to the original
                                    // Gemini estimate at save time.
                                    // Without auto-ETA, the GalleyCard meal
                                    // planner blocks on a missing eta and
                                    // tells the user "set departure & eta"
                                    // even though departure IS set.
                                    if (selectedPassageId && val) {
                                        // Store the picked date as UTC midnight, NOT
                                        // local midnight. `new Date(val)` (where val is
                                        // YYYY-MM-DD) parses as UTC per the ECMAScript
                                        // spec — and slicing the resulting ISO back to
                                        // the first 10 chars gives the same calendar
                                        // day regardless of the user's timezone. The
                                        // previous `${val}T00:00:00` (no Z) was parsed
                                        // as local time, which in AEST shifted the
                                        // stored value back to the previous day's UTC
                                        // — user picked May 12, ISO stored as May 11.
                                        const departureIso = new Date(val).toISOString();
                                        const row = draftVoyages.find((v) => v.id === selectedPassageId);
                                        const durHours = row?.durationHours;
                                        const update: Parameters<typeof updateVoyage>[1] = {
                                            departure_time: departureIso,
                                        };
                                        if (durHours && durHours > 0) {
                                            update.eta = new Date(
                                                Date.parse(departureIso) + durHours * 3_600_000,
                                            ).toISOString();
                                        }
                                        updateVoyage(selectedPassageId, update).then((result) => {
                                            if (result.voyage) {
                                                // Preserve the row's
                                                // departureCoords /
                                                // arrivalCoords / durationHours
                                                // through the merge — those
                                                // aren't stored in supabase.
                                                setDraftVoyages((prev) =>
                                                    prev.map((v) =>
                                                        v.id === selectedPassageId
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
                                }}
                                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-violet-500/30 transition-colors [color-scheme:dark]"
                            />
                        </div>

                        {/* Cast Off CTA */}
                        <button
                            onClick={() => {
                                setShowCastOff(true);
                                triggerHaptic('medium');
                            }}
                            disabled={!allCardsReady}
                            className={`shrink-0 px-5 py-2.5 rounded-xl text-xs font-bold uppercase tracking-widest border transition-all active:scale-[0.97] disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-1.5 ${
                                allCardsReady
                                    ? 'bg-gradient-to-r from-emerald-500/10 to-teal-500/10 border-emerald-500/20 text-emerald-300 hover:from-emerald-500/20 hover:to-teal-500/20'
                                    : 'bg-white/[0.03] border-white/[0.08] text-gray-500'
                            }`}
                        >
                            ⚓ Cast Off
                        </button>
                    </div>
                )}

                {/* CrewRoster moved to the top of the scroll content. */}

                {/* ── READINESS CARDS ── always render the stack so the
                    three group headers stay visible. The cards inside each
                    group are gated on selectedPassageId by the stack
                    itself — when no passage is picked, just the headers
                    show (rolled up) with a hint above pointing the user
                    at the passage selector. */}
                {!loading && (
                    <ReadinessCardStack
                        selectedPassageId={selectedPassageId}
                        draftVoyages={draftVoyages}
                        visibleCrew={visibleCrew}
                        planCrewCount={Math.max(visibleCrew.length + 1, 2)}
                        weatherReviewed={weatherReviewed}
                        reservesReady={reservesReady}
                        vesselChecked={vesselChecked}
                        medicalReady={medicalReady}
                        watchBriefed={watchBriefed}
                        commsReady={commsReady}
                        customsCleared={customsCleared}
                        navAcknowledged={navAcknowledged}
                        customsProgress={customsProgress}
                        onWeatherChange={setWeatherReviewed}
                        onReservesChange={setReservesReady}
                        onVesselCheckChange={setVesselChecked}
                        onMedicalChange={setMedicalReady}
                        onWatchChange={setWatchBriefed}
                        onCommsChange={setCommsReady}
                        onCustomsChange={(total, checked) => {
                            setCustomsProgress({ total, checked });
                            setCustomsCleared(total > 0 && checked >= total);
                        }}
                        onNavChange={setNavAcknowledged}
                        cardDelegations={cardDelegations}
                        delegationMenuOpen={delegationMenuOpen}
                        onDelegationMenuToggle={setDelegationMenuOpen}
                        onAssignCard={assignCard}
                        vesselProfileReady={vesselProfileReady}
                        comfortProfileReady={comfortProfileReady}
                        weatherWindowReady={weatherWindowReady}
                        currentsBriefed={currentsBriefed}
                        onVesselProfileChange={setVesselProfileReady}
                        onComfortProfileChange={setComfortProfileReady}
                        onWeatherWindowChange={setWeatherWindowReady}
                        onCurrentsChange={setCurrentsBriefed}
                    />
                )}
            </div>

            {/* ── INVITE MODAL ── */}
            <ModalSheet
                isOpen={showInviteModal}
                onClose={() => {
                    setShowInviteModal(false);
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
                    onEmailChange={setInviteEmail}
                    onToggleRegister={(reg) => toggleRegister(reg, inviteRegisters, setInviteRegisters)}
                    onInvite={handleInvite}
                />
            </ModalSheet>

            {/* ── EDIT PERMISSIONS MODAL ── */}
            <ModalSheet
                isOpen={!!editTarget}
                onClose={() => setEditTarget(null)}
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
                                    onChange={(e) => setEditPrefix(e.target.value)}
                                    placeholder="Capt."
                                    aria-label="Title prefix (optional)"
                                    className="col-span-2 w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white focus:border-sky-500 outline-none text-sm placeholder:text-gray-500"
                                />
                                <input
                                    type="text"
                                    value={editFirstName}
                                    onChange={(e) => setEditFirstName(e.target.value)}
                                    placeholder="First *"
                                    aria-label="First name"
                                    className="col-span-3 w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white focus:border-sky-500 outline-none text-sm placeholder:text-gray-500"
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-2 mt-2">
                                <input
                                    type="text"
                                    value={editLastName}
                                    onChange={(e) => setEditLastName(e.target.value)}
                                    placeholder="Surname"
                                    aria-label="Surname"
                                    className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white focus:border-sky-500 outline-none text-sm placeholder:text-gray-500"
                                />
                                <input
                                    type="text"
                                    value={editNickname}
                                    onChange={(e) => setEditNickname(e.target.value)}
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
                                        onClick={() => toggleRegister(reg, editRegisters, setEditRegisters)}
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
                    setShowDisbandConfirm(false);
                    setDisbandConfirmText('');
                }}
                title="Disband Group"
            >
                <div className="space-y-4">
                    <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4">
                        <p className="text-sm text-red-300 font-bold mb-2">⚠️ This action cannot be undone</p>
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
                            onChange={(e) => setDisbandConfirmText(e.target.value.toUpperCase())}
                            placeholder="DISBAND"
                            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500/40"
                        />
                    </div>

                    <button
                        aria-label="Confirm Disband"
                        onClick={handleDisbandGroup}
                        disabled={disbandConfirmText !== 'DISBAND' || disbanding}
                        className={`w-full py-3.5 rounded-xl font-bold text-sm transition-all active:scale-95 ${
                            disbandConfirmText === 'DISBAND' && !disbanding
                                ? 'bg-red-600 text-white hover:bg-red-700 shadow-lg shadow-red-500/20'
                                : 'bg-white/[0.04] text-gray-500 cursor-not-allowed'
                        }`}
                    >
                        {disbanding ? 'Disbanding…' : '🚨 Disband Entire Group'}
                    </button>
                </div>
            </ModalSheet>

            {/* ── CAST OFF PANEL ── */}
            {showCastOff && (
                <CastOffPanel
                    onClose={() => setShowCastOff(false)}
                    initialVoyageId={selectedPassageId || undefined}
                    onCastOff={(voyage) => {
                        setActiveVoyageName(voyage.voyage_name);
                        setShowCastOff(false);
                    }}
                />
            )}
        </div>
    );
});
