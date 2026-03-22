/**
 * PullToRefresh — pull-down gesture to trigger data refresh.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { PullToRefresh } from '../components/PullToRefresh';

describe('PullToRefresh', () => {
    it('renders children', () => {
        render(
            <PullToRefresh onRefresh={vi.fn()}>
                <p>Dashboard Content</p>
            </PullToRefresh>,
        );
        expect(screen.getByText('Dashboard Content')).toBeInTheDocument();
    });

    it('has the app-scroll-container id', () => {
        const { container } = render(
            <PullToRefresh onRefresh={vi.fn()}>
                <p>Content</p>
            </PullToRefresh>,
        );
        expect(container.querySelector('#app-scroll-container')).toBeInTheDocument();
    });

    it('does not show spinner initially', () => {
        const { container } = render(
            <PullToRefresh onRefresh={vi.fn()}>
                <p>Content</p>
            </PullToRefresh>,
        );
        expect(container.querySelector('.animate-spin')).toBeNull();
    });

    it('does not respond to touch when disabled', () => {
        const onRefresh = vi.fn();
        const { container } = render(
            <PullToRefresh onRefresh={onRefresh} disabled>
                <p>Content</p>
            </PullToRefresh>,
        );
        const el = container.querySelector('#app-scroll-container')!;

        fireEvent.touchStart(el, { touches: [{ clientY: 0 }] });
        fireEvent.touchMove(el, { touches: [{ clientY: 250 }] });
        fireEvent.touchEnd(el);

        expect(onRefresh).not.toHaveBeenCalled();
    });

    it('renders with min-h-[101%] when not disabled', () => {
        const { container } = render(
            <PullToRefresh onRefresh={vi.fn()}>
                <p>Content</p>
            </PullToRefresh>,
        );
        const inner = container.querySelector('.min-h-\\[101\\%\\]');
        expect(inner).toBeInTheDocument();
    });

    it('renders with h-full class when disabled', () => {
        const { container } = render(
            <PullToRefresh onRefresh={vi.fn()} disabled>
                <p>Content</p>
            </PullToRefresh>,
        );
        const inner = container.querySelector('.h-full');
        expect(inner).toBeInTheDocument();
    });
});
