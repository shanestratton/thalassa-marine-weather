/**
 * Colour bars for map palettes (test-only): WCAG 2 contrast, CIEDE2000 and
 * the Machado (2009) colour-vision simulations at full severity. The same
 * maths the 127-DESKMAP investigation measured the Light base with
 * (scratch harness contrast.cjs / flat3.cjs), so the tests hold the palette to
 * the numbers the plan was decided on.
 */

export type Vision = 'normal' | 'deutan' | 'protan' | 'tritan';

const MACHADO: Record<Exclude<Vision, 'normal'>, number[][]> = {
    protan: [
        [0.152286, 1.052583, -0.204868],
        [0.114503, 0.786281, 0.099216],
        [-0.003882, -0.048116, 1.051998],
    ],
    deutan: [
        [0.367322, 0.860646, -0.227968],
        [0.280085, 0.672501, 0.047413],
        [-0.01182, 0.04294, 0.968881],
    ],
    tritan: [
        [1.255528, -0.076749, -0.178779],
        [-0.078411, 0.930809, 0.147602],
        [0.004733, 0.691367, 0.3039],
    ],
};

/** '#rrggbb' → [r, g, b] in 0..1. */
function rgb(hex: string): [number, number, number] {
    const h = hex.replace('#', '');
    if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error(`not a #rrggbb colour: ${hex}`);
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
}

const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function linearRgb(hex: string, vision: Vision): [number, number, number] {
    const l = rgb(hex).map(linear) as [number, number, number];
    if (vision === 'normal') return l;
    return MACHADO[vision].map((row) => Math.min(1, Math.max(0, row[0] * l[0] + row[1] * l[1] + row[2] * l[2]))) as [
        number,
        number,
        number,
    ];
}

const luminance = (hex: string) => {
    const [r, g, b] = linearRgb(hex, 'normal');
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG 2 contrast ratio, 1..21. */
export function contrast(a: string, b: string): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

function lab([r, g, b]: [number, number, number]): [number, number, number] {
    const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
    const [fx, fy, fz] = [f(x), f(y), f(z)];
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function ciede2000([L1, a1, b1]: number[], [L2, a2, b2]: number[]): number {
    const rad = Math.PI / 180;
    const Cb = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
    const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
    const a1p = (1 + G) * a1;
    const a2p = (1 + G) * a2;
    const C1p = Math.hypot(a1p, b1);
    const C2p = Math.hypot(a2p, b2);
    const hue = (x: number, y: number) => {
        if (x === 0 && y === 0) return 0;
        const v = Math.atan2(y, x) / rad;
        return v < 0 ? v + 360 : v;
    };
    const h1p = hue(a1p, b1);
    const h2p = hue(a2p, b2);
    const dL = L2 - L1;
    const dC = C2p - C1p;
    let dh = 0;
    if (C1p * C2p !== 0) {
        dh = h2p - h1p;
        if (dh > 180) dh -= 360;
        else if (dh < -180) dh += 360;
    }
    const dH = 2 * Math.sqrt(C1p * C2p) * Math.sin((dh / 2) * rad);
    const Lb = (L1 + L2) / 2;
    const Cbp = (C1p + C2p) / 2;
    let hb = h1p + h2p;
    if (C1p * C2p !== 0) {
        hb = Math.abs(h1p - h2p) > 180 ? (h1p + h2p + (h1p + h2p < 360 ? 360 : -360)) / 2 : (h1p + h2p) / 2;
    }
    const T =
        1 -
        0.17 * Math.cos((hb - 30) * rad) +
        0.24 * Math.cos(2 * hb * rad) +
        0.32 * Math.cos((3 * hb + 6) * rad) -
        0.2 * Math.cos((4 * hb - 63) * rad);
    const dTh = 30 * Math.exp(-(((hb - 275) / 25) ** 2));
    const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
    const Sl = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2);
    const Sc = 1 + 0.045 * Cbp;
    const Sh = 1 + 0.015 * Cbp * T;
    const Rt = -Math.sin(2 * dTh * rad) * Rc;
    return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
}

/** CIEDE2000 between two colours as a viewer with `vision` sees them. */
export function deltaE(a: string, b: string, vision: Vision = 'normal'): number {
    return ciede2000(lab(linearRgb(a, vision)), lab(linearRgb(b, vision)));
}

export const VISIONS: readonly Vision[] = ['normal', 'deutan', 'protan', 'tritan'];
