/**
 * VesselDetailsStep — Component tests
 *
 * Tests rendering for sail/power/observer vessel types,
 * form field interactions, and next button.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
    VesselDetailsStep,
    roughEstimatedDimensionFields,
    validateVesselDetails,
} from '../components/onboarding/VesselDetailsStep';

// Mock YachtDatabaseSearch
vi.mock('../components/settings/YachtDatabaseSearch', () => ({
    YachtDatabaseSearch: () => <div data-testid="yacht-search">YachtSearch</div>,
}));

function renderStep(overrides: Record<string, unknown> = {}) {
    const defaultProps = {
        vesselType: 'sail' as const,
        onVesselTypeChange: vi.fn(),
        name: 'Test Vessel',
        onNameChange: vi.fn(),
        registration: '',
        onRegistrationChange: vi.fn(),
        mmsi: '',
        onMmsiChange: vi.fn(),
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
        expect(screen.getByPlaceholderText('Required')).toBeTruthy();
        expect(screen.getAllByPlaceholderText('Estimated if blank')).toHaveLength(2);
        expect(screen.getByPlaceholderText('Unknown if blank')).toBeTruthy();
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
        expect(screen.getByText('Needed for bridge-clearance checks; leave blank if you do not know it.')).toBeTruthy();
    });

    it('shows crew count helper text', () => {
        renderStep();
        expect(screen.getByText('Used for provisioning and watch schedules')).toBeTruthy();
    });

    it('blocks continuation and explains required or invalid values', () => {
        renderStep({ name: '', length: '', draft: '-1', mmsi: '123', crewCount: '2.5' });

        expect(screen.getByText('Vessel name is required')).toBeTruthy();
        expect(screen.getByText('Length is required')).toBeTruthy();
        expect(screen.getByText('Draft must be greater than zero')).toBeTruthy();
        expect(screen.getByText('MMSI must contain exactly 9 digits')).toBeTruthy();
        expect(screen.getByText('Crew aboard must be a whole number from 1 to 99')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Continue after vessel details' })).toBeDisabled();
    });

    it('makes rough model-derived dimensions visible and requires review', () => {
        const onAcknowledged = vi.fn();
        renderStep({
            autoFilledDimensions: { length: 'database', beam: 'estimate', draft: 'estimate' },
            estimatedDimensionsAcknowledged: false,
            onEstimatedDimensionsAcknowledgedChange: onAcknowledged,
        });

        expect(screen.getByText('Check the dimensions we filled in')).toBeTruthy();
        expect(screen.getByText('MODEL DATA')).toBeTruthy();
        expect(screen.getAllByText('ROUGH EST.')).toHaveLength(2);
        expect(screen.getByRole('button', { name: 'Continue after vessel details' })).toBeDisabled();

        fireEvent.click(screen.getByRole('checkbox'));
        expect(onAcknowledged).toHaveBeenCalledWith(true);
    });

    it('allows reviewed estimates to continue while retaining their provenance', () => {
        renderStep({
            autoFilledDimensions: { length: 'database', beam: 'estimate', draft: 'estimate' },
            estimatedDimensionsAcknowledged: true,
        });

        expect(screen.getByRole('button', { name: 'Continue after vessel details' })).not.toBeDisabled();
        expect(roughEstimatedDimensionFields({ length: 'database', beam: 'estimate', draft: 'estimate' })).toEqual([
            'beam',
            'draft',
        ]);
    });
});

describe('validateVesselDetails', () => {
    it('accepts unknown optional safety dimensions but rejects non-positive values', () => {
        const base = {
            name: 'Serenity',
            mmsi: '',
            length: '12',
            beam: '',
            draft: '',
            displacement: '',
            airDraft: '',
            fuel: '',
            water: '',
            crewCount: '2',
        };

        expect(validateVesselDetails(base)).toEqual({});
        expect(validateVesselDetails({ ...base, beam: '0' })).toEqual({
            beam: 'Beam must be greater than zero',
        });
    });
});
