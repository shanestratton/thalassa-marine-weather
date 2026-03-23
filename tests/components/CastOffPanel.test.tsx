/**
 * CastOffPanel — smoke tests (595 LOC component)
 */
import React from 'react';
import { render } from '@testing-library/react';
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

    it('renders without crashing', () => {
        const { container } = render(<CastOffPanel onClose={vi.fn()} />);
        expect(container).toBeDefined();
    });

    it('renders content', () => {
        const { container } = render(<CastOffPanel onClose={vi.fn()} />);
        expect(container.innerHTML.length).toBeGreaterThan(0);
    });
});
