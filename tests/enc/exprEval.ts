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
