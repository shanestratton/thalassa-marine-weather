/**
 * Every limit on the chart vault, in one block (127-C-d decisions 2 and 7).
 *
 * PROVISIONAL. These are the plan's budget, from the 2026-09-30 batch run on
 * calypso (the AU set: 935 cells in 75 s at nice 10, 1.87 GB peak RSS while
 * decryptBatch held every cell). The read-only measurement on calypso (M0-M5)
 * replaces each number; the comment on each names the step that sets it and
 * what to do when the measurement is over budget. Change a number HERE only:
 * systemd/thalassa-chart-vault.service carries the unit's copies and
 * vault/unitFile.test.mts holds the two equal.
 */
export const VAULT_LIMITS = {
    /** MemoryHigh, MB. M5 (vault + oexserverd RSS with the LRU full, budget ≤ 1.4 GB): lower lruMB first. */
    memoryHighMB: 1400,
    /** MemoryMax, MB. M5, as memoryHighMB; the kernel kills the vault, never the watch, at this line. */
    memoryMaxMB: 1700,
    /** V8 --max-old-space-size, MB. M2/M5: the largest cell's heap peak × 1.5 (budget ≤ 400 MB). */
    maxOldSpaceMB: 512,
    /** VAULT_LRU_MB: decoded cells held in memory, MB. M5: lowered before MemoryMax is raised. */
    lruMB: 600,
    /** Per-cell FIFO read timeout, ms. M2: the largest cell's cold decode × 2 (budget ≤ 3 s). */
    readTimeoutMs: 6_000,
    /** How long oexserverd may take to make its command FIFO, ms. M0/M1. */
    daemonStartMs: 5_000,
    /** CPUQuota, percent of one core. M3 (watch probe p99 ≤ 2× idle and ≤ 250 ms): else 100. */
    cpuQuotaPercent: 200,
    /**
     * Nice. It ranks the vault's own threads against each other only: CPUQuota
     * turns on the cgroup cpu controller in system.slice, and from then on each
     * service gets its cgroup's CPUWeight, whatever its Nice. M3: 19 when over budget.
     */
    nice: 10,
    /**
     * CPUWeight of the vault's cgroup against every other service (systemd's
     * default is 100). 10 keeps what Nice=10 meant before the controller was on:
     * about a ninth of an ordinary service's share under contention. M3.
     */
    cpuWeight: 10,
    /**
     * CPUWeight for thalassa-cache (its drop-in, 20-chart-vault.conf). 300 keeps
     * what its Nice=-5 gave it over the services at nice 0 (about 3x), and 30x
     * the vault's share. It holds the anchor watch, the night watch and the
     * alarm relay. M3.
     */
    serviceCpuWeight: 300,
    /** OOMScoreAdjust: the kernel kills the vault first, never the watch. */
    oomScoreAdjust: 800,
    /** TasksMax for the unit (node's threads plus oexserverd). M0. */
    tasksMax: 64,
    /** Requests queued before the vault answers 503 vault-busy (decision 7). */
    queueMax: 64,
    /** Retry-After on vault-busy and vault-starting, seconds. */
    retryAfterSeconds: 5,
    /** Prewarm may fill at most this share of the LRU (decision 7). M4. */
    prewarmShare: 0.6,
    /** Prewarm opens the cells within this many NM of the boat, finest scale first. M4 (corridor cold ≤ 5 s). */
    prewarmRadiusNm: 30,
    /** thalassa-cache sends the vault its fix this often, ms (decision 7). */
    hintEveryMs: 10 * 60 * 1000,
    /** ...and its watch state on every check, this often, ms (decision 11): a restarted vault hears it at once. */
    watchCheckMs: 30 * 1000,
    /**
     * thalassa-cache asks the vault for its status this often, ms, off the
     * request path: /api/admin/status (the app's Pi health probe) reports the
     * last answer and its age, and never waits on the vault's event loop.
     */
    statusEveryMs: 5 * 1000,
    /** Past this age, ms, the last status counts as no answer ('unreachable'). */
    statusStaleMs: 30 * 1000,
    /**
     * After the decoder goes down mid-pass, the pass is tried again this long
     * after, ms, doubling on each failure to restartBackoffMaxMs. A retry
     * resumes the files left to open; it rescans and re-hashes the delivered
     * sets only when their files changed.
     */
    passRetryMs: 30 * 1000,
    /** First oexserverd restart backoff, ms; doubles to restartBackoffMaxMs (Risks: dongle or daemon down). */
    restartBackoffMs: 5_000,
    restartBackoffMaxMs: 5 * 60 * 1000,
    /** The install waits this long for the first index pass, minutes. M2 (≈1,960 files, budget ≤ 6 min on 2 cores). */
    installReadyWaitMin: 15,
} as const;

/** The socket thalassa-cache reaches the vault on (RuntimeDirectory=thalassa-chart-vault, 0700). */
export const DEFAULT_VAULT_SOCKET = '/run/thalassa-chart-vault/vault.sock';
