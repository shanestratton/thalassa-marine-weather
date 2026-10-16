import express, { type RequestHandler } from 'express';
/** Wake mutations authenticate first, then enforce their own smaller raw-byte cap. */
export function createAppJsonParser(unsafeAdmin: boolean): RequestHandler {
    const parse = express.json({ limit: unsafeAdmin ? '100mb' : '64kb' });
    return (req, res, next) => {
        const path = req.path.toLowerCase();
        if (path === '/api/wake-rules' || path.startsWith('/api/wake-rules/')) return next();
        return parse(req, res, next);
    };
}
