import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    tracking: true,
    currentVoyageId: 'voyage-a' as string | undefined,
    setLink: vi.fn(),
}));

vi.mock('../services/ShipLogService', () => ({
    ShipLogService: {
        getTrackingStatus: () => ({
            isTracking: mocks.tracking,
            isPaused: false,
            isRapidMode: false,
            isPrecisionMode: false,
        }),
        getCurrentVoyageId: () => mocks.currentVoyageId,
    },
}));
vi.mock('../services/VoyageLogService', () => ({
    VoyageLogService: {
        setVoyagePlanLink: (...args: unknown[]) => mocks.setLink(...args),
    },
}));

import { setAuthIdentityScope } from '../services/authIdentityScope';
import { clearFollowedRoute, publishFollowedRoute } from '../services/shiplog/publishFollowedRoute';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.tracking = true;
    mocks.currentVoyageId = 'voyage-a';
    mocks.setLink.mockResolvedValue(true);
    setAuthIdentityScope('account-a');
});

describe('publishFollowedRoute identity ownership', () => {
    it('binds immutable A voyage and plan IDs and reports stale completion as an error', async () => {
        const link = deferred<boolean>();
        mocks.setLink.mockReturnValueOnce(link.promise);
        const request = publishFollowedRoute('plan-a');
        expect(mocks.setLink).toHaveBeenCalledWith('voyage-a', 'plan-a');

        mocks.currentVoyageId = 'voyage-b';
        setAuthIdentityScope('account-b');
        link.resolve(true);

        await expect(request).resolves.toBe('error');
        expect(mocks.setLink).toHaveBeenCalledTimes(1);
    });

    it('binds clear to A tracking voyage and never reports A success in B', async () => {
        const clear = deferred<boolean>();
        mocks.setLink.mockReturnValueOnce(clear.promise);
        const request = clearFollowedRoute();
        expect(mocks.setLink).toHaveBeenCalledWith('voyage-a', null);

        mocks.currentVoyageId = 'voyage-b';
        setAuthIdentityScope('account-b');
        clear.resolve(true);

        await expect(request).resolves.toBe(false);
    });

    it('does not link or clear when there is no active tracking voyage', async () => {
        mocks.tracking = false;
        await expect(publishFollowedRoute('plan-a')).resolves.toBe('not-tracking');
        await expect(clearFollowedRoute()).resolves.toBe(false);
        expect(mocks.setLink).not.toHaveBeenCalled();
    });
});
