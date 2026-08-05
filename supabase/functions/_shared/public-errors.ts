const INTERNAL_ERROR_MESSAGE = 'Internal server error';

/** A fixed error response whose API cannot accidentally accept exception details. */
export function internalServerErrorResponse(headers: HeadersInit = {}): Response {
    const responseHeaders = new Headers(headers);
    if (!responseHeaders.has('Content-Type')) responseHeaders.set('Content-Type', 'application/json');
    return new Response(JSON.stringify({ error: INTERNAL_ERROR_MESSAGE }), {
        status: 500,
        headers: responseHeaders,
    });
}
