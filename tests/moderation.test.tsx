/**
 * ContentModerationService Tests
 *
 * Tests the client-side filter (Layer 1) — a pure function with no side effects.
 * This is the most impactful moderation layer to test since it runs on every message.
 *
 * Also tests ChatErrorBoundary rendering and retry behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { clientFilter } from '../services/ContentModerationService';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { ChatErrorBoundary } from '../components/chat/ChatErrorBoundary';

// ═══════════════════════════════════════

describe('clientFilter — Layer 1 Content Moderation', () => {
    describe('clean messages (should pass)', () => {
        const cleanMessages = [
            'Great anchorage at the north end!',
            'Anyone headed to Fiji this season?',
            'Wind forecast looks gnarly tomorrow',
            'Damn, that sunset was beautiful',
            'Hell of a passage, 3 days non-stop',
            'My bloody windlass broke again',
            'Looking for crew from Cairns to PNG',
            'What VHF channel for port operations?',
            'Fair winds and following seas ⛵',
            'https://example.com check this anchorage guide',
        ];

        cleanMessages.forEach((msg) => {
            it(`passes: "${msg.substring(0, 40)}..."`, () => {
                const result = clientFilter(msg);
                expect(result.blocked).toBe(false);
                expect(result.warning).toBeNull();
            });
        });
    });

    describe('blocked messages (hate speech, threats)', () => {
        it('blocks racial slurs', () => {
            const result = clientFilter('you stupid n1gger');
            expect(result.blocked).toBe(true);
            expect(result.warning).toBeTruthy();
        });

        it('blocks homophobic slurs', () => {
            const result = clientFilter('what a faggot');
            expect(result.blocked).toBe(true);
        });

        it('blocks violent threats', () => {
            const result = clientFilter("I'll kill your family");
            expect(result.blocked).toBe(true);
        });

        it('blocks sexual harassment', () => {
            const result = clientFilter('send me nudes');
            expect(result.blocked).toBe(true);
        });

        it('blocks phishing/scam attempts', () => {
            const result = clientFilter('click this link and earn $500 per day');
            expect(result.blocked).toBe(true);
        });

        it('blocks link spam (3+ URLs)', () => {
            const result = clientFilter(
                'check https://a.com and https://b.com and https://c.com'
            );
            expect(result.blocked).toBe(true);
            expect(result.warning).toContain('link');
        });
    });

    describe('warning messages (spam patterns — not blocked)', () => {
        it('warns on excessive caps', () => {
            const result = clientFilter('THIS IS ALL CAPS AND VERY LOUD SHOUTING');
            expect(result.blocked).toBe(false);
            expect(result.warning).toBeTruthy();
            expect(result.warning).toContain('caps');
        });

        it('does not warn on short caps (< 8 chars)', () => {
            const result = clientFilter('OK FINE');
            expect(result.warning).toBeNull();
        });
    });

    describe('edge cases', () => {
        it('handles empty string', () => {
            const result = clientFilter('');
            expect(result.blocked).toBe(false);
            expect(result.warning).toBeNull();
        });

        it('handles very long clean text', () => {
            const longText = 'sailing '.repeat(500);
            const result = clientFilter(longText);
            expect(result.blocked).toBe(false);
        });

        it('handles unicode/emoji messages', () => {
            const result = clientFilter('⛵🌊 Great day on the water! 🐠🎣');
            expect(result.blocked).toBe(false);
            expect(result.warning).toBeNull();
        });

        it('handles 2 URLs without blocking (threshold is 3)', () => {
            const result = clientFilter('check https://a.com and https://b.com');
            expect(result.blocked).toBe(false);
        });
    });
});

// ═══════════════════════════════════════

describe('ChatErrorBoundary', () => {
    // Suppress console.error for error boundary tests
    const originalError = console.error;
    beforeEach(() => { console.error = vi.fn(); });
    afterEach(() => { console.error = originalError; });

    const ThrowError: React.FC<{ shouldThrow: boolean }> = ({ shouldThrow }) => {
        if (shouldThrow) throw new Error('Test crash');
        return <div>Child content </div>;
    };

    it('renders children when no error', () => {
        render(
            <ChatErrorBoundary>
            <div>Healthy content </div>
        </ChatErrorBoundary>
        );
        expect(screen.getByText('Healthy content')).toBeTruthy();
    });

    it('shows error UI when child throws', () => {
        render(
            <ChatErrorBoundary>
            <ThrowError shouldThrow={ true} />
        </ChatErrorBoundary>
        );
        expect(screen.getByText('Man overboard!')).toBeTruthy();
        expect(screen.getByText('Test crash')).toBeTruthy();
        expect(screen.getByLabelText('Try again')).toBeTruthy();
    });

    it('shows friendly recovery message', () => {
        render(
            <ChatErrorBoundary>
            <ThrowError shouldThrow={ true} />
        </ChatErrorBoundary>
        );
        expect(screen.getByText(/something went wrong/i)).toBeTruthy();
        expect(screen.getByText(/messages are safe/i)).toBeTruthy();
    });

    it('retry button has correct aria label', () => {
        render(
            <ChatErrorBoundary>
            <ThrowError shouldThrow={ true} />
        </ChatErrorBoundary>
        );
        const retryBtn = screen.getByLabelText('Try again');
        expect(retryBtn).toBeTruthy();
    });
});

// ═══════════════════════════════════════

import { afterEach } from 'vitest';
