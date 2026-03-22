/**
 * ContentModerationService — Unit tests for client-side content filter
 *
 * Tests: blocked patterns (slurs, threats, phishing), spam detection
 * (excessive caps, char repetition, word repetition, link spam), and clean text passthrough.
 */

import { describe, it, expect } from 'vitest';
import { clientFilter } from '../services/ContentModerationService';

// ── Clean Text (should pass) ──

describe('clientFilter — clean text', () => {
    it('allows normal sailing conversation', () => {
        const result = clientFilter('The anchorage at Whitehaven is beautiful this time of year');
        expect(result.blocked).toBe(false);
        expect(result.warning).toBeNull();
    });

    it('allows mild maritime language', () => {
        const result = clientFilter('Damn, the wind picked up fast. What a bloody beautiful sail!');
        expect(result.blocked).toBe(false);
        expect(result.warning).toBeNull();
    });

    it('allows technical weather discussion', () => {
        const result = clientFilter('NW swell 2.5m at 12s, gust to 35kts expected after frontal passage');
        expect(result.blocked).toBe(false);
        expect(result.warning).toBeNull();
    });

    it('allows empty string', () => {
        const result = clientFilter('');
        expect(result.blocked).toBe(false);
        expect(result.warning).toBeNull();
    });

    it('allows single word', () => {
        const result = clientFilter('Hello');
        expect(result.blocked).toBe(false);
        expect(result.warning).toBeNull();
    });

    it('allows URLs (under 3)', () => {
        const result = clientFilter('Check out https://example.com for the weather forecast');
        expect(result.blocked).toBe(false);
        expect(result.warning).toBeNull();
    });
});

// ── Blocked Patterns (hate speech, threats, phishing) ──

describe('clientFilter — blocked patterns', () => {
    it('blocks racial slurs', () => {
        const result = clientFilter('you are a n1gger');
        expect(result.blocked).toBe(true);
        expect(result.warning).toBeTruthy();
    });

    it('blocks homophobic slurs', () => {
        const result = clientFilter('shut up faggot');
        expect(result.blocked).toBe(true);
        expect(result.warning).toBeTruthy();
    });

    it('blocks violent threats', () => {
        const result = clientFilter("I'm going to kill you");
        expect(result.blocked).toBe(true);
        expect(result.warning).toBeTruthy();
    });

    it('blocks self-harm related threats', () => {
        const result = clientFilter('kill yourself');
        expect(result.blocked).toBe(true);
        expect(result.warning).toBeTruthy();
    });

    it('blocks phishing attempts', () => {
        const result = clientFilter('click this link for free bitcoin');
        expect(result.blocked).toBe(true);
        expect(result.warning).toBeTruthy();
    });

    it('blocks scam patterns', () => {
        const result = clientFilter('earn $500 per day working from home');
        expect(result.blocked).toBe(true);
        expect(result.warning).toBeTruthy();
    });

    it('blocks sexual harassment', () => {
        const result = clientFilter('send me nudes');
        expect(result.blocked).toBe(true);
        expect(result.warning).toBeTruthy();
    });

    it('catches l33t speak evasion', () => {
        const result = clientFilter('you r3tard');
        expect(result.blocked).toBe(true);
        expect(result.warning).toBeTruthy();
    });
});

// ── Spam Detection ──

describe('clientFilter — spam detection', () => {
    it('warns on excessive caps (>80% uppercase)', () => {
        const result = clientFilter('THIS IS ALL CAPS AND VERY ANNOYING MESSAGE');
        expect(result.blocked).toBe(false);
        expect(result.warning).toBeTruthy();
        expect(result.warning).toContain('caps');
    });

    it('does NOT warn on short caps (under 8 chars)', () => {
        const result = clientFilter('HELP');
        expect(result.blocked).toBe(false);
        expect(result.warning).toBeNull();
    });

    it('blocks link spam (3+ URLs)', () => {
        const result = clientFilter('Check https://spam1.com and https://spam2.com and https://spam3.com');
        expect(result.blocked).toBe(true);
        expect(result.warning).toBeTruthy();
        expect(result.warning).toContain('link');
    });

    it('allows 2 URLs (under threshold)', () => {
        const result = clientFilter('See https://a.com and https://b.com for details');
        expect(result.blocked).toBe(false);
        expect(result.warning).toBeNull();
    });
});

// ── Return shape ──

describe('clientFilter — return shape', () => {
    it('has correct shape for clean text', () => {
        const result = clientFilter('Hello sailor');
        expect(result).toEqual({
            blocked: false,
            warning: null,
        });
    });

    it('has correct shape for blocked text', () => {
        const result = clientFilter('send nudes');
        expect(result.blocked).toBe(true);
        expect(typeof result.warning).toBe('string');
        expect(typeof result.matchedPattern).toBe('string');
    });
});
