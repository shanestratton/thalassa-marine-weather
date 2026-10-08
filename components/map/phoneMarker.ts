/**
 * The phone's own mark on the chart: a little phone, not a dot (build 124).
 *
 * Shane 2026-10-08: "can we have a little picture of a mobile phone when we
 * are not using the vessel location on the obs page ... so i have the yacht
 * at airlie beach. but if i want to know my own personal location ... a
 * little image of a mobile phone shows up where my phone is". The 8 px blue
 * dot it replaces was easy to miss on a busy chart and never said whose it
 * was: a white phone in a blue badge says it at a glance, and reads on every
 * base (the white rim and the shadow carry it over relief and satellite).
 *
 * Dependency-free on purpose: the e2e fixture draws this very element, and
 * the locate button draws the same phone.
 */

/** The phone's outline, in a 24-unit box: body, then the home bar. Stroked, never filled. */
export const PHONE_GLYPH_PATHS = [
    'M8.5 2.5h7a2 2 0 0 1 2 2v15a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-15a2 2 0 0 1 2-2z',
    'M11 18h2',
];

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The marker's element: div.loc-dot (the class the chart and its tests know)
 * holding the phone. The caller names it (aria-label), as its fix allows.
 */
export function createPhoneMarkerElement(): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'loc-dot';
    el.dataset.source = 'phone';
    el.setAttribute('role', 'img');
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.dataset.glyph = 'phone';
    for (const d of PHONE_GLYPH_PATHS) {
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', d);
        svg.appendChild(path);
    }
    el.appendChild(svg);
    return el;
}
