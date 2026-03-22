/**
 * LegalGuard — Unit tests for disclaimer acceptance logic.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { checkDisclaimerAccepted, acceptDisclaimer, DISCLAIMER_VERSION } from '../modules/LegalGuard';

describe('LegalGuard', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('exports DISCLAIMER_VERSION constant', () => {
        expect(DISCLAIMER_VERSION).toBeDefined();
        expect(typeof DISCLAIMER_VERSION).toBe('string');
    });

    it('returns false when no disclaimer accepted', () => {
        expect(checkDisclaimerAccepted()).toBe(false);
    });

    it('returns true after accepting disclaimer', () => {
        acceptDisclaimer();
        expect(checkDisclaimerAccepted()).toBe(true);
    });

    it('persists acceptance across checks', () => {
        acceptDisclaimer();
        // Second call should still return true
        const check1 = checkDisclaimerAccepted();
        const check2 = checkDisclaimerAccepted();
        expect(check1).toBe(true);
        expect(check2).toBe(true);
    });

    it('survives re-check after acceptance', () => {
        acceptDisclaimer();
        expect(checkDisclaimerAccepted()).toBe(true);
        // Re-check
        expect(checkDisclaimerAccepted()).toBe(true);
    });
});
