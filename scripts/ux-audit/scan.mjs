export const SCAN = `(() => {
    const vw = innerWidth, vh = innerHeight;
    const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0.05 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw; };
    const nameOf = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || (el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.textContent) || el.querySelector('img[alt]')?.getAttribute('alt') || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
    // Any CSS colour (oklch, oklab, color-mix…) → rgba, via a 1x1 canvas. Tailwind v4 emits oklch, and a
    // regex that only knew rgb() silently fell back to the dark page colour in daylight mode.
    const cvs = document.createElement('canvas'); cvs.width = cvs.height = 1; const cx = cvs.getContext('2d', { willReadFrequently: true });
    const parse = (c) => { if (!c || c === 'transparent') return null; const m = /rgba?\\(([^)]+)\\)/.exec(c); if (m) { const p = m[1].split(/[\\s,\\/]+/).filter(Boolean).map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? (m[1].includes('%') && p[3] > 1 ? p[3] / 100 : p[3]) : 1 }; } try { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 }; } catch { return null; } };
    const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
    const base = parse(getComputedStyle(document.body).backgroundColor); const pageBase = base && base.a > 0 ? base : { r: 2, g: 6, b: 23, a: 1 };
    const effBg = (el) => { let node = el, layers = []; let translucent = false; while (node && node !== document.documentElement) { const cs = getComputedStyle(node); const bg = parse(cs.backgroundColor); if (bg && bg.a > 0) { layers.push(bg); if (bg.a >= 0.99) break; translucent = true; } if (cs.backdropFilter && cs.backdropFilter !== 'none') translucent = true; if (cs.backgroundImage && cs.backgroundImage !== 'none') translucent = true; node = node.parentElement; } let out = pageBase; for (const l of layers.reverse()) out = over(l, out); return { bg: out, translucent, layers: layers.length }; };
    const small = [], contrast = [], tiny = [], unlabelled = [], truncated = [], offRight = [];
    const seenText = new Set();
    for (const el of document.querySelectorAll('body *')) {
        if (!visible(el)) continue;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (r.right > vw + 1 && r.left < vw) offRight.push({ tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 60), right: Math.round(r.right) });
        const ownText = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim();
        if (ownText) {
            const fs = parseFloat(cs.fontSize);
            const key = ownText.slice(0, 40) + '|' + fs;
            if (fs < 12 && !seenText.has(key)) { seenText.add(key); small.push({ text: ownText.slice(0, 50), px: Math.round(fs * 10) / 10, tag: el.tagName.toLowerCase() }); }
            const fg = parse(cs.color); if (fg) { const { bg, translucent } = effBg(el); const fgc = fg.a < 1 ? over(fg, bg) : fg; const L1 = lum(fgc), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05); const bold = parseInt(cs.fontWeight) >= 700; const large = fs >= 24 || (fs >= 18.66 && bold); const need = large ? 3 : 4.5; if (ratio < need && !seenText.has('c|' + key)) { seenText.add('c|' + key); contrast.push({ text: ownText.slice(0, 50), px: Math.round(fs), ratio: Math.round(ratio * 100) / 100, need, translucent, color: cs.color, bg: 'rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + ')' }); } }
            if (cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) truncated.push({ text: ownText.slice(0, 60), w: Math.round(r.width) });
        }
        const inter = el.matches('button, a[href], [role=button], [role=tab], [role=switch], [role=slider], [role=menuitem], input, select, textarea, summary') || (el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1');
        if (inter) {
            const padded = el.matches('.hit-target-44, .hit-target-44 *') || !!el.closest('.hit-target-44');
            if (!padded && (r.width < 44 || r.height < 44) && !el.matches('input[type=range], [role=slider], [role=tab]') ) tiny.push({ tag: el.tagName.toLowerCase(), name: nameOf(el), w: Math.round(r.width), h: Math.round(r.height) });
            if (el.matches('button, a[href], [role=button], [role=tab]') && !nameOf(el)) unlabelled.push({ tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 80), w: Math.round(r.width), h: Math.round(r.height) });
        }
    }
    const imgs = [...document.querySelectorAll('img')].filter(visible).filter((i) => !i.hasAttribute('alt')).length;
    return { vw, vh, docScrollW: document.documentElement.scrollWidth, small, contrast, tiny, unlabelled, truncated, offRight: offRight.slice(0, 20), imgsNoAlt: imgs, headings: document.querySelectorAll('h1,h2').length, landmarks: { main: document.querySelectorAll('main').length, nav: document.querySelectorAll('nav').length }, buttons: document.querySelectorAll('button').length, focusables: document.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])').length, titleText: document.title, dialogs: document.querySelectorAll('[role=dialog]').length };
})()`;
