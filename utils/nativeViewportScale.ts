/**
 * The iPhone app's screens never zoom.
 *
 * Shane 2026-09-29: "sometimes the screen goes big, and i can not make it go
 * back to the normal size". On a phone the fluid root font (clamp 13–17 px)
 * leaves most text fields under 16 px, and iOS zooms the page to any focused
 * field under 16 px. The page-pinch blocker in index.tsx then stopped the very
 * pinch that would have zoomed it back out, and the WKWebView itself does not
 * scroll (capacitor.config ios.scrollEnabled: false), so the page stayed big
 * until the app was relaunched.
 *
 * Native only. WKWebView honours `maximum-scale=1, user-scalable=no` (Safari
 * ignores it, and Capacitor leaves ignoresViewportScaleLimits off), which
 * stops the focus zoom, double-tap zoom and page pinch at the source; the
 * chart zooms itself from raw touch events and is not affected. The web build
 * keeps index.html's zoomable viewport, which the Lighthouse zoom audit checks.
 */
export const NATIVE_VIEWPORT_CONTENT =
    'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';

/** Anything above this is a zoom, not float noise in visualViewport.scale. */
const ZOOMED_SCALE = 1.01;

export function lockNativeViewportScale(doc: Document, win: Window): () => void {
    let meta = doc.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!meta) {
        meta = doc.createElement('meta');
        meta.name = 'viewport';
        doc.head.appendChild(meta);
    }
    const viewportMeta = meta;
    viewportMeta.setAttribute('content', NATIVE_VIEWPORT_CONTENT);

    // Belt and braces: a zoom that slips through anyway (a WebKit edge case,
    // a build that shipped before this lock) snaps back instead of sticking.
    // WebKit re-applies the scale limits when the content CHANGES, so it is
    // written once with a harmless extra key and then restored.
    let restoring = false;
    const heal = () => {
        const scale = win.visualViewport?.scale ?? 1;
        if (restoring || !(scale > ZOOMED_SCALE)) return;
        restoring = true;
        viewportMeta.setAttribute('content', `${NATIVE_VIEWPORT_CONTENT}, shrink-to-fit=no`);
        win.requestAnimationFrame(() => {
            viewportMeta.setAttribute('content', NATIVE_VIEWPORT_CONTENT);
            restoring = false;
        });
    };
    win.visualViewport?.addEventListener('resize', heal);
    doc.addEventListener('focusout', heal);
    return () => {
        win.visualViewport?.removeEventListener('resize', heal);
        doc.removeEventListener('focusout', heal);
    };
}
