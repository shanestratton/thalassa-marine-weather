import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PaywallGate } from '../components/PaywallGate';
import { PUBLIC_BETA_ACCESS } from '../services/SubscriptionService';

describe('free public beta access contract', () => {
    it('renders a paid-route child for a free-tier account without opening the upgrade flow', () => {
        const onUpgrade = vi.fn();

        render(
            <PaywallGate feature="routePlanner" onUpgrade={onUpgrade}>
                <p>Route planning is available</p>
            </PaywallGate>,
        );

        expect(PUBLIC_BETA_ACCESS.enabled).toBe(true);
        expect(screen.getByText('Route planning is available')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /upgrade|unlock/i })).not.toBeInTheDocument();
        expect(onUpgrade).not.toHaveBeenCalled();
    });
});
