import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureException } from '../services/sentry';

describe('Sentry error forwarding', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('does not log recursively while telemetry is unavailable or loading', () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        captureException(new Error('early startup failure'));

        // The originating logger owns console output. The telemetry adapter
        // must never feed an exception back into createLogger.error.
        expect(consoleError).not.toHaveBeenCalled();
    });
});
