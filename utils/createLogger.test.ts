/**
 * logger — Unit tests for logger utilities.
 */
import { describe, it, expect, vi } from 'vitest';
import { getErrorMessage, createLogger } from './logger';

describe('getErrorMessage', () => {
    it('extracts message from Error instance', () => {
        expect(getErrorMessage(new Error('test error'))).toBe('test error');
    });

    it('handles string errors', () => {
        expect(getErrorMessage('string error')).toBe('string error');
    });

    it('converts null to string', () => {
        expect(getErrorMessage(null)).toBe('null');
    });

    it('converts undefined to string', () => {
        expect(getErrorMessage(undefined)).toBe('undefined');
    });

    it('handles numeric errors', () => {
        expect(getErrorMessage(42)).toBe('42');
    });
});

describe('createLogger', () => {
    it('returns a logger with info, warn, error methods', () => {
        const log = createLogger('TestModule');
        expect(typeof log.info).toBe('function');
        expect(typeof log.warn).toBe('function');
        expect(typeof log.error).toBe('function');
    });

    it('does not throw when calling log methods', () => {
        const log = createLogger('TestModule');
        const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(() => log.info('test')).not.toThrow();
        expect(() => log.warn('test')).not.toThrow();
        expect(() => log.error('test')).not.toThrow();
        infoSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });

    it('includes module tag in log output', () => {
        const log = createLogger('MyModule');
        const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
        log.info('hello');
        expect(infoSpy).toHaveBeenCalledWith('[MyModule]', 'hello');
        infoSpy.mockRestore();
    });
});
