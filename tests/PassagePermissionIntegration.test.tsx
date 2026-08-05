import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PassageStatus } from '../services/PassagePlanService';
import type { VoyageRow } from '../components/CrewManagement';
import type { CrewMember } from '../services/CrewService';

vi.mock('../data/customsDb', () => ({
    isSameCountry: vi.fn(() => false),
}));

vi.mock('../components/passage/PassageSummaryCard', () => ({
    PassageSummaryCard: ({
        onDepartureTimeChange,
    }: {
        onDepartureTimeChange?: (departureTime: string, eta: string | null) => void;
    }) => (
        <div data-testid="passage-summary-card">
            Passage summary
            <button
                type="button"
                data-testid="change-summary-departure"
                onClick={() => onDepartureTimeChange?.('2026-08-01T05:00:00.000Z', '2026-08-03T05:00:00.000Z')}
            >
                Change departure
            </button>
        </div>
    ),
}));
vi.mock('../components/passage/WeatherWindowCard', () => ({
    WeatherWindowCard: () => <div data-testid="weather-window-card">Weather window</div>,
}));
vi.mock('../components/passage/OceanCurrentsCard', () => ({
    OceanCurrentsCard: () => <div data-testid="ocean-currents-card">Ocean currents</div>,
}));
vi.mock('../components/passage/WatchScheduleCard', () => ({
    WatchScheduleCard: () => <div data-testid="watch-schedule-card">Watch schedule</div>,
}));
vi.mock('../components/passage/CustomsClearanceCard', () => ({
    CustomsClearanceCard: () => <div data-testid="customs-card">Customs</div>,
}));
vi.mock('../components/passage/AidToNavigationCard', () => ({
    AidToNavigationCard: ({ allOtherCardsReady }: { allOtherCardsReady?: boolean }) => (
        <div data-testid="navigation-card" data-other-cards-ready={String(allOtherCardsReady)}>
            Navigation
        </div>
    ),
}));
vi.mock('../components/passage/VesselProfileSummary', () => ({
    VesselProfileSummary: ({ voyageId }: { voyageId?: string }) => (
        <div data-testid="vessel-profile-card" data-voyage-id={voyageId}>
            Vessel profile
        </div>
    ),
}));
vi.mock('../components/passage/EssentialReservesCard', () => ({
    EssentialReservesCard: () => <div data-testid="reserves-card">Reserves</div>,
}));
vi.mock('../components/passage/VesselCheckCard', () => ({
    VesselCheckCard: () => <div data-testid="vessel-check-card">Vessel check</div>,
}));
vi.mock('../components/passage/MedicalFirstAidCard', () => ({
    MedicalFirstAidCard: () => <div data-testid="medical-card">Medical</div>,
}));
vi.mock('../components/passage/CommsPlanCard', () => ({
    CommsPlanCard: () => <div data-testid="comms-card">Comms</div>,
}));
vi.mock('../components/chat/GalleyCard', () => ({
    GalleyCard: ({
        passageStatus,
        onProvisionedChange,
    }: {
        passageStatus: PassageStatus;
        onProvisionedChange?: (provisioned: boolean) => void;
    }) => (
        <div
            data-testid="galley-card"
            data-owner={String(passageStatus.isOwner)}
            data-can-view-meals={String(passageStatus.canViewMeals)}
        >
            Galley
            <button type="button" data-testid="mark-provisioned" onClick={() => onProvisionedChange?.(true)}>
                Mark provisioned
            </button>
        </div>
    ),
}));
import { ReadinessCardStack } from '../components/crew/ReadinessCardStack';
import { isSameCountry } from '../data/customsDb';

const voyage: VoyageRow = {
    id: 'voyage-1',
    user_id: 'owner-1',
    vessel_id: null,
    voyage_name: 'Brisbane to Noumea',
    departure_port: 'Brisbane, Australia',
    destination_port: 'Noumea, New Caledonia',
    departure_time: '2026-08-01T00:00:00.000Z',
    eta: '2026-08-06T00:00:00.000Z',
    crew_count: 4,
    status: 'planning',
    weather_master_id: null,
    notes: null,
    created_at: '2026-07-23T00:00:00.000Z',
    updated_at: '2026-07-23T00:00:00.000Z',
    departureCoords: { lat: -27.47, lon: 153.03 },
    arrivalCoords: { lat: -22.27, lon: 166.44 },
    durationHours: 120,
};

const ownerStatus: PassageStatus = {
    visible: true,
    voyageId: voyage.id,
    ownerUserId: voyage.user_id,
    isOwner: true,
    canEditStores: true,
    canViewMeals: true,
    canViewChat: true,
    canViewRoute: true,
    canViewChecklist: true,
};

const restrictedChecklistStatus: PassageStatus = {
    visible: true,
    voyageId: voyage.id,
    ownerUserId: voyage.user_id,
    isOwner: false,
    canEditStores: false,
    canViewMeals: false,
    canViewChat: false,
    canViewRoute: false,
    canViewChecklist: true,
};

const crewMember = (overrides: Partial<CrewMember> = {}): CrewMember => ({
    id: 'crew-1',
    owner_id: voyage.user_id,
    crew_user_id: 'crew-user-1',
    crew_email: 'deckhand@example.com',
    owner_email: 'owner@example.com',
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
    status: 'pending',
    role: 'deckhand',
    voyage_id: voyage.id,
    created_at: '2026-07-23T00:00:00.000Z',
    updated_at: '2026-07-23T00:00:00.000Z',
    ...overrides,
});

const renderStack = (
    passageStatus: PassageStatus,
    visibleCrew: CrewMember[] = [],
    overrides: Partial<React.ComponentProps<typeof ReadinessCardStack>> = {},
) =>
    render(
        <ReadinessCardStack
            selectedPassageId={voyage.id}
            passageStatus={passageStatus}
            draftVoyages={[voyage]}
            visibleCrew={visibleCrew}
            planCrewCount={4}
            reservesReady={false}
            vesselChecked={false}
            medicalReady={false}
            watchBriefed={false}
            commsReady={false}
            customsCleared={false}
            navAcknowledged={false}
            customsProgress={{ total: 0, checked: 0 }}
            onReservesChange={vi.fn()}
            onVesselCheckChange={vi.fn()}
            onMedicalChange={vi.fn()}
            onWatchChange={vi.fn()}
            onCommsChange={vi.fn()}
            onCustomsChange={vi.fn()}
            onNavChange={vi.fn()}
            cardDelegations={{}}
            delegationMenuOpen={null}
            onDelegationMenuToggle={vi.fn()}
            onAssignCard={vi.fn()}
            onVesselProfileChange={vi.fn()}
            onWeatherWindowChange={vi.fn()}
            onCurrentsChange={vi.fn()}
            {...overrides}
        />,
    );

afterEach(() => {
    vi.mocked(isSameCountry).mockReturnValue(false);
});

describe('passage permission integration', () => {
    it('mounts every child-card family but hides delegation controls for a solo owner', () => {
        renderStack(ownerStatus);

        expect(screen.getByTestId('passage-summary-card')).toBeInTheDocument();
        expect(screen.getByTestId('weather-window-card')).toBeInTheDocument();
        expect(screen.getByTestId('galley-card')).toHaveAttribute('data-owner', 'true');
        expect(screen.getByTestId('galley-card')).toHaveAttribute('data-can-view-meals', 'true');
        expect(screen.getByTestId('watch-schedule-card')).toBeInTheDocument();
        expect(screen.getByTestId('vessel-profile-card')).toBeInTheDocument();
        expect(screen.getByTestId('vessel-profile-card')).toHaveAttribute('data-voyage-id', voyage.id);
        expect(screen.queryByRole('button', { name: /assign/i })).not.toBeInTheDocument();
    });

    it('starts a fresh international route with no implied readiness ticks', () => {
        renderStack(ownerStatus);

        expect(screen.getByText('Passage Intelligence').closest('summary')).toHaveTextContent('0/2');
        expect(screen.getByText('Departure Brief').closest('summary')).toHaveTextContent('0/4');
        expect(screen.getByText('Vessel Readiness').closest('summary')).toHaveTextContent('0/5');
    });

    it('forwards a Summary departure edit with the active voyage identity', () => {
        const onDepartureTimeChange = vi.fn();
        renderStack(ownerStatus, [], { onDepartureTimeChange });

        fireEvent.click(screen.getByTestId('change-summary-departure'));

        expect(onDepartureTimeChange).toHaveBeenCalledWith(
            voyage.id,
            '2026-08-01T05:00:00.000Z',
            '2026-08-03T05:00:00.000Z',
        );
    });

    it('does not lend old readiness ticks to an unresolved saved-route selection', () => {
        renderStack(ownerStatus, [], {
            // A selected ID can outlive the route list while saved routes are
            // being reconciled (or after a deleted route is healed). Treat
            // that as no route loaded, rather than showing the previous
            // passage's cached checklist progress.
            draftVoyages: [],
            weatherWindowReady: true,
            currentsBriefed: true,
            vesselProfileReady: true,
            reservesReady: true,
            vesselChecked: true,
            medicalReady: true,
            commsReady: true,
            watchBriefed: true,
            customsCleared: true,
            navAcknowledged: true,
        });

        expect(screen.getByText('Passage Intelligence').closest('summary')).toHaveTextContent('0/2');
        expect(screen.getByText('Departure Brief').closest('summary')).toHaveTextContent('0/4');
        expect(screen.getByText('Vessel Readiness').closest('summary')).toHaveTextContent('0/5');
    });

    it('keeps saved-route readiness after its active voyage resolves', () => {
        renderStack(ownerStatus, [], {
            watchBriefed: true,
            customsCleared: true,
        });

        expect(screen.getByText('Departure Brief').closest('summary')).toHaveTextContent('2/4');
    });

    it('counts provisioning alongside the other three international departure-brief cards', () => {
        const onProvisionedChange = vi.fn();
        renderStack(ownerStatus, [], {
            watchBriefed: true,
            customsCleared: true,
            navAcknowledged: true,
            onProvisionedChange,
        });

        const departureBrief = screen.getByText('Departure Brief').closest('summary');
        expect(departureBrief).toHaveTextContent('3/4');

        fireEvent.click(screen.getByTestId('mark-provisioned'));

        expect(departureBrief).toHaveTextContent('4/4');
        expect(onProvisionedChange).toHaveBeenCalledWith(true);
    });

    it('does not nest the full summary beneath a second accordion card', () => {
        renderStack(ownerStatus);

        expect(screen.getByTestId('passage-summary-card').closest('details')).toBeNull();
    });

    it('keeps domestic customs informational instead of auto-ticking a new brief', () => {
        vi.mocked(isSameCountry).mockReturnValue(true);
        const onCustomsChange = vi.fn();
        renderStack(ownerStatus, [], { onCustomsChange });

        expect(onCustomsChange).not.toHaveBeenCalled();
        const departureBrief = screen.getByText('Departure Brief').closest('summary');
        expect(departureBrief).toHaveTextContent(/0\/3\s*required/i);
        expect(departureBrief).toHaveTextContent(/1\s*N\/A/i);
        expect(screen.getByText('No Customs Required')).toBeInTheDocument();
        expect(screen.getByText('Customs & Immigration').closest('summary')).not.toHaveTextContent('✅');
    });

    it('retains the domestic customs exemption while showing the completed required cards', () => {
        vi.mocked(isSameCountry).mockReturnValue(true);
        renderStack(ownerStatus, [], {
            watchBriefed: true,
            navAcknowledged: true,
        });

        const departureBrief = screen.getByText('Departure Brief').closest('summary');
        expect(departureBrief).toHaveTextContent(/2\/3\s*required/i);
        expect(departureBrief).toHaveTextContent(/1\s*N\/A/i);
    });

    it('lets domestic passages progress to the navigation gate without a fictional customs check', () => {
        vi.mocked(isSameCountry).mockReturnValue(true);
        renderStack(ownerStatus, [], {
            weatherWindowReady: true,
            reservesReady: true,
            watchBriefed: true,
            commsReady: true,
        });

        expect(screen.getByTestId('navigation-card')).toHaveAttribute('data-other-cards-ready', 'true');
    });

    it('shows delegation controls as soon as a pending crew invite exists', () => {
        renderStack(ownerStatus, [crewMember()]);

        expect(screen.getAllByRole('button', { name: /assign/i }).length).toBeGreaterThan(0);
    });

    it('does not treat a declined invite as an assignable crew member', () => {
        renderStack(ownerStatus, [crewMember({ status: 'declined' })]);

        expect(screen.queryByRole('button', { name: /assign/i })).not.toBeInTheDocument();
    });

    it('mounts only shared checklist cards for restricted crew and never owner controls', () => {
        renderStack(restrictedChecklistStatus);

        expect(screen.queryByTestId('passage-summary-card')).not.toBeInTheDocument();
        expect(screen.queryByTestId('weather-window-card')).not.toBeInTheDocument();
        expect(screen.queryByTestId('ocean-currents-card')).not.toBeInTheDocument();
        expect(screen.queryByTestId('galley-card')).not.toBeInTheDocument();
        expect(screen.getByTestId('watch-schedule-card')).toBeInTheDocument();
        expect(screen.getByTestId('navigation-card')).toBeInTheDocument();
        expect(screen.getByTestId('vessel-profile-card')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /assign/i })).not.toBeInTheDocument();
    });

    it('rejects an otherwise valid grant when it belongs to a different voyage', () => {
        renderStack({ ...ownerStatus, voyageId: 'voyage-2' });

        expect(screen.getByText(/has not been shared with your crew account/i)).toBeInTheDocument();
        expect(screen.queryByTestId('passage-summary-card')).not.toBeInTheDocument();
        expect(screen.queryByTestId('galley-card')).not.toBeInTheDocument();
        expect(screen.queryByTestId('vessel-profile-card')).not.toBeInTheDocument();
    });

    it('hides sibling readiness dropdowns until the open card is rolled up', () => {
        renderStack(ownerStatus);

        const vesselReadiness = screen.getByText('Vessel Readiness').closest('summary');
        const vesselProfile = screen.getByText('Vessel Profile').closest('summary');
        expect(vesselReadiness).not.toBeNull();
        expect(vesselProfile).not.toBeNull();

        fireEvent.click(vesselReadiness!);
        fireEvent.click(vesselProfile!);

        expect(screen.getByTestId('vessel-profile-card')).toBeVisible();
        expect(screen.getByText('Essential Reserves')).not.toBeVisible();
        expect(screen.getByText('Communications Plan')).not.toBeVisible();

        fireEvent.click(vesselProfile!);

        expect(screen.getByText('Essential Reserves')).toBeVisible();
        expect(screen.getByText('Communications Plan')).toBeVisible();
    });
});
