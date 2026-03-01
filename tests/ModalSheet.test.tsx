/**
 * Tests for ModalSheet shared component
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModalSheet } from '../components/ui/ModalSheet';

describe('ModalSheet', () => {
    it('renders nothing when isOpen is false', () => {
        const { container } = render(
            <ModalSheet isOpen={false} onClose={() => { }}>
                <p>Content</p>
            </ModalSheet>
        );
        expect(container.innerHTML).toBe('');
    });

    it('renders children when isOpen is true', () => {
        render(
            <ModalSheet isOpen={true} onClose={() => { }}>
                <p>Test Content</p>
            </ModalSheet>
        );
        expect(screen.getByText('Test Content')).toBeInTheDocument();
    });

    it('renders title when provided', () => {
        render(
            <ModalSheet isOpen={true} onClose={() => { }} title="My Modal">
                <p>Content</p>
            </ModalSheet>
        );
        expect(screen.getByText('My Modal')).toBeInTheDocument();
    });

    it('calls onClose when backdrop is clicked', () => {
        const onClose = vi.fn();
        render(
            <ModalSheet isOpen={true} onClose={onClose}>
                <p>Content</p>
            </ModalSheet>
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
            </ModalSheet>
        );
        const closeBtn = screen.getByLabelText('Close');
        fireEvent.click(closeBtn);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('does NOT call onClose when content panel is clicked', () => {
        const onClose = vi.fn();
        render(
            <ModalSheet isOpen={true} onClose={onClose}>
                <p>Content</p>
            </ModalSheet>
        );
        fireEvent.click(screen.getByText('Content'));
        expect(onClose).not.toHaveBeenCalled();
    });
});
