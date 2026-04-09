/**
 * ContentModerationService — Unit tests
 *
 * Tests the client-side filter (Layer 1): word pattern matching,
 * spam detection, and clean message passthrough.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }),
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        from: vi.fn().mockReturnValue({
            insert: vi.fn().mockResolvedValue({ data: null, error: null }),
            select: vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
        }),
    },
}));

import { clientFilter } from '../services/ContentModerationService';

// ── clientFilter (Layer 1) ──────────────────────────────────────

describe('clientFilter', () => {
    // ── Clean messages ──

    it('allows normal sailing discussion', () => {
        const result = clientFilter('Heading to the Whitsundays next week, weather looks good!');
        expect(result.blocked).toBe(false);
        expect(result.warning).toBeNull();
    });

    it('allows maritime technical discussion', () => {
        const result = clientFilter('The anchor dragged overnight in 25kt gusts');
        expect(result.blocked).toBe(false);
        expect(result.warning).toBeNull();
    });

    it('allows mild language (sailors talk)', () => {
        const result = clientFilter('Damn, that was a rough crossing');
        expect(result.blocked).toBe(false);
        expect(result.warning).toBeNull();
    });

    it('allows short messages', () => {
        const result = clientFilter('Thanks!');
        expect(result.blocked).toBe(false);
    });

    // ── Hate speech detection ──

    it('blocks racial slurs', () => {
        const result = clientFilter('you stupid n1gger');
        expect(result.blocked).toBe(true);
    });

    it('blocks homophobic slurs', () => {
        const result = clientFilter('what a faggot');
        expect(result.blocked).toBe(true);
    });

    // ── Threat detection ──

    it('blocks death threats', () => {
        const result = clientFilter("I'll kill you");
        expect(result.blocked).toBe(true);
    });

    it('blocks self-harm encouragement', () => {
        const result = clientFilter('kill yourself');
        expect(result.blocked).toBe(true);
    });

    // ── Sexual harassment ──

    it('blocks sexual harassment', () => {
        const result = clientFilter('send me nudes');
        expect(result.blocked).toBe(true);
    });

    // ── Scam/phishing ──

    it('blocks phishing attempts', () => {
        const result = clientFilter('click this link to win free bitcoin');
        expect(result.blocked).toBe(true);
    });

    it('blocks get-rich-quick schemes', () => {
        const result = clientFilter('earn $5000 per day working from home');
        expect(result.blocked).toBe(true);
    });

    // ── Spam patterns ──

    it('warns on excessive caps (> 80%)', () => {
        const result = clientFilter('THIS IS ALL CAPS AND VERY ANNOYING MESSAGE');
        expect(result.warning).not.toBeNull();
        expect(result.blocked).toBe(false);
    });

    it('does not warn on short caps messages', () => {
        const result = clientFilter('OK');
        expect(result.warning).toBeNull();
    });

    it('warns on word repetition (3+ times)', () => {
        const result = clientFilter('hello hello hello hello how are you');
        expect(result.warning).not.toBeNull();
    });

    it('blocks link spam (3+ URLs)', () => {
        const result = clientFilter('Check https://scam1.com and https://scam2.com and https://scam3.com');
        expect(result.blocked).toBe(true);
    });

    it('allows single URL', () => {
        const result = clientFilter('Check out https://example.com for weather');
        expect(result.blocked).toBe(false);
    });

    // ── Return structure ──

    it('returns matchedPattern for blocked content', () => {
        const result = clientFilter("I'll kill you");
        expect(result.blocked).toBe(true);
        expect(result.matchedPattern).toBeTruthy();
    });

    it('returns null matchedPattern for clean content', () => {
        const result = clientFilter('Nice anchorage at Whitehaven Beach');
        expect(result.matchedPattern).toBeUndefined();
    });
});
