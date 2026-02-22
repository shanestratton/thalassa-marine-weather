/**
 * ResumableGribFetcher — Iridium-resilient, resumable download manager.
 *
 * Uses native fetch + Range headers to resume partial downloads after
 * satellite link drops. Streams response chunks via ReadableStream to
 * avoid holding large GRIB files in RAM.
 */

export interface FetchProgress {
    downloadedBytes: number;
    totalBytes: number | null;
    attempt: number;
}

export interface ResumableGribFetcherOptions {
    /** Maximum retry attempts before giving up. Default: 10 */
    maxRetries?: number;
    /** Delay between retries in ms. Default: 5000 */
    retryDelay?: number;
    /** Optional AbortSignal for cancellation. */
    signal?: AbortSignal;
    /** Progress callback fired after every chunk. */
    onProgress?: (progress: FetchProgress) => void;
}

export class ResumableGribFetcher {
    private readonly url: string;
    private readonly maxRetries: number;
    private readonly retryDelay: number;
    private readonly signal?: AbortSignal;
    private readonly onProgress?: (progress: FetchProgress) => void;

    private downloadedBytes = 0;
    private totalBytes: number | null = null;
    private chunks: Uint8Array[] = [];
    private attempt = 0;

    constructor(url: string, options: ResumableGribFetcherOptions = {}) {
        this.url = url;
        this.maxRetries = options.maxRetries ?? 10;
        this.retryDelay = options.retryDelay ?? 5000;
        this.signal = options.signal;
        this.onProgress = options.onProgress;
    }

    /**
     * Execute the download. Resumes automatically on network failure.
     * Returns the complete file as an ArrayBuffer.
     */
    async fetch(): Promise<ArrayBuffer> {
        return this.fetchWithResume();
    }

    private async fetchWithResume(): Promise<ArrayBuffer> {
        this.attempt++;

        if (this.attempt > this.maxRetries + 1) {
            throw new Error(
                `[ResumableGribFetcher] Exhausted ${this.maxRetries} retries after ${this.downloadedBytes} bytes`,
            );
        }

        const headers: Record<string, string> = {};
        if (this.downloadedBytes > 0) {
            headers['Range'] = `bytes=${this.downloadedBytes}-`;
        }

        let response: Response;
        try {
            response = await fetch(this.url, {
                headers,
                signal: this.signal,
            });
        } catch (err: unknown) {
            // Network error (satellite drop, DNS failure, etc.)
            if (this.signal?.aborted) throw err;

            console.warn(
                `[ResumableGribFetcher] Network error on attempt ${this.attempt}, ` +
                `${this.downloadedBytes} bytes so far. Retrying in ${this.retryDelay}ms...`,
                err,
            );
            await this.sleep(this.retryDelay);
            return this.fetchWithResume();
        }

        // Parse total size from Content-Range or Content-Length
        if (this.totalBytes === null) {
            const contentRange = response.headers.get('Content-Range');
            if (contentRange) {
                // Format: bytes 0-1023/4096
                const match = contentRange.match(/\/(\d+)$/);
                if (match) this.totalBytes = parseInt(match[1], 10);
            } else {
                const cl = response.headers.get('Content-Length');
                if (cl) this.totalBytes = parseInt(cl, 10);
            }
        }

        // 416 = Range Not Satisfiable → download is already complete
        if (response.status === 416) {
            return this.assembleResult();
        }

        if (!response.ok && response.status !== 206) {
            throw new Error(
                `[ResumableGribFetcher] HTTP ${response.status} ${response.statusText}`,
            );
        }

        const body = response.body;
        if (!body) {
            throw new Error('[ResumableGribFetcher] Response has no readable body');
        }

        const reader = body.getReader();

        try {
            for (; ;) {
                const { done, value } = await reader.read();
                if (done) break;

                // value is Uint8Array — append without copying into a single buffer
                this.chunks.push(value);
                this.downloadedBytes += value.byteLength;

                this.onProgress?.({
                    downloadedBytes: this.downloadedBytes,
                    totalBytes: this.totalBytes,
                    attempt: this.attempt,
                });
            }
        } catch (err: unknown) {
            // Stream interrupted mid-transfer (satellite link dropped)
            if (this.signal?.aborted) throw err;

            console.warn(
                `[ResumableGribFetcher] Stream interrupted at ${this.downloadedBytes} bytes ` +
                `on attempt ${this.attempt}. Resuming in ${this.retryDelay}ms...`,
                err,
            );
            reader.releaseLock();
            await this.sleep(this.retryDelay);
            return this.fetchWithResume();
        }

        // Reset attempt counter on successful completion
        this.attempt = 0;
        return this.assembleResult();
    }

    /** Concatenate streamed chunks into a single ArrayBuffer. */
    private assembleResult(): ArrayBuffer {
        const totalLength = this.chunks.reduce((sum, c) => sum + c.byteLength, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of this.chunks) {
            result.set(chunk, offset);
            offset += chunk.byteLength;
        }
        // Release chunk references for GC
        this.chunks = [];
        return result.buffer;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

/**
 * Convenience function for one-shot resumable GRIB download.
 *
 * @example
 * ```ts
 * const buffer = await fetchGribResumable(
 *     'https://api.example.com/gfs.grib2',
 *     {
 *         retryDelay: 5000,
 *         onProgress: ({ downloadedBytes, totalBytes }) => {
 *             console.log(`${downloadedBytes}/${totalBytes ?? '?'} bytes`);
 *         },
 *     },
 * );
 * ```
 */
export async function fetchGribResumable(
    url: string,
    options?: ResumableGribFetcherOptions,
): Promise<ArrayBuffer> {
    const fetcher = new ResumableGribFetcher(url, options);
    return fetcher.fetch();
}
