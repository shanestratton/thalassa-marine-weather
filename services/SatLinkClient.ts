/**
 * SatLinkClient — Resumable HTTP download manager for satellite connections.
 *
 * Uses HTTP Range headers to resume interrupted GRIB file downloads.
 * Writes chunks to Capacitor Filesystem, tracks progress,
 * and auto-retries with exponential backoff on network drops.
 */
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import type { GribDownloadState } from '../types';
import { saveLargeData, loadLargeData } from './nativeStorage';

const STATE_KEY = 'thalassa_grib_download_state';
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 30000;
const PROGRESS_INTERVAL_MS = 1000;

export interface DownloadProgress {
    downloadedBytes: number;
    totalBytes: number;
    percent: number;
    speedBps: number;     // Bytes per second
    estimatedRemainingS: number;
}

export type DownloadProgressCallback = (progress: DownloadProgress) => void;
export type DownloadStatusCallback = (state: GribDownloadState) => void;

class SatLinkClientClass {
    private state: GribDownloadState = this.createIdleState();
    private abortController: AbortController | null = null;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private retryAttempts = 0;
    private progressListeners: Set<DownloadProgressCallback> = new Set();
    private statusListeners: Set<DownloadStatusCallback> = new Set();

    // Speed measurement
    private lastProgressTime = 0;
    private lastProgressBytes = 0;
    private currentSpeed = 0;

    // ── Public API ──

    /** Start or resume a GRIB file download */
    async startDownload(url: string, filename?: string): Promise<void> {
        // Check for existing interrupted download of the same URL
        const existing = await this.loadState();
        if (existing && existing.url === url && existing.status !== 'complete' && existing.downloadedBytes > 0) {
            // Resume from where we left off
            this.state = existing;
            this.state.status = 'downloading';
            this.state.resumeOffset = existing.downloadedBytes;
        } else {
            // Fresh download
            const tempPath = `grib_${filename || 'download'}_${Date.now()}.tmp`;
            this.state = {
                status: 'downloading',
                totalBytes: 0,
                downloadedBytes: 0,
                resumeOffset: 0,
                url,
                tempFilePath: tempPath,
                startedAt: Date.now(),
                lastChunkAt: Date.now(),
            };
        }

        this.retryAttempts = 0;
        this.emitStatus();
        await this.persistState();
        this.doFetch();
    }

    /** Pause the current download */
    pause(): void {
        if (this.state.status !== 'downloading') return;
        this.abortController?.abort();
        this.abortController = null;
        this.state.status = 'paused';
        this.emitStatus();
        this.persistState();
    }

    /** Resume a paused download */
    resume(): void {
        if (this.state.status !== 'paused') return;
        this.state.status = 'downloading';
        this.state.resumeOffset = this.state.downloadedBytes;
        this.retryAttempts = 0;
        this.emitStatus();
        this.doFetch();
    }

    /** Cancel the download and clean up temp file */
    async cancel(): Promise<void> {
        this.abortController?.abort();
        this.abortController = null;
        if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }

        // Delete temp file
        try {
            await Filesystem.deleteFile({
                path: this.state.tempFilePath,
                directory: Directory.Documents,
            });
        } catch { /* ignore */ }

        this.state = this.createIdleState();
        this.emitStatus();
        await this.persistState();
    }

    /** Get current download state */
    getState(): GribDownloadState { return this.state; }

    /** Subscribe to progress updates */
    onProgress(cb: DownloadProgressCallback) { this.progressListeners.add(cb); return () => this.progressListeners.delete(cb); }

    /** Subscribe to status changes */
    onStatusChange(cb: DownloadStatusCallback) { this.statusListeners.add(cb); return () => this.statusListeners.delete(cb); }

    /** Get the path to the completed GRIB file (null if not complete) */
    getCompletedFilePath(): string | null {
        if (this.state.status !== 'complete') return null;
        return this.state.tempFilePath.replace('.tmp', '.grb2');
    }

    // ── Core Fetch with Range Resume ──

    private async doFetch(): Promise<void> {
        this.abortController = new AbortController();
        this.lastProgressTime = Date.now();
        this.lastProgressBytes = this.state.downloadedBytes;

        try {
            const headers: Record<string, string> = {};
            if (this.state.resumeOffset > 0) {
                headers['Range'] = `bytes=${this.state.resumeOffset}-`;
            }

            const response = await fetch(this.state.url, {
                headers,
                signal: this.abortController.signal,
            });

            // Validate response
            if (!response.ok && response.status !== 206) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            // Get total size from Content-Length or Content-Range
            if (this.state.totalBytes === 0) {
                const contentRange = response.headers.get('Content-Range');
                if (contentRange) {
                    // "bytes 1000-9999/10000" → total is 10000
                    const total = parseInt(contentRange.split('/')[1] || '0');
                    if (total > 0) this.state.totalBytes = total;
                } else {
                    const contentLength = response.headers.get('Content-Length');
                    if (contentLength) this.state.totalBytes = parseInt(contentLength);
                }
            }

            // Stream the response body
            if (!response.body) throw new Error('No response body');
            const reader = response.body.getReader();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                // Write chunk to file
                const base64Chunk = this.uint8ToBase64(value);
                try {
                    if (this.state.downloadedBytes === 0 && this.state.resumeOffset === 0) {
                        // First chunk — create file
                        await Filesystem.writeFile({
                            path: this.state.tempFilePath,
                            data: base64Chunk,
                            directory: Directory.Documents,
                        });
                    } else {
                        // Append subsequent chunks
                        await Filesystem.appendFile({
                            path: this.state.tempFilePath,
                            data: base64Chunk,
                            directory: Directory.Documents,
                        });
                    }
                } catch (fsErr) {
                    throw new Error(`Filesystem write failed: ${fsErr}`);
                }

                this.state.downloadedBytes += value.byteLength;
                this.state.lastChunkAt = Date.now();

                // Throttled progress emission
                const now = Date.now();
                if (now - this.lastProgressTime >= PROGRESS_INTERVAL_MS) {
                    const elapsed = (now - this.lastProgressTime) / 1000;
                    const bytesInInterval = this.state.downloadedBytes - this.lastProgressBytes;
                    this.currentSpeed = elapsed > 0 ? bytesInInterval / elapsed : 0;
                    this.lastProgressTime = now;
                    this.lastProgressBytes = this.state.downloadedBytes;
                    this.emitProgress();
                }
            }

            // Download complete
            this.state.status = 'complete';

            // Rename temp file to final
            const finalPath = this.state.tempFilePath.replace('.tmp', '.grb2');
            try {
                await Filesystem.rename({
                    from: this.state.tempFilePath,
                    to: finalPath,
                    directory: Directory.Documents,
                    toDirectory: Directory.Documents,
                });
                this.state.tempFilePath = finalPath;
            } catch { /* rename failed, temp file still valid */ }

            this.emitStatus();
            this.emitProgress();
            await this.persistState();
        } catch (err) {
            if (this.abortController?.signal.aborted) return; // User-initiated pause/cancel

            this.state.status = 'error';
            this.state.errorMessage = err instanceof Error ? err.message : 'Download failed';
            this.emitStatus();
            await this.persistState();

            // Auto-retry with exponential backoff
            this.scheduleRetry();
        }
    }

    private scheduleRetry(): void {
        if (this.state.status === 'paused' || this.state.status === 'complete') return;
        if (this.retryTimer) return;

        const delay = Math.min(RETRY_BASE_MS * Math.pow(2, this.retryAttempts), RETRY_MAX_MS);
        this.retryAttempts++;

        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.state.status = 'downloading';
            this.state.resumeOffset = this.state.downloadedBytes;
            this.emitStatus();
            this.doFetch();
        }, delay);
    }

    // ── Helpers ──

    private uint8ToBase64(bytes: Uint8Array): string {
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    private emitProgress(): void {
        const percent = this.state.totalBytes > 0
            ? Math.round((this.state.downloadedBytes / this.state.totalBytes) * 100)
            : 0;
        const remaining = this.currentSpeed > 0
            ? (this.state.totalBytes - this.state.downloadedBytes) / this.currentSpeed
            : 0;

        const progress: DownloadProgress = {
            downloadedBytes: this.state.downloadedBytes,
            totalBytes: this.state.totalBytes,
            percent,
            speedBps: this.currentSpeed,
            estimatedRemainingS: remaining,
        };
        for (const cb of this.progressListeners) cb(progress);
    }

    private emitStatus(): void {
        for (const cb of this.statusListeners) cb(this.state);
    }

    private async persistState(): Promise<void> {
        await saveLargeData(STATE_KEY, this.state);
    }

    private async loadState(): Promise<GribDownloadState | null> {
        const data = await loadLargeData(STATE_KEY);
        return data as GribDownloadState | null;
    }

    private createIdleState(): GribDownloadState {
        return {
            status: 'idle',
            totalBytes: 0,
            downloadedBytes: 0,
            resumeOffset: 0,
            url: '',
            tempFilePath: '',
            startedAt: 0,
            lastChunkAt: 0,
        };
    }
}

export const SatLinkClient = new SatLinkClientClass();
