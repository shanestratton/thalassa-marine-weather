import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'supabase/functions/gemini-diary/index.ts'), 'utf8');
const settingsSource = readFileSync(resolve(process.cwd(), 'types/settings.ts'), 'utf8');

describe('gemini-diary runtime contract', () => {
    it('uses the supported audio-capable Gemini model for diary transcription', () => {
        expect(source).toContain("const GEMINI_MODEL = 'gemini-3.6-flash';");
        expect(source).not.toMatch(/const GEMINI_MODEL = 'gemini-2\.0-flash';/);
        expect(source).toContain('inlineData');
    });

    it('keeps the high-intensity diary option distinctly Shakespearean', () => {
        expect(settingsSource).toContain("poetic: 'Shakespearean — maritime grandeur'");
        expect(source).toContain('Shakespearean: render the entry as vivid, elevated maritime prose');
        expect(source).toContain("Shakespeare's seafaring passages");
        expect(source).toContain('never invent an event, person, condition, or observation');
    });
});
