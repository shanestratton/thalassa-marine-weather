import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RadioPositionFix } from '../services/radioPosition';

const mocks = vi.hoisted(() => ({
    vessel: undefined as Record<string, unknown> | undefined,
    activeVesselId: 'radio-test-boat',
    position: null as RadioPositionFix | null,
    isLive: true,
    isFresh: true,
    error: false,
    mobState: { active: null } as Record<string, unknown>,
}));
vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({ settings: { vessel: mocks.vessel }, activeVesselId: mocks.activeVesselId }),
}));
vi.mock('../hooks/useRadioPosition', () => ({
    useRadioPosition: () => ({
        position: mocks.position,
        isLive: mocks.isLive,
        isFresh: mocks.isFresh,
        error: mocks.error,
        acquiring: !mocks.position && !mocks.error,
        requestGpsAccess: vi.fn(),
    }),
}));
vi.mock('../hooks/useGpsHealth', () => ({
    useGpsHealth: () => null,
    gpsHealthMessage: vi.fn(),
    openDeviceSettings: vi.fn(),
}));
vi.mock('../services/MobService', () => ({
    MOB_PRECISE_FIX_ACCURACY_M: 100,
    MobService: { currentState: () => mocks.mobState, subscribe: () => vi.fn() },
}));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { RadioConsolePage } from '../components/vessel/RadioConsolePage';
import { authScopedStorageKey, setAuthIdentityScope } from '../services/authIdentityScope';

const CURRENT_POSITION: RadioPositionFix = {
    latitude: -27.5,
    longitude: 153.5,
    accuracy: 6,
    heading: null,
    speed: 2,
    timestamp: Date.now(),
    source: 'bus',
    sourceLabel: 'Boat GPS',
    isVessel: true,
    receiverKey: 'bus:test-receiver',
};
const MOB_SNAPSHOT = { fixLat: -27.25, fixLon: 153.125, fixAccuracy: 12, activatedAt: Date.UTC(2026, 7, 5, 3, 4) };
function instructions() {
    return within(screen.getByRole('dialog', { name: 'VHF instructions' }));
}
function transcript() {
    return within(screen.getByRole('dialog', { name: 'Voice transcript' }));
}
function readScript(mode?: RegExp, confirmReceiver = true): string {
    if (screen.queryByRole('dialog', { name: 'Voice transcript' })) {
        fireEvent.click(transcript().getByRole('button', { name: 'VHF instructions' }));
    }
    if (mode) fireEvent.click(instructions().getByRole('button', { name: mode }));
    const confirmation = instructions().queryByRole('checkbox', {
        name: 'Confirm position receiver is aboard this vessel',
    });
    if (confirmReceiver && confirmation && !(confirmation as HTMLInputElement).checked) fireEvent.click(confirmation);
    fireEvent.click(instructions().getByRole('button', { name: 'Continue to voice transcript' }));
    return transcript().getByTestId('dsc-transcript').textContent ?? '';
}
describe('RadioConsole emergency transcript honesty', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        setAuthIdentityScope('radio-test-operator');
        mocks.vessel = undefined;
        mocks.activeVesselId = 'radio-test-boat';
        mocks.position = { ...CURRENT_POSITION, timestamp: Date.now() };
        mocks.isLive = true;
        mocks.isFresh = true;
        mocks.error = false;
        mocks.mobState = { active: null };
    });
    afterEach(() => {
        cleanup();
        setAuthIdentityScope(null);
    });

    it('opens instructions first and has an explicit exit from both dialogs', () => {
        render(<RadioConsolePage onBack={vi.fn()} />);
        expect(instructions().getByText(/agreed working channel for your position report/)).toBeVisible();
        expect(screen.queryByTestId('dsc-transcript')).not.toBeInTheDocument();
        fireEvent.click(instructions().getByRole('button', { name: 'Close vhf instructions' }));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /Prepare voice call/ }));
        readScript();
        fireEvent.click(transcript().getByRole('button', { name: 'Close voice transcript' }));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('keeps accessible call selectors in every state and returns transcript mode changes to instructions first', () => {
        const onBack = vi.fn();
        render(<RadioConsolePage onBack={onBack} />);
        expect(screen.getAllByRole('group', { name: 'Call type' })).toHaveLength(1);
        expect(instructions().getByRole('group', { name: 'Call type' })).toBeVisible();
        expect(instructions().getByTestId('radio-instructions-body')).not.toContainElement(
            instructions().getByRole('group', { name: 'Call type' }),
        );
        readScript();
        expect(screen.getAllByRole('group', { name: 'Call type' })).toHaveLength(1);
        expect(transcript().getByRole('button', { name: /Routine Position/i })).toHaveAttribute('aria-pressed', 'true');
        expect(transcript().getByTestId('radio-transcript-body')).not.toContainElement(
            transcript().getByRole('group', { name: 'Call type' }),
        );
        fireEvent.click(transcript().getByRole('button', { name: /Distress Mayday/i }));
        expect(screen.queryByRole('dialog', { name: 'Voice transcript' })).not.toBeInTheDocument();
        expect(screen.queryByTestId('dsc-transcript')).not.toBeInTheDocument();
        expect(instructions().getByRole('button', { name: /Distress Mayday/i })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        expect(instructions().getByText(/MAYDAY is for grave and imminent danger/)).toBeVisible();
        expect(readScript()).toContain('Mayday, Mayday, Mayday');
        fireEvent.click(transcript().getByRole('button', { name: 'Close voice transcript' }));
        expect(screen.getAllByRole('group', { name: 'Call type' })).toHaveLength(1);
        expect(screen.getByRole('button', { name: /Distress Mayday/i })).toHaveAttribute('aria-pressed', 'true');
        fireEvent.click(screen.getByRole('button', { name: /Urgency Pan-Pan/i }));
        expect(instructions().getByRole('button', { name: /Urgency Pan-Pan/i })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        expect(screen.queryByTestId('dsc-transcript')).not.toBeInTheDocument();
        fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /Back/i }));
        expect(onBack).toHaveBeenCalledOnce();
    });

    it('prompts an unset vessel identity in routine, Pan-Pan and Mayday scripts', () => {
        mocks.vessel = { name: 'Not Set', callSign: 'Not configured', mmsi: 'N/A', phoneticName: 'Unset' };
        render(<RadioConsolePage onBack={vi.fn()} />);
        expect(readScript()).toContain('Say your vessel name now');
        const urgency = readScript(/Urgency/i);
        expect(urgency).toContain('Say your vessel name three times now');
        expect(urgency).not.toMatch(/Thalassa|Not Set|N\/A/i);
        const distress = readScript(/Distress/i);
        expect(distress).toContain('Say your vessel name once now');
        expect(distress).toContain('State the number of persons on board');
        expect(distress).not.toMatch(/Thalassa|Not Set/i);
    });

    it('never gates an emergency script on GPS or DSC acknowledgement', () => {
        mocks.position = null;
        mocks.error = true;
        render(<RadioConsolePage onBack={vi.fn()} />);
        const urgency = readScript(/Urgency/i);
        expect(urgency).toContain('Pan-Pan, Pan-Pan, Pan-Pan');
        expect(urgency).toContain('Position unavailable in this app');
        const mayday = readScript(/Distress/i);
        expect(mayday).toContain('Mayday, Mayday, Mayday');
        expect(mayday).toContain('another reliable source, or your last known position and time');
        expect(mayday).toContain('Requesting immediate assistance. Over.');
    });

    it('omits unavailable course while preserving a genuine due-north zero', () => {
        const view = render(<RadioConsolePage onBack={vi.fn()} />);
        expect(readScript()).not.toMatch(/Course\./);
        mocks.position = { ...CURRENT_POSITION, heading: 0, timestamp: Date.now() };
        view.rerender(<RadioConsolePage onBack={vi.fn()} />);
        fireEvent.click(transcript().getByRole('button', { name: 'Update position' }));
        expect(transcript().getByTestId('dsc-transcript')).toHaveTextContent('Course. 0, 0, 0, degrees true');
    });

    it('keeps readback stable until Update position is explicitly selected', () => {
        const view = render(<RadioConsolePage onBack={vi.fn()} />);
        const original = readScript();
        mocks.position = { ...CURRENT_POSITION, latitude: -26, timestamp: Date.now() + 1 };
        view.rerender(<RadioConsolePage onBack={vi.fn()} />);
        expect(transcript().getByTestId('dsc-transcript').textContent).toBe(original);
        fireEvent.click(transcript().getByRole('button', { name: 'Update position' }));
        expect(transcript().getByTestId('dsc-transcript').textContent).not.toBe(original);
        expect(transcript().getByTestId('dsc-transcript')).toHaveTextContent('2, 6, degrees');
    });

    it('announces held boat coordinates as last known, with UTC time and no stale motion', () => {
        mocks.position = { ...CURRENT_POSITION, heading: 90, timestamp: Date.UTC(2026, 7, 5, 3, 4) };
        mocks.isLive = false;
        mocks.isFresh = false;
        mocks.error = true;
        render(<RadioConsolePage onBack={vi.fn()} />);
        expect(instructions().getByTestId('radio-position-status')).toHaveTextContent('Boat GPS · Last known');
        const script = readScript();
        expect(script).toContain('Last known vessel position, recorded at 0, 3, 0, 4, U T C on 2026-08-05');
        expect(script).not.toMatch(/Course\.|Speed over ground/i);
    });

    it('labels a phone as device GPS, not a verified vessel position', () => {
        mocks.position = { ...CURRENT_POSITION, source: 'phone', sourceLabel: 'Phone GPS', isVessel: false };
        render(<RadioConsolePage onBack={vi.fn()} />);
        expect(instructions().getByText(/Confirm this device is aboard/)).toBeVisible();
        expect(readScript()).toContain('Position from this device’s GPS');
    });

    it('allows an unconfirmed receiver to be displayed but not presented as this boat in the call', () => {
        render(<RadioConsolePage onBack={vi.fn()} />);
        expect(instructions().getByTestId('radio-position-status')).toHaveTextContent('27°30.000′S');
        const script = readScript(/Distress/i, false);
        expect(script).toContain('Position not verified for this vessel');
        expect(script).not.toContain('2, 7, degrees');
        expect(script).toContain('Requesting immediate assistance. Over.');
    });

    it('requires a receiver check even when a cloud row matches the selected boat', () => {
        mocks.position = {
            ...CURRENT_POSITION,
            source: 'cloud',
            sourceLabel: 'Boat GPS (via cloud)',
            vesselId: mocks.activeVesselId,
        };
        mocks.isLive = false;
        render(<RadioConsolePage onBack={vi.fn()} />);
        expect(instructions().getByRole('checkbox')).not.toBeChecked();
        expect(readScript(undefined, false)).toContain('Position not verified for this vessel');
        expect(readScript()).toContain('Vessel position, recorded at');
    });

    it('clears receiver confirmation and frozen readback on a selected-boat switch', () => {
        const view = render(<RadioConsolePage onBack={vi.fn()} />);
        expect(readScript()).toContain('2, 7, degrees');
        mocks.activeVesselId = 'another-boat';
        view.rerender(<RadioConsolePage onBack={vi.fn()} />);
        expect(screen.queryByTestId('dsc-transcript')).not.toBeInTheDocument();
        expect(instructions().getByRole('checkbox')).not.toBeChecked();
        expect(readScript(undefined, false)).toContain('Position not verified for this vessel');
    });

    it('does not apply receiver confirmation to a different receiver', () => {
        const view = render(<RadioConsolePage onBack={vi.fn()} />);
        expect(readScript()).toContain('2, 7, degrees');
        mocks.position = { ...CURRENT_POSITION, receiverKey: 'bus:different-gateway' };
        view.rerender(<RadioConsolePage onBack={vi.fn()} />);
        fireEvent.click(transcript().getByRole('button', { name: 'Update position' }));
        expect(instructions().getByRole('checkbox')).not.toBeChecked();
        expect(readScript(undefined, false)).toContain('Position not verified for this vessel');
    });

    it('never manually overrides a fix explicitly bound to another vessel', () => {
        mocks.position = {
            ...CURRENT_POSITION,
            source: 'cloud',
            sourceLabel: 'Boat GPS (via cloud)',
            vesselId: 'wrong-boat',
        };
        render(<RadioConsolePage onBack={vi.fn()} />);
        expect(instructions().queryByRole('checkbox')).not.toBeInTheDocument();
        expect(readScript()).toContain('Position not verified for this vessel');
    });

    it('uses motor-vessel wording for a power boat', () => {
        mocks.vessel = { name: 'Rescue One', type: 'power' };
        render(<RadioConsolePage onBack={vi.fn()} />);
        const script = readScript(/Distress/i);
        expect(script).toContain('This is motor vessel Rescue One');
        expect(script).not.toContain('sailing vessel Rescue One');
    });

    it('preserves a handed-off casualty datum independently of the boat position', () => {
        localStorage.setItem(
            authScopedStorageKey('thalassa_dsc_intent'),
            JSON.stringify({ version: 1, kind: 'distress-mob', snapshot: MOB_SNAPSHOT }),
        );
        render(<RadioConsolePage onBack={vi.fn()} />);
        const datum = screen.getByText(/MOB datum · not current vessel position/).parentElement;
        expect(datum).toHaveTextContent('27°15.000′S 153°07.500′E');
        expect(datum).toHaveTextContent('Marked 03:04:00 UTC');
        const script = readScript();
        expect(script).toContain('Vessel position, recorded at');
        expect(script).toContain('2, 7, degrees. 3, 0, decimal, 0, minutes. South');
        expect(script).toContain('Man Overboard datum. 2, 7, degrees. 1, 5, decimal, 0, minutes. South');
        expect(script).toContain('MOB marked at 0, 3, 0, 4, U T C');
    });

    it('drops the frozen script and MOB handoff on account transition', () => {
        mocks.vessel = { name: 'Previous Owner' };
        localStorage.setItem(
            authScopedStorageKey('thalassa_dsc_intent'),
            JSON.stringify({ version: 1, kind: 'distress-mob', snapshot: MOB_SNAPSHOT }),
        );
        render(<RadioConsolePage onBack={vi.fn()} />);
        expect(readScript()).toContain('Previous Owner');
        mocks.vessel = { name: 'Next Owner' };
        act(() => setAuthIdentityScope('next-radio-operator'));
        expect(screen.queryByTestId('dsc-transcript')).not.toBeInTheDocument();
        const freshScript = readScript();
        expect(freshScript).toContain('Next Owner');
        expect(freshScript).not.toMatch(/Previous Owner|Man Overboard datum/);
    });
});
