/** Real Research controller, JS admission/port/runtime and Thalassa page;
 * synthetic SDK/native replies only. No native crypto, network or devices.
 */
import React, { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrivateMessageResearchApp } from '../experiments/scuttlebutt-e2ee/app-pilot/PrivateMessageResearchApp';
import { createPrivateMessageResearchRuntime } from '../experiments/scuttlebutt-e2ee/app-pilot/runtime';
import {
    RESEARCH_LABEL,
    RESEARCH_SUPABASE_URL,
    type ResearchAccount,
    type ResearchAuthSdk,
    type ResearchAuthNativePlugin,
} from '../experiments/scuttlebutt-e2ee/bridge-web/auth';
import { captureLegacyPrivateMessagePermit } from '../services/chat/e2ee/privateMessageCutover';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

vi.mock('../components/LegacyChatPage', () => {
    throw new Error('Legacy page forbidden in UI fixture');
});
const OWNER = '11111111-1111-4111-8111-111111111111',
    DEVICE = '22222222-2222-4222-8222-222222222222',
    PEER = '33333333-3333-4333-8333-333333333333',
    VERSION = '44444444-4444-4444-8444-444444444444';
const CLOSED = { status: 'unavailable', reason: 'unavailable' };
const all: Array<() => void> = [];
let visibility = 'visible';
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}
function fixture(selection = 'protected-required') {
    let account: ResearchAccount | null = null,
        epoch = 0,
        issued: string | null = null,
        session: { access_token: string } | null = null;
    let listener: Parameters<ResearchAuthSdk['onAuthStateChange']>[0] | undefined;
    const sdk: ResearchAuthSdk = {
        getSession: vi.fn(async () => ({ data: { session }, error: null })),
        signInWithPassword: vi.fn(async () => {
            session = { access_token: 'synthetic-ui-token' };
            return { data: { session }, error: null };
        }),
        signOut: vi.fn(async () => {
            session = null;
            return { error: null };
        }),
        onAuthStateChange: vi.fn((cb) => {
            listener = cb;
            return {
                data: {
                    subscription: {
                        unsubscribe: vi.fn(() => {
                            listener = undefined;
                        }),
                    },
                },
            };
        }),
        stopAutoRefresh: vi.fn(),
    };
    const ready = () =>
        account && issued === account.credentialBinding
            ? {
                  status: 'ready',
                  authority: { accountId: OWNER, deviceId: DEVICE, lifecycleVersion: VERSION, serverVerified: true },
                  supportedContent: ['text'],
              }
            : CLOSED;
    const ok = (value: unknown) => ({
        status: 'ok',
        authority: { accountId: OWNER, deviceId: DEVICE, lifecycleVersion: VERSION, serverVerified: true },
        value,
    });
    const permissions = () => ({
        peerAccountId: PEER,
        blockedByMe: false,
        blockedEitherDirection: false,
        canSend: true,
        reason: null,
    });
    const forbidden = () => {
        throw new Error('Automatic setup or send forbidden in UI fixture');
    };
    const native = {
        configuration: vi.fn<ResearchAuthNativePlugin['configuration']>(async () => ({
            status: 'configured' as const,
            research: true as const,
            label: RESEARCH_LABEL,
            supabaseUrl: RESEARCH_SUPABASE_URL,
            publicApiKey: 'sb_publishable_research_fixture',
        })),
        fenceSession: vi.fn(async (_: { mode: 'verify' | 'sign_out' }) => {
            account = null;
            issued = null;
            return { status: 'fenced' as const, authFence: 'fixture-fence-' + ++epoch };
        }),
        authenticate: vi.fn(async (_: { accessToken: string; authFence: string }) => {
            account = {
                accountId: OWNER,
                deviceId: DEVICE,
                credentialBinding: '55555555-5555-4555-8555-' + String(epoch).padStart(12, '0'),
                serverVerified: true,
            };
            return { status: 'authenticated' as const, account };
        }),
        currentAccount: vi.fn(async () =>
            account ? { status: 'authenticated' as const, account } : { status: 'unavailable' as const },
        ),
        messagePrivateAdmission: vi.fn(
            async (_: { credentialBinding: string }): Promise<unknown> =>
                account
                    ? {
                          status: 'private_admission',
                          accountId: OWNER,
                          deviceId: DEVICE,
                          credentialBinding: account.credentialBinding,
                          selection,
                      }
                    : CLOSED,
        ),
        privateMessageIssue: vi.fn(async ({ credentialBinding }: { credentialBinding: string }): Promise<unknown> => {
            issued = credentialBinding;
            return ready();
        }),
        privateMessageReadiness: vi.fn(async (_: { lifecycleVersion: string }): Promise<unknown> => ready()),
        privateMessagePermissions: vi.fn(
            async (_: { lifecycleVersion: string; peerAccountId: string }): Promise<unknown> => ok(permissions()),
        ),
        privateMessageInbox: vi.fn(
            async (_: { lifecycleVersion: string }): Promise<unknown> =>
                ok([
                    {
                        peerAccountId: PEER,
                        displayName: 'Paired sailor',
                        lastText: null,
                        lastLocalCreatedAtMillis: null,
                        unreadCount: 0,
                        historyAvailable: true,
                    },
                ]),
        ),
        privateMessageThread: vi.fn(
            async (_: { lifecycleVersion: string; peerAccountId: string }): Promise<unknown> =>
                ok({
                    peerAccountId: PEER,
                    messages: [
                        {
                            id: 'incoming:66666666-6666-4666-8666-666666666666',
                            clientMessageId: '66666666-6666-4666-8666-666666666666',
                            direction: 'incoming',
                            senderAccountId: PEER,
                            recipientAccountId: OWNER,
                            senderName: 'Paired sailor',
                            text: null,
                            localCreatedAtMillis: null,
                            read: false,
                            delivery: 'received',
                            reason: null,
                        },
                    ],
                    permissions: permissions(),
                    unresolvedCount: 0,
                    pendingAttemptId: null,
                }),
        ),
        privateMessageSendText: vi.fn(
            async (_: {
                lifecycleVersion: string;
                peerAccountId: string;
                clientMessageId: string;
                text: string;
            }): Promise<unknown> => forbidden(),
        ),
        privateMessageRetryPending: vi.fn(
            async (_: { lifecycleVersion: string; peerAccountId: string; clientMessageId: string }): Promise<unknown> =>
                forbidden(),
        ),
        messageRegisterDevice: vi.fn(forbidden),
        messageClaimPeer: vi.fn(forbidden),
        messageRequireProtected: vi.fn(forbidden),
    };
    const factory = vi.fn(() =>
        createPrivateMessageResearchRuntime({ auth: { native, supported: () => true, createSdk: () => sdk }, native }),
    );
    const result = {
        sdk,
        native,
        factory,
        emit: (event: string) => listener?.(event, session),
        setSession: () => {
            session = { access_token: 'synthetic-ui-token' };
        },
        project: () =>
            account
                ? {
                      status: 'private_admission',
                      accountId: OWNER,
                      deviceId: DEVICE,
                      credentialBinding: account.credentialBinding,
                      selection,
                  }
                : CLOSED,
    };
    all.push(() => {
        expect(native.messageRegisterDevice).not.toHaveBeenCalled();
        expect(native.messageClaimPeer).not.toHaveBeenCalled();
        expect(native.messageRequireProtected).not.toHaveBeenCalled();
        expect(native.privateMessageSendText).not.toHaveBeenCalled();
        expect(native.privateMessageRetryPending).not.toHaveBeenCalled();
    });
    return result;
}
async function boot(f: ReturnType<typeof fixture>) {
    const view = render(<PrivateMessageResearchApp createRuntime={f.factory} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in and verify' })).not.toBeDisabled());
    return view;
}
function input() {
    fireEvent.change(screen.getByLabelText('Test account email'), { target: { value: 'ui-fixture@example.invalid' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'synthetic-ui-password' } });
}
async function signIn(f: ReturnType<typeof fixture>) {
    input();
    fireEvent.submit(screen.getByLabelText('Password').closest('form')!);
    await waitFor(() => expect(screen.getByText(/Account: authenticated/)).toBeInTheDocument());
    expect(f.native.authenticate).toHaveBeenCalled();
}
function transition(name: 'pagehide' | 'pageshow', persisted: boolean) {
    const event = new Event(name);
    Object.defineProperty(event, 'persisted', { value: persisted });
    fireEvent(window, event);
}
function hide() {
    visibility = 'hidden';
    fireEvent(document, new Event('visibilitychange'));
}
function show() {
    visibility = 'visible';
    fireEvent(document, new Event('visibilitychange'));
}
beforeEach(() => {
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    setAuthIdentityScope(null);
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
            throw new Error('Network forbidden in UI fixture');
        }),
    );
});
afterEach(() => {
    cleanup();
    for (const assertions of all.splice(0)) assertions();
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
});
describe('isolated PM page lifecycle — synthetic SDK/native integration', () => {
    it('failed terminal fencing does not poison replacement verification or imply successful revocation', async () => {
        const f = fixture(),
            first = await boot(f);
        await signIn(f);
        const before = f.native.fenceSession.mock.calls.length;
        f.native.fenceSession.mockRejectedValueOnce(new Error('Synthetic terminal refusal'));
        first.unmount();
        await boot(f);
        expect(f.native.fenceSession).toHaveBeenCalledTimes(before + 2);
        expect(f.native.authenticate).toHaveBeenCalledTimes(1);
    });
    it('SDK cleanup failure cannot suppress the already queued terminal denial', async () => {
        const f = fixture(),
            view = await boot(f);
        await signIn(f);
        const before = f.native.fenceSession.mock.calls.length;
        vi.mocked(f.sdk.stopAutoRefresh!).mockImplementationOnce(() => {
            throw new Error('Synthetic SDK cleanup failure');
        });
        expect(() => view.unmount()).not.toThrow();
        await waitFor(() => expect(f.native.fenceSession).toHaveBeenCalledTimes(before + 1));
        expect(f.native.fenceSession.mock.calls.at(-1)?.[0].mode).toBe('verify');
    });
    it('authenticated nonpersisted pagehide attempts a terminal verify fence without logout', async () => {
        const f = fixture();
        await boot(f);
        await signIn(f);
        const before = f.native.fenceSession.mock.calls.length;
        transition('pagehide', false);
        await waitFor(() => expect(f.native.fenceSession).toHaveBeenCalledTimes(before + 1));
        expect(f.native.fenceSession.mock.calls.at(-1)?.[0].mode).toBe('verify');
        expect(f.sdk.signOut).not.toHaveBeenCalled();
        expect(screen.getByText(/Research window stopped/)).toBeInTheDocument();
    });
    it('an old terminal fence finishes before a replacement can verify, and disposal is idempotent', async () => {
        const f = fixture(),
            first = await boot(f);
        await signIn(f);
        const gate = deferred<void>(),
            original = f.native.fenceSession.getMockImplementation()!;
        f.native.fenceSession.mockImplementationOnce(async (options) => {
            await gate.promise;
            return original(options);
        });
        const before = f.native.fenceSession.mock.calls.length;
        transition('pagehide', false);
        await waitFor(() => expect(f.native.fenceSession).toHaveBeenCalledTimes(before + 1));
        first.unmount();
        render(<PrivateMessageResearchApp createRuntime={f.factory} />);
        await act(async () => {});
        expect(f.native.fenceSession).toHaveBeenCalledTimes(before + 1);
        await act(async () => gate.resolve());
        await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in and verify' })).not.toBeDisabled());
        expect(f.native.fenceSession).toHaveBeenCalledTimes(before + 2);
    });
    it('waits for an already dispatched suspension fence before a newer explicit reverify', async () => {
        const f = fixture();
        await boot(f);
        await signIn(f);
        const gate = deferred<void>(),
            original = f.native.fenceSession.getMockImplementation()!;
        f.native.fenceSession.mockImplementationOnce(async (options) => {
            await gate.promise;
            return original(options);
        });
        const before = f.native.fenceSession.mock.calls.length;
        hide();
        await waitFor(() => expect(f.native.fenceSession).toHaveBeenCalledTimes(before + 1));
        show();
        fireEvent.click(screen.getByRole('button', { name: 'Reverify' }));
        await act(async () => {});
        expect(f.sdk.getSession).not.toHaveBeenCalled();
        expect(f.native.fenceSession).toHaveBeenCalledTimes(before + 1);
        await act(async () => gate.resolve());
        await waitFor(() => expect(screen.getByText(/Account: authenticated/)).toBeInTheDocument());
        expect(f.native.fenceSession).toHaveBeenCalledTimes(before + 2);
        expect(f.sdk.getSession).toHaveBeenCalledTimes(1);
    });
    it('denies legacy and has no automatic auth/setup/private read on cold boot', async () => {
        const f = fixture();
        await boot(f);
        expect(captureLegacyPrivateMessagePermit(getAuthIdentityScope(), PEER)).toBeNull();
        expect(f.native.authenticate).not.toHaveBeenCalled();
        expect(f.native.privateMessageIssue).not.toHaveBeenCalled();
        expect(f.native.privateMessageInbox).not.toHaveBeenCalled();
    });
    it('clears password before a held SDK sign-in and refuses duplicate submissions', async () => {
        const f = fixture(),
            gate = deferred<{ data: { session: { access_token: string } }; error: null }>();
        vi.mocked(f.sdk.signInWithPassword).mockReturnValueOnce(gate.promise);
        await boot(f);
        input();
        fireEvent.submit(screen.getByLabelText('Password').closest('form')!);
        await waitFor(() => expect(f.sdk.signInWithPassword).toHaveBeenCalledTimes(1));
        expect(screen.getByLabelText('Password')).toHaveValue('');
        fireEvent.submit(screen.getByLabelText('Password').closest('form')!);
        expect(f.sdk.signInWithPassword).toHaveBeenCalledTimes(1);
        await act(async () => gate.resolve({ data: { session: { access_token: 'synthetic-ui-token' } }, error: null }));
    });
    it('unknown admission never issues a PM authority or reads an inbox', async () => {
        const f = fixture('unknown');
        await boot(f);
        await signIn(f);
        fireEvent.click(screen.getByRole('button', { name: 'Check native setup and open messages' }));
        await waitFor(() => expect(screen.getByText(/Local private admission: unknown/)).toBeInTheDocument());
        expect(f.native.privateMessageIssue).not.toHaveBeenCalled();
        expect(f.native.privateMessageInbox).not.toHaveBeenCalled();
    });
    it('renders actual native-only inbox/thread components with honest null text/time and received state', async () => {
        const f = fixture();
        await boot(f);
        await signIn(f);
        fireEvent.click(screen.getByRole('button', { name: 'Check native setup and open messages' }));
        const paired = await screen.findByRole('button', { name: 'Message Paired sailor' });
        fireEvent.click(paired);
        await screen.findByText('Message text unavailable');
        expect(screen.getAllByText(/Time unknown/).length).toBeGreaterThan(0);
        expect(screen.getByText(/Received.*Read status unknown/)).toBeInTheDocument();
    });
    it('rejects wrong original binding in admission before PM issue', async () => {
        const f = fixture();
        await boot(f);
        await signIn(f);
        f.native.messagePrivateAdmission.mockResolvedValueOnce({ ...f.project(), credentialBinding: VERSION });
        fireEvent.click(screen.getByRole('button', { name: 'Check native setup and open messages' }));
        await waitFor(() => expect(screen.getByText(/Local private admission: unavailable/)).toBeInTheDocument());
        expect(f.native.privateMessageIssue).not.toHaveBeenCalled();
    });
    it('hiding a held admission drops the old open and clears fields', async () => {
        const f = fixture(),
            gate = deferred<unknown>();
        await boot(f);
        await signIn(f);
        f.native.messagePrivateAdmission.mockReturnValueOnce(gate.promise);
        fireEvent.click(screen.getByRole('button', { name: 'Check native setup and open messages' }));
        await waitFor(() => expect(f.native.messagePrivateAdmission).toHaveBeenCalledTimes(1));
        const value = f.project();
        hide();
        await act(async () => gate.resolve(value));
        expect(f.native.privateMessageIssue).not.toHaveBeenCalled();
        expect(screen.queryByRole('button', { name: 'Message Paired sailor' })).not.toBeInTheDocument();
        expect(screen.getByLabelText('Password')).toHaveValue('');
    });
    it('BFCache return preserves verified owner but requires explicit fresh reverify', async () => {
        const f = fixture();
        await boot(f);
        await signIn(f);
        transition('pagehide', true);
        await waitFor(() => expect(screen.getByText(/Account: unavailable/)).toBeInTheDocument());
        const count = f.native.authenticate.mock.calls.length;
        f.emit('TOKEN_REFRESHED');
        await act(async () => {});
        expect(f.native.authenticate).toHaveBeenCalledTimes(count);
        transition('pageshow', true);
        fireEvent.click(screen.getByRole('button', { name: 'Reverify' }));
        await waitFor(() => expect(screen.getByText(/Account: authenticated/)).toBeInTheDocument());
        expect(f.sdk.signInWithPassword).toHaveBeenCalledTimes(1);
        expect(f.native.fenceSession.mock.calls.every(([o]) => o.mode === 'verify')).toBe(true);
    });
    it('does not adopt SDK memory from a canceled first sign-in on resume', async () => {
        const f = fixture(),
            gate = deferred<{ data: { session: { access_token: string } }; error: null }>();
        vi.mocked(f.sdk.signInWithPassword).mockReturnValueOnce(gate.promise);
        await boot(f);
        input();
        fireEvent.submit(screen.getByLabelText('Password').closest('form')!);
        await waitFor(() => expect(f.sdk.signInWithPassword).toHaveBeenCalled());
        hide();
        f.setSession();
        await act(async () => gate.resolve({ data: { session: { access_token: 'synthetic-ui-token' } }, error: null }));
        show();
        fireEvent.click(screen.getByRole('button', { name: 'Reverify' }));
        await act(async () => {});
        expect(f.native.authenticate).not.toHaveBeenCalled();
        expect(f.sdk.getSession).not.toHaveBeenCalled();
    });
    it('an old open completion cannot clear a newer pending logout busy state', async () => {
        const f = fixture(),
            opening = deferred<unknown>(),
            logout = deferred<{ error: null }>();
        await boot(f);
        await signIn(f);
        f.native.messagePrivateAdmission.mockReturnValueOnce(opening.promise);
        fireEvent.click(screen.getByRole('button', { name: 'Check native setup and open messages' }));
        await waitFor(() => expect(f.native.messagePrivateAdmission).toHaveBeenCalled());
        const value = f.project();
        vi.mocked(f.sdk.signOut).mockReturnValueOnce(logout.promise);
        fireEvent.click(screen.getByRole('button', { name: 'Explicit logout' }));
        await waitFor(() => expect(f.sdk.signOut).toHaveBeenCalled());
        await act(async () => opening.resolve(value));
        expect(screen.getByRole('button', { name: 'Sign in and verify' })).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Explicit logout' }));
        expect(f.sdk.signOut).toHaveBeenCalledTimes(1);
        await act(async () => logout.resolve({ error: null }));
        await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in and verify' })).not.toBeDisabled());
    });
    it('nonpersisted pagehide stays closed with a truthful reload notice', async () => {
        const f = fixture();
        await boot(f);
        transition('pagehide', false);
        transition('pageshow', false);
        expect(screen.getByText(/Research window stopped/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Sign in and verify' })).toBeDisabled();
        expect(f.sdk.stopAutoRefresh).toHaveBeenCalledTimes(1);
    });
    it('a new mount gets fresh resources rather than stopped module singletons', async () => {
        const f = fixture(),
            first = await boot(f);
        first.unmount();
        await boot(f);
        expect(f.factory).toHaveBeenCalledTimes(2);
        expect(screen.getByRole('button', { name: 'Sign in and verify' })).not.toBeDisabled();
    });
    it('StrictMode setup-cleanup-setup creates no discarded render subscriptions or dead runtime', async () => {
        const f = fixture();
        render(
            <StrictMode>
                <PrivateMessageResearchApp createRuntime={f.factory} />
            </StrictMode>,
        );
        await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in and verify' })).not.toBeDisabled());
        expect(f.factory).toHaveBeenCalledTimes(2);
        expect(f.native.authenticate).not.toHaveBeenCalled();
    });
    it('queued hidden submissions and reverification do not dispatch SDK work', async () => {
        const f = fixture();
        await boot(f);
        input();
        hide();
        fireEvent.submit(screen.getByLabelText('Password').closest('form')!);
        fireEvent.click(screen.getByRole('button', { name: 'Reverify' }));
        await act(async () => {});
        expect(f.sdk.signInWithPassword).not.toHaveBeenCalled();
        expect(f.sdk.getSession).not.toHaveBeenCalled();
    });
});
