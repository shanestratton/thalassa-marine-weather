/**
 * VesselDetailsStep — Component tests
 *
 * Tests rendering for sail/power/observer vessel types,
 * form field interactions, and next button.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VesselDetailsStep } from '../components/onboarding/VesselDetailsStep';

// Mock YachtDatabaseSearch
vi.mock('../components/settings/YachtDatabaseSearch', () => ({
    YachtDatabaseSearch: () => <div data-testid="yacht-search">YachtSearch</div>,
}));

function renderStep(overrides: Record<string, unknown> = {}) {
    const defaultProps = {
        vesselType: 'sail' as const,
        name: 'Test Vessel',
        onNameChange: vi.fn(),
        hullType: 'monohull' as const,
        onHullTypeChange: vi.fn(),
        keelType: 'fin' as const,
        onKeelTypeChange: vi.fn(),
        riggingType: 'Sloop' as const,
        onRiggingTypeChange: vi.fn(),
        length: '40',
        onLengthChange: vi.fn(),
        lengthUnit: 'ft' as const,
        onToggleLengthUnit: vi.fn(),
        beam: '12',
        onBeamChange: vi.fn(),
        beamUnit: 'ft' as const,
        onToggleBeamUnit: vi.fn(),
        draft: '6',
        onDraftChange: vi.fn(),
        draftUnit: 'ft' as const,
        onToggleDraftUnit: vi.fn(),
        displacement: '18000',
        onDisplacementChange: vi.fn(),
        dispUnit: 'lbs' as const,
        onToggleDispUnit: vi.fn(),
        airDraft: '55',
        onAirDraftChange: vi.fn(),
        airDraftUnit: 'ft' as const,
        onToggleAirDraftUnit: vi.fn(),
        fuel: '200',
        onFuelChange: vi.fn(),
        water: '400',
        onWaterChange: vi.fn(),
        volUnit: 'l' as const,
        onToggleVolUnit: vi.fn(),
        crewCount: '2',
        onCrewCountChange: vi.fn(),
        onYachtSelect: vi.fn(),
        keyboardHeight: 0,
        onNext: vi.fn(),
        ...overrides,
    };

    return { ...render(<VesselDetailsStep {...defaultProps} />), props: defaultProps };
}

describe('VesselDetailsStep', () => {
    it('renders vessel name input with current value', () => {
        renderStep({ name: 'Black Pearl' });
        const input = screen.getByPlaceholderText('e.g. Black Pearl') as HTMLInputElement;
        expect(input.value).toBe('Black Pearl');
    });

    it('renders hull type selector with monohull active', () => {
        renderStep({ hullType: 'monohull' });
        const monoBtn = screen.getByText('Mono');
        expect(monoBtn).toBeTruthy();
        expect(screen.getByText('Cat')).toBeTruthy();
        expect(screen.getByText('Tri')).toBeTruthy();
    });

    it('calls onHullTypeChange when hull button clicked', () => {
        const { props } = renderStep();
        fireEvent.click(screen.getByText('Cat'));
        expect(props.onHullTypeChange).toHaveBeenCalledWith('catamaran');
    });

    it('renders keel type grid', () => {
        renderStep();
        // Text is lowercase in DOM, displayed uppercase via CSS
        expect(screen.getByText('fin')).toBeTruthy();
        expect(screen.getByText('full')).toBeTruthy();
        expect(screen.getByText('wing')).toBeTruthy();
        expect(screen.getByText('skeg')).toBeTruthy();
        expect(screen.getByText('C/Board')).toBeTruthy();
        expect(screen.getByText('bilge')).toBeTruthy();
    });

    it('calls onKeelTypeChange when keel button clicked', () => {
        const { props } = renderStep();
        fireEvent.click(screen.getByText('full'));
        expect(props.onKeelTypeChange).toHaveBeenCalledWith('full');
    });

    it('shows rigging type select for sail vessels', () => {
        renderStep({ vesselType: 'sail' });
        // Rigging type label should be present
        expect(screen.getByText('Rigging Type')).toBeTruthy();
    });

    it('hides rigging type for power vessels', () => {
        renderStep({ vesselType: 'power' });
        expect(screen.queryByText('Rigging Type')).toBeNull();
    });

    it('renders dimension fields', () => {
        renderStep();
        // Length field has placeholder '0', others have 'Auto'
        const autoFields = screen.getAllByPlaceholderText('Auto');
        expect(autoFields.length).toBeGreaterThanOrEqual(2);
    });

    it('renders tankage fields', () => {
        renderStep();
        const fuelLabel = screen.getByText('Fuel');
        const waterLabel = screen.getByText('Water');
        expect(fuelLabel).toBeTruthy();
        expect(waterLabel).toBeTruthy();
    });

    it('renders crew count field', () => {
        renderStep();
        expect(screen.getByPlaceholderText('2')).toBeTruthy();
    });

    it('calls onNext when Next button clicked', () => {
        const { props } = renderStep();
        const nextBtn = screen.getByText('Next');
        fireEvent.click(nextBtn);
        expect(props.onNext).toHaveBeenCalledOnce();
    });

    it('renders crew member mode with skip view', () => {
        renderStep({ vesselType: 'observer' });
        expect(screen.getByText('Crew Member Mode')).toBeTruthy();
        expect(screen.getByText('Continue to Preferences')).toBeTruthy();
    });

    it('calls onNext for observer continue button', () => {
        const { props } = renderStep({ vesselType: 'observer' });
        fireEvent.click(screen.getByText('Continue to Preferences'));
        expect(props.onNext).toHaveBeenCalledOnce();
    });

    it('renders yacht database search component', () => {
        renderStep();
        expect(screen.getByTestId('yacht-search')).toBeTruthy();
    });

    it('shows air draft field with helper text', () => {
        renderStep();
        expect(screen.getByPlaceholderText('Height above waterline')).toBeTruthy();
        expect(screen.getByText('Used for bridge clearance on routes')).toBeTruthy();
    });

    it('shows crew count helper text', () => {
        renderStep();
        expect(screen.getByText('Used for provisioning and watch schedules')).toBeTruthy();
    });
});
