import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrewMember, SharedRegister } from '../services/CrewService';
import type { AuthorizedSharedVoyagesResult, PassageStatus } from '../services/PassagePlanService';
import type { Voyage } from '../services/VoyageService';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

const mocks = vi.hoisted(() => ({
    authUserId: 'crew-user',
    activePassageId: '' as string,
    setPage: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
    inviteCrew: vi.fn(),
    getMyCrew: vi.fn(),
    getMyInvites: vi.fn(),
    getMyMemberships: vi.fn(),
    removeCrew: vi.fn(),
    disbandGroup: vi.fn(),
    updateCrewPermissions: vi.fn(),
    acceptInvite: vi.fn(),
    declineInvite: vi.fn(),
    leaveVessel: vi.fn(),
    getPassageStatus: vi.fn(),
    getAuthorizedSharedVoyages: vi.fn(),
    setActivePassage: vi.fn(),
    clearPassagePlan: vi.fn(),
    getDraftVoyages: vi.fn(),
    createVoyage: vi.fn(),
    updateVoyage: vi.fn(),
    getCachedActiveVoyage: vi.fn(),
    fetchRoutesAndTracks: vi.fn(),
    deleteVoyage: vi.fn(),
}));

vi.mock('../theme', () => ({
    t: {
        colors: { bg: { base: 'bg-slate-950' } },
        border: { default: 'border border-white/10' },
    },
}));

vi.mock('../stores/authStore', () => ({
    useAuthStore: (selector: (state: Record<string, unknown>) => unknown) =>
        selector({
            user: { id: mocks.authUserId, email: `${mocks.authUserId}@example.com` },
            authChecked: true,
        }),
}));

vi.mock('../context/UIContext', () => ({
    useUI: () => ({ setPage: mocks.setPage }),
}));

vi.mock('../services/supabase', () => ({ supabase: null }));

vi.mock('../services/CrewService', () => ({
    ALL_REGISTERS: ['stores', 'passage_checklist'],
    PASSAGE_REGISTERS: ['passage_meals', 'passage_chat', 'passage_route', 'passage_checklist'],
    REGISTER_ICONS: { stores: '📦', passage_checklist: '✅' },
    REGISTER_LABELS: { stores: "Ship's Stores", passage_checklist: 'Checklist' },
    inviteCrew: mocks.inviteCrew,
    getMyCrew: mocks.getMyCrew,
    removeCrew: mocks.removeCrew,
    disbandGroup: mocks.disbandGroup,
    updateCrewPermissions: mocks.updateCrewPermissions,
    getMyInvites: mocks.getMyInvites,
    getMyMemberships: mocks.getMyMemberships,
    acceptInvite: mocks.acceptInvite,
    declineInvite: mocks.declineInvite,
    leaveVessel: mocks.leaveVessel,
}));

vi.mock('../services/PassagePlanService', () => {
    const noAccess: PassageStatus = {
        visible: false,
        voyageId: null,
        ownerUserId: null,
        isOwner: false,
        canEditStores: false,
        canViewMeals: false,
        canViewChat: false,
        canViewRoute: false,
        canViewChecklist: false,
    };
    mocks.setActivePassage.mockImplementation((voyageId: string) => {
        mocks.activePassageId = voyageId;
        window.dispatchEvent(
            new CustomEvent('thalassa:passage-changed', {
                detail: { voyageId },
            }),
        );
    });
    mocks.clearPassagePlan.mockImplementation(() => {
        mocks.activePassageId = '';
        window.dispatchEvent(
            new CustomEvent('thalassa:passage-changed', {
                detail: { voyageId: null },
            }),
        );
    });
    return {
        NO_PASSAGE_ACCESS: noAccess,
        getActivePassageId: () => mocks.activePassageId || null,
        getPassageStatus: mocks.getPassageStatus,
        getAuthorizedSharedVoyages: mocks.getAuthorizedSharedVoyages,
        setActivePassage: mocks.setActivePassage,
        clearPassagePlan: mocks.clearPassagePlan,
    };
});

vi.mock('../services/VoyageService', () => ({
    getDraftVoyages: mocks.getDraftVoyages,
    createVoyage: mocks.createVoyage,
    updateVoyage: mocks.updateVoyage,
    getCachedActiveVoyage: mocks.getCachedActiveVoyage,
}));

vi.mock('../services/shiplog/RoutesAndTracks', () => ({
    fetchRoutesAndTracks: mocks.fetchRoutesAndTracks,
}));

vi.mock('../services/ShipLogService', () => ({
    ShipLogService: { deleteVoyage: mocks.deleteVoyage },
}));

vi.mock('../utils/system', () => ({
    triggerHaptic: vi.fn(),
}));

vi.mock('../utils/lazyRetry', () => ({
    lazyRetry: () =>
        function MockCastOffPanel({ initialVoyageId }: { initialVoyageId?: string }) {
            return <div data-testid="cast-off-panel">{initialVoyageId}</div>;
        },
}));

vi.mock('../components/Toast', () => ({
    toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

vi.mock('../components/SignInScreen', () => ({
    SignInScreen: () => null,
}));

vi.mock('../components/ui/PageHeader', () => ({
    PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

vi.mock('../components/ui/DataFreshness', () => ({
    DataFreshness: () => <div data-testid="freshness" />,
}));

vi.mock('../components/ui/UndoToast', () => ({
    UndoToast: () => null,
}));

vi.mock('../components/ui/ModalSheet', () => ({
    ModalSheet: ({ children, isOpen, title }: { children: React.ReactNode; isOpen: boolean; title: string }) =>
        isOpen ? <section aria-label={title}>{children}</section> : null,
}));

vi.mock('../components/crew/CrewRoster', () => ({
    CrewRoster: ({
        visibleCrew,
        pendingInvites,
        memberships,
        onInviteClick,
        onAcceptInvite,
    }: {
        visibleCrew: CrewMember[];
        pendingInvites: CrewMember[];
        memberships: CrewMember[];
        onInviteClick: () => void;
        onAcceptInvite: (invite: CrewMember) => void;
    }) => (
        <section aria-label="My Crew">
            {visibleCrew.map((member) => (
                <span key={member.id}>{member.crew_email}</span>
            ))}
            {pendingInvites.map((invite) => (
                <div key={invite.id}>
                    <span>{invite.owner_email}</span>
                    <button type="button" onClick={() => onAcceptInvite(invite)}>
                        Accept {invite.owner_email}
                    </button>
                </div>
            ))}
            {memberships.map((member) => (
                <span key={member.id}>{member.owner_email}</span>
            ))}
            <button type="button" onClick={onInviteClick}>
                Invite crew member
            </button>
        </section>
    ),
}));

interface MockInviteProps {
    inviteEmail: string;
    inviteRegisters: SharedRegister[];
    inviteError: string | null;
    onEmailChange: (value: string) => void;
    onToggleRegister: (register: SharedRegister) => void;
    onInvite: () => void;
}

vi.mock('../components/crew/InviteCrewModal', () => ({
    InviteCrewModal: ({
        inviteEmail,
        inviteRegisters,
        inviteError,
        onEmailChange,
        onToggleRegister,
        onInvite,
    }: MockInviteProps) => (
        <div>
            <input
                aria-label="Crew email"
                value={inviteEmail}
                onChange={(event) => onEmailChange(event.target.value)}
            />
            <button
                type="button"
                aria-pressed={inviteRegisters.includes('passage_checklist')}
                onClick={() => onToggleRegister('passage_checklist')}
            >
                Share checklist
            </button>
            <button type="button" onClick={onInvite}>
                Send invite
            </button>
            {inviteError && <p role="alert">{inviteError}</p>}
        </div>
    ),
}));

interface MockReadinessProps {
    selectedPassageId: string;
    passageStatus: PassageStatus;
    draftVoyages: Voyage[];
    cardDelegations: Record<string, string>;
    onReservesChange: (value: boolean) => void;
    onVesselCheckChange: (value: boolean) => void;
    onMedicalChange: (value: boolean) => void;
    onWatchChange: (value: boolean) => void;
    onCommsChange: (value: boolean) => void;
    onCustomsChange: (total: number, checked: number) => void;
    onNavChange: (value: boolean) => void;
    onWeatherWindowChange: (value: boolean) => void;
    onAssignCard: (cardKey: string, email: string) => void;
}

vi.mock('../components/crew/ReadinessCardStack', () => ({
    ReadinessCardStack: (props: MockReadinessProps) => {
        const active = props.draftVoyages.find((voyage) => voyage.id === props.selectedPassageId);
        return (
            <div
                data-testid="readiness-stack"
                data-selected={props.selectedPassageId}
                data-owner={String(props.passageStatus.isOwner)}
                data-has-coordinates={String(
                    Boolean((active as Voyage & { departureCoords?: unknown })?.departureCoords),
                )}
                data-delegation-count={String(Object.keys(props.cardDelegations).length)}
            >
                <button
                    type="button"
                    onClick={() => {
                        props.onReservesChange(true);
                        props.onVesselCheckChange(true);
                        props.onMedicalChange(true);
                        props.onWatchChange(true);
                        props.onCommsChange(true);
                        props.onCustomsChange(1, 1);
                        props.onNavChange(true);
                        props.onWeatherWindowChange(true);
                    }}
                >
                    Mark passage ready
                </button>
                {props.passageStatus.isOwner && (
                    <button type="button" onClick={() => props.onAssignCard('weather', 'deckhand@example.com')}>
                        Assign card
                    </button>
                )}
            </div>
        );
    },
}));

vi.mock('../components/Icons', () => {
    const Icon = () => <span aria-hidden="true" />;
    return {
        UsersIcon: Icon,
        CompassIcon: Icon,
        CalendarGridIcon: Icon,
        AnchorIcon: Icon,
        AlertTriangleIcon: Icon,
        SosIcon: Icon,
    };
});

import { CrewManagement } from '../components/CrewManagement';

const statusFor = (voyageId: string, isOwner: boolean): PassageStatus => ({
    visible: true,
    voyageId,
    ownerUserId: isOwner ? 'crew-user' : 'captain-1',
    isOwner,
    canEditStores: isOwner,
    canViewMeals: true,
    canViewChat: true,
    canViewRoute: true,
    canViewChecklist: true,
});

const voyage = (id: string, ownerId: string, name = `Voyage ${id}`): Voyage => ({
    id,
    user_id: ownerId,
    vessel_id: null,
    voyage_name: name,
    departure_port: 'Brisbane',
    destination_port: 'Noumea',
    departure_time: '2026-08-01T00:00:00.000Z',
    eta: '2026-08-05T00:00:00.000Z',
    crew_count: 3,
    status: 'planning',
    weather_master_id: ownerId,
    notes: null,
    created_at: '2026-07-23T00:00:00.000Z',
    updated_at: '2026-07-23T00:00:00.000Z',
});

const membership = (ownerId: string, voyageId: string | null): CrewMember => ({
    id: `membership-${ownerId}`,
    owner_id: ownerId,
    crew_user_id: 'crew-user',
    crew_email: 'crew@example.com',
    owner_email: `${ownerId}@example.com`,
    shared_registers: ['passage_checklist'],
    permissions: {
        can_view_stores: false,
        can_edit_stores: false,
        can_view_galley: false,
        can_view_nav: false,
        can_view_weather: false,
        can_edit_log: false,
        can_view_passage: true,
        can_view_passage_meals: false,
        can_view_passage_chat: false,
        can_view_passage_route: false,
        can_view_passage_checklist: true,
    },
    status: 'accepted',
    role: 'deckhand',
    voyage_id: voyageId,
    created_at: '2026-07-23T00:00:00.000Z',
    updated_at: '2026-07-23T00:00:00.000Z',
});

const route = (id: string, label: string) => ({
    id,
    label,
    sublabel: '4 days',
    points: [
        { lat: -27.47, lon: 153.03 },
        { lat: -22.27, lon: 166.44 },
    ],
    bbox: [153.03, -27.47, 166.44, -22.27] as [number, number, number, number],
    timestamp: Date.parse('2026-08-01T00:00:00.000Z'),
    distanceNm: 800,
    durationHours: 96,
    isLocal: false,
    kind: 'sea' as const,
});

const noAccess: PassageStatus = {
    visible: false,
    voyageId: null,
    ownerUserId: null,
    isOwner: false,
    canEditStores: false,
    canViewMeals: false,
    canViewChat: false,
    canViewRoute: false,
    canViewChecklist: false,
};

const rosterMember = (accountId: string, id: string, email: string): CrewMember => ({
    ...membership(accountId, null),
    id,
    owner_id: accountId,
    crew_user_id: `crew-${id}`,
    crew_email: email,
    owner_email: `${accountId}@example.com`,
});

const renderPage = () => render(<CrewManagement onBack={vi.fn()} />);

describe('CrewManagement shared passage ownership', () => {
    beforeEach(() => {
        localStorage.clear();
        mocks.authUserId = 'crew-user';
        setAuthIdentityScope('crew-user');
        mocks.activePassageId = '';
        vi.clearAllMocks();
        mocks.getMyCrew.mockResolvedValue([]);
        mocks.getMyInvites.mockResolvedValue([]);
        mocks.getMyMemberships.mockResolvedValue([]);
        mocks.inviteCrew.mockResolvedValue({ success: true });
        mocks.getDraftVoyages.mockResolvedValue([]);
        mocks.createVoyage.mockResolvedValue({ voyage: null, error: 'not configured' });
        mocks.updateVoyage.mockResolvedValue({ voyage: null });
        mocks.getCachedActiveVoyage.mockReturnValue(null);
        mocks.fetchRoutesAndTracks.mockResolvedValue({ routes: [], tracks: [] });
        mocks.deleteVoyage.mockResolvedValue(undefined);
        mocks.getAuthorizedSharedVoyages.mockResolvedValue({
            voyages: [],
            complete: true,
        } satisfies AuthorizedSharedVoyagesResult);
        mocks.getPassageStatus.mockResolvedValue(noAccess);
    });

    it('retains and marks a verified shared voyage without logbook coordinates', async () => {
        const own = voyage('own-voyage', 'crew-user', 'My future route');
        const shared = voyage('shared-voyage', 'captain-1', 'Captain’s passage');
        mocks.activePassageId = shared.id;
        mocks.getDraftVoyages.mockResolvedValue([own]);
        mocks.fetchRoutesAndTracks.mockResolvedValue({
            routes: [route('planned-own', own.voyage_name)],
            tracks: [],
        });
        mocks.getMyMemberships.mockResolvedValue([membership('captain-1', shared.id)]);
        mocks.getAuthorizedSharedVoyages.mockResolvedValue({
            voyages: [{ voyage: shared, ownerEmail: 'captain@example.com' }],
            complete: true,
        });
        mocks.getPassageStatus.mockImplementation(async (id: string | null) =>
            id === shared.id ? statusFor(shared.id, false) : statusFor(own.id, true),
        );

        renderPage();

        const selector = await screen.findByRole('combobox');
        await waitFor(() =>
            expect(
                within(selector).getByRole('option', {
                    name: /Captain’s passage — Shared by captain@example.com/,
                }),
            ).toBeInTheDocument(),
        );
        expect(selector).toHaveValue(shared.id);
        expect(mocks.getPassageStatus).toHaveBeenCalledWith(shared.id);
        expect(mocks.setActivePassage).not.toHaveBeenCalled();
        expect(mocks.clearPassagePlan).not.toHaveBeenCalled();
        expect(screen.queryByLabelText('Departure Date')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Cast Off' })).not.toBeInTheDocument();
        expect(screen.getByText(/departure and Cast Off stay with the skipper/i)).toBeInTheDocument();
        expect(screen.getByTestId('readiness-stack')).toHaveAttribute('data-selected', shared.id);
        expect(screen.getByTestId('readiness-stack')).toHaveAttribute('data-owner', 'false');
        expect(screen.getByTestId('readiness-stack')).toHaveAttribute('data-has-coordinates', 'false');
        expect(screen.getByRole('button', { name: /Plan a route/ })).toBeInTheDocument();
        expect(screen.getByRole('region', { name: 'My Crew' })).toBeInTheDocument();
    });

    it('clears both selector state and the active-passage store when blank is selected', async () => {
        const own = voyage('own-voyage', 'crew-user');
        mocks.activePassageId = own.id;
        mocks.getDraftVoyages.mockResolvedValue([own]);
        mocks.fetchRoutesAndTracks.mockResolvedValue({
            routes: [route('planned-own', own.voyage_name)],
            tracks: [],
        });
        mocks.getPassageStatus.mockImplementation(async (id: string | null) =>
            id === own.id ? statusFor(own.id, true) : noAccess,
        );

        renderPage();
        const selector = await screen.findByRole('combobox');
        await waitFor(() => expect(selector).toHaveValue(own.id));

        fireEvent.change(selector, { target: { value: '' } });

        await waitFor(() => expect(selector).toHaveValue(''));
        expect(mocks.clearPassagePlan).toHaveBeenCalledTimes(1);
        await waitFor(() => expect(mocks.getPassageStatus).toHaveBeenCalledWith(null));
        expect(screen.queryByLabelText('Departure Date')).not.toBeInTheDocument();
    });

    it('cancels or confirms clear-all through the app dialog and cannot submit twice', async () => {
        const own = voyage('own-voyage', 'crew-user', 'Route to Moreton');
        mocks.activePassageId = own.id;
        mocks.getDraftVoyages.mockResolvedValue([own]);
        mocks.fetchRoutesAndTracks.mockResolvedValue({
            routes: [route('planned-own', own.voyage_name)],
            tracks: [],
        });
        mocks.getPassageStatus.mockImplementation(async (id: string | null) =>
            id === own.id ? statusFor(own.id, true) : noAccess,
        );

        let finishDelete!: () => void;
        mocks.deleteVoyage.mockReturnValue(
            new Promise<void>((resolve) => {
                finishDelete = resolve;
            }),
        );

        renderPage();
        const clearAll = await screen.findByRole('button', { name: 'Clear all' });

        fireEvent.click(clearAll);
        expect(screen.getByRole('dialog', { name: 'Clear all saved passages?' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel action' }));
        expect(screen.queryByRole('dialog', { name: 'Clear all saved passages?' })).not.toBeInTheDocument();
        expect(mocks.deleteVoyage).not.toHaveBeenCalled();

        fireEvent.click(clearAll);
        const confirm = screen.getByRole('button', { name: 'Confirm action' });
        fireEvent.click(confirm);
        fireEvent.click(confirm);
        await waitFor(() => expect(mocks.deleteVoyage).toHaveBeenCalledTimes(1));

        await act(async () => {
            finishDelete();
        });
        await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith('All saved passages cleared'));
        expect(screen.queryByRole('dialog', { name: 'Clear all saved passages?' })).not.toBeInTheDocument();
    });

    it('resets stale Cast Off readiness whenever the skipper switches passages', async () => {
        const first = voyage('voyage-1', 'crew-user', 'First passage');
        const second = voyage('voyage-2', 'crew-user', 'Second passage');
        mocks.activePassageId = first.id;
        mocks.getDraftVoyages.mockResolvedValue([first, second]);
        mocks.fetchRoutesAndTracks.mockResolvedValue({
            routes: [route('planned-first', first.voyage_name), route('planned-second', second.voyage_name)],
            tracks: [],
        });
        mocks.getPassageStatus.mockImplementation(async (id: string | null) => (id ? statusFor(id, true) : noAccess));

        renderPage();
        const selector = await screen.findByRole('combobox');
        const castOff = await screen.findByRole('button', { name: 'Cast Off' });
        expect(castOff).toBeDisabled();

        fireEvent.click(screen.getByRole('button', { name: 'Mark passage ready' }));
        expect(castOff).toBeEnabled();
        fireEvent.click(screen.getByRole('button', { name: 'Assign card' }));
        expect(screen.getByTestId('readiness-stack')).toHaveAttribute('data-delegation-count', '1');

        fireEvent.change(selector, { target: { value: second.id } });

        await waitFor(() => expect(selector).toHaveValue(second.id));
        expect(screen.getByRole('button', { name: 'Cast Off' })).toBeDisabled();
        expect(screen.getByTestId('readiness-stack')).toHaveAttribute('data-delegation-count', '0');
        expect(mocks.setActivePassage).toHaveBeenCalledWith(second.id);
    });

    it('isolates per-voyage delegation emails across account transitions', async () => {
        const own = voyage('voyage-1', 'crew-user', 'Private passage');
        mocks.activePassageId = own.id;
        mocks.getDraftVoyages.mockResolvedValue([own]);
        mocks.fetchRoutesAndTracks.mockResolvedValue({
            routes: [route('planned-private', own.voyage_name)],
            tracks: [],
        });
        mocks.getPassageStatus.mockImplementation(async (id: string | null) =>
            id === own.id ? statusFor(own.id, true) : noAccess,
        );
        localStorage.setItem(
            'thalassa_card_delegations_v2',
            JSON.stringify({ [own.id]: { weather: 'legacy-secret@example.com' } }),
        );

        renderPage();
        await screen.findByRole('combobox');
        await waitFor(() =>
            expect(screen.getByTestId('readiness-stack')).toHaveAttribute('data-delegation-count', '0'),
        );

        fireEvent.click(screen.getByRole('button', { name: 'Assign card' }));
        expect(screen.getByTestId('readiness-stack')).toHaveAttribute('data-delegation-count', '1');
        const accountA = getAuthIdentityScope();
        expect(localStorage.getItem(authScopedStorageKey('thalassa_card_delegations_v2', accountA))).toContain(
            'deckhand@example.com',
        );

        mocks.authUserId = 'account-b';
        act(() => {
            setAuthIdentityScope('account-b');
        });
        await waitFor(() =>
            expect(screen.getByTestId('readiness-stack')).toHaveAttribute('data-delegation-count', '0'),
        );

        // Even if an A-era permission result is still mounted for a frame,
        // its owner fence prevents it from writing into B's namespace.
        fireEvent.click(screen.getByRole('button', { name: 'Assign card' }));
        expect(
            localStorage.getItem(authScopedStorageKey('thalassa_card_delegations_v2', getAuthIdentityScope())),
        ).toBeNull();

        mocks.authUserId = 'crew-user';
        act(() => {
            setAuthIdentityScope('crew-user');
        });
        await waitFor(() =>
            expect(screen.getByTestId('readiness-stack')).toHaveAttribute('data-delegation-count', '1'),
        );
    });

    it('waits for membership resolution before clearing an orphaned active passage', async () => {
        let resolveMemberships!: (memberships: CrewMember[]) => void;
        mocks.activePassageId = 'stale-shared';
        mocks.getMyMemberships.mockReturnValue(
            new Promise<CrewMember[]>((resolve) => {
                resolveMemberships = resolve;
            }),
        );
        const own = voyage('own-voyage', 'crew-user');
        mocks.getDraftVoyages.mockResolvedValue([own]);
        mocks.fetchRoutesAndTracks.mockResolvedValue({
            routes: [route('planned-own', own.voyage_name)],
            tracks: [],
        });
        mocks.getPassageStatus.mockResolvedValue(noAccess);

        renderPage();
        await screen.findByRole('combobox');
        await act(async () => Promise.resolve());
        expect(mocks.clearPassagePlan).not.toHaveBeenCalled();

        await act(async () => {
            resolveMemberships([]);
        });

        await waitFor(() => expect(mocks.clearPassagePlan).toHaveBeenCalledTimes(1));
        expect(mocks.setActivePassage).not.toHaveBeenCalled();
    });

    it('ignores a stale logbook-promotion result after the selector is cleared', async () => {
        let resolveCreate!: (result: { voyage: Voyage | null; error?: string }) => void;
        const promoted = voyage('promoted-voyage', 'crew-user', 'Logbook route');
        mocks.fetchRoutesAndTracks.mockResolvedValue({
            routes: [route('planned-route', promoted.voyage_name)],
            tracks: [],
        });
        mocks.createVoyage.mockReturnValue(
            new Promise((resolve) => {
                resolveCreate = resolve;
            }),
        );

        renderPage();
        const selector = await screen.findByRole('combobox');
        const stubId = 'logbook:planned-route';
        await waitFor(() => expect(within(selector).getByRole('option', { name: promoted.voyage_name })).toBeDefined());

        fireEvent.change(selector, { target: { value: stubId } });
        fireEvent.change(selector, { target: { value: '' } });
        await act(async () => {
            resolveCreate({ voyage: promoted });
        });

        expect(mocks.clearPassagePlan).toHaveBeenCalledTimes(1);
        expect(mocks.setActivePassage).not.toHaveBeenCalled();
        expect(selector).toHaveValue('');
    });

    it('scopes passage-register invites to the currently verified owner voyage', async () => {
        const own = voyage('own-voyage', 'crew-user');
        mocks.activePassageId = own.id;
        mocks.getDraftVoyages.mockResolvedValue([own]);
        mocks.fetchRoutesAndTracks.mockResolvedValue({
            routes: [route('planned-own', own.voyage_name)],
            tracks: [],
        });
        mocks.getPassageStatus.mockImplementation(async (id: string | null) =>
            id === own.id ? statusFor(own.id, true) : noAccess,
        );

        renderPage();
        await screen.findByLabelText('Departure Date');
        fireEvent.click(screen.getByRole('button', { name: 'Invite crew member' }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Crew email' }), {
            target: { value: 'deckhand@example.com' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Share checklist' }));
        fireEvent.click(screen.getByRole('button', { name: 'Send invite' }));

        await waitFor(() =>
            expect(mocks.inviteCrew).toHaveBeenCalledWith('deckhand@example.com', ['passage_checklist'], own.id),
        );
    });

    it('rejects passage-register invites while a non-owner shared passage is selected', async () => {
        const shared = voyage('shared-voyage', 'captain-1');
        mocks.activePassageId = shared.id;
        mocks.getMyMemberships.mockResolvedValue([membership('captain-1', shared.id)]);
        mocks.getAuthorizedSharedVoyages.mockResolvedValue({
            voyages: [{ voyage: shared, ownerEmail: 'captain@example.com' }],
            complete: true,
        });
        mocks.getPassageStatus.mockResolvedValue(statusFor(shared.id, false));

        renderPage();
        await screen.findByText(/departure and Cast Off stay with the skipper/i);
        fireEvent.click(screen.getByRole('button', { name: 'Invite crew member' }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Crew email' }), {
            target: { value: 'deckhand@example.com' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Share checklist' }));
        fireEvent.click(screen.getByRole('button', { name: 'Send invite' }));

        expect(await screen.findByRole('alert')).toHaveTextContent(
            'Select one of your own passages before sharing passage access.',
        );
        expect(mocks.inviteCrew).not.toHaveBeenCalled();
    });

    it('discards a deferred account-A roster after switching to account B', async () => {
        let resolveAccountA!: (members: CrewMember[]) => void;
        const accountAResult = new Promise<CrewMember[]>((resolve) => {
            resolveAccountA = resolve;
        });
        const accountAMember = rosterMember('crew-user', 'a-member', 'account-a-crew@example.com');
        const accountBMember = rosterMember('account-b', 'b-member', 'account-b-crew@example.com');
        mocks.getMyCrew
            .mockReset()
            .mockImplementationOnce(() => accountAResult)
            .mockResolvedValue([accountBMember]);

        renderPage();
        await waitFor(() => expect(mocks.getMyCrew).toHaveBeenCalledTimes(1));

        mocks.authUserId = 'account-b';
        act(() => {
            setAuthIdentityScope('account-b');
        });

        expect(await screen.findByText(accountBMember.crew_email)).toBeInTheDocument();
        await act(async () => {
            resolveAccountA([accountAMember]);
        });

        expect(screen.queryByText(accountAMember.crew_email)).not.toBeInTheDocument();
        expect(screen.getByText(accountBMember.crew_email)).toBeInTheDocument();
    });

    it('suppresses a stale account-A accept toast and reload after switching to account B', async () => {
        let resolveAccept!: (accepted: boolean) => void;
        const pending = {
            ...membership('captain-a', null),
            id: 'pending-a',
            status: 'pending' as const,
        };
        mocks.getMyInvites.mockReset().mockResolvedValueOnce([pending]).mockResolvedValue([]);
        mocks.acceptInvite.mockReset().mockReturnValue(
            new Promise<boolean>((resolve) => {
                resolveAccept = resolve;
            }),
        );

        renderPage();
        fireEvent.click(await screen.findByRole('button', { name: `Accept ${pending.owner_email}` }));

        mocks.authUserId = 'account-b';
        act(() => {
            setAuthIdentityScope('account-b');
        });
        await waitFor(() => expect(mocks.getMyInvites).toHaveBeenCalledTimes(2));

        await act(async () => {
            resolveAccept(true);
        });

        expect(mocks.toastSuccess).not.toHaveBeenCalledWith('Invite accepted!');
        expect(mocks.getMyInvites).toHaveBeenCalledTimes(2);
        expect(screen.queryByText(pending.owner_email)).not.toBeInTheDocument();
    });
});
