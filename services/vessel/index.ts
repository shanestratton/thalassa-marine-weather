/**
 * Vessel Hub — Service barrel export.
 *
 * Single import point for all vessel-related local-first services.
 */

// Core database
export { initLocalDatabase, getPendingCount, getSyncMeta, generateUUID } from './LocalDatabase';
export type { SyncQueueItem, SyncMeta } from './LocalDatabase';

// Sync engine
export { startSyncEngine, stopSyncEngine, syncNow, forceFullPull, getSyncStatus, onSyncComplete, onStatusChange } from './SyncService';
export type { SyncStatus } from './SyncService';

// Local-first services
export { LocalInventoryService } from './LocalInventoryService';
export { LocalMaintenanceService } from './LocalMaintenanceService';
