/**
 * Unit Tests for createLogger utility
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLogger } from '../utils/createLogger';

describe('createLogger', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('should return a logger with debug, info, warn, error methods', () => {
        const log = createLogger('TestTag');
        expect(typeof log.debug).toBe('function');
        expect(typeof log.info).toBe('function');
        expect(typeof log.warn).toBe('function');
        expect(typeof log.error).toBe('function');
    });

    it('should prefix messages with [Tag]', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
        const log = createLogger('MyComponent');
        log.warn('something broke');
        expect(warnSpy).toHaveBeenCalledWith('[MyComponent]', 'something broke');
    });

    it('should pass multiple arguments through', () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
        const log = createLogger('Svc');
        const err = new Error('test');
        log.error('failed:', err, { retries: 3 });
        expect(errorSpy).toHaveBeenCalledWith('[Svc]', 'failed:', err, { retries: 3 });
    });

    it('warn should always emit (even in prod concept)', () => {
        const spy = vi.spyOn(console, 'warn').mockImplementation(() => { });
        const log = createLogger('Tag');
        log.warn('alert');
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('error should always emit', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => { });
        const log = createLogger('Tag');
        log.error('critical');
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('should use different tags for different loggers', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
        const log1 = createLogger('Alpha');
        const log2 = createLogger('Beta');
        log1.warn('a');
        log2.warn('b');
        expect(warnSpy).toHaveBeenNthCalledWith(1, '[Alpha]', 'a');
        expect(warnSpy).toHaveBeenNthCalledWith(2, '[Beta]', 'b');
    });
});
