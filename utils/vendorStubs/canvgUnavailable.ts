/**
 * canvgUnavailable — what `import('canvg')` resolves to in the app build.
 *
 * jsPDF lists canvg as an optional dependency and reaches it through ONE
 * dynamic import, inside `jsPDF.addSvgAsImage`. Thalassa never calls that
 * method: the PDFs it builds use text, tables, addImage and `doc.html()`
 * (html2canvas + DOMPurify, which stay bundled). Left alone, Rollup still
 * emitted canvg as a lazy chunk of about 159 KB (canvg, its core-js
 * polyfills, svg-pathdata, stackblur and rgbcolor) that nothing could load,
 * and the whole of dist counts against the app's JavaScript budget.
 *
 * vite.config.ts aliases the bare 'canvg' specifier to this file. If
 * anything ever calls addSvgAsImage, jsPDF's own promise chain rejects with
 * the error below instead of rasterising the SVG. tests/JspdfCanvgStub.test.ts
 * fails first if app source starts calling addSvgAsImage or imports canvg.
 */
export const CANVG_UNAVAILABLE_MESSAGE =
    'jsPDF.addSvgAsImage is not available: canvg is not bundled (see utils/vendorStubs/canvgUnavailable.ts)';

const canvgUnavailable = {
    fromString(): never {
        throw new Error(CANVG_UNAVAILABLE_MESSAGE);
    },
};

export default canvgUnavailable;
