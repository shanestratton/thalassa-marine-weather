import { describe, expect, it } from 'vitest';
import { redactSensitiveDiagnostic } from '../utils/redactSensitiveDiagnostic';

describe('redactSensitiveDiagnostic', () => {
    it('removes URL, bearer, DRM-session, and JSON credentials while preserving useful context', () => {
        const raw =
            'TILE https://data.linz.govt.nz/services;key=linz-secret/path' +
            '?access_token=oauth-secret&request=key&ticket=proxy-ticket ' +
            '/tokens/path-secret?sessionId=session-secret ' +
            'Authorization: Bearer bearer-secret ' +
            '{"key":"drm-secret","sessionId":"json-session","status":"OK"}';

        const safe = redactSensitiveDiagnostic(raw);

        for (const secret of [
            'linz-secret',
            'oauth-secret',
            'proxy-ticket',
            'path-secret',
            'session-secret',
            'bearer-secret',
            'drm-secret',
            'json-session',
        ]) {
            expect(safe).not.toContain(secret);
        }
        expect(safe).toContain('request=key');
        expect(safe).toContain('"status":"OK"');
        expect(safe.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(7);
    });

    it('does not alter ordinary diagnostic values', () => {
        const message = 'Connected to host calypso.local on port 8080';
        expect(redactSensitiveDiagnostic(message)).toBe(message);
    });
});
