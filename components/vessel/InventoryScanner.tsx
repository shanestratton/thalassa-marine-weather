/**
 * InventoryScanner — Full-screen barcode scanning view with bottom sheet.
 *
 * Uses the device camera via BarcodeDetector API (or fallback manual entry).
 * On scan:
 *   - If barcode exists → show item details with quantity ± controls
 *   - If barcode is new → show "Add New Item" form with barcode pre-filled
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { InventoryItem, InventoryCategory } from '../../types';
import { InventoryService } from '../../services/InventoryService';
import { triggerHaptic } from '../../utils/system';
import { Capacitor } from '@capacitor/core';

interface InventoryScannerProps {
    onClose: () => void;
    onItemSaved: () => void; // Refresh parent list
    startInManualMode?: boolean; // Skip camera and go straight to add form
}

const CATEGORIES: InventoryCategory[] = ['Engine', 'Plumbing', 'Electrical', 'Rigging', 'Safety', 'Provisions', 'Medical'];

export const InventoryScanner: React.FC<InventoryScannerProps> = ({ onClose, onItemSaved, startInManualMode = false }) => {
    // ── Scanner state ──
    const [scanning, setScanning] = useState(!startInManualMode);
    const [cameraError, setCameraError] = useState<string | null>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const scanIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // ── Inline barcode scanner (manual mode) ──
    const [showInlineScanner, setShowInlineScanner] = useState(false);
    const inlineVideoRef = useRef<HTMLVideoElement>(null);
    const inlineStreamRef = useRef<MediaStream | null>(null);
    const inlineScanRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // ── Bottom sheet state ──
    const [sheetMode, setSheetMode] = useState<'hidden' | 'existing' | 'new'>(startInManualMode ? 'new' : 'hidden');
    const [scannedBarcode, setScannedBarcode] = useState('');
    const [foundItem, setFoundItem] = useState<InventoryItem | null>(null);
    const [saving, setSaving] = useState(false);

    // ── New item form ──
    const [newItem, setNewItem] = useState({
        item_name: '',
        barcode: '',
        category: 'Provisions' as InventoryCategory,
        quantity: 1,
        min_quantity: 0,
        location_zone: '',
        location_specific: '',
        description: '',
        expiry_date: '',
    });

    // ── Camera setup (skip if starting in manual mode) ──
    useEffect(() => {
        if (!startInManualMode) {
            startCamera();
        }
        return () => stopCamera();
    }, []);

    const startCamera = async () => {
        // On native: use ML Kit scanner instead of camera stream
        if (Capacitor.isNativePlatform()) {
            try {
                const { BarcodeScanner, BarcodeFormat } = await import('@capacitor-mlkit/barcode-scanning');

                const { camera } = await BarcodeScanner.checkPermissions();
                if (camera !== 'granted') {
                    const result = await BarcodeScanner.requestPermissions();
                    if (result.camera !== 'granted') {
                        setCameraError('Camera permission denied. Please enable in Settings.');
                        return;
                    }
                }

                const { barcodes } = await BarcodeScanner.scan({
                    formats: [
                        BarcodeFormat.Ean13,
                        BarcodeFormat.Ean8,
                        BarcodeFormat.UpcA,
                        BarcodeFormat.UpcE,
                        BarcodeFormat.Code128,
                        BarcodeFormat.Code39,
                        BarcodeFormat.QrCode,
                    ],
                });

                if (barcodes.length > 0 && barcodes[0].rawValue) {
                    handleBarcodeScan(barcodes[0].rawValue);
                } else {
                    // User cancelled
                    handleManualEntry();
                }
            } catch (err: any) {
                if (err?.message?.includes('canceled') || err?.message?.includes('cancelled')) {
                    handleManualEntry();
                } else {
                    setCameraError('Scanner unavailable. Use manual entry below.');
                }
            }
            return;
        }

        // Web: use camera stream + BarcodeDetector API
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: 'environment', // Rear camera
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                },
            });
            streamRef.current = stream;
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
                await videoRef.current.play();
            }
            startBarcodeDetection();
        } catch (err) {
            setCameraError('Camera access denied. Use manual entry below.');
        }
    };

    const stopCamera = () => {
        if (scanIntervalRef.current) clearInterval(scanIntervalRef.current);
        if (streamRef.current) {
            for (const track of streamRef.current.getTracks()) track.stop();
            streamRef.current = null;
        }
    };

    // ── Inline scanner for manual mode ──
    const openInlineScanner = async () => {
        // Native platform: use Capacitor ML Kit barcode scanner
        if (Capacitor.isNativePlatform()) {
            try {
                const { BarcodeScanner, BarcodeFormat } = await import('@capacitor-mlkit/barcode-scanning');

                // Check & request camera permission
                const { camera } = await BarcodeScanner.checkPermissions();
                if (camera !== 'granted') {
                    const result = await BarcodeScanner.requestPermissions();
                    if (result.camera !== 'granted') {
                        setCameraError('Camera permission denied. Please enable in Settings.');
                        return;
                    }
                }

                // Launch native scanner
                const { barcodes } = await BarcodeScanner.scan({
                    formats: [
                        BarcodeFormat.Ean13,
                        BarcodeFormat.Ean8,
                        BarcodeFormat.UpcA,
                        BarcodeFormat.UpcE,
                        BarcodeFormat.Code128,
                        BarcodeFormat.Code39,
                        BarcodeFormat.QrCode,
                    ],
                });

                if (barcodes.length > 0 && barcodes[0].rawValue) {
                    const code = barcodes[0].rawValue;
                    setNewItem(prev => ({ ...prev, barcode: code }));
                    triggerHaptic('medium');
                }
            } catch (err: any) {
                // User cancelled or error
                if (err?.message?.includes('canceled') || err?.message?.includes('cancelled')) {
                    // User pressed back — that's fine
                } else {
                    console.warn('[InventoryScanner] Native scan error:', err);
                    setCameraError('Scanner unavailable. Enter barcode manually.');
                }
            }
            return;
        }

        // Web fallback: use BarcodeDetector API + camera stream
        setShowInlineScanner(true);
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
            });
            inlineStreamRef.current = stream;
            // Wait for the video element to mount
            await new Promise(r => setTimeout(r, 100));
            if (inlineVideoRef.current) {
                inlineVideoRef.current.srcObject = stream;
                await inlineVideoRef.current.play();
            }
            // Start detection
            if (!('BarcodeDetector' in window)) {
                setCameraError('Barcode detection not supported on this device.');
                closeInlineScanner();
                return;
            }
            const detector = new (window as unknown as { BarcodeDetector: new (opts: { formats: string[] }) => { detect: (src: HTMLVideoElement) => Promise<{ rawValue: string }[]> } }).BarcodeDetector({
                formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'],
            });
            inlineScanRef.current = setInterval(async () => {
                if (!inlineVideoRef.current) return;
                try {
                    const barcodes = await detector.detect(inlineVideoRef.current);
                    if (barcodes.length > 0 && barcodes[0].rawValue.length > 3) {
                        const code = barcodes[0].rawValue;
                        setNewItem(prev => ({ ...prev, barcode: code }));
                        triggerHaptic('medium');
                        closeInlineScanner();
                    }
                } catch { /* frame failed */ }
            }, 500);
        } catch {
            setCameraError('Camera access denied.');
            setShowInlineScanner(false);
        }
    };

    const closeInlineScanner = () => {
        if (inlineScanRef.current) { clearInterval(inlineScanRef.current); inlineScanRef.current = null; }
        if (inlineStreamRef.current) {
            for (const track of inlineStreamRef.current.getTracks()) track.stop();
            inlineStreamRef.current = null;
        }
        setShowInlineScanner(false);
    };

    const startBarcodeDetection = () => {
        // Use BarcodeDetector API if available (Chrome, Safari 17.2+)
        if (!('BarcodeDetector' in window)) {
            setCameraError('Barcode detection not supported. Use manual entry.');
            return;
        }

        const detector = new (window as unknown as { BarcodeDetector: new (opts: { formats: string[] }) => { detect: (src: HTMLVideoElement) => Promise<{ rawValue: string }[]> } }).BarcodeDetector({
            formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'],
        });

        scanIntervalRef.current = setInterval(async () => {
            if (!videoRef.current || !scanning) return;
            try {
                const barcodes = await detector.detect(videoRef.current);
                if (barcodes.length > 0) {
                    const code = barcodes[0].rawValue;
                    if (code && code.length > 3) {
                        handleBarcodeScan(code);
                    }
                }
            } catch {
                // Detection frame failed — continue
            }
        }, 500); // Scan every 500ms
    };

    // ── Barcode scan handler ──
    const handleBarcodeScan = useCallback(async (barcode: string) => {
        if (sheetMode !== 'hidden') return; // Don't re-scan while sheet is open
        setScanning(false);
        setScannedBarcode(barcode);
        triggerHaptic('medium');

        try {
            const existing = await InventoryService.findByBarcode(barcode);
            if (existing) {
                setFoundItem(existing);
                setSheetMode('existing');
            } else {
                setNewItem(prev => ({ ...prev, barcode }));
                setSheetMode('new');
            }
        } catch {
            setNewItem(prev => ({ ...prev, barcode }));
            setSheetMode('new');
        }
    }, [sheetMode]);

    // ── Manual barcode entry ──
    const handleManualEntry = () => {
        setScanning(false);
        setSheetMode('new');
        setNewItem(prev => ({ ...prev, barcode: '' }));
    };

    // ── Quantity adjustment for existing item ──
    const handleQuantityAdjust = async (delta: number) => {
        if (!foundItem) return;
        setSaving(true);
        try {
            const updated = await InventoryService.adjustQuantity(foundItem.id, delta);
            setFoundItem(updated);
            triggerHaptic('light');
            onItemSaved();
        } catch { /* ignore */ }
        setSaving(false);
    };

    // ── Save new item ──
    const handleSaveNew = async () => {
        if (!newItem.item_name.trim()) return;
        setSaving(true);
        try {
            await InventoryService.create({
                ...newItem,
                barcode: newItem.barcode || null,
                location_zone: newItem.location_zone || null,
                location_specific: newItem.location_specific || null,
                description: newItem.description || null,
                expiry_date: newItem.expiry_date || null,
            });
            triggerHaptic('medium');
            onItemSaved();
            // In manual mode, close entirely instead of showing camera
            if (startInManualMode) {
                onClose();
            } else {
                dismissSheet();
            }
        } catch { /* ignore */ }
        setSaving(false);
    };

    const dismissSheet = () => {
        setSheetMode('hidden');
        setFoundItem(null);
        setScannedBarcode('');
        setScanning(true);
    };

    // ── Manual mode: full-page Add Item form (no camera) ──
    if (startInManualMode && sheetMode === 'new') {
        return (
            <div className="fixed inset-0 z-[2000] bg-slate-950 flex flex-col">
                {/* ── Header ── */}
                <div className="shrink-0 px-4 pt-3 pb-2">
                    <div className="flex items-center gap-3">
                        <button onClick={onClose} className="p-1.5 -ml-1.5 text-slate-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors">
                            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                            </svg>
                        </button>
                        <h1 className="text-xl font-extrabold text-white uppercase tracking-wider">Add Item</h1>
                    </div>
                </div>

                {/* ── Form ── */}
                <div className="flex-1 overflow-y-auto px-4 no-scrollbar" style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}>
                    <div className="space-y-2">
                        {/* Item name */}
                        <div>
                            <label className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Item Name *</label>
                            <input
                                type="text"
                                value={newItem.item_name}
                                onChange={e => setNewItem(prev => ({ ...prev, item_name: e.target.value }))}
                                placeholder="e.g. Racor 2010PM-OR Fuel Filter"
                                className="w-full mt-0.5 bg-black/40 border border-white/10 rounded-xl px-4 py-2 text-white text-sm outline-none focus:border-sky-500 transition-colors placeholder:text-gray-600"
                                autoFocus
                            />
                        </div>

                        {/* Barcode + Scan button */}
                        <div>
                            <label className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Barcode</label>
                            <div className="flex gap-2 mt-0.5">
                                <input
                                    type="text"
                                    value={newItem.barcode}
                                    onChange={e => setNewItem(prev => ({ ...prev, barcode: e.target.value }))}
                                    placeholder="Optional"
                                    className="flex-[2] bg-black/40 border border-white/10 rounded-xl px-4 py-2 text-white text-sm font-mono outline-none focus:border-sky-500 transition-colors placeholder:text-gray-600"
                                />
                                <button
                                    type="button"
                                    onClick={openInlineScanner}
                                    className="flex-1 flex items-center justify-center gap-1.5 bg-sky-600/20 border border-sky-500/30 rounded-xl text-sky-400 text-xs font-bold hover:bg-sky-600/30 transition-colors active:scale-95"
                                >
                                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" />
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z" />
                                    </svg>
                                    Scan
                                </button>
                            </div>
                        </div>

                        {/* Inline camera scanner overlay */}
                        {showInlineScanner && (
                            <div className="relative w-full h-40 rounded-xl overflow-hidden border border-sky-500/30 bg-black">
                                <video
                                    ref={inlineVideoRef}
                                    className="w-full h-full object-cover"
                                    playsInline
                                    muted
                                    autoPlay
                                />
                                {/* Reticle */}
                                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                    <div className="w-3/4 h-12 border-2 border-sky-400/60 rounded-lg">
                                        <div className="absolute inset-x-4 h-0.5 bg-sky-400/50 animate-pulse" style={{ top: '50%' }} />
                                    </div>
                                </div>
                                {/* Scanning label */}
                                <div className="absolute bottom-1 left-0 right-0 text-center">
                                    <span className="text-[9px] font-bold text-sky-400 animate-pulse uppercase tracking-widest">Scanning…</span>
                                </div>
                                {/* Close button */}
                                <button
                                    onClick={closeInlineScanner}
                                    className="absolute top-2 right-2 p-1 rounded-full bg-black/60 text-white/70 hover:text-white"
                                >
                                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                    </svg>
                                </button>
                            </div>
                        )}

                        {/* Category */}
                        <div>
                            <label className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Category</label>
                            <div className="flex flex-wrap gap-1.5 mt-0.5">
                                {CATEGORIES.map(cat => (
                                    <button
                                        key={cat}
                                        onClick={() => setNewItem(prev => ({ ...prev, category: cat }))}
                                        className={`px-3 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all ${newItem.category === cat
                                            ? 'bg-sky-600 text-white'
                                            : 'bg-white/5 text-gray-400 hover:bg-white/10'
                                            }`}
                                    >
                                        {cat}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Quantity + Min */}
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Quantity</label>
                                <input
                                    type="number"
                                    min="0"
                                    value={newItem.quantity}
                                    onChange={e => setNewItem(prev => ({ ...prev, quantity: parseInt(e.target.value) || 0 }))}
                                    className="w-full mt-0.5 bg-black/40 border border-white/10 rounded-xl px-4 py-2 text-white text-sm outline-none focus:border-sky-500 transition-colors"
                                />
                            </div>
                            <div>
                                <label className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Min Alert</label>
                                <input
                                    type="number"
                                    min="0"
                                    value={newItem.min_quantity}
                                    onChange={e => setNewItem(prev => ({ ...prev, min_quantity: parseInt(e.target.value) || 0 }))}
                                    className="w-full mt-0.5 bg-black/40 border border-white/10 rounded-xl px-4 py-2 text-white text-sm outline-none focus:border-sky-500 transition-colors"
                                />
                            </div>
                        </div>

                        {/* Location */}
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Zone</label>
                                <input
                                    type="text"
                                    value={newItem.location_zone}
                                    onChange={e => setNewItem(prev => ({ ...prev, location_zone: e.target.value }))}
                                    placeholder="Engine Room"
                                    className="w-full mt-0.5 bg-black/40 border border-white/10 rounded-xl px-4 py-2 text-white text-sm outline-none focus:border-sky-500 transition-colors placeholder:text-gray-600"
                                />
                            </div>
                            <div>
                                <label className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Exact Spot</label>
                                <input
                                    type="text"
                                    value={newItem.location_specific}
                                    onChange={e => setNewItem(prev => ({ ...prev, location_specific: e.target.value }))}
                                    placeholder="Stbd drawer"
                                    className="w-full mt-0.5 bg-black/40 border border-white/10 rounded-xl px-4 py-2 text-white text-sm outline-none focus:border-sky-500 transition-colors placeholder:text-gray-600"
                                />
                            </div>
                        </div>

                        {/* Description */}
                        <div>
                            <label className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Notes</label>
                            <input
                                type="text"
                                value={newItem.description}
                                onChange={e => setNewItem(prev => ({ ...prev, description: e.target.value }))}
                                placeholder="Part number, batch, etc."
                                className="w-full mt-0.5 bg-black/40 border border-white/10 rounded-xl px-4 py-2 text-white text-sm outline-none focus:border-sky-500 transition-colors placeholder:text-gray-600"
                            />
                        </div>

                        {/* Expiry / Service Date */}
                        <div>
                            <label className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Expiry / Service Date</label>
                            <input
                                type="date"
                                value={newItem.expiry_date}
                                onChange={e => setNewItem(prev => ({ ...prev, expiry_date: e.target.value }))}
                                className="w-full mt-0.5 bg-black/40 border border-white/10 rounded-xl px-4 py-2 text-white text-sm outline-none focus:border-sky-500 transition-colors"
                            />
                        </div>
                    </div>

                    {/* Actions */}
                    <div className="flex gap-3 mt-3">
                        <button onClick={onClose} className="flex-1 py-2.5 bg-white/5 text-gray-400 rounded-xl text-sm font-bold">
                            Cancel
                        </button>
                        <button
                            onClick={handleSaveNew}
                            disabled={!newItem.item_name.trim() || saving}
                            className="flex-1 py-2.5 bg-sky-600 text-white rounded-xl text-sm font-black uppercase tracking-wider disabled:opacity-50 transition-all active:scale-[0.98]"
                        >
                            {saving ? 'Saving…' : 'Add Item'}
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    // ── Camera scanner mode (original layout) ──
    return (
        <div className="fixed inset-0 z-[2000] bg-black flex flex-col">
            {/* ── Camera View ── */}
            <div className="relative flex-1 overflow-hidden">
                <video
                    ref={videoRef}
                    className="w-full h-full object-cover"
                    playsInline
                    muted
                    autoPlay
                />

                {/* Targeting reticle overlay */}
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    {/* Darkened corners */}
                    <div className="absolute inset-0 bg-black/40" />
                    <div className="relative w-64 h-40 z-10">
                        {/* Clear scanning area */}
                        <div className="absolute inset-0 bg-transparent border-2 border-sky-400 rounded-xl shadow-[0_0_30px_rgba(56,189,248,0.3)]" />
                        {/* Corner marks */}
                        <div className="absolute -top-0.5 -left-0.5 w-6 h-6 border-t-4 border-l-4 border-sky-400 rounded-tl-lg" />
                        <div className="absolute -top-0.5 -right-0.5 w-6 h-6 border-t-4 border-r-4 border-sky-400 rounded-tr-lg" />
                        <div className="absolute -bottom-0.5 -left-0.5 w-6 h-6 border-b-4 border-l-4 border-sky-400 rounded-bl-lg" />
                        <div className="absolute -bottom-0.5 -right-0.5 w-6 h-6 border-b-4 border-r-4 border-sky-400 rounded-br-lg" />
                        {/* Scan line animation */}
                        {scanning && (
                            <div className="absolute inset-x-2 h-0.5 bg-gradient-to-r from-transparent via-sky-400 to-transparent animate-pulse" style={{ top: '50%' }} />
                        )}
                    </div>
                </div>

                {/* Header bar */}
                <div className="absolute top-0 left-0 right-0 z-20 bg-gradient-to-b from-black/80 to-transparent pt-[max(1rem,env(safe-area-inset-top))] px-4 pb-8">
                    <div className="flex items-center justify-between">
                        <button onClick={onClose} className="p-2 rounded-xl bg-white/10 backdrop-blur-sm">
                            <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                        <span className="text-sm font-black text-white uppercase tracking-widest">Scan Item</span>
                        <button onClick={handleManualEntry} className="px-3 py-2 rounded-xl bg-white/10 backdrop-blur-sm text-xs font-bold text-white">
                            + Manual
                        </button>
                    </div>
                </div>

                {/* Camera error */}
                {cameraError && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-30">
                        <div className="text-center px-8">
                            <p className="text-amber-400 text-sm font-bold mb-4">{cameraError}</p>
                            <button onClick={handleManualEntry} className="px-6 py-3 bg-sky-600 text-white rounded-xl text-sm font-bold">
                                Enter Manually
                            </button>
                        </div>
                    </div>
                )}

                {/* Scanning indicator */}
                <div className="absolute bottom-4 left-0 right-0 text-center z-20">
                    <p className={`text-xs font-bold uppercase tracking-widest ${scanning ? 'text-sky-400 animate-pulse' : 'text-emerald-400'}`}>
                        {scanning ? 'Scanning for barcode…' : `Scanned: ${scannedBarcode}`}
                    </p>
                </div>
            </div>

            {/* ═══════════════════════════════════════════ */}
            {/* BOTTOM SHEET — Existing Item */}
            {/* ═══════════════════════════════════════════ */}
            {sheetMode === 'existing' && foundItem && (
                <div className="bg-slate-900 border-t border-white/10 rounded-t-3xl px-5 pt-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] animate-in slide-in-from-bottom duration-300">
                    {/* Handle bar */}
                    <div className="w-12 h-1 bg-white/20 rounded-full mx-auto mb-4" />

                    <div className="flex items-start justify-between mb-4">
                        <div className="flex-1">
                            <p className="text-[9px] font-bold text-sky-400 uppercase tracking-widest mb-1">{foundItem.category}</p>
                            <h3 className="text-lg font-black text-white leading-tight">{foundItem.item_name}</h3>
                            {foundItem.location_zone && (
                                <p className="text-xs text-gray-400 mt-1">
                                    📍 {foundItem.location_zone}{foundItem.location_specific ? ` — ${foundItem.location_specific}` : ''}
                                </p>
                            )}
                        </div>
                        <span className="text-[9px] font-mono text-gray-600 bg-white/5 px-2 py-1 rounded-lg">{scannedBarcode}</span>
                    </div>

                    {/* Quantity controls */}
                    <div className="flex items-center justify-center gap-6 py-4 bg-white/[0.03] border border-white/[0.06] rounded-2xl mb-4">
                        <button
                            onClick={() => handleQuantityAdjust(-1)}
                            disabled={saving || foundItem.quantity <= 0}
                            className="w-14 h-14 rounded-2xl bg-red-500/20 border border-red-500/30 flex items-center justify-center text-red-400 text-2xl font-black hover:bg-red-500/30 transition-all active:scale-90 disabled:opacity-30"
                        >
                            −
                        </button>
                        <div className="text-center">
                            <p className="text-4xl font-black text-white tabular-nums">{foundItem.quantity}</p>
                            <p className="text-[9px] text-gray-500 uppercase tracking-widest">In Stock</p>
                        </div>
                        <button
                            onClick={() => handleQuantityAdjust(1)}
                            disabled={saving}
                            className="w-14 h-14 rounded-2xl bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 text-2xl font-black hover:bg-emerald-500/30 transition-all active:scale-90"
                        >
                            +
                        </button>
                    </div>

                    {/* Low stock warning */}
                    {foundItem.quantity <= foundItem.min_quantity && foundItem.min_quantity > 0 && (
                        <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl mb-4">
                            <p className="text-xs font-bold text-amber-400">⚠️ Low stock — minimum is {foundItem.min_quantity}</p>
                        </div>
                    )}

                    <button onClick={dismissSheet} className="w-full py-3 bg-white/5 text-gray-400 rounded-xl text-sm font-bold">
                        Done
                    </button>
                </div>
            )}

            {/* ═══════════════════════════════════════════ */}
            {/* BOTTOM SHEET — New Item Form (camera mode) */}
            {/* ═══════════════════════════════════════════ */}
            {sheetMode === 'new' && (
                <div className="bg-slate-900 border-t border-white/10 rounded-t-3xl px-5 pt-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] animate-in slide-in-from-bottom duration-300 max-h-[70vh] overflow-y-auto">
                    {/* Handle bar */}
                    <div className="w-12 h-1 bg-white/20 rounded-full mx-auto mb-4" />

                    <h3 className="text-lg font-black text-white mb-4">Add New Item</h3>

                    <div className="space-y-3">
                        {/* Item name */}
                        <div>
                            <label className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Item Name *</label>
                            <input
                                type="text"
                                value={newItem.item_name}
                                onChange={e => setNewItem(prev => ({ ...prev, item_name: e.target.value }))}
                                placeholder="e.g. Racor 2010PM-OR Fuel Filter"
                                className="w-full mt-1 bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white text-sm outline-none focus:border-sky-500 transition-colors placeholder:text-gray-600"
                                autoFocus
                            />
                        </div>

                        {/* Barcode (pre-filled if scanned) */}
                        <div>
                            <label className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Barcode</label>
                            <input
                                type="text"
                                value={newItem.barcode}
                                onChange={e => setNewItem(prev => ({ ...prev, barcode: e.target.value }))}
                                placeholder="(auto-filled from scan)"
                                className="w-full mt-1 bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white text-sm font-mono outline-none focus:border-sky-500 transition-colors placeholder:text-gray-600"
                            />
                        </div>

                        {/* Category */}
                        <div>
                            <label className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Category</label>
                            <div className="flex flex-wrap gap-1.5 mt-1">
                                {CATEGORIES.map(cat => (
                                    <button
                                        key={cat}
                                        onClick={() => setNewItem(prev => ({ ...prev, category: cat }))}
                                        className={`px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all ${newItem.category === cat
                                            ? 'bg-sky-600 text-white'
                                            : 'bg-white/5 text-gray-400 hover:bg-white/10'
                                            }`}
                                    >
                                        {cat}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Quantity + Min */}
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Quantity</label>
                                <input
                                    type="number"
                                    min="0"
                                    value={newItem.quantity}
                                    onChange={e => setNewItem(prev => ({ ...prev, quantity: parseInt(e.target.value) || 0 }))}
                                    className="w-full mt-1 bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white text-sm outline-none focus:border-sky-500 transition-colors"
                                />
                            </div>
                            <div>
                                <label className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Min Alert</label>
                                <input
                                    type="number"
                                    min="0"
                                    value={newItem.min_quantity}
                                    onChange={e => setNewItem(prev => ({ ...prev, min_quantity: parseInt(e.target.value) || 0 }))}
                                    className="w-full mt-1 bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white text-sm outline-none focus:border-sky-500 transition-colors"
                                />
                            </div>
                        </div>

                        {/* Location */}
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Zone</label>
                                <input
                                    type="text"
                                    value={newItem.location_zone}
                                    onChange={e => setNewItem(prev => ({ ...prev, location_zone: e.target.value }))}
                                    placeholder="Engine Room"
                                    className="w-full mt-1 bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white text-sm outline-none focus:border-sky-500 transition-colors placeholder:text-gray-600"
                                />
                            </div>
                            <div>
                                <label className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Exact Spot</label>
                                <input
                                    type="text"
                                    value={newItem.location_specific}
                                    onChange={e => setNewItem(prev => ({ ...prev, location_specific: e.target.value }))}
                                    placeholder="Stbd drawer"
                                    className="w-full mt-1 bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white text-sm outline-none focus:border-sky-500 transition-colors placeholder:text-gray-600"
                                />
                            </div>
                        </div>

                        {/* Description */}
                        <div>
                            <label className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Notes</label>
                            <input
                                type="text"
                                value={newItem.description}
                                onChange={e => setNewItem(prev => ({ ...prev, description: e.target.value }))}
                                placeholder="Part number, batch, etc."
                                className="w-full mt-1 bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white text-sm outline-none focus:border-sky-500 transition-colors placeholder:text-gray-600"
                            />
                        </div>

                        {/* Expiry / Service Date */}
                        <div>
                            <label className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Expiry / Service Date</label>
                            <input
                                type="date"
                                value={newItem.expiry_date}
                                onChange={e => setNewItem(prev => ({ ...prev, expiry_date: e.target.value }))}
                                className="w-full mt-1 bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white text-sm outline-none focus:border-sky-500 transition-colors"
                            />
                        </div>
                    </div>

                    {/* Actions */}
                    <div className="flex gap-3 mt-5">
                        <button onClick={dismissSheet} className="flex-1 py-3 bg-white/5 text-gray-400 rounded-xl text-sm font-bold">
                            Cancel
                        </button>
                        <button
                            onClick={handleSaveNew}
                            disabled={!newItem.item_name.trim() || saving}
                            className="flex-1 py-3 bg-sky-600 text-white rounded-xl text-sm font-black uppercase tracking-wider disabled:opacity-50 transition-all active:scale-[0.98]"
                        >
                            {saving ? 'Saving…' : 'Add Item'}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};

