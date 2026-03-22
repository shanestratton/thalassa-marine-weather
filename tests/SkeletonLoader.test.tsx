/**
 * SkeletonLoader — loading placeholder UI tests.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

// Mock the Icons module
vi.mock('../components/Icons', () => ({
    WindIcon: (props: any) => <svg data-testid="wind-icon" {...props} />,
}));

import { SkeletonDashboard } from '../components/SkeletonLoader';

describe('SkeletonDashboard', () => {
    it('renders without crashing', () => {
        const { container } = render(<SkeletonDashboard />);
        expect(container).toBeDefined();
    });

    it('displays loading message', () => {
        render(<SkeletonDashboard />);
        expect(screen.getByText('Loading Marine Data...')).toBeInTheDocument();
    });

    it('displays content type hint', () => {
        render(<SkeletonDashboard />);
        expect(screen.getByText('Weather · Tides · Sea State')).toBeInTheDocument();
    });

    it('renders animated pulse elements', () => {
        const { container } = render(<SkeletonDashboard />);
        const pulseElements = container.querySelectorAll('.animate-pulse');
        expect(pulseElements.length).toBeGreaterThan(0);
    });

    it('renders the wind icon', () => {
        render(<SkeletonDashboard />);
        expect(screen.getByTestId('wind-icon')).toBeInTheDocument();
    });

    it('renders skeleton grid placeholders', () => {
        const { container } = render(<SkeletonDashboard />);
        // Should have multiple skeleton card placeholders
        const cards = container.querySelectorAll('.rounded-2xl');
        expect(cards.length).toBeGreaterThan(2);
    });
});
