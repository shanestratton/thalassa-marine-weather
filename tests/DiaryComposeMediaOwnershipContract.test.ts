import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'components/DiaryPage.tsx'), 'utf8');

describe('Diary compose media ownership contract', () => {
    it('owns only newly-uploaded photos and exact-discards them on remove or cancel', () => {
        expect(source.match(/unsavedPhotoRefs\.current\.add\(url\)/g)).toHaveLength(1);
        expect(source).toContain('if (ref) discardNewPhoto(ref);');
        // Whitespace-tolerant: the pair being ADJACENT is the contract; their
        // indentation is prettier's business (it re-flowed when the compose
        // return gained a fragment wrapper for the video trimmer).
        expect(source).toMatch(/discardAllNewPhotos\(\);\s*\n\s*invalidateComposeSession\(\);/);
        expect(source).toContain('await DiaryService.discardUnsavedPhoto(url);');
    });

    it('defers unmount cleanup while Save is adopting media and settles failed saves afterwards', () => {
        expect(source).toContain('const savingRefs = savingPhotoRefsRef.current ?? new Set<string>();');
        expect(source).toContain('if (!savingRefs.has(ref)) void DiaryService.discardUnsavedPhoto(ref);');
        expect(source).toContain('const abandonedComposeSessions = abandonedComposeSessionsRef.current;');
        expect(source).toContain('abandonedComposeSessions.add(composeSessionRef.current);');
        expect(source).toContain('abandonedComposeSessionsRef.current.add(composeSessionRef.current);');
        expect(source).toContain('const abandoned = abandonedComposeSessionsRef.current.delete(composeSession);');
        expect(source).toContain('if (!mediaAdopted && (abandoned || !pageActiveRef.current)) {');
        expect(source).toContain('for (const ref of savePhotoRefs) void DiaryService.discardUnsavedPhoto(ref);');
        expect(source).toContain('if (updateResult.ok) {\n                    mediaAdopted = true;');
        expect(source).toContain('if (entry) {\n                    mediaAdopted = true;');
    });
});
