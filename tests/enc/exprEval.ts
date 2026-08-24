/**
 * Minimal Mapbox-GL expression evaluator for tests — just the ops the
 * ENC depth-style expressions use, with Mapbox's documented semantics
 * for the traps that matter to chart safety:
 *   - to-number(null) → 0 (NOT an error);
 *   - to-number(garbage string) → error, falls through to the next arg;
 *   - coalesce skips ERRORS as well as nulls;
 *   - round() rounds halfway values away from zero.
 * Keeping these faithful is the point: the production bugs this guards
 * against (unknown DRVAL1 reading as deep, "0 m" contour labels) were
 * exactly interactions of these semantics.
 */

export class ExprError extends Error {}

export interface ExprCtx {
    props?: Record<string, unknown>;
    zoom?: number;
}

export function evalExpr(expr: unknown, ctx: ExprCtx = {}): unknown {
    if (!Array.isArray(expr)) return expr;
    const [op, ...args] = expr as [string, ...unknown[]];
    const ev = (e: unknown): unknown => evalExpr(e, ctx);
    const num = (e: unknown): number => {
        const v = ev(e);
        if (typeof v !== 'number' || !Number.isFinite(v)) {
            throw new ExprError(`expected number, got ${JSON.stringify(v)}`);
        }
        return v;
    };

    switch (op) {
        case 'literal':
            return args[0];
        case 'get':
            return ctx.props?.[args[0] as string] ?? null;
        case 'has':
            return ctx.props != null && (args[0] as string) in ctx.props && ctx.props[args[0] as string] !== undefined;
        case 'zoom':
            if (ctx.zoom === undefined) throw new ExprError('zoom not provided');
            return ctx.zoom;
        case 'to-number': {
            let lastErr: unknown = new ExprError('to-number: no args');
            for (const arg of args) {
                try {
                    const v = ev(arg);
                    if (v === null) return 0;
                    if (typeof v === 'number') return v;
                    if (typeof v === 'boolean') return v ? 1 : 0;
                    if (typeof v === 'string' && v.trim() !== '') {
                        const n = Number(v);
                        if (Number.isFinite(n)) return n;
                    }
                    throw new ExprError(`to-number failed on ${JSON.stringify(v)}`);
                } catch (e) {
                    lastErr = e;
                }
            }
            throw lastErr;
        }
        case 'to-string': {
            const v = ev(args[0]);
            return v === null ? '' : String(v);
        }
        case 'coalesce': {
            for (const arg of args) {
                try {
                    const v = ev(arg);
                    if (v !== null) return v;
                } catch {
                    /* coalesce skips errors — the Mapbox trap */
                }
            }
            return null;
        }
        case 'case': {
            for (let i = 0; i + 1 < args.length; i += 2) {
                if (ev(args[i])) return ev(args[i + 1]);
            }
            return ev(args[args.length - 1]);
        }
        case 'interpolate': {
            // Linear only — that is all the style expressions use, and a
            // silently-wrong exponential would be worse than an error.
            const [curve, input, ...stops] = args as [unknown[], unknown, ...unknown[]];
            if (!Array.isArray(curve) || curve[0] !== 'linear') {
                throw new ExprError(`unsupported interpolate curve: ${JSON.stringify(curve)}`);
            }
            const x = num(ev(input));
            const pts: { at: number; v: number }[] = [];
            for (let i = 0; i + 1 < stops.length; i += 2) pts.push({ at: num(stops[i]), v: num(ev(stops[i + 1])) });
            if (pts.length === 0) throw new ExprError('interpolate with no stops');
            if (x <= pts[0].at) return pts[0].v;
            if (x >= pts[pts.length - 1].at) return pts[pts.length - 1].v;
            for (let i = 1; i < pts.length; i++) {
                if (x <= pts[i].at) {
                    const a = pts[i - 1];
                    const b = pts[i];
                    const t = b.at === a.at ? 0 : (x - a.at) / (b.at - a.at);
                    return a.v + t * (b.v - a.v);
                }
            }
            return pts[pts.length - 1].v;
        }
        case 'step': {
            const input = num(args[0]);
            let out = args[1];
            for (let i = 2; i + 1 < args.length; i += 2) {
                if (input >= (args[i] as number)) out = args[i + 1];
                else break;
            }
            return ev(out);
        }
        case 'match': {
            const input = ev(args[0]);
            for (let i = 1; i + 1 < args.length - 1; i += 2) {
                const label = args[i];
                const hit = Array.isArray(label) ? (label as unknown[]).includes(input) : label === input;
                if (hit) return ev(args[i + 1]);
            }
            return ev(args[args.length - 1]);
        }
        case 'all':
            return args.every((a) => Boolean(ev(a)));
        case 'any':
            return args.some((a) => Boolean(ev(a)));
        case '!':
            return !ev(args[0]);
        case '==':
            return ev(args[0]) === ev(args[1]);
        case '!=':
            return ev(args[0]) !== ev(args[1]);
        case '<':
            return num(args[0]) < num(args[1]);
        case '<=':
            return num(args[0]) <= num(args[1]);
        case '>':
            return num(args[0]) > num(args[1]);
        case '>=':
            return num(args[0]) >= num(args[1]);
        case '+':
            return args.reduce<number>((s, a) => s + num(a), 0);
        case '*':
            return args.reduce<number>((s, a) => s * num(a), 1);
        case '-':
            return args.length === 1 ? -num(args[0]) : num(args[0]) - num(args[1]);
        case '/':
            return num(args[0]) / num(args[1]);
        case '%':
            return num(args[0]) % num(args[1]);
        case 'abs':
            return Math.abs(num(args[0]));
        case 'floor':
            return Math.floor(num(args[0]));
        case 'round': {
            // Mapbox rounds halfway values AWAY FROM ZERO (JS Math.round
            // rounds toward +Infinity — differs for negatives).
            const v = num(args[0]);
            return Math.sign(v) * Math.round(Math.abs(v));
        }
        case 'concat':
            return args
                .map((a) => {
                    const v = ev(a);
                    return v === null ? '' : String(v);
                })
                .join('');
        case 'at': {
            const i = num(args[0]);
            const arr = ev(args[1]);
            if (!Array.isArray(arr)) throw new ExprError('at: not an array');
            return arr[i];
        }
        default:
            throw new ExprError(`unsupported op: ${String(op)}`);
    }
}

/**
 * Mapbox's paint/layout rule this homemade evaluator cannot feel: ['zoom']
 * may appear ONLY as the direct input of a TOP-LEVEL 'step' or
 * 'interpolate'. b3b065ed (2026-08-23) nested a zoom interpolate inside
 * step outputs; the real Style.setPaintProperty rejected the property at
 * runtime, the glaze painted nothing for two days, and CI stayed green
 * because evalExpr happily evaluates the illegal shape. Paint-expression
 * tests call this alongside evalExpr so the class cannot ship again.
 * (Filters are exempt in Mapbox — do not apply this to filter builders.)
 */
export function assertZoomTopLevelOnly(expr: unknown): void {
    const usesZoom = (e: unknown): boolean =>
        Array.isArray(e) && ((e as unknown[])[0] === 'zoom' || (e as unknown[]).some(usesZoom));
    if (!Array.isArray(expr)) return;
    const [op, ...rest] = expr as [string, ...unknown[]];
    let input: unknown;
    let others: unknown[];
    if (op === 'interpolate') {
        input = rest[1];
        others = [rest[0], ...rest.slice(2)];
    } else if (op === 'step') {
        input = rest[0];
        others = rest.slice(1);
    } else {
        input = undefined;
        others = rest;
    }
    const inputIsBareZoom =
        Array.isArray(input) && (input as unknown[]).length === 1 && (input as unknown[])[0] === 'zoom';
    if (!inputIsBareZoom && usesZoom(input)) {
        throw new ExprError("['zoom'] must BE the input of the top-level step/interpolate, not nested inside it");
    }
    for (const o of others) {
        if (usesZoom(o)) {
            throw new ExprError(
                "['zoom'] outside a top-level step/interpolate input — Mapbox rejects this paint expression",
            );
        }
    }
}
