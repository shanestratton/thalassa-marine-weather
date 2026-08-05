import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'components/dashboard/hero/EssentialAnchorView.tsx'), 'utf8');

describe('Essential Anchor swing-radius update safety', () => {
    it('awaits native/recovery confirmation and keeps failure visible as radius unchanged', () => {
        expect(source).toContain('const updated = await AnchorWatchService.updateConfig');
        expect(source).toContain('if (!updated)');
        expect(source).toContain('The previous radius remains active');
        expect(source).toContain('setSuggestionError(message)');
        expect(source).toContain('Radius unchanged: {suggestionError}');
        expect(source).toContain('disabled={suggestionSaving}');
    });
});
