/**
 * The file a Ship's Document is written as before it goes to the share sheet
 * (binder audit 2026-10-09, DOC-4). Pure: no Capacitor, no network.
 *
 * A synced attachment comes from a signed storage URL,
 * `…/object/sign/vessel_vault/<uid>/documents/<id>.jpg?token=<JWT a.b.c>`. The
 * old `uri.split('.').pop()` read the JWT's last segment, missed, and every
 * synced photo of a paper went out as "<name>.pdf", unopenable. Names lost every
 * letter outside ASCII, so a Greek, Cyrillic or Japanese title became
 * "document.pdf" and two papers could share one cache file.
 *
 * 126-B3 (offline Documents) builds on this module. SyncService keeps its own
 * attachment maps for uploads; they are not shared yet, so the binders' sync
 * code stays untouched.
 */

/** The extensions a document is saved as (DocumentForm accepts these). */
const EXTENSIONS = new Set(['pdf', 'jpg', 'jpeg', 'png', 'heic', 'doc', 'docx']);

/** Content type → extension. Word 97 is msword → .doc; Word 2007+ is the OOXML type → .docx. */
const BY_TYPE: Record<string, string> = {
    'application/pdf': 'pdf',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/heic': 'heic',
    'image/heif': 'heic',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

/** The legacy default, kept: most papers are PDFs. */
const FALLBACK = 'pdf';

function extensionForType(contentType: string | null | undefined): string | null {
    const type = contentType?.split(';', 1)[0].trim().toLowerCase();
    return (type && BY_TYPE[type]) || null;
}

function extensionOfPath(uri: string): string | null {
    let path: string;
    try {
        path = new URL(uri).pathname;
    } catch {
        return null;
    }
    const name = path.split('/').pop() ?? '';
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return null;
    const ext = name.slice(dot + 1).toLowerCase();
    return EXTENSIONS.has(ext) ? ext : null;
}

/**
 * The extension to save a document as: the downloaded file's own content type
 * first (storage serves what the upload declared), then a data: URI's type or
 * the URL path's extension (never its query string), else 'pdf'.
 */
export function docFileExtension(uri: string, blobType?: string | null): string {
    const fromBlob = extensionForType(blobType);
    if (fromBlob) return fromBlob;
    if (uri.startsWith('data:')) {
        return extensionForType(uri.slice(5).split(/[;,]/, 1)[0]) ?? FALLBACK;
    }
    return extensionOfPath(uri) ?? FALLBACK;
}

/** Longest name kept, in characters: 60 four-byte ones still fit iOS's 255-byte file names. */
const NAME_CAP = 60;

/**
 * A cache file name for a document: its name in any script (letters, digits,
 * the marks that complete them, spaces, '_' and '-'; never a path), then the
 * first 8 characters of its id, so two papers called "Passport" are two files.
 */
export function docCacheFileName(name: string, id: string, ext: string): string {
    const slug = Array.from(
        (name ?? '')
            .normalize('NFC')
            .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
            // A mark left with nothing to sit on (an emoji's variation selector).
            .replace(/(^|[^\p{L}\p{N}\p{M}])\p{M}+/gu, '$1')
            .trim(),
    )
        .slice(0, NAME_CAP)
        .join('')
        .trim();
    const tag = (id ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
    return `${slug || 'document'}${tag ? `-${tag}` : ''}.${ext}`;
}
