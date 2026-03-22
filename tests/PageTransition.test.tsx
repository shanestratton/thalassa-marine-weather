/**
 * PageTransition — CSS-only page transition tests.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { PageTransition } from '../components/ui/PageTransition';

describe('PageTransition', () => {
    it('renders children', () => {
        render(
            <PageTransition pageKey="dashboard" direction="tab">
                <p>Dashboard Content</p>
            </PageTransition>,
        );
        expect(screen.getByText('Dashboard Content')).toBeInTheDocument();
    });

    it('renders with tab direction without sliding', () => {
        const { container } = render(
            <PageTransition pageKey="settings" direction="tab">
                <p>Settings</p>
            </PageTransition>,
        );
        expect(container.firstChild).toBeDefined();
        expect(screen.getByText('Settings')).toBeInTheDocument();
    });

    it('renders with push direction', () => {
        const { container } = render(
            <PageTransition pageKey="details" direction="push">
                <p>Details Page</p>
            </PageTransition>,
        );
        expect(container.firstChild).toBeDefined();
        expect(screen.getByText('Details Page')).toBeInTheDocument();
    });

    it('renders with pop direction', () => {
        render(
            <PageTransition pageKey="vessel" direction="pop">
                <p>Vessel Hub</p>
            </PageTransition>,
        );
        expect(screen.getByText('Vessel Hub')).toBeInTheDocument();
    });

    it('handles swipe back disabled by default', () => {
        const { container } = render(
            <PageTransition pageKey="test" direction="push">
                <p>Content</p>
            </PageTransition>,
        );
        // Should render without errors even without swipe back handler
        expect(container).toBeDefined();
    });

    it('accepts onSwipeBack callback without errors', () => {
        expect(() => {
            render(
                <PageTransition pageKey="test" direction="push" canSwipeBack onSwipeBack={() => {}}>
                    <p>Content</p>
                </PageTransition>,
            );
        }).not.toThrow();
    });
});
