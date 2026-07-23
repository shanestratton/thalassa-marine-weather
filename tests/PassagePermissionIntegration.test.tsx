import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PassageStatus } from '../services/PassagePlanService';
import type { VoyageRow } from '../components/CrewManagement';

vi.mock('../data/customsDb', () => ({
    isSameCountry: vi.fn(() => false),
}));

vi.mock('../components/passage/PassageSummaryCard', () => ({
    PassageSummaryCard: () => <div data-testid="passage-summary-card">Passage summary</div>,
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
    AidToNavigationCard: () => <div data-testid="navigation-card">Navigation</div>,
}));
vi.mock('../components/passage/VesselProfileSummary', () => ({
    VesselProfileSummary: () => <div data-testid="vessel-profile-card">Vessel profile</div>,
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
    GalleyCard: ({ passageStatus }: { passageStatus: PassageStatus }) => (
        <div
            data-testid="galley-card"
            data-owner={String(passageStatus.isOwner)}
            data-can-view-meals={String(passageStatus.canViewMeals)}
        >
            Galley
        </div>
    ),
}));
vi.mock('../components/crew/DelegationBadge', () => ({
    DelegationBadge: () => <button type="button">Assign</button>,
}));

import { ReadinessCardStack } from '../components/crew/ReadinessCardStack';

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

const renderStack = (passageStatus: PassageStatus) =>
    render(
        <ReadinessCardStack
            selectedPassageId={voyage.id}
            passageStatus={passageStatus}
            draftVoyages={[voyage]}
            visibleCrew={[]}
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
        />,
    );

describe('passage permission integration', () => {
    it('mounts every child-card family and owner delegation controls for a verified owner', () => {
        renderStack(ownerStatus);

        expect(screen.getByTestId('passage-summary-card')).toBeInTheDocument();
        expect(screen.getByTestId('weather-window-card')).toBeInTheDocument();
        expect(screen.getByTestId('galley-card')).toHaveAttribute('data-owner', 'true');
        expect(screen.getByTestId('galley-card')).toHaveAttribute('data-can-view-meals', 'true');
        expect(screen.getByTestId('watch-schedule-card')).toBeInTheDocument();
        expect(screen.getByTestId('vessel-profile-card')).toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: 'Assign' }).length).toBeGreaterThan(0);
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
        expect(screen.queryByRole('button', { name: 'Assign' })).not.toBeInTheDocument();
    });

    it('rejects an otherwise valid grant when it belongs to a different voyage', () => {
        renderStack({ ...ownerStatus, voyageId: 'voyage-2' });

        expect(screen.getByText(/has not been shared with your crew account/i)).toBeInTheDocument();
        expect(screen.queryByTestId('passage-summary-card')).not.toBeInTheDocument();
        expect(screen.queryByTestId('galley-card')).not.toBeInTheDocument();
        expect(screen.queryByTestId('vessel-profile-card')).not.toBeInTheDocument();
    });
});
