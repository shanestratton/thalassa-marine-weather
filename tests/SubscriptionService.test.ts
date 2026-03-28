/**
 * SubscriptionService — Unit tests for the three-tier feature gate system.
 */
import { describe, it, expect } from 'vitest';
import {
    canAccess,
    requiredTier,
    tierLabel,
    isExpired,
    effectiveTier,
    tierIsPro,
    TIER_INFO,
} from '../services/SubscriptionService';

describe('SubscriptionService', () => {
    // ── Tier Info ──

    describe('TIER_INFO', () => {
        it('has correct pricing for all tiers', () => {
            expect(TIER_INFO.free.priceAnnual).toBe(0);
            expect(TIER_INFO.crew.priceAnnual).toBe(49.95);
            expect(TIER_INFO.owner.priceAnnual).toBe(79.95);
        });

        it('has labels for all tiers', () => {
            expect(TIER_INFO.free.label).toBe('Crew (Free)');
            expect(TIER_INFO.crew.label).toBe('Crew');
            expect(TIER_INFO.owner.label).toBe('Vessel Owner');
        });
    });

    // ── canAccess ──

    describe('canAccess', () => {
        it('free tier can access nothing gated', () => {
            expect(canAccess('free', 'routePlanner')).toBe(false);
            expect(canAccess('free', 'weatherFull')).toBe(false);
            expect(canAccess('free', 'gpsTracking')).toBe(false);
            expect(canAccess('free', 'shipLog')).toBe(false);
        });

        it('crew tier can access crew-level features', () => {
            expect(canAccess('crew', 'weatherFull')).toBe(true);
            expect(canAccess('crew', 'gpsTracking')).toBe(true);
            expect(canAccess('crew', 'crewTalkWrite')).toBe(true);
            expect(canAccess('crew', 'directMessages')).toBe(true);
            expect(canAccess('crew', 'aiAdvice')).toBe(true);
            expect(canAccess('crew', 'anchorWatch')).toBe(true);
            expect(canAccess('crew', 'shipLogRead')).toBe(true);
        });

        it('crew tier cannot access owner-level features', () => {
            expect(canAccess('crew', 'routePlanner')).toBe(false);
            expect(canAccess('crew', 'passagePlanning')).toBe(false);
            expect(canAccess('crew', 'passageLegs')).toBe(false);
            expect(canAccess('crew', 'shipLog')).toBe(false);
            expect(canAccess('crew', 'vesselProfile')).toBe(false);
            expect(canAccess('crew', 'galley')).toBe(false);
            expect(canAccess('crew', 'crewFinderCaptain')).toBe(false);
            expect(canAccess('crew', 'polars')).toBe(false);
        });

        it('owner tier can access everything', () => {
            expect(canAccess('owner', 'routePlanner')).toBe(true);
            expect(canAccess('owner', 'passagePlanning')).toBe(true);
            expect(canAccess('owner', 'passageLegs')).toBe(true);
            expect(canAccess('owner', 'shipLog')).toBe(true);
            expect(canAccess('owner', 'vesselProfile')).toBe(true);
            expect(canAccess('owner', 'galley')).toBe(true);
            expect(canAccess('owner', 'crewFinderCaptain')).toBe(true);
            expect(canAccess('owner', 'polars')).toBe(true);
            expect(canAccess('owner', 'weatherFull')).toBe(true);
            expect(canAccess('owner', 'gpsTracking')).toBe(true);
            expect(canAccess('owner', 'communityShare')).toBe(true);
        });
    });

    // ── requiredTier ──

    describe('requiredTier', () => {
        it('returns correct minimum tier for features', () => {
            expect(requiredTier('weatherFull')).toBe('crew');
            expect(requiredTier('routePlanner')).toBe('owner');
            expect(requiredTier('gpsTracking')).toBe('crew');
            expect(requiredTier('shipLog')).toBe('owner');
            expect(requiredTier('shipLogRead')).toBe('crew');
        });
    });

    // ── tierLabel ──

    describe('tierLabel', () => {
        it('returns display labels', () => {
            expect(tierLabel('free')).toBe('Crew (Free)');
            expect(tierLabel('crew')).toBe('Crew');
            expect(tierLabel('owner')).toBe('Vessel Owner');
        });
    });

    // ── isExpired ──

    describe('isExpired', () => {
        it('returns false for undefined expiry (free tier)', () => {
            expect(isExpired(undefined)).toBe(false);
        });

        it('returns true for past date', () => {
            expect(isExpired('2020-01-01T00:00:00Z')).toBe(true);
        });

        it('returns false for future date', () => {
            expect(isExpired('2099-12-31T23:59:59Z')).toBe(false);
        });
    });

    // ── effectiveTier ──

    describe('effectiveTier', () => {
        it('free tier always returns free', () => {
            expect(effectiveTier('free')).toBe('free');
            expect(effectiveTier('free', '2020-01-01')).toBe('free');
        });

        it('expired crew falls back to free', () => {
            expect(effectiveTier('crew', '2020-01-01T00:00:00Z')).toBe('free');
        });

        it('active crew stays crew', () => {
            expect(effectiveTier('crew', '2099-12-31T23:59:59Z')).toBe('crew');
        });

        it('expired owner falls back to free', () => {
            expect(effectiveTier('owner', '2020-01-01T00:00:00Z')).toBe('free');
        });

        it('active owner stays owner', () => {
            expect(effectiveTier('owner', '2099-12-31T23:59:59Z')).toBe('owner');
        });
    });

    // ── tierIsPro (backward compat) ──

    describe('tierIsPro', () => {
        it('free is not pro', () => {
            expect(tierIsPro('free')).toBe(false);
        });

        it('crew is pro', () => {
            expect(tierIsPro('crew')).toBe(true);
        });

        it('owner is pro', () => {
            expect(tierIsPro('owner')).toBe(true);
        });
    });
});
