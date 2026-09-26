/**
 * scaleBarLabel — gives Mapbox's scale bar a spoken name.
 *
 * The control is a bare text node ("300 nm"): VoiceOver can read "nm" as
 * nanometres, and nothing says it is a scale (UX scorecard run 7). The bar
 * becomes role="img" named "Scale: 300 nautical miles", kept in step with the
 * text Mapbox rewrites on every move (on its own DOM-task frame, hence the
 * observer rather than a map event). Only the scale is touched; the licence
 * credits beside it are not.
 */

/** "300 nm" → "Scale: 300 nautical miles"; null while the bar is empty. */
export function scaleBarLabel(text: string | null | undefined): string | null {
    const shown = (text ?? '').replace(/\s+/g, ' ').trim();
    if (!shown) return null;
    const nautical = /^([\d.,]+) ?nm$/i.exec(shown);
    if (nautical) {
        const amount = nautical[1];
        return `Scale: ${amount} nautical ${amount === '1' ? 'mile' : 'miles'}`;
    }
    return `Scale: ${shown}`;
}

/**
 * Label the scale bar inside `mapContainer` and keep the label current.
 * A no-op (returning a no-op) when there is no scale bar to label.
 */
export function installScaleBarLabel(mapContainer: Element | null | undefined): () => void {
    const bar = mapContainer?.querySelector<HTMLElement>('.mapboxgl-ctrl-scale');
    if (!bar) return () => {};
    const sync = () => {
        const label = scaleBarLabel(bar.textContent);
        if (!label || bar.getAttribute('aria-label') === label) return;
        // An image needs its name, so the role waits for the first reading.
        bar.setAttribute('role', 'img');
        bar.setAttribute('aria-label', label);
    };
    sync();
    if (typeof MutationObserver === 'undefined') return () => {};
    const observer = new MutationObserver(sync);
    observer.observe(bar, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
}
