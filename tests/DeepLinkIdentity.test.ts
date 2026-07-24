import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    consumeTracerAction,
    consumeTracerOpenRequest,
    peekTracerOpenRequest,
    requestTracerOpen,
    type TracerOpenEventDetail,
} from '../services/deepLink';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

function captureNextTracerEvent(): { read: () => CustomEvent<TracerOpenEventDetail> } {
    let captured: CustomEvent<TracerOpenEventDetail> | null = null;
    const listener = (event: Event) => {
        captured = event as CustomEvent<TracerOpenEventDetail>;
        window.removeEventListener('thalassa:trace-mode', listener);
    };
    window.addEventListener('thalassa:trace-mode', listener);
    return {
        read: () => {
            if (!captured) throw new Error('Expected a tracer event');
            return captured;
        },
    };
}

describe('tracer deep-link identity fence', () => {
    beforeEach(() => {
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
    });

    afterEach(() => {
        // A real transition synchronously clears either half of a request that
        // a failing assertion may have left pending.
        setAuthIdentityScope(null);
    });

    it('clears a private pending action synchronously when identity changes', () => {
        const eventA = captureNextTracerEvent();
        requestTracerOpen({ kind: 'load-saved', id: 'account-a-route' });
        expect(eventA.read().detail.identity).toBe(getAuthIdentityScope());

        setAuthIdentityScope('account-b');

        expect(consumeTracerOpenRequest(eventA.read())).toBe(false);
        expect(consumeTracerAction()).toBeNull();
    });

    it('clears an action even after the open half was claimed by A', () => {
        const eventA = captureNextTracerEvent();
        requestTracerOpen({ kind: 'load-voyage', choice: voyageChoice('voyage-a') });
        expect(consumeTracerOpenRequest(eventA.read())).toBe(true);

        setAuthIdentityScope('account-b');

        expect(consumeTracerAction()).toBeNull();
    });

    it('rejects stale events without consuming the current account request', () => {
        const eventA = captureNextTracerEvent();
        requestTracerOpen({ kind: 'load-voyage', choice: voyageChoice('voyage-a') });

        setAuthIdentityScope('account-b');
        const eventB = captureNextTracerEvent();
        requestTracerOpen({ kind: 'load-saved', id: 'account-b-route' });

        expect(consumeTracerOpenRequest(eventA.read())).toBe(false);
        expect(consumeTracerOpenRequest(eventB.read())).toBe(true);
        expect(consumeTracerAction()).toEqual({ kind: 'load-saved', id: 'account-b-route' });
    });

    it('uses generation as well as account key after logout and same-account login', () => {
        const firstLogin = getAuthIdentityScope();
        const staleEvent = captureNextTracerEvent();
        requestTracerOpen({ kind: 'new-leg', fromId: 'old-generation-leg' }, firstLogin);

        setAuthIdentityScope(null);
        const secondLogin = setAuthIdentityScope('account-a');
        expect(secondLogin.key).toBe(firstLogin.key);
        expect(secondLogin.generation).not.toBe(firstLogin.generation);

        const currentEvent = captureNextTracerEvent();
        requestTracerOpen({ kind: 'new-leg', fromId: 'current-generation-leg' }, secondLogin);

        expect(consumeTracerOpenRequest(staleEvent.read())).toBe(false);
        expect(consumeTracerOpenRequest(currentEvent.read())).toBe(true);
        expect(consumeTracerAction()).toEqual({ kind: 'new-leg', fromId: 'current-generation-leg' });
    });

    it('rejects a delayed producer scoped to A rather than overwriting B', () => {
        const accountA = getAuthIdentityScope();
        setAuthIdentityScope('account-b');
        const eventB = captureNextTracerEvent();
        requestTracerOpen({ kind: 'load-saved', id: 'account-b-route' });

        requestTracerOpen({ kind: 'load-saved', id: 'late-account-a-route' }, accountA);

        expect(consumeTracerOpenRequest(eventB.read())).toBe(true);
        expect(consumeTracerAction()).toEqual({ kind: 'load-saved', id: 'account-b-route' });
    });

    it('keeps the deliberately anonymous builder door working', () => {
        setAuthIdentityScope(null);
        const anonymous = getAuthIdentityScope();
        const event = captureNextTracerEvent();

        requestTracerOpen();

        expect(event.read().detail.identity).toBe(anonymous);
        expect(peekTracerOpenRequest()).toBe(true);
        expect(consumeTracerOpenRequest(event.read())).toBe(true);
        expect(peekTracerOpenRequest()).toBe(false);
        expect(consumeTracerAction()).toBeNull();
    });

    it('fences old listeners that consume without passing the event', () => {
        let eventB: CustomEvent<TracerOpenEventDetail> | null = null;
        const switchDuringAEvent = (event: Event) => {
            const detail = (event as CustomEvent<TracerOpenEventDetail>).detail;
            if (detail.identity.userId !== 'account-a') {
                eventB = event as CustomEvent<TracerOpenEventDetail>;
                return;
            }
            setAuthIdentityScope('account-b');
            requestTracerOpen({ kind: 'load-saved', id: 'account-b-route' });
        };
        const gatedLegacyConsumer = (event: Event) => {
            const detail = (event as CustomEvent<TracerOpenEventDetail>).detail;
            if (detail.identity.userId === 'account-a') {
                // Simulates today's MapHub listener: it does not pass `event`.
                expect(consumeTracerOpenRequest()).toBe(false);
            }
        };
        window.addEventListener('thalassa:trace-mode', switchDuringAEvent);
        window.addEventListener('thalassa:trace-mode', gatedLegacyConsumer);

        try {
            requestTracerOpen({ kind: 'load-saved', id: 'account-a-route' });

            expect(eventB).not.toBeNull();
            expect(consumeTracerOpenRequest(eventB!)).toBe(true);
            expect(consumeTracerAction()).toEqual({ kind: 'load-saved', id: 'account-b-route' });
        } finally {
            window.removeEventListener('thalassa:trace-mode', switchDuringAEvent);
            window.removeEventListener('thalassa:trace-mode', gatedLegacyConsumer);
        }
    });
});

function voyageChoice(voyageId: string) {
    return {
        voyageId,
        label: 'Private voyage',
        sublabel: '12 NM',
        timestamp: Date.now(),
        distanceNm: 12,
        isLocal: false,
    };
}
