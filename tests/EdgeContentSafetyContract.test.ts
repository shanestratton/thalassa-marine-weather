import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');
const edgeSource = (name: string): string => source(`supabase/functions/${name}/index.ts`);

describe('active Edge content-safety contracts', () => {
    it('normalises upstream markup with the bounded single-pass scanner', () => {
        for (const name of ['proxy-amsa-msi', 'proxy-ukho-msi', 'maritime-intel']) {
            const edge = edgeSource(name);
            expect(edge, name).toContain('plainTextFromMarkup(');
            expect(edge, name).not.toContain('.replace(/<[^>');
            expect(edge, name).not.toMatch(/\.replace\(\/&(?:amp|lt|gt|quot|nbsp)/);
        }

        const scanner = source('supabase/functions/_shared/plain-text.ts');
        expect(scanner).toContain('maxInputChars');
        expect(scanner).toContain('maxOutputChars');
        expect(scanner).toContain("HIDDEN_BODY_TAGS = new Set(['script', 'style', 'template'])");
    });

    it('keeps exception diagnostics out of public push-function responses', () => {
        for (const name of ['send-anchor-alarm', 'send-push']) {
            const edge = edgeSource(name);
            expect(edge, name).toContain('internalServerErrorResponse()');
            expect(edge, name).not.toContain('String(error)');
            expect(edge, name).not.toMatch(/JSON\.stringify\(\{ error: (?:error|err)/);
        }
    });

    it('logs only allowlisted Deepgram frame metadata', () => {
        const edge = edgeSource('deepgram-ws-proxy');
        const classifier = source('supabase/functions/deepgram-ws-proxy/safety.ts');

        expect(edge).toContain('classifyDeepgramFrame(ev.data)');
        expect(edge).not.toContain('ev.data.slice');
        expect(edge).not.toContain('ev.reason');
        expect(classifier).toContain("case 'Results':");
        expect(classifier).toContain("case 'Error':");
        expect(classifier).toContain("return 'other-json'");
        expect(classifier).not.toContain('return parsed.type');
    });
});
