import { describe, expect, it } from 'vitest';
import {
    WHITSUNDAYS_RESEARCH_SOURCES,
    WHITSUNDAYS_STARTER_DESTINATIONS,
    WHITSUNDAYS_STARTER_REVIEW,
    WHITSUNDAYS_STARTER_TRIP_IDEAS,
} from '../services/dayPlanner/whitsundaysStarter';

describe('Whitsundays editorial starter manifest', () => {
    it('remains an unpublished, unreviewed research draft', () => {
        expect(WHITSUNDAYS_STARTER_REVIEW).toMatchObject({
            purpose: 'editorial-research-only',
            status: 'draft',
            reviewStatus: 'pending',
            publicationReady: false,
            reviewedAt: null,
            reviewDueAt: null,
            reviewerLabel: null,
        });
        expect(WHITSUNDAYS_STARTER_REVIEW.destinations).toBe(WHITSUNDAYS_STARTER_DESTINATIONS);
        expect(WHITSUNDAYS_STARTER_REVIEW.tripIdeas).toBe(WHITSUNDAYS_STARTER_TRIP_IDEAS);
        expect(WHITSUNDAYS_STARTER_REVIEW.sources).toBe(WHITSUNDAYS_RESEARCH_SOURCES);
    });

    it('contains the six requested destination drafts without invented positions', () => {
        expect(WHITSUNDAYS_STARTER_DESTINATIONS.map(({ key }) => key)).toEqual([
            'airlie',
            'daydream',
            'hamilton',
            'nara',
            'tongue',
            'butterfly',
        ]);
        expect(WHITSUNDAYS_STARTER_DESTINATIONS.find(({ key }) => key === 'hamilton')?.aliases).toContain('Hamo');
        for (const destination of WHITSUNDAYS_STARTER_DESTINATIONS) {
            expect(destination).toMatchObject({ status: 'draft', reviewStatus: 'pending', position: null });
            expect(destination.unresolved.length).toBeGreaterThan(0);
            expect(destination).not.toHaveProperty('reviewerLabel');
            expect(destination).not.toHaveProperty('reviewedAt');
        }
    });

    it('contains five Airlie trip ideas but no reviewed route variants or geometry', () => {
        const destinationKeys = new Set(WHITSUNDAYS_STARTER_DESTINATIONS.map(({ key }) => key));
        expect(WHITSUNDAYS_STARTER_TRIP_IDEAS).toHaveLength(5);
        expect(WHITSUNDAYS_STARTER_TRIP_IDEAS.map(({ destinationKey }) => destinationKey)).toEqual([
            'daydream',
            'hamilton',
            'nara',
            'tongue',
            'butterfly',
        ]);
        for (const trip of WHITSUNDAYS_STARTER_TRIP_IDEAS) {
            expect(trip).toMatchObject({
                originKey: 'airlie',
                status: 'draft',
                reviewStatus: 'pending',
                routeVariants: [],
                requiredReviewDirections: ['outbound', 'return'],
            });
            expect(destinationKeys.has(trip.originKey)).toBe(true);
            expect(destinationKeys.has(trip.destinationKey)).toBe(true);
            expect(trip).not.toHaveProperty('checkpoints');
            expect(trip).not.toHaveProperty('geometry');
            expect(trip).not.toHaveProperty('reviewerLabel');
            expect(trip).not.toHaveProperty('reviewedAt');
        }
    });

    it('resolves every destination source reference to a recorded research source', () => {
        for (const destination of WHITSUNDAYS_STARTER_DESTINATIONS) {
            expect(destination.sourceKeys.length).toBeGreaterThan(0);
            for (const key of destination.sourceKeys) {
                expect(Object.hasOwn(WHITSUNDAYS_RESEARCH_SOURCES, key)).toBe(true);
                expect(WHITSUNDAYS_RESEARCH_SOURCES[key].label.trim().length).toBeGreaterThan(0);
            }
        }
    });

    it('records research links without claiming that reuse rights are cleared', () => {
        for (const source of Object.values(WHITSUNDAYS_RESEARCH_SOURCES)) {
            expect(new URL(source.url).protocol).toBe('https:');
            expect(source.retrievedOn).toBe(WHITSUNDAYS_STARTER_REVIEW.preparedOn);
            expect(['notice-found-scope-pending', 'permission-unresolved']).toContain(source.rights);
            if (source.rightsNoticeUrl) {
                expect(new URL(source.rightsNoticeUrl).protocol).toBe('https:');
                expect(source.rights).toBe('notice-found-scope-pending');
            } else {
                expect(source.rights).toBe('permission-unresolved');
            }
        }
    });
});
