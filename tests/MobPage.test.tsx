import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    activate: vi.fn(),
    currentState: vi.fn(),
    subscribe: vi.fn(),
}));

vi.mock('../services/MobService', () => ({
    MobService: {
        activate: (...args: unknown[]) => mocks.activate(...args),
        currentState: () => mocks.currentState(),
        subscribe: (...args: unknown[]) => mocks.subscribe(...args),
        clear: vi.fn(),
    },
}));

vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({
        settings: { vessel: { name: 'Test Vessel' } },
    }),
}));

vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../services/voice/safetyTts', () => ({
    speakSafetyMessage: vi.fn(),
}));

import { MobPage } from '../components/vessel/MobPage';

describe('MobPage activation feedback', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.currentState.mockReturnValue({ active: null, currentPosition: null, distanceM: null, bearingDeg: null });
        mocks.subscribe.mockReturnValue(vi.fn());
        mocks.activate.mockResolvedValue(null);
    });

    it('fails visibly and non-modally when no fresh GPS fix is available', async () => {
        const browserAlert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
        render(<MobPage onBack={vi.fn()} />);

        fireEvent.click(screen.getByRole('button', { name: 'Activate Man Overboard' }));

        expect(await screen.findByRole('alert')).toHaveTextContent('no fresh GPS fix is available');
        expect(browserAlert).not.toHaveBeenCalled();
        browserAlert.mockRestore();
    });

    it('locks duplicate activation while the emergency GPS request is pending', async () => {
        let resolveActivation!: (value: null) => void;
        mocks.activate.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveActivation = resolve;
            }),
        );
        render(<MobPage onBack={vi.fn()} />);

        const button = screen.getByRole('button', { name: 'Activate Man Overboard' });
        fireEvent.click(button);
        fireEvent.click(button);
        expect(mocks.activate).toHaveBeenCalledTimes(1);
        expect(button).toBeDisabled();

        resolveActivation(null);
        await waitFor(() => expect(button).toBeEnabled());
    });
});
