/**
 * ChildCard — component tests
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ChildCard } from '../components/chat/ChildCard';

describe('ChildCard', () => {
    const defaultProps = {
        icon: '🍴',
        title: "Ship's Galley",
        subtitle: 'Meals & Stores',
        color: 'amber',
        isOpen: false,
        onToggle: vi.fn(),
        children: <div data-testid="child-content">Content here</div>,
    };

    it('renders collapsed state with title and subtitle', () => {
        render(<ChildCard {...defaultProps} />);
        expect(screen.getByText("Ship's Galley")).toBeDefined();
        expect(screen.getByText('Meals & Stores')).toBeDefined();
    });

    it('sets aria-expanded=false when collapsed', () => {
        render(<ChildCard {...defaultProps} />);
        const button = screen.getByRole('button', { name: /Ship's Galley/ });
        expect(button.getAttribute('aria-expanded')).toBe('false');
    });

    it('sets aria-expanded=true when open', () => {
        render(<ChildCard {...defaultProps} isOpen={true} />);
        const button = screen.getByRole('button', { name: "Ship's Galley — Meals & Stores" });
        expect(button.getAttribute('aria-expanded')).toBe('true');
    });

    it('calls onToggle when tapped', () => {
        const onToggle = vi.fn();
        render(<ChildCard {...defaultProps} onToggle={onToggle} />);
        fireEvent.click(screen.getByRole('button', { name: /Ship's Galley/ }));
        expect(onToggle).toHaveBeenCalledTimes(1);
    });

    it('renders children via portal when open', () => {
        render(<ChildCard {...defaultProps} isOpen={true} />);
        expect(screen.getByTestId('child-content')).toBeDefined();
    });

    it('does not render children when collapsed', () => {
        render(<ChildCard {...defaultProps} isOpen={false} />);
        expect(screen.queryByTestId('child-content')).toBeNull();
    });

    it('renders back button in full-screen overlay', () => {
        render(<ChildCard {...defaultProps} isOpen={true} />);
        expect(
            screen.getByRole('button', { name: "Close Ship's Galley and return to passage planning" }),
        ).toBeDefined();
    });

    it('exposes the full-screen detail as a labelled modal dialog', () => {
        render(<ChildCard {...defaultProps} isOpen={true} />);

        const dialog = screen.getByRole('dialog', { name: "Ship's Galley" });
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
        const portal = dialog.closest<HTMLElement>('[data-overlay-layer="modal"]');
        expect(portal?.parentElement).toBe(document.body);
        expect(portal).toHaveStyle({ zIndex: '1100' });
    });

    it('focuses the close action and restores the opener after Escape', () => {
        const Harness = () => {
            const [isOpen, setIsOpen] = React.useState(false);
            return <ChildCard {...defaultProps} isOpen={isOpen} onToggle={() => setIsOpen((open) => !open)} />;
        };

        render(<Harness />);
        const opener = screen.getByRole('button', { name: "Ship's Galley — Meals & Stores" });
        opener.focus();
        fireEvent.click(opener);

        const closeButton = screen.getByRole('button', {
            name: "Close Ship's Galley and return to passage planning",
        });
        expect(document.activeElement).toBe(closeButton);

        fireEvent.keyDown(closeButton, { key: 'Escape' });
        expect(screen.queryByRole('dialog', { name: "Ship's Galley" })).toBeNull();
        expect(document.activeElement).toBe(opener);
    });

    it('applies correct color theme', () => {
        render(<ChildCard {...defaultProps} color="sky" isOpen={false} />);
        const button = screen.getByRole('button', { name: /Ship's Galley/ });
        expect(button.className).toContain('border-white');
    });
});
