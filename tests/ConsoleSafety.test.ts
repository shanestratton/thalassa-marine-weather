import { describe, expect, it } from 'vitest';

import { safeConsoleArgument } from '../utils/consoleSafety';

describe('console diagnostic safety', () => {
    it('collapses every JavaScript line separator in untrusted strings', () => {
        expect(safeConsoleArgument('first\r\nforged\u2028entry\u2029last')).toBe('first  forged entry last');
    });

    it('keeps error type and message without stack data or injected lines', () => {
        const error = new Error('request failed\nFAKE success');
        error.name = 'Network\rError';
        error.stack = 'private stack detail';

        expect(safeConsoleArgument(error)).toBe('[Network Error] request failed FAKE success');
    });

    it('never invokes attacker-controlled object stringification', () => {
        const value = { toString: () => 'forged\nline', secret: 'do-not-log' };

        expect(safeConsoleArgument(value)).toBe('[structured value omitted]');
        expect(safeConsoleArgument(['private', 'values'])).toBe('[array:2]');
    });
});
