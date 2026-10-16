import { describe, expect, it } from 'vitest';
import { canonicalReviewedSourceUrl, reviewedSourceUrlMatches } from '../services/tides/reviewedSourceUrl';

describe('canonical reviewed acquisition URL boundary', () => {
    it('accepts exactly the reviewed origin and complete path segment', () => {
        expect(
            reviewedSourceUrlMatches('https://official.example/predictions/station', 'https://official.example'),
        ).toBe(true);
        expect(
            reviewedSourceUrlMatches('https://official.example/predictions', 'https://official.example/predictions'),
        ).toBe(true);
        expect(
            reviewedSourceUrlMatches(
                'https://official.example/predictions/station',
                'https://official.example/predictions',
            ),
        ).toBe(true);
        expect(
            reviewedSourceUrlMatches(
                'https://official.example/predictions/station',
                'https://official.example/predictions/',
            ),
        ).toBe(true);
        expect(
            reviewedSourceUrlMatches(
                'https://official.example/predictions-other/station',
                'https://official.example/predictions',
            ),
        ).toBe(false);
    });
    it.each([
        'https://official.example.attacker.invalid/predictions/station',
        'https://sibling.official.example/predictions/station',
        'https://other.example/predictions/station',
        'https://official.example:444/predictions/station',
    ])('rejects sibling/lookalike or different origins: %s', (url) => {
        expect(reviewedSourceUrlMatches(url, 'https://official.example')).toBe(false);
    });
    it.each([
        'https://official.example/predictions/../elsewhere',
        'https://official.example/predictions/%2e%2e/elsewhere',
        'https://official.example/predictions/%252e%252e/elsewhere',
        'https://official.example/predictions/%2felsewhere',
        'https://official.example/predictions/%5celsewhere',
        'https://official.example/predictions\\elsewhere',
        'https://official.example/predictions?provider=official',
        'https://official.example/predictions?',
        'https://official.example/predictions#fragment',
        'https://official.example/predictions#',
        'https://user:password@official.example/predictions',
        'https://official.example:443/predictions',
        'https://OFFICIAL.example/predictions',
    ])('refuses noncanonical, encoded, queried or credentialled endpoints: %s', (url) => {
        expect(canonicalReviewedSourceUrl(url)).toBeNull();
        expect(reviewedSourceUrlMatches(url, 'https://official.example/predictions')).toBe(false);
        expect(reviewedSourceUrlMatches('https://official.example/predictions/station', url)).toBe(false);
    });
});
