import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RouteEnhancementChip } from '../components/passage/RouteEnhancementChip';
import {
    createPassageEnhancementToken,
    dispatchPassageEnhancementEvent,
    PASSAGE_ENHANCEMENT_END_EVENT,
    PASSAGE_ENHANCEMENT_START_EVENT,
} from '../services/passageEnhancementEvents';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

beforeEach(() => {
    setAuthIdentityScope(null);
    setAuthIdentityScope('account-a');
});

afterEach(() => {
    cleanup();
    setAuthIdentityScope(null);
});

describe('RouteEnhancementChip event ownership', () => {
    it('ignores an old operation end after a newer same-account operation starts', () => {
        render(<RouteEnhancementChip />);
        const scope = getAuthIdentityScope();
        const first = createPassageEnhancementToken(scope, 'first');
        const second = createPassageEnhancementToken(scope, 'second');

        act(() => {
            dispatchPassageEnhancementEvent(PASSAGE_ENHANCEMENT_START_EVENT, first);
            dispatchPassageEnhancementEvent(PASSAGE_ENHANCEMENT_START_EVENT, second);
            dispatchPassageEnhancementEvent(PASSAGE_ENHANCEMENT_END_EVENT, first);
        });
        expect(screen.getByRole('status')).toBeInTheDocument();

        act(() => {
            dispatchPassageEnhancementEvent(PASSAGE_ENHANCEMENT_END_EVENT, second);
        });
        expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('hides A synchronously and rejects A start/end events after B takes ownership', () => {
        render(<RouteEnhancementChip />);
        const scopeA = getAuthIdentityScope();
        const tokenA = createPassageEnhancementToken(scopeA, 'account-a-operation');
        act(() => {
            dispatchPassageEnhancementEvent(PASSAGE_ENHANCEMENT_START_EVENT, tokenA);
        });
        expect(screen.getByRole('status')).toBeInTheDocument();

        let tokenB = tokenA;
        act(() => {
            const scopeB = setAuthIdentityScope('account-b');
            tokenB = createPassageEnhancementToken(scopeB, 'account-b-operation');
        });
        expect(screen.queryByRole('status')).not.toBeInTheDocument();

        act(() => {
            dispatchPassageEnhancementEvent(PASSAGE_ENHANCEMENT_START_EVENT, tokenA);
            dispatchPassageEnhancementEvent(PASSAGE_ENHANCEMENT_START_EVENT, tokenB);
            dispatchPassageEnhancementEvent(PASSAGE_ENHANCEMENT_END_EVENT, tokenA);
        });
        expect(screen.getByRole('status')).toBeInTheDocument();

        act(() => {
            dispatchPassageEnhancementEvent(PASSAGE_ENHANCEMENT_END_EVENT, tokenB);
        });
        expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('rejects events from a previous login generation of the same account', () => {
        render(<RouteEnhancementChip />);
        const firstLogin = getAuthIdentityScope();
        const staleToken = createPassageEnhancementToken(firstLogin, 'old-login');

        act(() => {
            setAuthIdentityScope(null);
            setAuthIdentityScope('account-a');
            dispatchPassageEnhancementEvent(PASSAGE_ENHANCEMENT_START_EVENT, staleToken);
        });

        expect(getAuthIdentityScope().generation).toBeGreaterThan(firstLogin.generation);
        expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('ignores untagged legacy events', () => {
        render(<RouteEnhancementChip />);
        act(() => {
            window.dispatchEvent(new CustomEvent(PASSAGE_ENHANCEMENT_START_EVENT));
            window.dispatchEvent(new CustomEvent(PASSAGE_ENHANCEMENT_END_EVENT));
        });
        expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
});
