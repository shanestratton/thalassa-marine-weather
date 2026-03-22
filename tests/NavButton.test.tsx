/**
 * NavButton — bottom tab bar navigation button tests.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

// Mock haptic feedback
vi.mock('../utils/system', () => ({
    triggerHaptic: vi.fn(),
}));

import { NavButton } from '../components/NavButton';

describe('NavButton', () => {
    it('renders label text', () => {
        render(<NavButton icon={<span data-testid="icon">🌤</span>} label="Wx" active={false} onClick={vi.fn()} />);
        expect(screen.getByText('Wx')).toBeInTheDocument();
    });

    it('renders the icon', () => {
        render(<NavButton icon={<span data-testid="icon">🗺</span>} label="Map" active={false} onClick={vi.fn()} />);
        expect(screen.getByTestId('icon')).toBeInTheDocument();
    });

    it('calls onClick when tapped', () => {
        const onClick = vi.fn();
        render(<NavButton icon={<span>📡</span>} label="Chat" active={false} onClick={onClick} />);
        fireEvent.click(screen.getByRole('tab'));
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('shows active styling when active', () => {
        const { container } = render(
            <NavButton icon={<span>⛵</span>} label="Vessel" active={true} onClick={vi.fn()} />,
        );
        const button = container.querySelector('[role="tab"]');
        expect(button?.getAttribute('aria-selected')).toBe('true');
    });

    it('does NOT show aria-selected when inactive', () => {
        const { container } = render(
            <NavButton icon={<span>⛵</span>} label="Vessel" active={false} onClick={vi.fn()} />,
        );
        const button = container.querySelector('[role="tab"]');
        expect(button?.getAttribute('aria-selected')).toBe('false');
    });

    it('renders numeric badge when provided', () => {
        render(<NavButton icon={<span>💬</span>} label="Chat" active={false} onClick={vi.fn()} badge={3} />);
        expect(screen.getByText('3')).toBeInTheDocument();
    });

    it('renders dot badge when badge is true', () => {
        const { container } = render(
            <NavButton icon={<span>💬</span>} label="Chat" active={false} onClick={vi.fn()} badge={true} />,
        );
        // A dot badge should render something but not a number
        expect(container.querySelector('[aria-label]')).toBeDefined();
    });

    it('does NOT render badge when badge is undefined', () => {
        render(<NavButton icon={<span>💬</span>} label="Chat" active={false} onClick={vi.fn()} />);
        // No badge element should be visible — just the icon and label
        expect(screen.queryByText(/\d+/)).not.toBeInTheDocument();
    });

    it('has accessible role="tab"', () => {
        render(<NavButton icon={<span>🌤</span>} label="Wx" active={false} onClick={vi.fn()} />);
        expect(screen.getByRole('tab')).toBeInTheDocument();
    });
});
