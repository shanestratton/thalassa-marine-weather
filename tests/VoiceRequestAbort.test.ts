import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/BoatNetworkService', () => ({
    BoatNetworkService: {
        getState: () => ({ piHost: '192.0.2.10' }),
    },
}));

import { askBosunText } from '../services/voice/bosunVoice';

describe('voice request cancellation', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('physically propagates the owner AbortSignal into an active request', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
            const signal = init?.signal;
            return new Promise<Response>((_resolve, reject) => {
                if (signal?.aborted) {
                    reject(signal.reason);
                    return;
                }
                signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
        });
        const controller = new AbortController();

        const request = askBosunText({ text: 'account A request' }, controller.signal);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        controller.abort();

        await expect(request).rejects.toMatchObject({ name: 'AbortError' });
        expect((fetchMock.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true);
    });
});
