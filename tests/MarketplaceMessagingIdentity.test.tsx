import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import type { MarketplaceListing } from '../services/MarketplaceService';

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

const authHarness = vi.hoisted(() => {
    let userId: string | null = null;
    const listeners = new Set<() => void>();
    return {
        getUserId: () => userId,
        setUserId: (next: string | null) => {
            userId = next;
            for (const listener of [...listeners]) listener();
        },
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
});

const mocks = vi.hoisted(() => ({
    getUser: vi.fn(),
    from: vi.fn(),
    channel: vi.fn(),
    removeChannel: vi.fn(),
    getListing: vi.fn(),
    triggerHaptic: vi.fn(),
    toastError: vi.fn(),
}));

vi.mock('../stores/authStore', async () => {
    const ReactModule = await import('react');
    const getState = () => ({
        user: authHarness.getUserId() ? { id: authHarness.getUserId() as string } : null,
    });
    const useAuthStore = Object.assign(
        <T,>(selector: (state: ReturnType<typeof getState>) => T): T =>
            ReactModule.useSyncExternalStore(
                authHarness.subscribe,
                () => selector(getState()),
                () => selector(getState()),
            ),
        { getState },
    );
    return { useAuthStore };
});

vi.mock('../services/supabase', () => ({
    supabase: {
        auth: { getUser: mocks.getUser },
        from: mocks.from,
        channel: mocks.channel,
        removeChannel: mocks.removeChannel,
    },
}));

vi.mock('../services/MarketplaceService', () => ({
    MarketplaceService: { getListing: mocks.getListing },
    CATEGORY_ICONS: { Safety: '🛟' },
}));

vi.mock('../utils/system', () => ({
    triggerHaptic: mocks.triggerHaptic,
}));

vi.mock('../components/Toast', () => ({
    toast: { error: mocks.toastError },
}));

vi.mock('../components/ChatPage', () => ({
    ChatPage: () => <div>Community chat</div>,
}));

vi.mock('../utils/featureVisibility', () => ({
    FEATURE_VISIBILITY: { marketplace: true },
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { ChatHub } from '../components/ChatHub';
import { MarketplaceThread } from '../components/MarketplaceThread';

const authResult = (userId: string | null) => ({
    data: { user: userId ? { id: userId } : null },
    error: null,
});

function listing(id = 'listing-1'): MarketplaceListing {
    return {
        id,
        seller_id: 'seller-1',
        title: 'Account A sextant',
        description: null,
        price: 750,
        currency: 'AUD',
        category: 'Safety',
        condition: 'Used - Good',
        images: [],
        location_name: null,
        status: 'available',
        sold_at: null,
        created_at: '2026-07-23T00:00:00.000Z',
        updated_at: '2026-07-23T00:00:00.000Z',
        seller_name: 'Seller One',
    };
}

interface ThreadRow {
    id: string;
    listing_id: string;
    sender_id: string;
    recipient_id: string;
    content: string;
    created_at: string;
}

function message(id: string, senderId: string, recipientId: string, content: string): ThreadRow {
    return {
        id,
        listing_id: 'listing-1',
        sender_id: senderId,
        recipient_id: recipientId,
        content,
        created_at: '2026-07-23T00:00:00.000Z',
    };
}

function switchIdentity(userId: string): void {
    act(() => {
        setAuthIdentityScope(userId);
        authHarness.setUserId(userId);
    });
}

function conversationQuery(result: Promise<{ data: ThreadRow[]; error: null }> | { data: ThreadRow[]; error: null }) {
    const query = {
        select: vi.fn(),
        or: vi.fn(),
        order: vi.fn(),
    };
    query.select.mockReturnValue(query);
    query.or.mockReturnValue(query);
    query.order.mockReturnValue(result);
    return query;
}

function threadQuery(result: Promise<{ data: ThreadRow[]; error: null }> | { data: ThreadRow[]; error: null }) {
    const query = {
        select: vi.fn(),
        eq: vi.fn(),
        or: vi.fn(),
        order: vi.fn(),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.or.mockReturnValue(query);
    query.order.mockReturnValue(result);
    return query;
}

function realtimeChannel(callbacks: Array<(payload: { new: ThreadRow }) => void>) {
    const channel = {
        on: vi.fn((_kind: string, _filter: unknown, callback: (payload: { new: ThreadRow }) => void) => {
            callbacks.push(callback);
            return channel;
        }),
        subscribe: vi.fn(() => channel),
    };
    return channel;
}

describe('marketplace messaging identity isolation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setAuthIdentityScope(null);
        authHarness.setUserId(null);
        setAuthIdentityScope('account-a');
        authHarness.setUserId('account-a');
        mocks.getUser.mockImplementation(() => Promise.resolve(authResult(authHarness.getUserId())));
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
            configurable: true,
            value: vi.fn(),
        });
    });

    afterEach(() => {
        cleanup();
    });

    it('hides A inbox rows immediately on B and keeps separate buyers for one listing', async () => {
        const accountAQuery = conversationQuery({
            data: [
                message('a-1', 'account-a', 'buyer-1', 'First buyer'),
                message('a-2', 'buyer-2', 'account-a', 'Second buyer'),
            ],
            error: null,
        });
        const accountBQuery = conversationQuery({ data: [], error: null });
        mocks.from.mockReturnValueOnce(accountAQuery).mockReturnValueOnce(accountBQuery);
        mocks.getListing.mockResolvedValue(listing());

        render(<ChatHub />);
        fireEvent.click(screen.getByRole('button', { name: 'Switch to Chandlery messages' }));

        await waitFor(() => {
            expect(screen.getAllByRole('button', { name: 'Open marketplace conversation' })).toHaveLength(2);
        });
        expect(accountAQuery.or).toHaveBeenCalledWith('sender_id.eq.account-a,recipient_id.eq.account-a');

        switchIdentity('account-b');

        expect(screen.queryByText('Account A sextant')).not.toBeInTheDocument();
        await waitFor(() => expect(accountBQuery.order).toHaveBeenCalledTimes(1));
        expect(accountBQuery.or).toHaveBeenCalledWith('sender_id.eq.account-b,recipient_id.eq.account-b');
    });

    it('discards a deferred A inbox query after the account changes', async () => {
        const accountARows = deferred<{ data: ThreadRow[]; error: null }>();
        const accountAQuery = conversationQuery(accountARows.promise);
        const accountBQuery = conversationQuery({ data: [], error: null });
        mocks.from.mockReturnValueOnce(accountAQuery).mockReturnValueOnce(accountBQuery);
        mocks.getListing.mockResolvedValue(listing());

        render(<ChatHub />);
        fireEvent.click(screen.getByRole('button', { name: 'Switch to Chandlery messages' }));
        await waitFor(() => expect(accountAQuery.order).toHaveBeenCalledTimes(1));

        switchIdentity('account-b');
        await waitFor(() => expect(accountBQuery.order).toHaveBeenCalledTimes(1));

        accountARows.resolve({
            data: [message('late-a', 'account-a', 'buyer-1', 'A private negotiation')],
            error: null,
        });

        await act(async () => {
            await accountARows.promise;
        });
        expect(screen.queryByText('A private negotiation')).not.toBeInTheDocument();
        expect(mocks.getListing).not.toHaveBeenCalled();
    });

    it('does not query the inbox when Supabase auth disagrees with the synchronous owner', async () => {
        mocks.getUser.mockResolvedValue(authResult('account-b'));

        render(<ChatHub />);
        fireEvent.click(screen.getByRole('button', { name: 'Switch to Chandlery messages' }));

        await waitFor(() => expect(mocks.getUser).toHaveBeenCalledTimes(1));
        expect(mocks.from).not.toHaveBeenCalled();
        expect(screen.queryByRole('button', { name: 'Open marketplace conversation' })).not.toBeInTheDocument();
    });

    it('loads only the exact A/listing/counterparty pair and closes synchronously on B', async () => {
        const callbacks: Array<(payload: { new: ThreadRow }) => void> = [];
        const channel = realtimeChannel(callbacks);
        mocks.channel.mockReturnValue(channel);
        const query = threadQuery({
            data: [
                message('exact', 'account-a', 'seller-1', 'A private offer'),
                message('wrong-buyer', 'buyer-2', 'seller-1', 'Another buyer secret'),
            ],
            error: null,
        });
        mocks.from.mockReturnValue(query);

        render(<MarketplaceThread listing={listing()} otherPartyId="seller-1" onBack={vi.fn()} />);

        expect(await screen.findByText('A private offer')).toBeInTheDocument();
        expect(screen.queryByText('Another buyer secret')).not.toBeInTheDocument();
        expect(query.eq).toHaveBeenCalledWith('listing_id', 'listing-1');
        expect(query.or).toHaveBeenCalledWith(
            'and(sender_id.eq.account-a,recipient_id.eq.seller-1),and(sender_id.eq.seller-1,recipient_id.eq.account-a)',
        );

        fireEvent.change(screen.getByPlaceholderText('Type a message...'), {
            target: { value: 'A unsent secret' },
        });
        expect(screen.getByDisplayValue('A unsent secret')).toBeInTheDocument();

        switchIdentity('account-b');

        expect(screen.getByLabelText('Marketplace conversation closed')).toBeInTheDocument();
        expect(screen.queryByText('A private offer')).not.toBeInTheDocument();
        expect(screen.queryByDisplayValue('A unsent secret')).not.toBeInTheDocument();
        expect(mocks.removeChannel).toHaveBeenCalledWith(channel);

        act(() => {
            callbacks[0]?.({
                new: message('late-realtime', 'seller-1', 'account-a', 'Late A realtime secret'),
            });
        });
        expect(screen.queryByText('Late A realtime secret')).not.toBeInTheDocument();
    });

    it('captures the A send tuple and suppresses its late failure toast under B', async () => {
        const callbacks: Array<(payload: { new: ThreadRow }) => void> = [];
        mocks.channel.mockReturnValue(realtimeChannel(callbacks));
        const query = threadQuery({ data: [], error: null });
        const remoteInsert = deferred<{ error: { message: string } | null }>();
        const insertQuery = {
            insert: vi.fn(() => remoteInsert.promise),
        };
        mocks.from.mockReturnValueOnce(query).mockReturnValueOnce(insertQuery);

        render(<MarketplaceThread listing={listing()} otherPartyId="seller-1" onBack={vi.fn()} />);
        await waitFor(() => expect(query.order).toHaveBeenCalledTimes(1));

        fireEvent.change(screen.getByPlaceholderText('Type a message...'), {
            target: { value: '  Offer from A  ' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

        await waitFor(() => expect(insertQuery.insert).toHaveBeenCalledTimes(1));
        expect(insertQuery.insert).toHaveBeenCalledWith({
            listing_id: 'listing-1',
            sender_id: 'account-a',
            recipient_id: 'seller-1',
            content: 'Offer from A',
        });

        switchIdentity('account-b');
        remoteInsert.resolve({ error: { message: 'late A failure' } });
        await act(async () => {
            await remoteInsert.promise;
        });

        expect(mocks.toastError).not.toHaveBeenCalled();
        expect(screen.getByLabelText('Marketplace conversation closed')).toBeInTheDocument();
    });

    it('does not load, subscribe, or send when the remote session is a different user', async () => {
        mocks.getUser.mockResolvedValue(authResult('account-b'));

        render(<MarketplaceThread listing={listing()} otherPartyId="seller-1" onBack={vi.fn()} />);
        await waitFor(() => expect(mocks.getUser).toHaveBeenCalledTimes(1));

        expect(mocks.channel).not.toHaveBeenCalled();
        expect(mocks.from).not.toHaveBeenCalled();

        fireEvent.change(screen.getByPlaceholderText('Type a message...'), {
            target: { value: 'Should never send' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
        await waitFor(() => expect(mocks.getUser).toHaveBeenCalledTimes(2));

        expect(mocks.from).not.toHaveBeenCalled();
        expect(mocks.toastError).not.toHaveBeenCalled();
    });
});
