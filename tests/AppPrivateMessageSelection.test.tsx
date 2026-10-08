// @vitest-environment jsdom
/** Actual selection helper, view registry props and ChatPage validators with
 * fresh fixture cutover policies and mocked lazy pages. NOT full-App/bootstrap,
 * SDK, native readiness, provider encryption or production integration evidence.
 * Production services must not evaluate in this isolated component fixture.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import type { PrivateMessageCutoverPolicy } from '../services/chat/e2ee/privateMessageCutover';
import type { PrivateMessagePilotRuntime } from '../services/chat/e2ee/privateMessagePilot';

const fixture = vi.hoisted(() => ({
    policy: null as PrivateMessageCutoverPolicy | null,
    legacyRender: vi.fn(),
    nativeRender: vi.fn(),
}));
vi.mock('../services/chat/e2ee/privateMessageCutover', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../services/chat/e2ee/privateMessageCutover')>();
    return {
        ...actual,
        requireNativePrivateMessagesForProcess: () => fixture.policy!.requireNativePrivateMessagesForProcess(),
        requireNativePrivateMessagesForScope: (
            ...args: Parameters<PrivateMessageCutoverPolicy['requireNativePrivateMessagesForScope']>
        ) => fixture.policy!.requireNativePrivateMessagesForScope(...args),
        captureLegacyPrivateMessagePermit: (
            ...args: Parameters<PrivateMessageCutoverPolicy['captureLegacyPrivateMessagePermit']>
        ) => fixture.policy!.captureLegacyPrivateMessagePermit(...args),
        isLegacyPrivateMessagePermitCurrent: (permit: unknown) =>
            fixture.policy!.isLegacyPrivateMessagePermitCurrent(permit),
    };
});
vi.mock('../components/LegacyChatPage', () => ({
    LegacyChatPage: (props: { onBack?: () => void }) => {
        fixture.legacyRender(props);
        return (
            <div>
                <p>Legacy route fixture</p>
                <button onClick={props.onBack}>Back</button>
            </div>
        );
    },
}));
vi.mock('../components/chat/PrivateMessagePilotPage', () => ({
    PrivateMessagePilotPage: (props: { runtime: unknown; onBack?: () => void }) => {
        fixture.nativeRender(props);
        return (
            <div>
                <p>Native route fixture — authority not exercised</p>
                <button onClick={props.onBack}>Back</button>
            </div>
        );
    },
}));
vi.mock('../services/ChatService', () => {
    throw new Error('Production ChatService must not evaluate in routing fixture');
});
vi.mock('../services/supabase', () => {
    throw new Error('Production SDK must not evaluate in routing fixture');
});
vi.mock('../stores/authStore', () => {
    throw new Error('Production authStore must not evaluate in routing fixture');
});
// The registry's eager Button edge normally evaluates themeStore and its
// EnvironmentService singleton. No non-chat component is rendered here.
vi.mock('../stores/themeStore', () => ({
    useThemeStore: vi.fn(() => {
        throw new Error('Theme rendering is outside routing fixture');
    }),
}));
vi.mock('../services/EnvironmentService', () => {
    throw new Error('Production EnvironmentService must not evaluate in routing fixture');
});

import {
    getAppPrivateMessageSelection,
    normalizeAppPrivateMessageSelection,
} from '../services/chat/e2ee/appPrivateMessageSelection';
import { createPrivateMessageCutoverPolicy } from '../services/chat/e2ee/privateMessageCutover';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import { ChatPage, type ChatPageProps } from '../components/ChatPage';
import { VIEW_REGISTRY, type ViewContext } from '../viewRegistry';

const OWNER = 'app-selection-synthetic-owner';
const PEER = 'app-selection-synthetic-peer';
const capture = () => fixture.policy!.captureLegacyPrivateMessagePermit(getAuthIdentityScope(), PEER);
function context(additional: object = {}, setPage = vi.fn()): ViewContext {
    return Object.assign(
        {
            setPage,
            previousView: 'dashboard',
            setIsUpgradeOpen: vi.fn(),
            settings: {},
            updateSettings: vi.fn(),
            handleFavoriteSelect: vi.fn(),
            weatherAlerts: [],
        },
        additional,
    );
}
function route(props: unknown, setPage = vi.fn()) {
    const selection = getAppPrivateMessageSelection(props);
    const ctx = context(selection === undefined ? {} : { privateMessageSelection: selection }, setPage);
    const routed = VIEW_REGISTRY.chat.getProps!(ctx) as ChatPageProps;
    return { selection, ctx, routed, setPage };
}
function runtime() {
    return {
        kind: 'native-pilot' as const,
        getInbox: vi.fn(),
        getThread: vi.fn(),
        sendText: vi.fn(),
        retryPending: vi.fn(),
        getBlockStatus: vi.fn(),
        setBlocked: vi.fn(),
        subscribe: vi.fn(),
    } as unknown as PrivateMessagePilotRuntime;
}
function expectDenied(previous: unknown) {
    expect(capture()).toBeNull();
    expect(fixture.policy!.isLegacyPrivateMessagePermitCurrent(previous)).toBe(false);
}
beforeEach(() => {
    vi.clearAllMocks();
    setAuthIdentityScope(null);
    setAuthIdentityScope(OWNER);
    // Each case owns a new policy. Never reset the application's process latch.
    fixture.policy = createPrivateMessageCutoverPolicy(getAuthIdentityScope);
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
            throw new Error('Network forbidden in routing fixture');
        }),
    );
});
afterEach(() => {
    cleanup();
    expect(fetch).not.toHaveBeenCalled();
    setAuthIdentityScope(null);
    fixture.policy = null;
    vi.unstubAllGlobals();
});

describe('explicit App selection helper — fresh policy fixtures only', () => {
    it.each([undefined, null, {}, [], 'absent', 0])(
        'preserves default behavior for missing selection in %j',
        (props) => {
            const permit = capture();
            expect(permit).not.toBeNull();
            const scope = getAuthIdentityScope();
            expect(getAppPrivateMessageSelection(props)).toBeUndefined();
            expect(getAuthIdentityScope()).toBe(scope);
            expect(fixture.policy!.isLegacyPrivateMessagePermitCurrent(permit)).toBe(true);
            expect(capture()).not.toBeNull();
        },
    );
    it('ignores an inherited selection without reading its getter or activating process denial', () => {
        const inherited = vi.fn(() => {
            throw new Error('Inherited selection must not be read');
        });
        const props = Object.create(Object.defineProperty({}, 'privateMessageSelection', { get: inherited }));
        const permit = capture();
        expect(getAppPrivateMessageSelection(props)).toBeUndefined();
        expect(inherited).not.toHaveBeenCalled();
        expect(fixture.policy!.isLegacyPrivateMessagePermitCurrent(permit)).toBe(true);
    });
    it.each([
        undefined,
        null,
        [],
        { kind: 'legacy' },
        { kind: 'native-unavailable' },
        { kind: 'wrong' },
        'native-pilot',
        false,
    ])('denies explicit malformed selection %j before returning unavailable', (privateMessageSelection) => {
        const permit = capture();
        expect(getAppPrivateMessageSelection({ privateMessageSelection })).toEqual({ kind: 'native-unavailable' });
        expectDenied(permit);
    });
    it.each(['selection', 'kind', 'runtime'] as const)('denies before reading a throwing %s getter', (field) => {
        const observed: unknown[] = [];
        const getter = vi.fn(() => {
            observed.push(capture());
            throw new Error('Synthetic getter refusal');
        });
        const selected: Record<string, unknown> = { kind: 'native-pilot', runtime: {} };
        const props: Record<string, unknown> = { privateMessageSelection: selected };
        Object.defineProperty(
            field === 'selection' ? props : selected,
            field === 'selection' ? 'privateMessageSelection' : field,
            { get: getter },
        );
        const permit = capture();
        expect(getAppPrivateMessageSelection(props)).toEqual({ kind: 'native-unavailable' });
        expect(observed).toEqual([null]);
        expect(getter).toHaveBeenCalledTimes(1);
        expectDenied(permit);
    });
    it('denies before a Proxy property-read trap attempts to capture a legacy permit', () => {
        const observed: unknown[] = [];
        const props = new Proxy(
            { privateMessageSelection: {} },
            {
                get() {
                    observed.push(capture());
                    throw new Error('Synthetic Proxy refusal');
                },
            },
        );
        const permit = capture();
        expect(getAppPrivateMessageSelection(props)).toEqual({ kind: 'native-unavailable' });
        expect(observed).toEqual([null]);
        expectDenied(permit);
    });
    it('refuses unreadable ownership, while documenting the pre-latch Proxy trap boundary', () => {
        const observed: unknown[] = [];
        const props = new Proxy(
            {},
            {
                getOwnPropertyDescriptor() {
                    observed.push(capture());
                    throw new Error('Synthetic ownership refusal');
                },
            },
        );
        const permit = capture();
        expect(getAppPrivateMessageSelection(props)).toEqual({ kind: 'native-unavailable' });
        // Ownership must be inspected to distinguish absence. Its Proxy trap
        // currently runs before the render-time latch: an isolated entry's
        // earlier boot fence is still required. Do not claim trap-safe dispatch.
        expect(observed).toHaveLength(1);
        expect(observed[0]).not.toBeNull();
        expectDenied(permit);
    });
    it('preserves a valid-looking runtime identity without granting Auth or invoking it', () => {
        const candidate = runtime();
        const scope = getAuthIdentityScope(),
            permit = capture();
        const selected = getAppPrivateMessageSelection({
            privateMessageSelection: { kind: 'native-pilot', runtime: candidate },
        });
        expect(selected).toEqual({ kind: 'native-pilot', runtime: candidate });
        expect((selected as { runtime: unknown }).runtime).toBe(candidate);
        expect(Object.isFrozen(selected)).toBe(true);
        expect(getAuthIdentityScope()).toBe(scope);
        for (const value of Object.values(candidate))
            if (typeof value === 'function') expect(value).not.toHaveBeenCalled();
        expectDenied(permit);
    });
    it.each(['kind-getter', 'runtime-getter', 'proxy-get'] as const)(
        'normalizes explicit untrusted values only after denial: %s',
        (trap) => {
            const observed: unknown[] = [];
            const read = () => {
                observed.push(capture());
                throw new Error('Synthetic explicit-value refusal');
            };
            const value =
                trap === 'proxy-get'
                    ? new Proxy({ kind: 'native-pilot', runtime: {} }, { get: read })
                    : Object.defineProperty(
                          { kind: 'native-pilot', runtime: {} },
                          trap === 'kind-getter' ? 'kind' : 'runtime',
                          { get: read },
                      );
            const permit = capture();
            expect(normalizeAppPrivateMessageSelection(value)).toEqual({ kind: 'native-unavailable' });
            expect(observed).toEqual([null]);
            expectDenied(permit);
        },
    );
    it('normalizes explicit undefined as denial while the trusted-props convenience preserves absence', () => {
        const permit = capture();
        expect(getAppPrivateMessageSelection({})).toBeUndefined();
        expect(fixture.policy!.isLegacyPrivateMessagePermitCurrent(permit)).toBe(true);
        expect(normalizeAppPrivateMessageSelection(undefined)).toEqual({ kind: 'native-unavailable' });
        expectDenied(permit);
    });
});

describe('actual registry props and ChatPage validators — mocked lazy pages', () => {
    it('routes absent injection to the ordinary page with the unchanged Vessel Back callback', async () => {
        const permit = capture();
        const selected = route({});
        expect(selected.routed).not.toHaveProperty('selection');
        render(<ChatPage {...selected.routed} />);
        expect(await screen.findByText('Legacy route fixture')).toBeInTheDocument();
        expect(fixture.nativeRender).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Back' }));
        expect(selected.setPage).toHaveBeenCalledWith('vessel');
        expect(fixture.policy!.isLegacyPrivateMessagePermitCurrent(permit)).toBe(true);
        expect(VIEW_REGISTRY.chat).toMatchObject({ boundaryName: 'Chat', group: 'vessel' });
    });
    it('passes the same native runtime only to chat and leaves other route props and Back labels intact', async () => {
        const candidate = runtime(),
            selected = route({ privateMessageSelection: { kind: 'native-pilot', runtime: candidate } });
        expect((selected.routed.selection as { runtime: unknown }).runtime).toBe(candidate);
        render(<ChatPage {...selected.routed} />);
        expect(await screen.findByText('Native route fixture — authority not exercised')).toBeInTheDocument();
        expect(fixture.nativeRender.mock.calls.at(-1)?.[0].runtime).toBe(candidate);
        expect(fixture.legacyRender).not.toHaveBeenCalled();
        for (const value of Object.values(candidate))
            if (typeof value === 'function') expect(value).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Back' }));
        expect(selected.setPage).toHaveBeenCalledWith('vessel');
        const sightings = VIEW_REGISTRY.sightings.getProps!(selected.ctx);
        expect(sightings).not.toHaveProperty('selection');
        expect(sightings).not.toHaveProperty('privateMessageSelection');
        expect(sightings).toMatchObject({ backLabel: 'Back to Scuttlebutt' });
        (sightings.onBack as () => void)();
        expect(selected.setPage).toHaveBeenLastCalledWith('chat');
        const mob = VIEW_REGISTRY.mob.getProps!({ ...selected.ctx, previousView: 'vessel' });
        expect(mob).toMatchObject({ backLabel: 'Back to Vessel' });
        expect(mob).not.toHaveProperty('selection');
    });
    it.each([
        () => ({}),
        () => ({ kind: 'disabled' }),
        () => ({ kind: 'native-pilot' }),
        () => ({ ...runtime(), getInbox: 'invalid-method' }),
        () =>
            new Proxy(
                {},
                {
                    has() {
                        throw new Error('Synthetic runtime refusal');
                    },
                },
            ),
    ])('renders malformed runtime unavailable without mounting either lazy page', (makeRuntime) => {
        const selected = route({ privateMessageSelection: { kind: 'native-pilot', runtime: makeRuntime() } });
        render(<ChatPage {...selected.routed} />);
        expect(screen.getByText(/The native private message test is unavailable/)).toBeInTheDocument();
        expect(screen.getByText('Encryption test—not reviewed')).toBeInTheDocument();
        expect(fixture.legacyRender).not.toHaveBeenCalled();
        expect(fixture.nativeRender).not.toHaveBeenCalled();
        expect(capture()).toBeNull();
    });
    it('does not read runtime authority getters and keeps runtime validation behind the denial', () => {
        const authority = vi.fn(() => {
            throw new Error('Authority must not be queried by routing');
        });
        const observed: unknown[] = [];
        const candidate = Object.defineProperty({}, 'kind', {
            get() {
                observed.push(capture());
                return 'wrong';
            },
        });
        Object.defineProperty(candidate, 'authority', { get: authority });
        const selected = route({ privateMessageSelection: { kind: 'native-pilot', runtime: candidate } });
        render(<ChatPage {...selected.routed} />);
        expect(screen.getByText(/Sending is blocked/)).toBeInTheDocument();
        expect(observed).toEqual([null]);
        expect(authority).not.toHaveBeenCalled();
        expect(fixture.legacyRender).not.toHaveBeenCalled();
    });
    it('renders the sticky unavailable projection after prop removal and owner change without loading legacy', () => {
        const permit = capture();
        const first = route({ privateMessageSelection: null });
        const view = render(<ChatPage {...first.routed} />);
        expect(screen.getByText(/Sending is blocked/)).toBeInTheDocument();
        expectDenied(permit);
        expect(getAppPrivateMessageSelection({})).toBeUndefined();
        // Project the explicitly unavailable selection produced by App's sticky
        // fallback. The actual App useRef ordering is source-checked below;
        // this fixture does not execute App/bootstrap or copy its hook logic.
        const sticky = normalizeAppPrivateMessageSelection(undefined);
        const routed = VIEW_REGISTRY.chat.getProps!(context({ privateMessageSelection: sticky })) as ChatPageProps;
        expect(routed.selection).toEqual({ kind: 'native-unavailable' });
        view.rerender(<ChatPage {...routed} />);
        expect(screen.getByText(/Sending is blocked/)).toBeInTheDocument();
        setAuthIdentityScope('app-selection-next-synthetic-owner');
        view.rerender(<ChatPage {...routed} />);
        expect(screen.getByText(/Sending is blocked/)).toBeInTheDocument();
        expect(fixture.legacyRender).not.toHaveBeenCalled();
        expect(fixture.nativeRender).not.toHaveBeenCalled();
        expect(capture()).toBeNull();
    });
    it('omits inherited registry selection rather than accidentally making it explicit', () => {
        const getter = vi.fn(() => {
            throw new Error('Inherited registry prop must not be read');
        });
        const ctx = Object.assign(
            Object.create(Object.defineProperty({}, 'privateMessageSelection', { get: getter })),
            context(),
        ) as ViewContext;
        expect(VIEW_REGISTRY.chat.getProps!(ctx)).not.toHaveProperty('selection');
        expect(getter).not.toHaveBeenCalled();
        expect(capture()).not.toBeNull();
    });
});

describe('App source ordering contract — not actual bootstrap execution', () => {
    it('places the render-time selection latch before its first hook and private push permit capture', () => {
        const source = readFileSync(new NodeURL('../App.tsx', import.meta.url), 'utf8');
        const body = source.slice(source.indexOf('const App: React.FC<AppProps>'));
        const withoutComments = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        expect(withoutComments).toMatch(
            /=\s*\(props\)\s*=>\s*\{\s*const \w+ = getAppPrivateMessageSelection\(props\);/,
        );
        const fence = body.indexOf('getAppPrivateMessageSelection(props)');
        expect(fence).toBeGreaterThanOrEqual(0);
        expect(fence).toBeLessThan(body.indexOf('captureLegacyPrivateMessagePermit(getAuthIdentityScope())'));
        expect(fence).toBeLessThan(body.indexOf('useWeather()'));
        expect(fence).toBeLessThan(body.indexOf('useAppBootstrap()'));
        expect(fence).toBeLessThan(body.indexOf('useRef('));
        const sticky = body.match(/const\s+(\w+)\s*=\s*useRef\(requestedPrivateMessageSelection\s*!==\s*undefined\)/);
        expect(sticky, 'App must own a mount-lifetime routing latch').not.toBeNull();
        if (!sticky) throw new Error('Sticky App routing source contract missing');
        expect(body).toMatch(new RegExp(sticky[1] + '\\.current\\s*=\\s*true'));
        const assignments = [
            ...withoutComments.matchAll(new RegExp(sticky[1] + '\\.current\\s*=(?!=)\\s*([^;\\n]+)', 'g')),
        ];
        expect(assignments.map((assignment) => assignment[1].trim())).toEqual(['true']);
        expect(body).toMatch(
            new RegExp(
                sticky[1] +
                    '\\.current[\\s\\S]{0,250}(?:native-unavailable|normalizeAppPrivateMessageSelection\\(undefined\\))',
            ),
        );
        const helper = readFileSync(
            new NodeURL('../services/chat/e2ee/appPrivateMessageSelection.ts', import.meta.url),
            'utf8',
        );
        const ownValue = helper.indexOf("Reflect.get(props, 'privateMessageSelection')");
        expect(helper.lastIndexOf('requireNativePrivateMessagesForProcess();', ownValue)).toBeGreaterThanOrEqual(0);
        const normalize = helper
            .slice(helper.indexOf('export function normalizeAppPrivateMessageSelection'))
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/[^\n]*/g, '');
        expect(normalize).toMatch(
            /normalizeAppPrivateMessageSelection\([^)]*\)[^{]*\{\s*requireNativePrivateMessagesForProcess\(\);/,
        );
    });
});
