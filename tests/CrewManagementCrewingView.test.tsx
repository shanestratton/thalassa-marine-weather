/**
 * The crewing view (Shane 2026-10-03): "once a crew member has been invited to
 * your vessel, can we hide all of the rest of the information in his crew and
 * float plan, it should all pertain to the vessel that the punter has been
 * invited on".
 *
 * Driven through the REAL shared-binder snapshot and crew-view cache (seeded
 * in localStorage), so the account-switch and Switch-boat cases exercise the
 * same selection the binders use. Fictional boats and people only.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrewMember, SharedRegister } from '../services/CrewService';
import type { AuthorizedSharedVoyagesResult, PassageStatus } from '../services/PassagePlanService';
import type { Voyage } from '../services/VoyageService';
import type { CrewVesselView, CrewVesselViewResult } from '../services/crew/crewVesselView';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import { readLastPassageStatus } from '../services/crew/lastPassageStatus';
import { reloadSharedBindersFromStorage } from '../services/vessel/sharedBinders';
import { clearStaleWindowEvent } from './helpers/clearStaleWindowEvent';

const binderSync = vi.hoisted(() => ({ requestFullReconciliation: vi.fn() }));
vi.mock('../services/vessel/SyncService', () => ({
    requestFullReconciliation: binderSync.requestFullReconciliation,
}));

const mocks = vi.hoisted(() => ({
    authUserId: 'crew-user',
    activePassageId: '' as string,
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
    getMyCrew: vi.fn(),
    getMyInvites: vi.fn(),
    getMyMemberships: vi.fn(),
    leaveVessel: vi.fn(),
    acceptInvite: vi.fn(),
    getPassageStatus: vi.fn(),
    getAuthorizedSharedVoyages: vi.fn(),
    setActivePassage: vi.fn(),
    clearPassagePlan: vi.fn(),
    getDraftVoyages: vi.fn(),
    getCachedDraftVoyages: vi.fn(),
    loadCrewVesselView: vi.fn(),
    shareFloatPlanDetails: vi.fn(),
    vessel: { name: 'Kestrel', type: 'sail', crewCount: 2, cruisingSpeed: 6 } as Record<string, unknown>,
    // How long each readiness-stack render takes, in ms. Past React's 5 ms
    // slice the event loop is handed back between painting the stack and the
    // effects that follow, as on a loaded CI runner with coverage on.
    stackRenderMs: 0,
    // The shared passages each readiness-stack render was given, in order.
    stackVoyagesRendered: [] as string[],
}));

vi.mock('../theme', () => ({
    getThemeForEnvironment: () => ({
        button: { primary: 'primary', secondary: 'secondary', danger: 'danger', ghost: 'ghost' },
    }),
    touchTarget: { button: 'min-h-[44px]', buttonSm: 'min-h-[36px]', icon: 'w-11 h-11' },
    t: { colors: { bg: { base: 'bg-slate-950' } }, border: { default: 'border border-white/10' } },
}));

vi.mock('../stores/authStore', () => ({
    useAuthStore: (selector: (state: Record<string, unknown>) => unknown) =>
        selector({ user: { id: mocks.authUserId, email: `${mocks.authUserId}@example.com` }, authChecked: true }),
}));

vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({ settings: { vessel: mocks.vessel } }),
}));

vi.mock('../services/supabase', () => ({ supabase: null }));
vi.mock('../hooks/useRealtimeSync', () => ({ useRealtimeSync: vi.fn(), useRealtimeSyncMulti: vi.fn() }));

vi.mock('../services/CrewService', () => ({
    ALL_REGISTERS: ['stores', 'passage_checklist', 'passage_chat'],
    PASSAGE_REGISTERS: ['passage_meals', 'passage_chat', 'passage_route', 'passage_checklist'],
    REGISTER_ICONS: { stores: '📦', passage_checklist: '✅', passage_chat: '💬', equipment: '⚙️' },
    REGISTER_LABELS: {
        stores: "Ship's Stores",
        passage_checklist: 'Checklist',
        passage_chat: 'Group Chat',
        equipment: 'Equipment',
    },
    inviteCrew: vi.fn(),
    getMyCrew: mocks.getMyCrew,
    removeCrew: vi.fn(),
    disbandGroup: vi.fn(),
    updateCrewPermissions: vi.fn(),
    getMyInvites: mocks.getMyInvites,
    getMyMemberships: mocks.getMyMemberships,
    acceptInvite: mocks.acceptInvite,
    declineInvite: vi.fn(),
    leaveVessel: mocks.leaveVessel,
}));

vi.mock('../services/crew/crewVesselView', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/crew/crewVesselView')>()),
    loadCrewVesselView: mocks.loadCrewVesselView,
}));

vi.mock('../services/crew/crewFloatPlanDetails', () => ({
    shareMyFloatPlanDetails: mocks.shareFloatPlanDetails,
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
        window.dispatchEvent(new CustomEvent('thalassa:passage-changed', { detail: { voyageId } }));
    });
    mocks.clearPassagePlan.mockImplementation(() => {
        mocks.activePassageId = '';
        window.dispatchEvent(new CustomEvent('thalassa:passage-changed', { detail: { voyageId: null } }));
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
    getCachedDraftVoyages: mocks.getCachedDraftVoyages,
    getDraftVoyages: mocks.getDraftVoyages,
    createVoyage: vi.fn(async () => ({ voyage: null, error: 'not configured' })),
    updateVoyage: vi.fn(async () => ({ voyage: null })),
    getCachedActiveVoyage: () => null,
    adoptSavedRouteLink: vi.fn(),
}));

vi.mock('../services/shiplog/RoutesAndTracks', () => ({
    fetchRoutesAndTracks: vi.fn(async () => ({ routes: [], tracks: [] })),
}));

vi.mock('../utils/system', () => ({
    triggerHaptic: vi.fn(),
    getSystemUnits: () => ({ speed: 'kts', length: 'm', distance: 'nm' }),
}));

vi.mock('../utils/lazyRetry', () => ({ lazyRetry: () => () => null }));
vi.mock('../components/Toast', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock('../components/SignInScreen', () => ({ SignInScreen: () => null }));

vi.mock('../components/ui/PageHeader', () => ({
    PageHeader: ({ title, subtitle }: { title: string; subtitle?: string }) => (
        <header>
            <h1>{title}</h1>
            <p data-testid="page-subtitle">{subtitle}</p>
        </header>
    ),
}));

vi.mock('../components/ui/UndoToast', () => ({
    UndoToast: ({
        isOpen,
        message,
        onUndo,
        onDismiss,
    }: {
        isOpen: boolean;
        message: string;
        onUndo: () => void;
        onDismiss: () => void;
    }) =>
        isOpen ? (
            <div role="status">
                <span>{message}</span>
                <button type="button" onClick={onUndo}>
                    Undo
                </button>
                <button type="button" onClick={onDismiss}>
                    Let the undo lapse
                </button>
            </div>
        ) : null,
}));

vi.mock('../components/ui/ModalSheet', () => ({
    ModalSheet: ({ children, isOpen, title }: { children: React.ReactNode; isOpen: boolean; title: string }) =>
        isOpen ? <section aria-label={title}>{children}</section> : null,
}));

vi.mock('../components/crew/InviteCrewModal', () => ({ InviteCrewModal: () => <div>Invite form</div> }));

interface MockReadinessProps {
    selectedPassageId: string;
    passageStatus: PassageStatus;
    draftVoyages: Voyage[];
    planCrewCount: number;
    standingCrewAboard?: number;
    crewVesselProfile?: { name: string } | null;
}

vi.mock('../components/crew/ReadinessCardStack', () => ({
    ReadinessCardStack: (props: MockReadinessProps) => {
        const voyages = props.draftVoyages.map((voyage) => voyage.id).join(',');
        mocks.stackVoyagesRendered.push(voyages);
        const until = performance.now() + mocks.stackRenderMs;
        while (performance.now() < until) {
            // A slow render: hold the thread, as a busy runner would.
        }
        return (
            <div
                data-testid="readiness-stack"
                data-selected={props.selectedPassageId}
                data-owner={String(props.passageStatus.isOwner)}
                data-voyages={voyages}
                data-plan-crew={String(props.planCrewCount)}
                data-standing-crew={String(props.standingCrewAboard)}
                data-crew-vessel={props.crewVesselProfile?.name ?? ''}
            />
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
        CheckCircleIcon: Icon,
        LifeBuoyIcon: Icon,
    };
});

import { CrewManagement } from '../components/CrewManagement';

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

const statusFor = (voyageId: string, ownerUserId: string): PassageStatus => ({
    visible: true,
    voyageId,
    ownerUserId,
    isOwner: ownerUserId === 'crew-user',
    canEditStores: false,
    canViewMeals: true,
    canViewChat: true,
    canViewRoute: true,
    canViewChecklist: true,
});

const voyage = (id: string, ownerId: string, name: string, status: Voyage['status'] = 'planning'): Voyage => ({
    id,
    user_id: ownerId,
    vessel_id: null,
    voyage_name: name,
    departure_port: 'Example Harbour',
    destination_port: 'Far Island',
    departure_time: '2026-10-10T00:00:00.000Z',
    eta: '2026-10-11T06:00:00.000Z',
    crew_count: 3,
    status,
    weather_master_id: ownerId,
    notes: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
});

const membership = (
    ownerId: string,
    id: string,
    role: CrewMember['role'],
    registers: SharedRegister[],
    voyageId: string | null = null,
): CrewMember => ({
    id,
    owner_id: ownerId,
    crew_user_id: 'crew-user',
    crew_email: 'crew@example.com',
    owner_email: `${ownerId}@example.com`,
    shared_registers: registers,
    permissions: {} as CrewMember['permissions'],
    status: 'accepted',
    role,
    voyage_id: voyageId,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
});

const VIEW: CrewVesselView = {
    ownerId: 'skipper-1',
    vessel: {
        name: 'Wandering Albatross',
        type: 'sail',
        model: 'Fictional 44',
        hullColor: 'Navy',
        registration: 'TEST-123',
        mmsi: '503000999',
        callSign: 'VZZ1234',
        crewCount: 4,
        cruisingSpeed: 6.5,
        liferaftCapacity: 6,
    },
    vesselUnits: null,
    roster: [],
    manifest: [
        { isSkipper: true, isSelf: false, role: 'skipper', name: 'Capt Ana Reyes' },
        { isSkipper: false, isSelf: true, role: 'co-skipper', name: 'Tom Okafor' },
        { isSkipper: false, isSelf: false, role: 'navigator', name: 'Lena "Lee" Park' },
    ],
    fetchedAt: '2026-10-02T21:30:00.000Z',
    source: 'rpc',
};

function seedSnapshot(
    vessels: Array<{ ownerId: string; vesselName: string; role: string; lastAcceptedAt: string }>,
    userId = 'crew-user',
) {
    localStorage.setItem(
        authScopedStorageKey('thalassa_shared_binders_v1'),
        JSON.stringify({ version: 1, userId, confirmedAt: '2026-10-02T00:00:00.000Z', skippers: [], vessels }),
    );
    reloadSharedBindersFromStorage();
}

function seedView(views: CrewVesselView[], userId = 'crew-user') {
    localStorage.setItem(
        authScopedStorageKey('thalassa_crew_vessel_view_v1'),
        JSON.stringify({
            version: 1,
            cachedFor: userId,
            views: Object.fromEntries(views.map((view) => [view.ownerId, view])),
        }),
    );
}

const ALBATROSS = {
    ownerId: 'skipper-1',
    vesselName: 'Wandering Albatross',
    role: 'co-skipper',
    lastAcceptedAt: '2026-10-01T00:00:00.000Z',
};

/** Your two accepted rows on the skipper's boat: one boat-wide, one for a finished passage. */
const albatrossRows = () => [
    membership('skipper-1', 'row-global', 'deckhand', ['stores', 'passage_chat']),
    membership('skipper-1', 'row-scoped', 'co-skipper', ['passage_checklist'], 'voyage-done'),
];

const renderPage = () => render(<CrewManagement onBack={vi.fn()} />);

/** The skipper shares a planning, an active and a finished passage; another skipper and your own route mix in. */
function shareSkipperPassages() {
    const planning = voyage('voyage-plan', 'skipper-1', 'Harbour to Far Island');
    const active = voyage('voyage-active', 'skipper-1', 'Far Island to Reef', 'active');
    const completed = voyage('voyage-done', 'skipper-1', 'Last week’s run', 'completed');
    const otherSkipper = voyage('voyage-other', 'skipper-9', 'Someone else’s passage');
    const own = voyage('own-voyage', 'crew-user', 'My own route');
    mocks.getDraftVoyages.mockResolvedValue([own]);
    mocks.getAuthorizedSharedVoyages.mockResolvedValue({
        voyages: [planning, active, completed, otherSkipper].map((row) => ({
            voyage: row,
            ownerEmail: `${row.user_id}@example.com`,
        })),
        complete: true,
    });
}

describe('Crew & Float Plan while crewing on a skipper’s boat', () => {
    beforeEach(() => {
        clearStaleWindowEvent();
        localStorage.clear();
        mocks.authUserId = 'crew-user';
        setAuthIdentityScope(null);
        setAuthIdentityScope('crew-user');
        mocks.activePassageId = '';
        mocks.vessel = { name: 'Kestrel', type: 'sail', crewCount: 2, cruisingSpeed: 6 };
        mocks.stackRenderMs = 0;
        mocks.stackVoyagesRendered = [];
        vi.clearAllMocks();
        mocks.getMyCrew.mockResolvedValue([
            { ...membership('crew-user', 'own-crew-1', 'deckhand', ['stores']), crew_email: 'mate@example.com' },
        ]);
        mocks.getMyInvites.mockResolvedValue([]);
        mocks.getMyMemberships.mockResolvedValue(albatrossRows());
        mocks.getDraftVoyages.mockResolvedValue([]);
        mocks.getCachedDraftVoyages.mockReturnValue([]);
        mocks.getAuthorizedSharedVoyages.mockResolvedValue({
            voyages: [],
            complete: true,
        } satisfies AuthorizedSharedVoyagesResult);
        mocks.getPassageStatus.mockResolvedValue(noAccess);
        mocks.leaveVessel.mockResolvedValue(true);
        mocks.shareFloatPlanDetails.mockResolvedValue('skipped');
        mocks.loadCrewVesselView.mockImplementation(
            async (): Promise<CrewVesselViewResult> => ({ status: 'fresh', view: VIEW }),
        );
        binderSync.requestFullReconciliation.mockResolvedValue({ pushed: 0, pulled: 0, errors: [] });
        seedSnapshot([ALBATROSS]);
        seedView([VIEW]);
    });

    it("shows the skipper's boat, its people and roles, and none of your own crew", async () => {
        renderPage();

        const panel = await screen.findByRole('region', { name: 'Crewing on Wandering Albatross' });
        expect(screen.getByTestId('page-subtitle')).toHaveTextContent("Wandering Albatross · you're crew");
        expect(within(panel).getByText('Skipper: Capt Ana Reyes')).toBeInTheDocument();
        // Your own role, the most senior across your rows; the chips are their union.
        expect(within(panel).getByText('Your role: Co-skipper')).toBeInTheDocument();
        expect(within(panel).getByText(/Ship's Stores/)).toBeInTheDocument();
        expect(within(panel).getByText(/Checklist/)).toBeInTheDocument();
        expect(within(panel).getByText(/Group Chat/)).toBeInTheDocument();

        const aboard = within(panel).getByRole('list', { name: 'Crew aboard Wandering Albatross' });
        const rows = within(aboard)
            .getAllByRole('listitem')
            .map((item) => item.textContent);
        expect(rows).toEqual(['Capt Ana ReyesSkipper', 'Tom Okafor (you)Co-skipper', 'Lena "Lee" ParkNavigator']);

        // Your own boat's crew, invite and disband are gone; no emails anywhere.
        await waitFor(() => expect(mocks.getMyCrew).toHaveBeenCalled());
        expect(screen.queryByText('My Crew')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Invite crew member' })).not.toBeInTheDocument();
        expect(screen.queryByText(/Disband/)).not.toBeInTheDocument();
        expect(screen.queryByText(/mate@example\.com/)).not.toBeInTheDocument();
        expect(screen.queryByText(/@example\.com/)).not.toBeInTheDocument();
        // The readiness stack reads the skipper's boat. Read it afresh: it can
        // step aside while passage access is re-checked, then paint again.
        await waitFor(() => {
            const stack = screen.getByTestId('readiness-stack');
            expect(stack).toHaveAttribute('data-crew-vessel', 'Wandering Albatross');
            expect(stack).toHaveAttribute('data-standing-crew', '4');
            expect(stack).toHaveAttribute('data-plan-crew', '4');
        });
        // The read-only float plan card, and the quiet way back to your own boat.
        expect(screen.getByTestId('crew-float-plan-card')).toBeInTheDocument();
        expect(
            screen.getByText(/You're crewing on Wandering Albatross, so Kestrel's crew and plans are hidden here\./),
        ).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Show Kestrel' })).toBeInTheDocument();
    });

    it("shares your own name, phone and age from Settings with the skipper's float plan, and says so", async () => {
        // Shane 2026-10-04: "the invitee needs to use the name and phone number
        // and age from the vessel profile in settings for the float plan".
        mocks.vessel = {
            ...mocks.vessel,
            contactPhone: '0491 570 156',
            crewRoster: [{ name: 'Thomas Okafor', age: 34, rank: 'Skipper' }],
        };
        mocks.shareFloatPlanDetails.mockResolvedValue('shared');
        renderPage();

        const card = await screen.findByTestId('crew-float-plan-card');
        await waitFor(() =>
            expect(mocks.shareFloatPlanDetails).toHaveBeenCalledWith({
                name: 'Thomas Okafor',
                phone: '0491 570 156',
                age: 34,
            }),
        );
        expect(within(card).getByText('Thomas Okafor (you)')).toBeInTheDocument();
        expect(within(card).getByText('0491 570 156 · age 34')).toBeInTheDocument();
        expect(within(card).getByText('People aboard: 4')).toBeInTheDocument();
        expect(
            await within(card).findByText(
                "Your name, mobile and age from Settings → Vessel Profile go on Wandering Albatross's float plan. In the app only the skippers you crew for see them; the float plan itself goes to whoever they send it to.",
            ),
        ).toBeInTheDocument();
        // Nobody else's phone or age is anywhere on the page.
        expect(screen.queryAllByText(/· age /)).toHaveLength(1);
    });

    it("lists the skipper's own people too, in Crew aboard and on the float plan: all three (Shane 2026-10-06)", async () => {
        // The production shape: the skipper's profile names Skipper and First
        // mate; the one accepted invitee (you, a co-skipper) is not on it.
        mocks.vessel = { ...mocks.vessel, crewRoster: [{ name: 'Tom Okafor', age: 41, rank: 'Skipper' }] };
        const view: CrewVesselView = {
            ...VIEW,
            vessel: { ...VIEW.vessel, crewCount: undefined },
            roster: [
                { name: 'Ana Reyes', rank: 'Skipper' },
                { name: 'Priya Nair', rank: 'First mate' },
            ],
            manifest: [
                { isSkipper: true, isSelf: false, role: 'skipper', name: 'Capt Ana Reyes' },
                { isSkipper: false, isSelf: true, role: 'co-skipper', name: 'Tom O' },
            ],
        };
        seedView([view]);
        mocks.loadCrewVesselView.mockImplementation(async () => ({ status: 'fresh', view }));
        renderPage();

        const aboard = await screen.findByRole('list', { name: 'Crew aboard Wandering Albatross' });
        expect(
            within(aboard)
                .getAllByRole('listitem')
                .map((item) => item.textContent),
        ).toEqual(['Ana ReyesSkipper', 'Priya NairFirst mate', 'Tom Okafor (you)Co-skipper']);
        const card = screen.getByTestId('crew-float-plan-card');
        expect(within(card).getByText('People aboard: 3')).toBeInTheDocument();
        expect(within(card).getByText('Priya Nair')).toBeInTheDocument();
        await waitFor(() => expect(screen.getByTestId('readiness-stack')).toHaveAttribute('data-standing-crew', '3'));
    });

    it('says nothing about sharing before the server can take your details', async () => {
        mocks.shareFloatPlanDetails.mockResolvedValue('unavailable');
        renderPage();
        await screen.findByTestId('crew-float-plan-card');
        await waitFor(() => expect(mocks.shareFloatPlanDetails).toHaveBeenCalled());
        // Read the card afresh: a node held from first sight says nothing once it is replaced.
        await waitFor(() =>
            expect(
                within(screen.getByTestId('crew-float-plan-card')).queryByText(/skippers you crew for see them/),
            ).toBeNull(),
        );
    });

    it('says nothing about sharing until the server has answered, and nothing after a failed share', async () => {
        mocks.vessel = {
            ...mocks.vessel,
            contactPhone: '0491 570 156',
            crewRoster: [{ name: 'Thomas Okafor', age: 34, rank: 'Skipper' }],
        };
        let answer: (result: string) => void = () => undefined;
        mocks.shareFloatPlanDetails.mockReturnValue(
            new Promise<string>((resolve) => {
                answer = resolve;
            }),
        );
        renderPage();
        await screen.findByTestId('crew-float-plan-card');
        await waitFor(() => expect(mocks.shareFloatPlanDetails).toHaveBeenCalled());
        // The card is read afresh each time: a node held from first sight says
        // nothing once it is replaced.
        const card = () => screen.getByTestId('crew-float-plan-card');
        // Still waiting: no claim yet.
        expect(within(card()).queryByText(/skippers you crew for see them/)).toBeNull();
        await act(async () => answer('failed'));
        expect(within(card()).queryByText(/skippers you crew for see them/)).toBeNull();
        // Your own details still show on your own row.
        expect(within(card()).getByText('0491 570 156 · age 34')).toBeInTheDocument();
    });

    it("lists only that skipper's planning or active passages, labelled From <boat>", async () => {
        shareSkipperPassages();

        renderPage();
        // Read the stack afresh on every try. It paints once your memberships
        // load, steps aside while passage access is re-checked for them, and
        // paints again; a stack held from first sight can be off the page by
        // the time the passages land, and never updates.
        await waitFor(() =>
            expect(screen.getByTestId('readiness-stack')).toHaveAttribute('data-voyages', 'voyage-plan,voyage-active'),
        );
        expect(screen.getByText('2 shared from Wandering Albatross')).toBeInTheDocument();
        expect(screen.queryByText(/yours/)).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('combobox', { name: 'Saved Routes' }));
        const options = (await screen.findAllByRole('option'))
            .map((option) => option.textContent ?? '')
            .filter((text) => !text.includes('Clear selection'));
        expect(options).toHaveLength(2);
        expect(options.every((text) => text.includes('From Wandering Albatross'))).toBe(true);
        expect(options.join(' ')).not.toMatch(/example\.com|My own route|Last week|Someone else/);
    });

    it("still lists that skipper's passages when your memberships answer after the access check, on a slow render", async () => {
        // The order CI run 37548529698 met: the access check answers first
        // (nothing selected needs no round trip), your memberships after it,
        // and each render is slow enough for the event loop to turn between
        // painting the stack and re-checking access for those memberships.
        mocks.stackRenderMs = 25;
        shareSkipperPassages();
        let answerMemberships: () => void = () => undefined;
        mocks.getMyMemberships.mockReturnValue(
            new Promise<CrewMember[]>((resolve) => {
                answerMemberships = () => resolve(albatrossRows());
            }),
        );

        renderPage();
        await waitFor(() => expect(mocks.getPassageStatus).toHaveBeenCalledWith(null));
        await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
        expect(screen.queryByTestId('readiness-stack')).not.toBeInTheDocument();

        answerMemberships();
        await waitFor(() =>
            expect(screen.getByTestId('readiness-stack')).toHaveAttribute('data-voyages', 'voyage-plan,voyage-active'),
        );
        // The stack was on screen before the shared passages came (the order
        // pinned here), and they reached the stack that is on screen now.
        expect(mocks.stackVoyagesRendered[0]).toBe('');
        expect(screen.getByText('2 shared from Wandering Albatross')).toBeInTheDocument();
    });

    it('says so plainly when the skipper has shared no passage right now', async () => {
        renderPage();
        expect(
            await screen.findByText("Wandering Albatross's skipper hasn't shared a passage with you right now."),
        ).toBeInTheDocument();
        expect(screen.queryByText(/Plan a route from the Plan tab/)).not.toBeInTheDocument();
    });

    it('treats your own stored passage as unselected, without clearing it', async () => {
        const own = voyage('own-voyage', 'crew-user', 'My own route');
        mocks.activePassageId = own.id;
        mocks.getDraftVoyages.mockResolvedValue([own]);
        mocks.getPassageStatus.mockImplementation(async (id: string | null) =>
            id === own.id ? statusFor(own.id, 'crew-user') : noAccess,
        );

        renderPage();
        // Wait for the verified answer (that you own it), or the checks below
        // would pass on the "no access yet" placeholder. The page remembers a
        // grant as it applies it.
        await waitFor(() =>
            expect(readLastPassageStatus(getAuthIdentityScope(), own.id)).toEqual(statusFor(own.id, 'crew-user')),
        );
        await waitFor(() => {
            const stack = screen.getByTestId('readiness-stack');
            expect(stack).toHaveAttribute('data-selected', '');
            expect(stack).toHaveAttribute('data-owner', 'false');
        });
        expect(mocks.clearPassagePlan).not.toHaveBeenCalled();
        expect(mocks.activePassageId).toBe(own.id);
        expect(screen.queryByRole('button', { name: 'Cast Off' })).not.toBeInTheDocument();
    });

    it("selects a skipper's shared passage and keeps Cast Off with the skipper", async () => {
        const planning = voyage('voyage-plan', 'skipper-1', 'Harbour to Far Island');
        mocks.activePassageId = planning.id;
        mocks.getAuthorizedSharedVoyages.mockResolvedValue({
            voyages: [{ voyage: planning, ownerEmail: 'skipper-1@example.com' }],
            complete: true,
        });
        mocks.getPassageStatus.mockImplementation(async (id: string | null) =>
            id === planning.id ? statusFor(planning.id, 'skipper-1') : noAccess,
        );

        renderPage();
        // The stack remounts (keyed by passage) once the selection is verified.
        await waitFor(() =>
            expect(screen.getByTestId('readiness-stack')).toHaveAttribute('data-selected', planning.id),
        );
        expect(screen.getByText(/departure and Cast Off stay with the skipper/i)).toBeInTheDocument();
        const card = screen.getByTestId('crew-float-plan-card');
        expect(within(card).getByText(/Example Harbour → Far Island/)).toBeInTheDocument();
    });

    it("'Show Kestrel' brings back today's page, and 'Back to Wandering Albatross' returns", async () => {
        renderPage();
        fireEvent.click(await screen.findByRole('button', { name: 'Show Kestrel' }));

        expect(await screen.findByText('My Crew')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Invite crew member' })).toBeInTheDocument();
        expect(screen.queryByRole('region', { name: 'Crewing on Wandering Albatross' })).not.toBeInTheDocument();
        expect(screen.getByText(/You're crew on Wandering Albatross/)).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Back to Wandering Albatross' }));
        expect(await screen.findByRole('region', { name: 'Crewing on Wandering Albatross' })).toBeInTheDocument();
        expect(screen.queryByText('My Crew')).not.toBeInTheDocument();
    });

    it("pending invites alone are not crew: today's page with the invite card", async () => {
        seedSnapshot([]);
        mocks.getMyMemberships.mockResolvedValue([]);
        mocks.getMyInvites.mockResolvedValue([
            { ...membership('skipper-1', 'invite-1', 'deckhand', ['stores']), status: 'pending' },
        ]);
        renderPage();

        expect(await screen.findByText('Pending Invites')).toBeInTheDocument();
        expect(screen.getByText('My Crew')).toBeInTheDocument();
        expect(screen.queryByRole('region', { name: /Crewing on/ })).not.toBeInTheDocument();
        expect(screen.queryByTestId('crew-float-plan-card')).not.toBeInTheDocument();
        expect(mocks.loadCrewVesselView).not.toHaveBeenCalled();
    });

    it('a pending invite still shows above the crewing panel', async () => {
        mocks.getMyInvites.mockResolvedValue([
            { ...membership('skipper-2', 'invite-2', 'deckhand', ['stores']), status: 'pending' },
        ]);
        renderPage();
        expect(await screen.findByText('Pending Invites')).toBeInTheDocument();
        expect(screen.getByRole('region', { name: 'Crewing on Wandering Albatross' })).toBeInTheDocument();
    });

    it('Leave flips to your own page at once, Undo flips back, and a confirmed leave removes every row', async () => {
        renderPage();
        const panel = await screen.findByRole('region', { name: 'Crewing on Wandering Albatross' });
        // Leaving is destructive: the page's last row, not beside Switch boat
        // in the boat's card (the tier-1 look, 2026-10-06).
        const leave = screen.getByRole('button', { name: 'Leave Wandering Albatross' });
        expect(panel).not.toContainElement(leave);
        expect(
            screen.getByTestId('crew-float-plan-card').compareDocumentPosition(leave) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        expect(leave).toHaveAccessibleDescription(/Ends your access to Wandering Albatross/);
        fireEvent.click(leave);

        expect(await screen.findByText('My Crew')).toBeInTheDocument();
        expect(screen.getByText('Left Wandering Albatross')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
        expect(await screen.findByRole('region', { name: 'Crewing on Wandering Albatross' })).toBeInTheDocument();
        expect(mocks.leaveVessel).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: 'Leave Wandering Albatross' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Let the undo lapse' }));
        await waitFor(() => expect(mocks.leaveVessel).toHaveBeenCalledTimes(2));
        expect(mocks.leaveVessel).toHaveBeenCalledWith('row-global');
        expect(mocks.leaveVessel).toHaveBeenCalledWith('row-scoped');
        await waitFor(() => expect(binderSync.requestFullReconciliation).toHaveBeenCalledTimes(1));
    });

    it('a failed leave puts the boat back and says so', async () => {
        mocks.leaveVessel.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        renderPage();
        fireEvent.click(await screen.findByRole('button', { name: 'Leave Wandering Albatross' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Let the undo lapse' }));
        await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Could not leave Wandering Albatross'));
        expect(await screen.findByRole('region', { name: 'Crewing on Wandering Albatross' })).toBeInTheDocument();
    });

    it('two boats: Switch boat moves the page and the binders together', async () => {
        const petrel = {
            ownerId: 'skipper-2',
            vesselName: 'Petrel',
            role: 'punter',
            lastAcceptedAt: '2026-09-01T00:00:00.000Z',
        };
        seedSnapshot([ALBATROSS, petrel]);
        seedView([VIEW, { ...VIEW, ownerId: 'skipper-2', vessel: { name: 'Petrel' }, manifest: [] }]);
        mocks.loadCrewVesselView.mockImplementation(async (ownerId: string) => ({
            status: 'fresh',
            view: ownerId === 'skipper-2' ? { ...VIEW, ownerId, vessel: { name: 'Petrel' }, manifest: [] } : VIEW,
        }));
        renderPage();

        fireEvent.click(await screen.findByRole('button', { name: 'Switch boat' }));
        const sheet = screen.getByRole('region', { name: 'Switch boat' });
        fireEvent.click(within(sheet).getByRole('button', { name: 'Petrel' }));

        expect(await screen.findByRole('region', { name: 'Crewing on Petrel' })).toBeInTheDocument();
        expect(screen.getByTestId('page-subtitle')).toHaveTextContent("Petrel · you're crew");
        // The same one selection the binders read.
        const { getCrewingVessel } = await import('../services/vessel/sharedBinders');
        expect(getCrewingVessel()?.ownerId).toBe('skipper-2');
    });

    it("an account switch never paints the previous account's boat", async () => {
        renderPage();
        await screen.findByRole('region', { name: 'Crewing on Wandering Albatross' });

        act(() => {
            mocks.authUserId = 'other-user';
            setAuthIdentityScope('other-user');
        });
        expect(screen.queryByText(/Wandering Albatross/)).not.toBeInTheDocument();
    });

    it('a stale cached view says when it was last updated', async () => {
        mocks.loadCrewVesselView.mockImplementation(async () => ({ status: 'stale', view: VIEW }));
        renderPage();
        // The panel is read afresh each time, in case it is replaced meanwhile.
        const panel = () => screen.getByRole('region', { name: 'Crewing on Wandering Albatross' });
        await waitFor(() => expect(within(panel()).getByText(/^Last updated /)).toBeInTheDocument());
        // Still the cached people, offline.
        expect(within(panel()).getByText(/Tom Okafor/)).toBeInTheDocument();
    });

    it('degraded mode (RPC not pushed) still names the boat and its people', async () => {
        const fallback: CrewVesselView = {
            ...VIEW,
            source: 'fallback',
            vessel: { name: 'Wandering Albatross', mmsi: '503000999' },
            manifest: [
                { isSkipper: true, isSelf: false, role: 'skipper', name: 'Capt Ana Reyes' },
                { isSkipper: false, isSelf: false, role: 'crew', name: 'Lena "Lee" Park' },
                { isSkipper: false, isSelf: true, role: 'co-skipper', name: 'Tom Okafor' },
            ],
        };
        seedView([fallback]);
        mocks.loadCrewVesselView.mockImplementation(async () => ({ status: 'fresh', view: fallback }));
        renderPage();
        const aboard = await screen.findByRole('list', { name: 'Crew aboard Wandering Albatross' });
        expect(within(aboard).getByText('Lena "Lee" Park').closest('li')).toHaveTextContent('Crew');
        expect(
            within(aboard)
                .getByText(/Tom Okafor/)
                .closest('li'),
        ).toHaveTextContent('Co-skipper');
        await waitFor(() => expect(screen.getByTestId('readiness-stack')).toHaveAttribute('data-standing-crew', '3'));
    });

    it("names the hull you are crew on, not the skipper's newly selected boat", async () => {
        // vessel_identity (the snapshot's name) follows the skipper's SELECTED
        // boat; the view's name is the hull this account was bridged onto.
        seedSnapshot([{ ...ALBATROSS, vesselName: 'Petrel' }]);
        renderPage();
        expect(await screen.findByRole('region', { name: 'Crewing on Wandering Albatross' })).toBeInTheDocument();
        expect(screen.queryByText(/Petrel/)).not.toBeInTheDocument();
        await waitFor(() =>
            expect(screen.getByTestId('readiness-stack')).toHaveAttribute('data-crew-vessel', 'Wandering Albatross'),
        );
    });

    it("settles the passage picker even when your memberships can't be read (a slow satellite link)", async () => {
        mocks.getMyMemberships.mockRejectedValue(new Error('timed out'));
        renderPage();
        expect(
            await screen.findByText("Wandering Albatross's skipper hasn't shared a passage with you right now."),
        ).toBeInTheDocument();
        expect(screen.queryByText('Loading saved routes…')).not.toBeInTheDocument();
    });
});
