/**
 * dompurifyUnavailable — what `import('dompurify')` resolves to in the app build.
 *
 * jsPDF lists DOMPurify as an optional dependency and reaches it through ONE
 * dynamic import, inside its `html()` plugin, to clean the HTML it is about to
 * render. Nothing else in the app sanitises with it: no app source imports it,
 * and jsPDF is the only package in package-lock.json that depends on it
 * (checked 2026-10-13, 129-10). Thalassa stopped calling doc.html() in 129-10,
 * so the ~29 KB lazy chunk could never load.
 *
 * vite.config.ts aliases the bare 'dompurify' specifier to this file. If
 * anything ever calls doc.html() again, jsPDF's promise chain rejects with the
 * error below rather than rendering unsanitised HTML. Anything that needs to
 * sanitise HTML must remove the alias and import DOMPurify for real;
 * tests/JspdfHtmlStubs.test.ts fails first if app source imports it.
 */
export const DOMPURIFY_UNAVAILABLE_MESSAGE =
    'DOMPurify is not bundled (see utils/vendorStubs/dompurifyUnavailable.ts); jsPDF.html is not available';

const dompurifyUnavailable = {
    sanitize(): never {
        throw new Error(DOMPURIFY_UNAVAILABLE_MESSAGE);
    },
};

export default dompurifyUnavailable;
