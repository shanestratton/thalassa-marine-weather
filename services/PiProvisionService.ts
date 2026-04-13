/**
 * PiProvisionService — One-tap Raspberry Pi cache server provisioning.
 *
 * SSHs into the skipper's Pi, installs the Thalassa Cache service,
 * verifies it's running, and auto-configures the app to use it.
 * The punter never opens a terminal.
 *
 * Flow:
 *   1. Test SSH connection (validate creds before long install)
 *   2. Check if thalassa-cache is already installed
 *   3. If not → download + run install script via SSH
 *   4. Health-check the Pi Cache HTTP endpoint (port 3001)
 *   5. Push Supabase creds + boat location so pre-fetch starts
 *   6. Enable Pi Cache in app settings
 */

import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';
import { createLogger } from '../utils/createLogger';
import { piCache } from './PiCacheService';

const log = createLogger('PiProvision');

// ── Native SSH Plugin ──────────────────────────────────────────

interface SshExecuteResult {
    stdout: string;
    exitCode: number;
}

interface SshTestResult {
    reachable: boolean;
    authenticated: boolean;
    error: string;
}

interface SshClientPluginInterface {
    execute(options: {
        host: string;
        port: number;
        username: string;
        password: string;
        command: string;
        timeout?: number;
    }): Promise<SshExecuteResult>;

    testConnection(options: { host: string; port: number; username: string; password: string }): Promise<SshTestResult>;
}

const SshClient = registerPlugin<SshClientPluginInterface>('SshClient');

// ── Provision Phases ───────────────────────────────────────────

export type ProvisionPhase =
    | 'idle'
    | 'connecting'
    | 'checking'
    | 'installing'
    | 'verifying'
    | 'configuring'
    | 'done'
    | 'error';

export interface ProvisionProgress {
    phase: ProvisionPhase;
    message: string;
    /** Install script output (populated during/after install) */
    output?: string;
}

export interface ProvisionResult {
    success: boolean;
    piHost: string;
    message: string;
    output?: string;
}

// ── Constants ──────────────────────────────────────────────────

const INSTALL_SCRIPT_URL =
    'https://raw.githubusercontent.com/shanestratton/thalassa-marine-weather/master/pi-cache/install.sh';

const PI_CACHE_PORT = 3001;

/** Default SSH hosts to try if user doesn't specify */
const DEFAULT_HOSTS = ['openplotter.local', 'raspberrypi.local', 'thalassa.local', 'pi.local'];

/** Default SSH username for Raspberry Pi / OpenPlotter */
const DEFAULT_USERNAME = 'pi';

// ── Shell Helpers ──────────────────────────────────────────────

/** Escape a string for safe embedding in single-quoted shell context */
function shellEscape(s: string): string {
    return s.replace(/'/g, "'\\''");
}

/**
 * Build the install command. Uses sudo -S to accept the password
 * via stdin (non-interactive SSH sessions can't prompt for sudo).
 */
function buildInstallCommand(password: string): string {
    const escaped = shellEscape(password);
    return [
        // Download the install script
        `curl -fsSL '${INSTALL_SCRIPT_URL}' -o /tmp/thalassa-install.sh`,
        // Run with sudo, piping password to stdin
        `printf '%s\\n' '${escaped}' | sudo -S bash /tmp/thalassa-install.sh 2>&1`,
        // Clean up
        `rm -f /tmp/thalassa-install.sh`,
    ].join(' && ');
}

/** Command to check if the service is already installed and running */
const CHECK_COMMAND = 'systemctl is-active thalassa-cache 2>/dev/null || echo "not-installed"';

// ── Service ────────────────────────────────────────────────────

class PiProvisionServiceClass {
    /** Whether the native SSH plugin is available */
    get isAvailable(): boolean {
        return Capacitor.isNativePlatform();
    }

    /**
     * Resolve the Pi's SSH hostname. Tries the user-provided host first,
     * then falls back to common .local hostnames.
     */
    async resolveHost(
        preferredHost: string | null,
        username: string,
        password: string,
    ): Promise<{ host: string; error?: string } | null> {
        const candidates = preferredHost ? [preferredHost, ...DEFAULT_HOSTS] : DEFAULT_HOSTS;

        for (const host of candidates) {
            try {
                log.info(`Testing SSH to ${host}...`);
                const result = await SshClient.testConnection({
                    host,
                    port: 22,
                    username,
                    password,
                });
                if (result.reachable && result.authenticated) {
                    log.info(`SSH OK: ${host}`);
                    return { host };
                }
                if (result.reachable && !result.authenticated) {
                    return { host, error: 'Wrong username or password' };
                }
            } catch {
                // Host not reachable — try next
            }
        }
        return null;
    }

    /**
     * Full provisioning flow. Call this from the UI.
     *
     * @param host     Pi hostname or IP
     * @param username SSH username (default: 'user')
     * @param password SSH / sudo password
     * @param onProgress  Phase callback for UI updates
     * @param supabaseConfig  Supabase creds to push to Pi after install
     */
    async provision(
        host: string,
        username: string,
        password: string,
        onProgress: (progress: ProvisionProgress) => void,
        supabaseConfig?: { url: string; key: string; lat: number; lon: number },
    ): Promise<ProvisionResult> {
        if (!this.isAvailable) {
            return {
                success: false,
                piHost: host,
                message: 'SSH is only available on iOS/Android — use the manual install for web.',
            };
        }

        try {
            // ── Phase 1: Connect & authenticate ──
            onProgress({ phase: 'connecting', message: `Connecting to ${host}...` });

            const testResult = await SshClient.testConnection({
                host,
                port: 22,
                username,
                password,
            });

            if (!testResult.reachable) {
                return {
                    success: false,
                    piHost: host,
                    message: `Can't reach ${host} — is SSH enabled and are you on the same WiFi?`,
                };
            }
            if (!testResult.authenticated) {
                return {
                    success: false,
                    piHost: host,
                    message: 'Wrong username or password.',
                };
            }

            log.info(`SSH authenticated to ${host}`);

            // ── Phase 2: Check if already installed ──
            onProgress({ phase: 'checking', message: 'Checking for existing installation...' });

            const checkResult = await SshClient.execute({
                host,
                port: 22,
                username,
                password,
                command: CHECK_COMMAND,
                timeout: 15,
            });

            const alreadyRunning = checkResult.stdout.trim() === 'active';

            if (alreadyRunning) {
                log.info('Thalassa Cache already installed and running');
                onProgress({ phase: 'verifying', message: 'Already installed! Verifying...' });
            } else {
                // ── Phase 3: Install ──
                onProgress({
                    phase: 'installing',
                    message: 'Installing Thalassa Cache — this takes 3-5 min on a Pi, hang tight...',
                });
                log.info('Running install script...');

                const installResult = await SshClient.execute({
                    host,
                    port: 22,
                    username,
                    password,
                    command: buildInstallCommand(password),
                    timeout: 300, // 5 min ceiling
                });

                log.info(`Install script exited with code ${installResult.exitCode}`);
                log.info(`Install output:\n${installResult.stdout.slice(-500)}`);

                if (installResult.exitCode !== 0) {
                    return {
                        success: false,
                        piHost: host,
                        message: 'Install script failed — see output for details.',
                        output: installResult.stdout,
                    };
                }

                onProgress({
                    phase: 'verifying',
                    message: 'Install complete — verifying service...',
                    output: installResult.stdout,
                });
            }

            // ── Phase 4: HTTP health check ──
            const cacheUrl = `http://${host}:${PI_CACHE_PORT}/health`;
            let healthy = false;

            // Retry a few times — the service might need a moment to start.
            // Use CapacitorHttp on native for reliable timeout enforcement
            // (bare fetch + AbortSignal.timeout can hang on iOS WKWebView).
            const isNative = Capacitor.isNativePlatform();
            for (let attempt = 0; attempt < 8; attempt++) {
                try {
                    if (isNative) {
                        const resp = await CapacitorHttp.get({
                            url: cacheUrl,
                            connectTimeout: 3000,
                            readTimeout: 3000,
                        });
                        if (resp.status === 200) {
                            healthy = true;
                            break;
                        }
                    } else {
                        const resp = await fetch(cacheUrl, {
                            signal: AbortSignal.timeout(3000),
                        });
                        if (resp.ok) {
                            healthy = true;
                            break;
                        }
                    }
                } catch {
                    // Not ready yet — wait and retry
                }
                await new Promise((r) => setTimeout(r, 2000));
                onProgress({
                    phase: 'verifying',
                    message: `Waiting for service to start (attempt ${attempt + 2}/8)...`,
                });
            }

            if (!healthy) {
                return {
                    success: false,
                    piHost: host,
                    message:
                        'Service installed but HTTP health check failed on port 3001. It may need a moment — try enabling Pi Cache in a minute.',
                };
            }

            // ── Phase 5: Push config to Pi ──
            if (supabaseConfig) {
                onProgress({ phase: 'configuring', message: 'Pushing configuration to Pi...' });
                try {
                    await piCache.configure({ enabled: true, host, port: PI_CACHE_PORT });
                    await piCache.pushConfig({
                        supabaseUrl: supabaseConfig.url,
                        supabaseAnonKey: supabaseConfig.key,
                        prefetchLat: supabaseConfig.lat,
                        prefetchLon: supabaseConfig.lon,
                        prefetchRadius: 5,
                    });
                    log.info('Config pushed to Pi');
                } catch (err) {
                    log.warn('Config push failed (non-fatal):', err);
                }
            }

            // ── Done ──
            onProgress({ phase: 'done', message: 'All set — Pi Cache is live!' });

            return {
                success: true,
                piHost: host,
                message: alreadyRunning
                    ? 'Thalassa Cache was already installed and running.'
                    : 'Thalassa Cache installed and running.',
            };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error('Provision failed:', msg);
            onProgress({ phase: 'error', message: msg });
            return { success: false, piHost: host, message: msg };
        }
    }
}

export const PiProvisionService = new PiProvisionServiceClass();

/** Re-export defaults for the UI */
export { DEFAULT_HOSTS, DEFAULT_USERNAME, PI_CACHE_PORT };
