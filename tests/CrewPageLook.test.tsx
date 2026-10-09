/**
 * The Crew & Float Plan page's tier-1 look (Shane 2026-10-06: "the crew and
 * float plan page also needs to be dragged into the 21st century as well"),
 * through the real page and roster: the crew by name, the status pills, the
 * emerald Invite crew, Disband as the page's last row, Remove in the Edit
 * sheet, and cache-first passage access ("Checking passage access…" only on
 * the first visit). Fictional people only.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrewMember } from '../services/CrewService';
import type { PassageStatus } from '../services/PassagePlanService';
import type { Voyage } from '../services/VoyageService';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import { readLastPassageStatus } from '../services/crew/lastPassageStatus';
import { clearStaleWindowEvent } from './helpers/clearStaleWindowEvent';

const mocks = vi.hoisted(() => ({
    activePassageId: '' as string,
    getMyCrew: vi.fn(),
    removeCrew: vi.fn(),
    updateCrewPermissions: vi.fn(),
    getPassageStatus: vi.fn(),
    loadNames: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
}));

vi.mock('../services/vessel/SyncService', () => ({ requestFullReconciliation: vi.fn(async () => ({})) }));

vi.mock('../theme', () => ({
    getThemeForEnvironment: () => ({
        button: { primary: 'primary', secondary: 'secondary', danger: 'danger', ghost: 'ghost' },
    }),
    touchTarget: { button: 'min-h-[44px]', buttonSm: 'min-h-[36px]', icon: 'w-11 h-11' },
    t: { colors: { bg: { base: 'bg-slate-950' } }, border: { default: 'border border-white/10' } },
}));

vi.mock('../stores/authStore', () => ({
    useAuthStore: (selector: (state: Record<string, unknown>) => unknown) =>
        selector({ user: { id: 'skipper-1', email: 'skipper@example.com' }, authChecked: true }),
}));

vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({
        settings: { vessel: { name: 'Sea Swallow', type: 'sail', crewCount: 2, cruisingSpeed: 6 } },
    }),
}));

vi.mock('../services/supabase', () => ({ supabase: null }));
vi.mock('../hooks/useRealtimeSync', () => ({ useRealtimeSync: vi.fn(), useRealtimeSyncMulti: vi.fn() }));

vi.mock('../services/CrewService', () => ({
    ALL_REGISTERS: ['stores', 'equipment', 'passage_chat', 'passage_checklist'],
    ALWAYS_SHARED_REGISTERS: ['passage_chat'],
    PASSAGE_REGISTERS: ['passage_meals', 'passage_chat', 'passage_route', 'passage_checklist'],
    REGISTER_ICONS: {},
    REGISTER_NOTES: { documents: 'Crew IDs stay with you' },
    REGISTER_LABELS: {
        stores: "Ship's Stores",
        equipment: 'Equipment',
        passage_chat: 'Group Chat',
        passage_checklist: 'Passage readiness',
        instruments: 'Instrument Panel',
    },
    inviteCrew: vi.fn(),
    getMyCrew: mocks.getMyCrew,
    removeCrew: mocks.removeCrew,
    disbandGroup: vi.fn(),
    updateCrewPermissions: mocks.updateCrewPermissions,
    getMyInvites: vi.fn(async () => []),
    getMyMemberships: vi.fn(async () => []),
    acceptInvite: vi.fn(),
    declineInvite: vi.fn(),
    leaveVessel: vi.fn(),
}));

vi.mock('../services/crew/crewCardNames', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/crew/crewCardNames')>()),
    loadCrewCardNames: mocks.loadNames,
}));

vi.mock('../services/crew/crewFloatPlanDetails', () => ({ shareMyFloatPlanDetails: vi.fn(async () => 'skipped') }));

vi.mock('../services/PassagePlanService', () => ({
    NO_PASSAGE_ACCESS: {
        visible: false,
        voyageId: null,
        ownerUserId: null,
        isOwner: false,
        canEditStores: false,
        canViewMeals: false,
        canViewChat: false,
        canViewRoute: false,
        canViewChecklist: false,
    },
    getActivePassageId: () => mocks.activePassageId || null,
    getPassageStatus: mocks.getPassageStatus,
    getAuthorizedSharedVoyages: vi.fn(async () => ({ voyages: [], complete: true })),
    setActivePassage: vi.fn(),
    clearPassagePlan: vi.fn(),
}));

const VOYAGE: Voyage = {
    id: 'voyage-1',
    user_id: 'skipper-1',
    vessel_id: null,
    voyage_name: 'Bay Marina - Green Island',
    departure_port: 'Bay Marina',
    destination_port: 'Green Island',
    departure_time: '2026-10-10T21:00:00.000Z',
    eta: '2026-10-11T05:00:00.000Z',
    crew_count: 3,
    status: 'planning',
    weather_master_id: null,
    notes: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
};

vi.mock('../services/VoyageService', () => ({
    getCachedDraftVoyages: () => [],
    getDraftVoyages: vi.fn(async () => [VOYAGE]),
    createVoyage: vi.fn(async () => ({ voyage: null, error: 'not configured' })),
    updateVoyage: vi.fn(async () => ({ voyage: null })),
    getCachedActiveVoyage: () => null,
    adoptSavedRouteLink: vi.fn(),
}));

vi.mock('../services/shiplog/RoutesAndTracks', () => ({
    fetchRoutesAndTracks: vi.fn(async () => ({
        routes: [
            {
                id: 'planned_voyage-1',
                label: 'Bay Marina - Green Island',
                sublabel: '',
                points: [
                    { lat: -27.4, lon: 153.1 },
                    { lat: -27.0, lon: 153.3 },
                ],
                bbox: [153.1, -27.4, 153.3, -27.0],
                timestamp: Date.parse('2026-10-10T21:00:00.000Z'),
                distanceNm: 26,
                durationHours: 5,
                linkedPlanId: 'voyage-1',
            },
        ],
        tracks: [],
    })),
}));

vi.mock('../utils/system', () => ({
    triggerHaptic: vi.fn(),
    getSystemUnits: () => ({ speed: 'kts', length: 'm', distance: 'nm' }),
}));
vi.mock('../utils/lazyRetry', () => ({ lazyRetry: () => () => null }));
vi.mock('../components/Toast', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock('../components/SignInScreen', () => ({ SignInScreen: () => null }));
vi.mock('../components/ui/PageHeader', () => ({
    PageHeader: ({ title }: { title: string }) => (
        <header>
            <h1>{title}</h1>
        </header>
    ),
}));
vi.mock('../components/ui/UndoToast', () => ({
    UndoToast: ({ isOpen, message, onDismiss }: { isOpen: boolean; message: string; onDismiss: () => void }) =>
        isOpen ? (
            <div role="status">
                <span>{message}</span>
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
vi.mock('../components/crew/ReadinessCardStack', () => ({
    ReadinessCardStack: (props: { selectedPassageId: string; passageStatus: PassageStatus }) => (
        <div
            data-testid="readiness-stack"
            data-selected={props.selectedPassageId}
            data-owner={String(props.passageStatus.isOwner)}
            data-visible={String(props.passageStatus.visible)}
        />
    ),
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

const NONE: PassageStatus = {
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
const OWNER: PassageStatus = {
    visible: true,
    voyageId: 'voyage-1',
    ownerUserId: 'skipper-1',
    isOwner: true,
    canEditStores: true,
    canViewMeals: true,
    canViewChat: true,
    canViewRoute: true,
    canViewChecklist: true,
};

const crewRow = (overrides: Partial<CrewMember>): CrewMember => ({
    id: 'row',
    owner_id: 'skipper-1',
    crew_user_id: '',
    crew_email: 'crew@example.com',
    owner_email: 'skipper@example.com',
    shared_registers: ['stores'],
    permissions: {} as CrewMember['permissions'],
    status: 'accepted',
    role: 'deckhand',
    voyage_id: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-05T00:00:00.000Z',
    ...overrides,
});

const MIA = crewRow({
    id: 'crew-mia',
    crew_user_id: 'u-mia',
    crew_email: 'mia.chen@example.com',
    role: 'navigator',
    shared_registers: ['instruments', 'equipment', 'stores', 'passage_chat'],
});
const SAM = crewRow({
    id: 'crew-sam',
    crew_email: 'sam.hollis@example.com',
    status: 'pending',
    shared_registers: ['stores', 'passage_checklist', 'passage_chat'],
});

/**
 * Every getPassageStatus call for a passage waits for `release`, as on a
 * stalled link. Once released the server has answered: the checks waiting get
 * that answer, and so does any check the page starts after it. The page
 * re-checks access once your memberships load, and on a slow render that
 * re-check can start either side of the release; a check nobody answers would
 * leave its paint up.
 */
function holdPassageStatus() {
    const waiting: Array<(status: PassageStatus) => void> = [];
    let answer: PassageStatus | null = null;
    mocks.getPassageStatus.mockImplementation(
        (id: string | null) =>
            new Promise<PassageStatus>((resolve) => {
                if (!id) resolve(NONE);
                else if (answer) resolve(answer);
                else waiting.push(resolve);
            }),
    );
    return (status: PassageStatus) =>
        act(async () => {
            answer = status;
            for (const resolve of waiting.splice(0)) resolve(status);
        });
}

function seedPassageMemory(status: PassageStatus = OWNER) {
    localStorage.setItem(
        authScopedStorageKey('thalassa_crew_page_passage_status_v1'),
        JSON.stringify({ version: 1, userId: 'skipper-1', voyageId: 'voyage-1', status }),
    );
}

const renderPage = () => render(<CrewManagement onBack={vi.fn()} />);

describe('Crew & Float Plan, the tier-1 look', () => {
    beforeEach(() => {
        clearStaleWindowEvent();
        localStorage.clear();
        setAuthIdentityScope(null);
        setAuthIdentityScope('skipper-1');
        vi.clearAllMocks();
        mocks.activePassageId = 'voyage-1';
        mocks.getMyCrew.mockResolvedValue([MIA, SAM]);
        mocks.removeCrew.mockResolvedValue(true);
        mocks.updateCrewPermissions.mockResolvedValue(true);
        mocks.getPassageStatus.mockImplementation(async (id: string | null) => (id === 'voyage-1' ? OWNER : NONE));
        mocks.loadNames.mockResolvedValue({ 'u-mia': 'Mia Chen' });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('names each person and their role, with the status as a pill and Invite crew as the primary', async () => {
        renderPage();

        const title = await screen.findByText('Mia Chen');
        const card = title.closest('[data-testid="crew-member-card"]') as HTMLElement;
        expect(within(card).getByText('Navigator · mia.chen@example.com')).toBeInTheDocument();
        expect(within(card).getByText('Active')).toHaveClass('crew-pill');
        expect(within(card).getByRole('list', { name: 'Shared registers' })).toHaveTextContent(
            "Instrument PanelEquipmentShip's StoresGroup Chat",
        );
        // The invite nobody has accepted keeps its email.
        const invited = screen
            .getByText('sam.hollis@example.com')
            .closest('[data-testid="crew-member-card"]') as HTMLElement;
        expect(within(invited).getByText('Invited')).toHaveClass('crew-pill');
        expect(within(invited).getByText(/Waiting for them to accept/)).toBeInTheDocument();
        // The count's semantics are unchanged.
        expect(screen.getByText('2 aboard · +2 invited')).toHaveClass('crew-pill');
        expect(screen.getByRole('button', { name: 'Invite crew member' })).toHaveClass('crew-cta');
        expect(mocks.loadNames).toHaveBeenCalledWith(expect.objectContaining({ userId: 'skipper-1' }), ['u-mia']);
    });

    it('paints the names this device last read at once, before the read answers', async () => {
        localStorage.setItem(
            authScopedStorageKey('thalassa_crew_card_names_v1'),
            JSON.stringify({ version: 1, userId: 'skipper-1', names: { 'u-mia': 'Mia Chen' } }),
        );
        mocks.loadNames.mockReturnValue(new Promise(() => undefined));
        renderPage();
        expect(await screen.findByText('Mia Chen')).toBeInTheDocument();
    });

    it("draws Disband Entire Group as the page's last row, apart from Invite crew, with the same confirm", async () => {
        renderPage();
        const disband = await screen.findByRole('button', { name: 'Disband Entire Group' });
        expect(disband).toHaveClass('crew-danger-row');
        expect(disband).toHaveAccessibleDescription(/Removes all 2 crew members and their access/);
        // After the readiness cards, never in the My Crew header. Both are read
        // afresh: a stack held from first sight may have stepped aside for the
        // access re-check, and a detached node's position means nothing.
        await waitFor(() =>
            expect(
                screen
                    .getByTestId('readiness-stack')
                    .compareDocumentPosition(screen.getByRole('button', { name: 'Disband Entire Group' })) &
                    Node.DOCUMENT_POSITION_FOLLOWING,
            ).toBeTruthy(),
        );
        const invite = screen.getByRole('button', { name: 'Invite crew member' });
        expect(invite.closest('section')).not.toContainElement(
            screen.getByRole('button', { name: 'Disband Entire Group' }),
        );

        fireEvent.click(screen.getByRole('button', { name: 'Disband Entire Group' }));
        const dialog = screen.getByRole('region', { name: 'Disband Group' });
        expect(within(dialog).getByText('Type DISBAND to confirm')).toBeInTheDocument();
        expect(within(dialog).getByRole('button', { name: 'Confirm Disband' })).toBeDisabled();
    });

    it("Edit offers Remove from crew: the swipe's soft remove, with its Undo", async () => {
        renderPage();
        const card = (await screen.findByText('Mia Chen')).closest('[data-testid="crew-member-card"]') as HTMLElement;
        fireEvent.click(within(card).getByRole('button', { name: 'Edit crew member details' }));
        const sheet = screen.getByRole('region', { name: 'Edit Access — mia.chen@example.com' });
        expect(within(sheet).getByRole('button', { name: 'Save crew management changes' })).toHaveClass('crew-cta');

        fireEvent.click(within(sheet).getByRole('button', { name: 'Remove from crew' }));
        expect(screen.queryByRole('region', { name: /Edit Access/ })).not.toBeInTheDocument();
        expect(screen.queryByText('Mia Chen')).not.toBeInTheDocument();
        expect(screen.getByText('"mia.chen@example.com" removed')).toBeInTheDocument();
        expect(mocks.removeCrew).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: 'Let the undo lapse' }));
        await waitFor(() => expect(mocks.removeCrew).toHaveBeenCalledWith('crew-mia'));
    });

    it('a crew list that answers after the 6 s never brings back someone you have just removed', async () => {
        // A permission save reloads the lists, and this time your crew answer
        // late: at 6 s the page gives up waiting and shows the list it has.
        // You remove Mia from it. The late answer was read before that, so it
        // must not put her card back.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
        renderPage();
        const openMia = async () => {
            const card = (await screen.findByText('Mia Chen')).closest(
                '[data-testid="crew-member-card"]',
            ) as HTMLElement;
            fireEvent.click(within(card).getByRole('button', { name: 'Edit crew member details' }));
            return screen.getByRole('region', { name: 'Edit Access — mia.chen@example.com' });
        };

        let answerLate: () => void = () => undefined;
        mocks.getMyCrew.mockReturnValueOnce(
            new Promise<CrewMember[]>((resolve) => {
                answerLate = () => resolve([MIA, SAM]);
            }),
        );
        fireEvent.click(within(await openMia()).getByRole('button', { name: 'Save crew management changes' }));
        await waitFor(() => expect(mocks.getMyCrew).toHaveBeenCalledTimes(2));
        await act(async () => {});
        await act(async () => {
            vi.advanceTimersByTime(6000);
        });

        fireEvent.click(within(await openMia()).getByRole('button', { name: 'Remove from crew' }));
        expect(screen.queryByText('Mia Chen')).not.toBeInTheDocument();
        expect(screen.getByText('"mia.chen@example.com" removed')).toBeInTheDocument();

        await act(async () => answerLate());
        await act(async () => {});
        expect(screen.queryByText('Mia Chen')).not.toBeInTheDocument();
        expect(screen.getByText('sam.hollis@example.com')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Let the undo lapse' }));
        await waitFor(() => expect(mocks.removeCrew).toHaveBeenCalledWith('crew-mia'));
        await act(async () => {});
        expect(screen.queryByText('Mia Chen')).not.toBeInTheDocument();
    });

    it('a first visit shows "Checking passage access…" until the answer, then remembers the grant', async () => {
        const release = holdPassageStatus();
        renderPage();
        expect(await screen.findByText('Checking passage access…')).toBeInTheDocument();
        expect(screen.queryByTestId('readiness-stack')).not.toBeInTheDocument();

        await release(OWNER);
        await waitFor(() => expect(screen.getByTestId('readiness-stack')).toHaveAttribute('data-owner', 'true'));
        expect(screen.queryByText('Checking passage access…')).not.toBeInTheDocument();
        expect(readLastPassageStatus(getAuthIdentityScope(), 'voyage-1')).toEqual(OWNER);
    });

    it('a later visit paints the last verified access at once, and waits for the verified one to act', async () => {
        seedPassageMemory();
        const release = holdPassageStatus();
        renderPage();

        const stack = await screen.findByTestId('readiness-stack');
        expect(stack).toHaveAttribute('data-owner', 'true');
        expect(stack).toHaveAttribute('data-selected', 'voyage-1');
        expect(screen.queryByText('Checking passage access…')).not.toBeInTheDocument();
        // Nothing that changes the passage moves on the painted answer.
        expect(screen.getByLabelText('Departure Date')).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Cast Off' })).toBeDisabled();

        await release(OWNER);
        await waitFor(() => expect(screen.getByLabelText('Departure Date')).not.toBeDisabled());
        expect(screen.getByTestId('readiness-stack')).toHaveAttribute('data-owner', 'true');
    });

    it('a denial replaces the painted access and forgets it', async () => {
        seedPassageMemory();
        const release = holdPassageStatus();
        renderPage();
        expect(await screen.findByTestId('readiness-stack')).toHaveAttribute('data-owner', 'true');

        await release(NONE);
        await waitFor(() => expect(screen.getByTestId('readiness-stack')).toHaveAttribute('data-visible', 'false'));
        expect(screen.queryByLabelText('Departure Date')).not.toBeInTheDocument();
        expect(readLastPassageStatus(getAuthIdentityScope(), 'voyage-1')).toBeNull();
    });

    it("another account's remembered access never paints", async () => {
        localStorage.setItem(
            authScopedStorageKey('thalassa_crew_page_passage_status_v1'),
            JSON.stringify({ version: 1, userId: 'someone-else', voyageId: 'voyage-1', status: OWNER }),
        );
        holdPassageStatus();
        renderPage();
        expect(await screen.findByText('Checking passage access…')).toBeInTheDocument();
        expect(screen.queryByTestId('readiness-stack')).not.toBeInTheDocument();
    });
});
