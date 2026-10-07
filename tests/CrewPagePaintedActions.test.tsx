/**
 * The Crew & Float Plan page paints the passage access it last verified while
 * the live check runs (services/crew/lastPassageStatus). Through the page and
 * the REAL ReadinessCardStack (its cards mocked): nothing that writes is handed
 * to the cards on the painted answer, so a write cannot be dropped by the
 * page's verified-status handlers, and once the answer lands it is handed over
 * and lands. The Summary card's past-departure roll-forward is mocked the way
 * PassageSummaryCard does it (once per target, behind a ref that resets while
 * it has no handler). Fictional people only.
 */
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrewMember } from '../services/CrewService';
import type { PassageStatus } from '../services/PassagePlanService';
import type { Voyage } from '../services/VoyageService';
import { authScopedStorageKey, setAuthIdentityScope } from '../services/authIdentityScope';
import { clearStaleWindowEvent } from './helpers/clearStaleWindowEvent';

/** Where the mocked Summary card rolls a past departure forward to. */
const ROLLED_DEPARTURE = '2026-12-01T21:00:00.000Z';

const mocks = vi.hoisted(() => ({
    getPassageStatus: vi.fn(),
    getMyMemberships: vi.fn(),
    updateVoyage: vi.fn(),
    galley: vi.fn(),
    watch: vi.fn(),
    weather: vi.fn(),
    // How long each Summary card render takes, in ms. Past React's 5 ms slice
    // the effects of the commit that painted the card run a turn later, as on
    // a loaded CI runner with coverage on.
    summaryRenderMs: 0,
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

const MIA: CrewMember = {
    id: 'crew-mia',
    owner_id: 'skipper-1',
    crew_user_id: 'u-mia',
    crew_email: 'mia.chen@example.com',
    owner_email: 'skipper@example.com',
    shared_registers: ['stores', 'passage_checklist', 'passage_chat'],
    permissions: {} as CrewMember['permissions'],
    status: 'accepted',
    role: 'navigator',
    voyage_id: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-05T00:00:00.000Z',
};

vi.mock('../services/CrewService', () => ({
    ALL_REGISTERS: ['stores', 'equipment', 'passage_chat', 'passage_checklist'],
    ALWAYS_SHARED_REGISTERS: ['passage_chat'],
    PASSAGE_REGISTERS: ['passage_meals', 'passage_chat', 'passage_route', 'passage_checklist'],
    REGISTER_ICONS: {},
    REGISTER_LABELS: {
        stores: "Ship's Stores",
        equipment: 'Equipment',
        passage_chat: 'Group Chat',
        passage_checklist: 'Checklist',
    },
    inviteCrew: vi.fn(),
    getMyCrew: vi.fn(async () => [MIA]),
    removeCrew: vi.fn(),
    disbandGroup: vi.fn(),
    updateCrewPermissions: vi.fn(),
    getMyInvites: vi.fn(async () => []),
    getMyMemberships: mocks.getMyMemberships,
    acceptInvite: vi.fn(),
    declineInvite: vi.fn(),
    leaveVessel: vi.fn(),
}));
vi.mock('../services/crew/crewCardNames', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/crew/crewCardNames')>()),
    loadCrewCardNames: vi.fn(async () => ({ 'u-mia': 'Mia Chen' })),
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
    getActivePassageId: () => 'voyage-1',
    getPassageStatus: mocks.getPassageStatus,
    getAuthorizedSharedVoyages: vi.fn(async () => ({ voyages: [], complete: true })),
    setActivePassage: vi.fn(),
    clearPassagePlan: vi.fn(),
}));

// A departure already in the past, so the Summary card wants to roll it on.
const VOYAGE: Voyage = {
    id: 'voyage-1',
    user_id: 'skipper-1',
    vessel_id: null,
    voyage_name: 'Bay Marina - Green Island',
    departure_port: 'Bay Marina',
    destination_port: 'Green Island',
    departure_time: '2026-01-10T21:00:00.000Z',
    eta: '2026-01-11T05:00:00.000Z',
    crew_count: 2,
    status: 'planning',
    weather_master_id: null,
    notes: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
};
vi.mock('../services/VoyageService', () => ({
    getCachedDraftVoyages: () => [],
    getDraftVoyages: vi.fn(async () => [VOYAGE]),
    createVoyage: vi.fn(async () => ({ voyage: null, error: 'not configured' })),
    updateVoyage: mocks.updateVoyage,
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
                timestamp: Date.parse('2026-01-10T21:00:00.000Z'),
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
vi.mock('../components/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../components/SignInScreen', () => ({ SignInScreen: () => null }));
vi.mock('../components/ui/PageHeader', () => ({
    PageHeader: ({ title }: { title: string }) => (
        <header>
            <h1>{title}</h1>
        </header>
    ),
}));
vi.mock('../components/ui/UndoToast', () => ({ UndoToast: () => null }));
vi.mock('../components/ui/ModalSheet', () => ({
    ModalSheet: ({ children, isOpen, title }: { children: React.ReactNode; isOpen: boolean; title: string }) =>
        isOpen ? <section aria-label={title}>{children}</section> : null,
}));
vi.mock('../components/crew/InviteCrewModal', () => ({ InviteCrewModal: () => <div>Invite form</div> }));
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

// ── The readiness stack's cards ──
type DepartureHandler = ((departureTime: string, eta?: string | null) => void) | undefined;
vi.mock('../components/passage/PassageSummaryCard', () => ({
    PassageSummaryCard: ({
        departureTime,
        onDepartureTimeChange,
        allowFloatPlan,
    }: {
        departureTime?: string | null;
        onDepartureTimeChange?: DepartureHandler;
        allowFloatPlan?: boolean;
    }) => {
        const until = performance.now() + mocks.summaryRenderMs;
        while (performance.now() < until) {
            // A slow render: hold the thread, as a busy runner would.
        }
        // PassageSummaryCard.tsx's automaticDepartureRef, in miniature.
        const fired = React.useRef<string | null>(null);
        React.useEffect(() => {
            const stored = departureTime ? Date.parse(departureTime) : NaN;
            if (!onDepartureTimeChange || !Number.isFinite(stored) || stored >= Date.now()) {
                fired.current = null;
                return;
            }
            if (fired.current === ROLLED_DEPARTURE) return;
            fired.current = ROLLED_DEPARTURE;
            onDepartureTimeChange(ROLLED_DEPARTURE, null);
        }, [departureTime, onDepartureTimeChange]);
        return (
            <div
                data-testid="summary-card"
                data-can-edit={String(Boolean(onDepartureTimeChange))}
                data-float-plan={String(Boolean(allowFloatPlan))}
            />
        );
    },
}));
vi.mock('../components/passage/WeatherWindowCard', () => ({
    WeatherWindowCard: (props: { onDepartureTimeChange?: DepartureHandler }) => {
        mocks.weather(Boolean(props.onDepartureTimeChange));
        return null;
    },
}));
vi.mock('../components/passage/WatchScheduleCard', () => ({
    WatchScheduleCard: (props: { readOnly?: boolean }) => {
        mocks.watch(props.readOnly);
        return null;
    },
}));
vi.mock('../components/chat/GalleyCard', () => ({
    GalleyCard: (props: { passageStatus?: PassageStatus; onAssignCard?: unknown }) => {
        mocks.galley({ canEditStores: props.passageStatus?.canEditStores, delegation: Boolean(props.onAssignCard) });
        return null;
    },
}));
vi.mock('../components/crew/DelegationBadge', () => ({
    DelegationBadge: ({ cardKey }: { cardKey: string }) => <span data-testid={`delegate-${cardKey}`} />,
}));
vi.mock('../components/passage/OceanCurrentsCard', () => ({ OceanCurrentsCard: () => null }));
vi.mock('../components/passage/EssentialReservesCard', () => ({ EssentialReservesCard: () => null }));
vi.mock('../components/passage/AidToNavigationCard', () => ({ AidToNavigationCard: () => null }));
vi.mock('../components/passage/CommsPlanCard', () => ({ CommsPlanCard: () => null }));
vi.mock('../components/passage/VesselCheckCard', () => ({ VesselCheckCard: () => null }));
vi.mock('../components/passage/MedicalFirstAidCard', () => ({ MedicalFirstAidCard: () => null }));
vi.mock('../components/passage/CustomsClearanceCard', () => ({ CustomsClearanceCard: () => null }));
vi.mock('../components/passage/VesselProfileSummary', () => ({ VesselProfileSummary: () => null }));

import { CrewManagement } from '../components/CrewManagement';

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

/**
 * Every getPassageStatus call waits for `release`, as on a stalled link. Once
 * released the server has answered: the checks waiting get that answer, and
 * so does any check the page starts after it. The page re-checks access once
 * your memberships load, and on a slow render that re-check can start either
 * side of the release; a check nobody answers would leave its paint up.
 */
function holdPassageStatus() {
    const waiting: Array<(status: PassageStatus) => void> = [];
    let answer: PassageStatus | null = null;
    mocks.getPassageStatus.mockImplementation(() =>
        answer ? Promise.resolve(answer) : new Promise<PassageStatus>((resolve) => waiting.push(resolve)),
    );
    return (status: PassageStatus) =>
        act(async () => {
            answer = status;
            for (const resolve of waiting.splice(0)) resolve(status);
        });
}

const MEMORY_KEY = 'thalassa_crew_page_passage_status_v1';

/** This device last verified the owner's grant for voyage-1. Returns the key it is kept under. */
function rememberOwnerGrant() {
    const key = authScopedStorageKey(MEMORY_KEY);
    localStorage.setItem(key, JSON.stringify({ version: 1, userId: 'skipper-1', voyageId: 'voyage-1', status: OWNER }));
    return key;
}

// The Summary card's roll-forward, written through the page's departure
// handler. The page's own ETA backfill also clamps a past departure to now as
// it reconciles the row (loadData, not the cards), so it is told apart by the
// time the card asked for.
const departureWrites = () =>
    mocks.updateVoyage.mock.calls.filter(
        ([, patch]) => (patch as { departure_time?: string }).departure_time === ROLLED_DEPARTURE,
    );

const last = (mock: ReturnType<typeof vi.fn>) => mock.mock.calls[mock.mock.calls.length - 1]?.[0];

/**
 * From the painted card (fake timers on): 6 s with no answer from the check
 * that is out, then its late answer.
 */
async function noAnswerForSixSecondsThenLate(release: ReturnType<typeof holdPassageStatus>, key: string) {
    // Let the page finish what painting the card started before the clock
    // moves. A render past React's 5 ms slice runs its effects a turn later,
    // and one of them can be the re-check your memberships start once they
    // land: a fresh check with its own 6 s. Moved before that turn, the clock
    // timed out the check before it, and the fresh check painted again (CI run
    // 37556214853). An async `act` resolves only after a task turn, behind the
    // one React queued for those effects.
    await act(async () => {});
    const checks = mocks.getPassageStatus.mock.calls.length;

    await act(async () => {
        vi.advanceTimersByTime(6000);
    });
    // 6 s with no answer from the check that is out, and no new check since.
    expect(mocks.getPassageStatus).toHaveBeenCalledTimes(checks);
    expect(screen.queryByTestId('summary-card')).not.toBeInTheDocument();
    expect(screen.getByText('Checking passage access…')).toBeInTheDocument();
    expect(screen.getByText(/No answer yet/)).toBeInTheDocument();
    // No answer is not a denial: the next visit still paints at once.
    expect(localStorage.getItem(key)).not.toBeNull();
    expect(departureWrites()).toHaveLength(0);

    await release(OWNER);
    await waitFor(() => expect(screen.getByTestId('summary-card')).toHaveAttribute('data-can-edit', 'true'));
    expect(screen.queryByText('Checking passage access…')).not.toBeInTheDocument();
    await waitFor(() => expect(departureWrites()).toHaveLength(1));
}

describe('Crew & Float Plan: painted passage access hands the cards no write', () => {
    beforeEach(() => {
        clearStaleWindowEvent();
        localStorage.clear();
        setAuthIdentityScope(null);
        setAuthIdentityScope('skipper-1');
        vi.clearAllMocks();
        mocks.summaryRenderMs = 0;
        mocks.getMyMemberships.mockImplementation(async () => []);
        mocks.updateVoyage.mockResolvedValue({ voyage: null });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('first visit: the roll-forward is handed over once verified, and lands', async () => {
        const release = holdPassageStatus();
        render(<CrewManagement onBack={vi.fn()} />);
        expect(await screen.findByText('Checking passage access…')).toBeInTheDocument();

        await release(OWNER);
        await waitFor(() => expect(screen.getByTestId('summary-card')).toHaveAttribute('data-can-edit', 'true'));
        expect(screen.queryByText('Checking passage access…')).not.toBeInTheDocument();
        await waitFor(() => expect(departureWrites()).toHaveLength(1));
        expect(departureWrites()[0]).toEqual([
            'voyage-1',
            expect.objectContaining({ departure_time: ROLLED_DEPARTURE }),
        ]);
    });

    it('repeat visit: the cards paint at once with no write, then the roll-forward lands once verified', async () => {
        rememberOwnerGrant();
        const release = holdPassageStatus();
        render(<CrewManagement onBack={vi.fn()} />);

        // Painted: the owner's cards, but nothing that writes.
        const summary = await screen.findByTestId('summary-card');
        expect(screen.queryByText('Checking passage access…')).not.toBeInTheDocument();
        expect(summary).toHaveAttribute('data-can-edit', 'false');
        expect(summary).toHaveAttribute('data-float-plan', 'false');
        expect(screen.queryByTestId('delegate-weather_windows')).not.toBeInTheDocument();
        expect(last(mocks.weather)).toBe(false);
        expect(last(mocks.watch)).toBe(true);
        expect(last(mocks.galley)).toEqual({ canEditStores: false, delegation: false });
        expect(departureWrites()).toHaveLength(0);

        // Verified: handed over, and the roll-forward is written exactly once.
        await release(OWNER);
        await waitFor(() => expect(screen.getByTestId('summary-card')).toHaveAttribute('data-can-edit', 'true'));
        await waitFor(() => expect(departureWrites()).toHaveLength(1));
        expect(departureWrites()[0]).toEqual([
            'voyage-1',
            expect.objectContaining({ departure_time: ROLLED_DEPARTURE }),
        ]);
        expect(screen.getByTestId('summary-card')).toHaveAttribute('data-float-plan', 'true');
        expect(screen.getByTestId('delegate-weather_windows')).toBeInTheDocument();
        expect(last(mocks.weather)).toBe(true);
        expect(last(mocks.watch)).toBe(false);
        expect(last(mocks.galley)).toEqual({ canEditStores: true, delegation: true });
    });

    it('a check with no answer after 6 s drops the paint, keeps the memory, and its late answer still lands', async () => {
        // getPassageStatus has no deadline (a stalled link at sea): a
        // possibly-revoked grant must not stay on screen while it stalls.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
        const key = rememberOwnerGrant();
        const release = holdPassageStatus();
        render(<CrewManagement onBack={vi.fn()} />);
        expect(await screen.findByTestId('summary-card')).toHaveAttribute('data-can-edit', 'false');

        await noAnswerForSixSecondsThenLate(release, key);
    });

    it('drops the paint 6 s after the check out when your memberships land late, on a slow render', async () => {
        // The order CI run 37556214853 met: your memberships answer after the
        // page's first check is out, and the render that paints the card runs
        // past React's 5 ms slice, so the re-check those memberships start
        // (with its own 6 s) runs a turn after the card is on screen.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
        mocks.summaryRenderMs = 25;
        mocks.getMyMemberships.mockImplementation(
            () => new Promise<CrewMember[]>((resolve) => setTimeout(() => resolve([]), 60)),
        );
        const key = rememberOwnerGrant();
        const release = holdPassageStatus();
        render(<CrewManagement onBack={vi.fn()} />);
        expect(await screen.findByTestId('summary-card')).toHaveAttribute('data-can-edit', 'false');

        await noAnswerForSixSecondsThenLate(release, key);
    });

    it('an answered denial forgets the grant; the same "no access" while offline does not', async () => {
        const key = authScopedStorageKey(MEMORY_KEY);
        const remembered = JSON.stringify({ version: 1, userId: 'skipper-1', voyageId: 'voyage-1', status: OWNER });
        const NO_ACCESS: PassageStatus = {
            ...OWNER,
            visible: false,
            voyageId: null,
            ownerUserId: null,
            isOwner: false,
        };

        // Offline: getPassageStatus fails closed with "no access", which is not
        // a denial. The page follows it, but the memory stays.
        localStorage.setItem(key, remembered);
        const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        let release = holdPassageStatus();
        const first = render(<CrewManagement onBack={vi.fn()} />);
        await screen.findByTestId('summary-card');
        await release(NO_ACCESS);
        await waitFor(() => expect(screen.queryByTestId('summary-card')).not.toBeInTheDocument());
        expect(localStorage.getItem(key)).not.toBeNull();
        first.unmount();

        // Online, the same answer is a denial (revoked): forgotten.
        onLine.mockReturnValue(true);
        release = holdPassageStatus();
        render(<CrewManagement onBack={vi.fn()} />);
        await screen.findByTestId('summary-card');
        await release(NO_ACCESS);
        await waitFor(() => expect(screen.queryByTestId('summary-card')).not.toBeInTheDocument());
        expect(localStorage.getItem(key)).toBeNull();
        expect(departureWrites()).toHaveLength(0);
        onLine.mockRestore();
    });
});
