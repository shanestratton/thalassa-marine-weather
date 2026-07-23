/**
 * Tests for ModalSheet shared component
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModalSheet } from '../components/ui/ModalSheet';

describe('ModalSheet', () => {
    it('renders nothing when isOpen is false', () => {
        const { container } = render(
            <ModalSheet isOpen={false} onClose={() => {}}>
                <p>Content</p>
            </ModalSheet>,
        );
        expect(container.innerHTML).toBe('');
    });

    it('renders children when isOpen is true', () => {
        render(
            <ModalSheet isOpen={true} onClose={() => {}}>
                <p>Test Content</p>
            </ModalSheet>,
        );
        expect(screen.getByText('Test Content')).toBeInTheDocument();
    });

    it('renders title when provided', () => {
        render(
            <ModalSheet isOpen={true} onClose={() => {}} title="My Modal">
                <p>Content</p>
            </ModalSheet>,
        );
        expect(screen.getByText('My Modal')).toBeInTheDocument();
    });

    it('calls onClose when backdrop is clicked', () => {
        const onClose = vi.fn();
        render(
            <ModalSheet isOpen={true} onClose={onClose}>
                <p>Content</p>
            </ModalSheet>,
        );
        // Click the outer container (backdrop)
        const backdrop = screen.getByText('Content').closest('[class*="fixed"]');
        if (backdrop) fireEvent.click(backdrop);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('calls onClose when close button is clicked', () => {
        const onClose = vi.fn();
        render(
            <ModalSheet isOpen={true} onClose={onClose}>
                <p>Content</p>
            </ModalSheet>,
        );
        const closeBtn = screen.getByLabelText('Close modal');
        fireEvent.click(closeBtn);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('does NOT call onClose when content panel is clicked', () => {
        const onClose = vi.fn();
        render(
            <ModalSheet isOpen={true} onClose={onClose}>
                <p>Content</p>
            </ModalSheet>,
        );
        fireEvent.click(screen.getByText('Content'));
        expect(onClose).not.toHaveBeenCalled();
    });

    it('contains keyboard focus, closes on Escape, and restores the opener', () => {
        const onClose = vi.fn();
        const { rerender } = render(
            <>
                <button>Open modal</button>
                <ModalSheet isOpen={false} onClose={onClose}>
                    <button>Last action</button>
                </ModalSheet>
            </>,
        );
        const opener = screen.getByRole('button', { name: 'Open modal' });
        opener.focus();

        rerender(
            <>
                <button>Open modal</button>
                <ModalSheet isOpen onClose={onClose}>
                    <button>Last action</button>
                </ModalSheet>
            </>,
        );
        const close = screen.getByRole('button', { name: 'Close modal' });
        const last = screen.getByRole('button', { name: 'Last action' });
        expect(close).toHaveFocus();

        close.focus();
        fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
        expect(last).toHaveFocus();
        fireEvent.keyDown(last, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledOnce();

        rerender(
            <>
                <button>Open modal</button>
                <ModalSheet isOpen={false} onClose={onClose}>
                    <button>Last action</button>
                </ModalSheet>
            </>,
        );
        expect(opener).toHaveFocus();
    });
});
