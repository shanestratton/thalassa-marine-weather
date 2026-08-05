import { internalServerErrorResponse } from './public-errors.ts';

function assert(condition: boolean, message: string): void {
    if (!condition) throw new Error(message);
}

Deno.test('internal error response has a fixed non-diagnostic public contract', async () => {
    const response = internalServerErrorResponse({ 'X-Request-Scope': 'push' });
    const body = await response.text();

    assert(response.status === 500, 'expected HTTP 500');
    assert(response.headers.get('Content-Type') === 'application/json', 'expected JSON content type');
    assert(response.headers.get('X-Request-Scope') === 'push', 'expected supplied safe header');
    assert(body === '{"error":"Internal server error"}', 'expected fixed public body');
    assert(!body.includes('stack') && !body.includes('Error:'), 'response must not expose exception diagnostics');
});
