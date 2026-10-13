/**
 * html2canvasUnavailable — what `import('html2canvas')` resolves to in the app build.
 *
 * jsPDF lists html2canvas as an optional dependency and reaches it through ONE
 * dynamic import, inside its `html()` plugin. Thalassa's PDFs stopped calling
 * doc.html() in 129-10: they draw with text, lines, rectangles and addImage,
 * and services/pdf/pdfText.ts paints any non-Latin run on a plain canvas
 * itself. Left alone, Rollup still emitted html2canvas as a lazy chunk of
 * about 201 KB that nothing could load, and the whole of dist counts against
 * the app's JavaScript budget.
 *
 * vite.config.ts aliases the bare 'html2canvas' specifier to this file. If
 * anything ever calls doc.html() again, jsPDF's own promise chain rejects with
 * the error below instead of rendering. tests/JspdfHtmlStubs.test.ts fails
 * first if app source starts calling `.html(` or imports html2canvas.
 */
export const HTML2CANVAS_UNAVAILABLE_MESSAGE =
    'jsPDF.html is not available: html2canvas is not bundled (see utils/vendorStubs/html2canvasUnavailable.ts)';

export default function html2canvasUnavailable(): never {
    throw new Error(HTML2CANVAS_UNAVAILABLE_MESSAGE);
}
