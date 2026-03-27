/**
 * Safe DOM-based Mapbox marker element builders.
 *
 * Replaces all `el.innerHTML = \`...\`` patterns with programmatic
 * DOM construction to eliminate XSS vectors.
 */

/** Apply a CSS text string to an element */
function applyStyle(el: HTMLElement, css: string): void {
    el.style.cssText = css;
}

/** Create a simple styled div with optional children */
function styledDiv(css: string, children?: (HTMLElement | Text)[]): HTMLDivElement {
    const div = document.createElement('div');
    applyStyle(div, css);
    if (children) children.forEach((c) => div.appendChild(c));
    return div;
}

/** Create a text node */
function text(str: string): Text {
    return document.createTextNode(str);
}

/** Create an SVG element with innerHTML (safe — static SVG, no user input) */
function createSvgElement(svgMarkup: string): HTMLDivElement {
    const wrapper = document.createElement('div');
    // SVG is static developer-authored content, not user input
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgMarkup, 'image/svg+xml');
    const svg = doc.documentElement;
    if (svg && svg.nodeName === 'svg') {
        wrapper.appendChild(document.importNode(svg, true));
    }
    return wrapper;
}

// ── Reusable Marker Factories ──

/**
 * Pin-drop marker: teardrop shape with customizable color and size.
 * Used by usePickerMode, useMapInit, PinMapViewer.
 */
export function createPinMarker(opts?: { size?: number; bg?: string; emoji?: string }): HTMLDivElement {
    const size = opts?.size ?? 24;
    const bg = opts?.bg ?? '#38bdf8';

    const pin = document.createElement('div');
    applyStyle(
        pin,
        `width: ${size}px; height: ${size}px; background: ${bg};
         border: 3px solid #fff; border-radius: 50% 50% 50% 0;
         transform: rotate(-45deg); box-shadow: 0 4px 12px rgba(56,189,248,0.4);
         animation: pinBounce 0.4s ease-out; display: flex; align-items: center;
         justify-content: center;`,
    );

    if (opts?.emoji) {
        const span = document.createElement('span');
        applyStyle(span, `transform: rotate(45deg); font-size: ${Math.round(size * 0.58)}px;`);
        span.textContent = opts.emoji;
        pin.appendChild(span);
    }

    const container = document.createElement('div');
    container.appendChild(pin);
    return container;
}

/**
 * Gradient pin marker used by PinMapViewer (orange→red gradient).
 */
export function createGradientPinMarker(): HTMLDivElement {
    return createPinMarker({
        size: 36,
        bg: 'linear-gradient(135deg, #f59e0b, #ef4444)',
        emoji: '📍',
    });
}

/**
 * Route nudge marker: amber draggable via-point with + icon and tooltip.
 */
export function createNudgeMarkerEl(): HTMLDivElement {
    const container = document.createElement('div');
    applyStyle(container, 'display: flex; flex-direction: column; align-items: center; cursor: grab;');

    // Amber circle with + SVG
    const circle = document.createElement('div');
    applyStyle(
        circle,
        `width: 28px; height: 28px;
         background: linear-gradient(135deg, #f59e0b, #ef4444);
         border: 3px solid #fff; border-radius: 50%;
         box-shadow: 0 0 16px rgba(245,158,11,0.5), 0 4px 12px rgba(0,0,0,0.3);
         animation: pinBounce 0.3s ease-out;
         display: flex; align-items: center; justify-content: center;`,
    );

    const svgStr = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round"><path d="M12 6v12M6 12h12"/></svg>`;
    const svgEl = createSvgElement(svgStr);
    circle.appendChild(svgEl.firstChild!);
    container.appendChild(circle);

    // Tooltip
    const tooltip = document.createElement('div');
    tooltip.className = 'nudge-penalty-tooltip';
    applyStyle(
        tooltip,
        `margin-top: 4px; padding: 2px 8px;
         background: rgba(15,23,42,0.9); border: 1px solid rgba(255,255,255,0.1);
         border-radius: 8px; font-size: 9px; font-weight: 800;
         color: #fbbf24; text-transform: uppercase; letter-spacing: 0.1em;
         white-space: nowrap;`,
    );
    tooltip.textContent = 'Drag to nudge';
    container.appendChild(tooltip);

    return container;
}

/**
 * Wind label marker showing speed (kt) and cardinal direction.
 */
export function createWindLabelMarker(speedKts: number, cardinal: string, bgColor: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'wind-label-marker';
    applyStyle(
        el,
        `display: inline-block; background: ${bgColor};
         color: ${speedKts > 25 ? '#fff' : '#1a1a2e'};
         font-size: 10px; font-weight: 800; line-height: 1.2;
         text-align: center; padding: 3px 6px; border-radius: 6px;
         white-space: nowrap; pointer-events: none; text-shadow: none;
         box-shadow: 0 1px 4px rgba(0,0,0,0.4);
         border: 1px solid rgba(255,255,255,0.15);
         position: relative; z-index: 20;`,
    );

    el.appendChild(text(`${speedKts}kt`));
    el.appendChild(document.createElement('br'));
    el.appendChild(text(cardinal));

    return el;
}

/**
 * Ghost ship SVG marker element.
 */
export function createGhostShipEl(svgMarkup: string): HTMLDivElement {
    const el = document.createElement('div');
    applyStyle(
        el,
        'width:32px;height:32px;opacity:0.6;transition:transform 0.15s ease-out,opacity 0.3s ease;pointer-events:none;',
    );

    const svgEl = createSvgElement(svgMarkup);
    if (svgEl.firstChild) el.appendChild(svgEl.firstChild);

    return el;
}

/**
 * Simple location dot marker.
 */
export function createLocationDotEl(): HTMLDivElement {
    const outer = document.createElement('div');
    applyStyle(outer, 'position:relative; width:20px; height:20px;');

    const pulse = document.createElement('div');
    applyStyle(
        pulse,
        `position:absolute; inset:-6px; border-radius:50%;
         background:rgba(56,189,248,0.25); animation:pulse 2s ease-out infinite;`,
    );
    outer.appendChild(pulse);

    const dot = document.createElement('div');
    applyStyle(
        dot,
        `width:20px; height:20px; border-radius:50%;
         background:radial-gradient(circle,#38bdf8,#0284c7);
         border:3px solid white; box-shadow:0 2px 8px rgba(0,0,0,0.3);`,
    );
    outer.appendChild(dot);

    return outer;
}

export { styledDiv, applyStyle, text, createSvgElement };
