import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const { dispatchAlert } = vi.hoisted(() => ({
    dispatchAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/AlertNotifier', () => ({
    dispatchAlert,
}));

import {
    cancelSundownerReminder,
    getPendingSundowner,
    setSundownerReminder,
} from '../services/voice/integrations/sundowner';

describe('sundowner identity boundary', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        dispatchAlert.mockClear();
        setAuthIdentityScope(null);
        setAuthIdentityScope('sundowner-a');
    });

    it('synchronously cancels A reminder and never alerts B from a queued callback', async () => {
        const sunset = new Date(Date.now() + 60_000).toISOString();
        await setSundownerReminder(sunset, 0, 'A private anchor-light reminder');

        expect(JSON.parse((await getPendingSundowner()).content)).toMatchObject({
            status: 'pending',
            message: 'A private anchor-light reminder',
        });

        setAuthIdentityScope('sundowner-b');

        expect(JSON.parse((await getPendingSundowner()).content)).toEqual({ status: 'no_pending' });
        expect(JSON.parse((await cancelSundownerReminder()).content)).toEqual({ status: 'no_pending' });

        await vi.advanceTimersByTimeAsync(60_000);
        expect(dispatchAlert).not.toHaveBeenCalled();
    });

    it('does not let B inspect or cancel A slot during an adversarial transition', async () => {
        const sunset = new Date(Date.now() + 120_000).toISOString();
        await setSundownerReminder(sunset, 1, 'A-only message');

        setAuthIdentityScope('sundowner-b');
        const bRead = JSON.parse((await getPendingSundowner()).content);
        const bCancel = JSON.parse((await cancelSundownerReminder()).content);

        expect(bRead).toEqual({ status: 'no_pending' });
        expect(bCancel).toEqual({ status: 'no_pending' });
        expect(JSON.stringify([bRead, bCancel])).not.toContain('A-only');
    });
});
