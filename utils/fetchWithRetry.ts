/**
 * fetchWithRetry — Resilient HTTP client with exponential backoff.
 *
 * Retries on network failures and 5xx server errors (not 4xx client errors).
 * Includes jitter to prevent thundering herd when multiple requests retry.
 */

interface RetryOptions {
    /** Maximum number of retry attempts (default: 3) */
    maxRetries?: number;
    /** Base delay in ms before first retry (default: 1000) */
    baseDelayMs?: number;
    /** Maximum delay in ms between retries (default: 10000) */
    maxDelayMs?: number;
    /** AbortSignal for cancellation */
    signal?: AbortSignal;
    /** Optional callback on each retry attempt */
    onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

/**
 * Fetch with automatic retry and exponential backoff.
 *
 * @example
 * ```ts
 * const response = await fetchWithRetry('https://api.example.com/data', {
 *   headers: { 'Content-Type': 'application/json' },
 * }, { maxRetries: 3 });
 * ```
 */
export async function fetchWithRetry(
    url: string | URL,
    init?: RequestInit,
    options?: RetryOptions,
): Promise<Response> {
    const {
        maxRetries = 3,
        baseDelayMs = 1000,
        maxDelayMs = 10_000,
        signal,
        onRetry,
    } = options ?? {};

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(url, { ...init, signal });

            // Don't retry on client errors (4xx) — those won't change
            if (response.ok || (response.status >= 400 && response.status < 500)) {
                return response;
            }

            // Server error (5xx) — retry
            lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
        } catch (err) {
            // Network error or abort
            if (signal?.aborted) throw err;
            lastError = err instanceof Error ? err : new Error(String(err));
        }

        // Don't delay after the last attempt
        if (attempt < maxRetries) {
            // Exponential backoff with jitter: delay = min(base * 2^attempt + jitter, max)
            const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
            const jitter = Math.random() * baseDelayMs * 0.5;
            const delayMs = Math.min(exponentialDelay + jitter, maxDelayMs);

            onRetry?.(attempt + 1, lastError!, delayMs);

            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }

    throw lastError ?? new Error(`fetchWithRetry: all ${maxRetries} retries exhausted for ${url}`);
}

/**
 * Convenience wrapper that also parses JSON response.
 */
export async function fetchJsonWithRetry<T>(
    url: string | URL,
    init?: RequestInit,
    options?: RetryOptions,
): Promise<T> {
    const response = await fetchWithRetry(url, init, options);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.json() as Promise<T>;
}
