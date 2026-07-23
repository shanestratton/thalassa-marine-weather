/**
 * Vessel Hub — Service barrel export.
 *
 * Single import point for all vessel-related local-first services.
 */

// Core database
export {
    initLocalDatabase,
    getPendingCount,
    getFailedCount,
    getSyncMeta,
    getLocalDatabaseIdentity,
    generateUUID,
    deltaLocal,
} from './LocalDatabase';
export type { SyncQueueItem, SyncMeta, LocalDatabaseSession } from './LocalDatabase';

// Sync engine
export {
    startSyncEngine,
    stopSyncEngine,
    syncNow,
    forceFullPull,
    requestFullReconciliation,
    getSyncStatus,
    onSyncComplete,
    onStatusChange,
} from './SyncService';
export type { SyncStatus } from './SyncService';

// Local-first services
export { LocalInventoryService } from './LocalInventoryService';
export { LocalInventoryService as LocalStoresService } from './LocalInventoryService';
export { LocalMaintenanceService } from './LocalMaintenanceService';
