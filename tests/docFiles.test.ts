/**
 * The file a Ship's Document is shared as (binder audit 2026-10-09, DOC-4).
 *
 * A synced attachment is fetched from a signed storage URL whose token is a
 * JWT, "a.b.c": the old `uri.split('.').pop()` read its last segment, missed,
 * and every synced photo of a paper went out as "<name>.pdf". Names lost every
 * letter outside ASCII, so two papers could share one cache file.
 * Fictional papers on fictional boats; global names on purpose.
 */
import { describe, expect, it } from 'vitest';
import { docCacheFileName, docFileExtension } from '../components/vessel/documents/docFiles';

const SIGNED_JPG =
    'https://example-project.supabase.co/storage/v1/object/sign/vessel_vault/u-1/documents/1a2b.jpg?token=aaa.bbb.ccc';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('docFileExtension', () => {
    it('reads the extension from a signed storage URL, not from its JWT token', () => {
        expect(docFileExtension(SIGNED_JPG)).toBe('jpg');
        expect(docFileExtension(SIGNED_JPG.replace('1a2b.jpg', '1a2b.PNG'))).toBe('png');
        expect(docFileExtension('https://example.org/papers/survey.heic#page=1')).toBe('heic');
    });

    it("the downloaded file's own type beats the URL", () => {
        expect(docFileExtension(SIGNED_JPG, 'image/png')).toBe('png');
        expect(docFileExtension(SIGNED_JPG, 'image/jpeg; charset=binary')).toBe('jpg');
        // A type that says nothing falls back to the URL.
        expect(docFileExtension(SIGNED_JPG, 'application/octet-stream')).toBe('jpg');
        expect(docFileExtension(SIGNED_JPG, '')).toBe('jpg');
    });

    it('maps each document type, Word 97 to .doc and Word 2007+ to .docx', () => {
        expect(docFileExtension('data:application/msword;base64,AAAA')).toBe('doc');
        expect(docFileExtension(`data:${DOCX_MIME};base64,AAAA`)).toBe('docx');
        expect(docFileExtension('data:image/heic;base64,AAAA')).toBe('heic');
        expect(docFileExtension('data:image/jpeg;base64,AAAA')).toBe('jpg');
        expect(docFileExtension('data:application/pdf;base64,AAAA')).toBe('pdf');
        expect(docFileExtension(SIGNED_JPG, 'application/msword')).toBe('doc');
        expect(docFileExtension(SIGNED_JPG, DOCX_MIME)).toBe('docx');
    });

    it('anything unknown is a PDF, as before (most papers are)', () => {
        expect(docFileExtension('data:application/x-unknown;base64,AAAA')).toBe('pdf');
        expect(docFileExtension('https://example.org/papers/registration')).toBe('pdf');
        expect(docFileExtension('https://example.org/papers/registration.exe')).toBe('pdf');
        expect(docFileExtension('not a url at all')).toBe('pdf');
    });
});

describe('docCacheFileName', () => {
    const ID_A = '0f1e2d3c-aaaa-4bbb-8ccc-000000000001';
    const ID_B = '9a8b7c6d-aaaa-4bbb-8ccc-000000000002';

    it('keeps Greek, Cyrillic, Japanese and Devanagari names', () => {
        expect(docCacheFileName('Πιστοποιητικό νηολόγησης', ID_A, 'pdf')).toBe('Πιστοποιητικό νηολόγησης-0f1e2d3c.pdf');
        expect(docCacheFileName('Паспорт судна', ID_A, 'jpg')).toBe('Паспорт судна-0f1e2d3c.jpg');
        expect(docCacheFileName('船舶国籍証書', ID_A, 'pdf')).toBe('船舶国籍証書-0f1e2d3c.pdf');
        // Vowel signs and the virama are combining marks: they stay.
        expect(docCacheFileName('पंजीकरण प्रमाणपत्र', ID_A, 'pdf')).toBe('पंजीकरण प्रमाणपत्र-0f1e2d3c.pdf');
    });

    it('a decomposed name is stored composed', () => {
        const decomposed = 'Πιστοποιητικό'.normalize('NFD');
        expect(docCacheFileName(decomposed, ID_A, 'pdf')).toBe('Πιστοποιητικό-0f1e2d3c.pdf');
    });

    it('an empty or all-symbol name is "document"', () => {
        expect(docCacheFileName('', ID_A, 'png')).toBe('document-0f1e2d3c.png');
        expect(docCacheFileName('★★★', ID_A, 'pdf')).toBe('document-0f1e2d3c.pdf');
    });

    it('never carries a path: slashes and dots go', () => {
        const name = docCacheFileName('../etc', ID_A, 'pdf');
        expect(name).toBe('etc-0f1e2d3c.pdf');
        expect(docCacheFileName('Hull insurance 2026/27.v2', ID_A, 'pdf')).toBe('Hull insurance 202627v2-0f1e2d3c.pdf');
        expect(docCacheFileName('a\\b:c', ID_A, 'pdf')).not.toMatch(/[\\/:]/);
    });

    it('two papers with the same name get two files', () => {
        expect(docCacheFileName('Passport', ID_A, 'pdf')).not.toBe(docCacheFileName('Passport', ID_B, 'pdf'));
    });

    it('caps a long name at 60 characters, well inside a 255-byte file name', () => {
        const long = 'Ж'.repeat(300);
        const name = docCacheFileName(long, ID_A, 'docx');
        expect(name).toBe(`${'Ж'.repeat(60)}-0f1e2d3c.docx`);
        expect(new TextEncoder().encode(name).length).toBeLessThan(255);
        const cjk = docCacheFileName('船'.repeat(100), ID_A, 'pdf');
        expect(Array.from(cjk.split('-')[0])).toHaveLength(60);
    });
});
