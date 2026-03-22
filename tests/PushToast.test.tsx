/**
 * PushToast — Component tests.
 */
import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@capacitor/push-notifications', () => ({
    PushNotifications: {
        addListener: vi.fn(() => ({ remove: vi.fn() })),
        register: vi.fn(),
        removeAllListeners: vi.fn(),
    },
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' },
}));

vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));

import { PushToast } from '../components/PushToast';

describe('PushToast', () => {
    beforeEach(() => vi.clearAllMocks());

    it('renders without crashing', () => {
        const { container } = render(<PushToast onTap={vi.fn()} />);
        expect(container).toBeDefined();
    });

    it('does not show toast initially', () => {
        const { container } = render(<PushToast onTap={vi.fn()} />);
        // No visible toast when no push received
        expect(container.textContent).toBe('');
    });

    it('does not throw on rerender', () => {
        expect(() => {
            const { rerender } = render(<PushToast onTap={vi.fn()} />);
            rerender(<PushToast onTap={vi.fn()} />);
        }).not.toThrow();
    });
});
