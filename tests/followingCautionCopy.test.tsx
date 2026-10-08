/**
 * After following an amber route — from the Log's sheet or by casting off —
 * the headline must match WHY it is amber (review, 2026-10-08). "Following,
 * not checked yet" over a row that read "Last checked 4 Sep" contradicts the
 * line printed right beside it.
 */
import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { CastOffHandoffNotices } from '../pages/log/CastOffHandoffNotices';
import { FOLLOWING_UNCHECKED_NOTICE, followingCautionTitle, followingNotice } from '../pages/log/logPageTypes';
import type { CastOffHandoff } from '../services/castOffHandoff';

describe('following an amber route: the headline says why', () => {
    it('only a never-checked route is "not checked yet"', () => {
        expect(followingNotice('none')).toBe(FOLLOWING_UNCHECKED_NOTICE);
        expect(followingNotice('aged')).toBe('Following, but its check is out of date. Keep a good lookout.');
        expect(followingNotice('draft')).toBe('Following, but its check is out of date. Keep a good lookout.');
        for (const code of ['unavailable', 'tide', 'nochart'] as const) {
            expect(followingNotice(code)).toBe('Following, but it couldn’t be checked. Keep a good lookout.');
        }
        expect(followingNotice('nodraft')).toMatch(/set your draft/);
    });

    it('the Cast Off caution card titles by code, and red stays red', () => {
        expect(followingCautionTitle('unchecked', 'none')).toBe('Following — route not checked yet');
        expect(followingCautionTitle('unchecked', 'aged')).toBe('Following — check out of date');
        expect(followingCautionTitle('unchecked', 'draft')).toBe('Following — check out of date');
        expect(followingCautionTitle('unchecked', 'tide')).toBe('Following — couldn’t be checked');
        expect(followingCautionTitle('finding', 'finding')).toBe('Following — the check found a problem');
    });

    it('renders the card for a route checked last month without claiming it was never checked', () => {
        const handoff: CastOffHandoff = {
            voyageId: 'voyage-fictional',
            voyageName: 'Lymington → Yarmouth',
            caution: null,
            gps: 'confirmed',
            gpsError: null,
            retryCount: 0,
            followNote: null,
            followCaution: { tone: 'unchecked', text: 'Last checked 4 Sep', code: 'aged' },
            publishState: 'private',
            publishRoute: false,
            savedRouteId: 'trace-fictional',
        };
        render(<CastOffHandoffNotices castOffHandoff={handoff} isTracking />);
        expect(screen.getByText('Following — check out of date')).toBeInTheDocument();
        expect(screen.getByText('Last checked 4 Sep. Keep a good lookout.')).toBeInTheDocument();
        expect(screen.queryByText(/not checked yet/)).not.toBeInTheDocument();
    });
});
