/**
 * CastOffPanel — smoke tests (595 LOC component)
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../utils/system', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../../context/SettingsContext', () => ({
    useSettings: () => ({
        settings: { vesselName: 'Test Vessel', vesselType: 'sailboat' },
        updateSettings: vi.fn(),
    }),
}));
vi.mock('../../components/ui/SlideToAction', () => ({
    SlideToAction: ({ children }: { children: React.ReactNode }) => <div data-testid="slide-to-action">{children}</div>,
}));
vi.mock('../../components/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CastOffPanel } from '../../components/vessel/CastOffPanel';

describe('CastOffPanel', () => {
    beforeEach(() => vi.clearAllMocks());

    const renderSettled = async () => {
        const result = render(<CastOffPanel onClose={vi.fn()} />);
        await screen.findByText('No draft voyages yet');
        return result;
    };

    it('renders without crashing', async () => {
        const { container } = await renderSettled();
        expect(container).toBeDefined();
    });

    it('renders content', async () => {
        const { container } = await renderSettled();
        expect(container.innerHTML.length).toBeGreaterThan(0);
    });
});
