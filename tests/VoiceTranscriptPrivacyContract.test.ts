import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
    return readFileSync(path, 'utf8');
}

describe('voice transcript privacy contract', () => {
    it('never logs Deepgram response bodies or transcript previews', () => {
        const edge = source('supabase/functions/deepgram-ws-proxy/index.ts');
        const deepgram = source('services/voice/deepgramRecognizer.ts');
        const apple = source('services/voice/speechRecognizer.ts');

        expect(edge).not.toContain('ev.data.slice');
        expect(edge).toContain('type=${messageType} bytes=${upstreamSize}');
        expect(deepgram).not.toMatch(/text=\\?"\$\{preview/);
        expect(deepgram).not.toContain('transcript.slice(0, 40)');
        expect(deepgram).toContain('chars=${trimmed.length}');
        expect(apple).not.toMatch(/text=\\?"\$\{preview/);
        expect(apple).toContain('chars=${trimmed.length}');
    });

    it('drops all production console breadcrumbs and redacts voice diagnostics in development', () => {
        const sentry = source('services/sentry.ts');
        expect(sentry).toContain("if (IS_PROD && crumb.category === 'console') return null");
        expect(sentry).toContain("crumb.category === 'console'");
        expect(sentry).toContain('[voice diagnostic redacted]');
    });
});
