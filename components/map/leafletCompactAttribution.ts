import L from 'leaflet';

/**
 * Collapse a Leaflet map's attribution control to a Mapbox-style ⓘ button
 * (Shane 2026-08-13: "we are suppose to be hiding the wording at the bottom
 * of the map … it was going to be hidden behind an 'i'").
 *
 * LICENCE NOTE — this is the compact-attribution pattern, not a hide. OSM's
 * attribution guidance (and Mapbox GL's own compact control, the precedent)
 * accepts credits collapsed behind an ⓘ toggle on small maps, provided one
 * tap reveals the full text. What the tile licences forbid is removal. The
 * collapsed/expanded styling lives in index.css under
 * `.thalassa-attribution-compact`; tests/MapAttributionContract.test.ts
 * enforces that the expanded state exists and this helper stays wired.
 *
 * Leaflet already calls disableClickPropagation on the attribution control,
 * so toggling here cannot leak into map 'click' handlers (LiveMiniMap's
 * tap-to-expand rides on map clicks).
 */
export function installCompactAttribution(map: L.Map): void {
    const control = (map as L.Map & { attributionControl?: L.Control.Attribution }).attributionControl;
    const container =
        control?.getContainer() ?? map.getContainer().querySelector<HTMLElement>('.leaflet-control-attribution');
    if (!container) return;
    container.classList.add('thalassa-attribution-compact');
    container.setAttribute('role', 'button');
    container.setAttribute('aria-label', 'Map credits');
    container.setAttribute('aria-expanded', 'false');
    container.addEventListener('click', (event) => {
        // Links inside the OPEN pill must stay tappable without re-collapsing
        // the control underneath the tap.
        if (event.target instanceof HTMLAnchorElement && container.classList.contains('is-open')) return;
        const open = container.classList.toggle('is-open');
        container.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
}
