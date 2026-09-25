import { describe, expect, it } from 'vitest';
import { presentShoreWatchStatus } from '../components/anchor-watch/shoreWatchStatus';
import type { ShoreAlarmSnapshot } from '../services/ShoreWatchAlarmService';

const ready = { status: 'ready' as const, reason: null, checkedAt: 1000 };
const waiting: ShoreAlarmSnapshot = {
    sessionCode: 'WATCHSESSION',
    position: null,
    lastContactAt: null,
    stale: true,
    cause: null,
    muted: false,
    audioError: null,
};

describe('Shore Watch info status', () => {
    it('is inactive without a shore session even with an old cause', () => {
        expect(presentShoreWatchStatus({ ...waiting, sessionCode: null, cause: 'contact-lost' }, ready).active).toBe(
            false,
        );
    });

    it('never treats a connected socket without a position as fresh boat data', () => {
        expect(presentShoreWatchStatus({ ...waiting, stale: false, lastContactAt: 1000 }, ready).tone).toBe('yellow');
    });

    it.each(['drag', 'gps-lost', 'contact-lost'] as const)('keeps %s red after muting', (cause) => {
        const status = presentShoreWatchStatus({ ...waiting, cause, muted: true }, ready);
        expect(status.tone).toBe('red');
        expect(status.detail).toContain('In-app sound is silenced');
    });

    it('keeps expiring authorisation amber with a renewal explanation', () => {
        const status = presentShoreWatchStatus({ ...waiting, cause: 'session-expiring' }, ready);
        expect(status.tone).toBe('yellow');
        expect(status.detail).toContain('renew');
    });
});
