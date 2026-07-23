import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const mocks = vi.hoisted(() => ({
    getMyPins: vi.fn(),
    savePin: vi.fn(),
    sendMessage: vi.fn(),
    getLastPosition: vi.fn(),
    getFreshPosition: vi.fn(),
    getCurrentPosition: vi.fn(),
    toastError: vi.fn(),
    toastInfo: vi.fn(),
}));

vi.mock('../services/PinService', () => ({
    PinService: {
        getMyPins: mocks.getMyPins,
        savePin: mocks.savePin,
    },
}));

vi.mock('../services/ChatService', () => ({
    ChatService: {
        sendMessage: mocks.sendMessage,
    },
}));

vi.mock('../services/BgGeoManager', () => ({
    BgGeoManager: {
        getLastPosition: mocks.getLastPosition,
        getFreshPosition: mocks.getFreshPosition,
    },
}));

vi.mock('../services/GpsService', () => ({
    GpsService: {
        getCurrentPosition: mocks.getCurrentPosition,
    },
}));

vi.mock('../components/Toast', () => ({
    toast: {
        error: mocks.toastError,
        info: mocks.toastInfo,
    },
}));

import { usePinDrop } from '../hooks/chat/usePinDrop';
import type { ChatMessage } from '../services/ChatService';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const renderPinDrop = (
    activeChannel: { id: string } | null = { id: 'channel-a' },
    setMessages = vi.fn() as React.Dispatch<React.SetStateAction<ChatMessage[]>>,
) =>
    renderHook(() =>
        usePinDrop({
            activeChannel,
            setMessages,
            setMessageText: vi.fn(),
            messageEndRef: { current: null },
        }),
    );

describe('usePinDrop identity isolation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
        mocks.getMyPins.mockResolvedValue([]);
        mocks.savePin.mockResolvedValue(null);
        mocks.sendMessage.mockResolvedValue(undefined);
        mocks.getLastPosition.mockReturnValue(null);
        mocks.getFreshPosition.mockResolvedValue(null);
        mocks.getCurrentPosition.mockResolvedValue(null);
    });

    it('clears A pin UI synchronously and drops deferred A pin/GPS results', async () => {
        const pins = deferred<
            {
                id: string;
                user_id: string;
                latitude: number;
                longitude: number;
                caption: string;
                category: string;
                created_at: string;
            }[]
        >();
        const position = deferred<{ latitude: number; longitude: number }>();
        mocks.getMyPins.mockReturnValue(pins.promise);
        mocks.getFreshPosition.mockReturnValue(position.promise);
        const { result } = renderPinDrop();

        let pending!: Promise<void>;
        act(() => {
            pending = result.current.openPinDrop();
        });
        expect(result.current.showPinSheet).toBe(true);
        expect(result.current.pinLoading).toBe(true);

        act(() => setAuthIdentityScope('account-b'));
        expect(result.current.showPinSheet).toBe(false);
        expect(result.current.savedPins).toEqual([]);
        expect(result.current.pinLoading).toBe(false);

        pins.resolve([
            {
                id: 'pin-a',
                user_id: 'account-a',
                latitude: -27,
                longitude: 153,
                caption: 'Private A pin',
                category: 'general',
                created_at: '2026-01-01T00:00:00.000Z',
            },
        ]);
        position.resolve({ latitude: -27, longitude: 153 });
        await act(async () => {
            await pending;
            await pins.promise;
        });

        expect(result.current.savedPins).toEqual([]);
        expect(result.current.pinLat).toBe(0);
        expect(result.current.pinLng).toBe(0);
    });

    it('does not save A pin data into B after chat send resolves', async () => {
        const sent = deferred<void>();
        mocks.sendMessage.mockReturnValue(sent.promise);
        const { result } = renderPinDrop();

        act(() => {
            result.current.setPinLat(-27);
            result.current.setPinLng(153);
            result.current.setPinCaption('Account A secret');
        });

        let pending!: Promise<void>;
        act(() => {
            pending = result.current.sendPin();
        });
        await vi.waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledOnce());

        act(() => setAuthIdentityScope('account-b'));
        sent.resolve();
        await act(async () => pending);

        expect(mocks.savePin).not.toHaveBeenCalled();
    });

    it('rolls back a failed pin send, restores the caption, and does not save the pin', async () => {
        mocks.sendMessage.mockResolvedValueOnce(null);
        const setMessagesMock = vi.fn();
        const setMessages = setMessagesMock as React.Dispatch<React.SetStateAction<ChatMessage[]>>;
        const { result } = renderPinDrop({ id: 'channel-a' }, setMessages);
        act(() => {
            result.current.setPinLat(-27);
            result.current.setPinLng(153);
            result.current.setPinCaption('Safe anchorage');
        });

        await act(() => result.current.sendPin());

        const finalMessages = setMessagesMock.mock.calls.reduce<ChatMessage[]>((messages, [update]) => {
            return typeof update === 'function' ? update(messages) : update;
        }, []);
        expect(finalMessages).toEqual([]);
        expect(result.current.showPinSheet).toBe(true);
        expect(result.current.pinCaption).toBe('Safe anchorage');
        expect(mocks.savePin).not.toHaveBeenCalled();
        expect(mocks.toastError).toHaveBeenCalledWith("Pin wasn't sent. Its caption has been restored.");
    });

    it('keeps a durably queued pin visible and saves it to the pin library', async () => {
        mocks.sendMessage.mockResolvedValueOnce('queued');
        const setMessagesMock = vi.fn();
        const setMessages = setMessagesMock as React.Dispatch<React.SetStateAction<ChatMessage[]>>;
        const { result } = renderPinDrop({ id: 'channel-a' }, setMessages);
        act(() => {
            result.current.setPinLat(-27);
            result.current.setPinLng(153);
            result.current.setPinCaption('Safe anchorage');
        });

        await act(() => result.current.sendPin());

        const finalMessages = setMessagesMock.mock.calls.reduce<ChatMessage[]>((messages, [update]) => {
            return typeof update === 'function' ? update(messages) : update;
        }, []);
        expect(finalMessages).toHaveLength(1);
        expect(finalMessages[0].delivery_status).toBe('queued');
        expect(mocks.savePin).toHaveBeenCalledWith(
            expect.objectContaining({ latitude: -27, longitude: 153, caption: 'Safe anchorage' }),
        );
        expect(mocks.toastInfo).toHaveBeenCalledWith('Pin queued — it will send when the connection returns.');
    });
});
