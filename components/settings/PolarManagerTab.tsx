/**
 * PolarManagerTab — Tabbed interface for polar data input.
 * Tab A: Database (select from known boats)
 * Tab B: File Import (.pol / .csv)
 * Tab C: Manual Matrix (editable spreadsheet)
 *
 * All tabs write to the same PolarData state, which auto-saves to Supabase.
 * PolarChart renders below for visual feedback.
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { PolarData } from '../../types';
import { PolarChart } from './PolarChart';
import { POLAR_DATABASE, searchPolarDatabase, type PolarDatabaseEntry } from '../../data/polarDatabase';
import { parsePolarFile, validatePolarData, createEmptyPolar } from '../../utils/polarParser';
import { supabase } from '../../services/supabase';

type InputTab = 'database' | 'import' | 'manual';

export const PolarManagerTab: React.FC = () => {
    const [activeTab, setActiveTab] = useState<InputTab>('database');
    const [polarData, setPolarData] = useState<PolarData>(createEmptyPolar());
    const [boatModel, setBoatModel] = useState('');
    const [source, setSource] = useState<'database' | 'file_import' | 'manual'>('manual');
    const [saving, setSaving] = useState(false);
    const [lastSaved, setLastSaved] = useState<string | null>(null);
    const [loadingExisting, setLoadingExisting] = useState(true);

    // Load existing polar data from Supabase on mount
    useEffect(() => {
        loadExistingPolar();
    }, []);

    const loadExistingPolar = async () => {
        if (!supabase) { setLoadingExisting(false); return; }
        try {
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) { setLoadingExisting(false); return; }

            const { data, error } = await supabase
                .from('vessel_polars')
                .select('*')
                .eq('user_id', user.id)
                .single();

            if (data && !error) {
                setPolarData(data.polar_data as PolarData);
                setBoatModel(data.boat_model || '');
                setSource(data.source || 'manual');
                setLastSaved('Loaded from cloud');
            }
        } catch { /* No existing data */ }
        setLoadingExisting(false);
    };

    // Auto-save to Supabase (debounced)
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const savePolar = useCallback(async (data: PolarData, model: string, src: string) => {
        if (!supabase) return;
        setSaving(true);
        try {
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) return;

            const { error } = await supabase
                .from('vessel_polars')
                .upsert({
                    user_id: user.id,
                    boat_model: model,
                    source: src,
                    polar_data: data,
                    updated_at: new Date().toISOString(),
                }, { onConflict: 'user_id' });

            if (!error) {
                setLastSaved(new Date().toLocaleTimeString());
            }
        } catch { /* best effort */ }
        setSaving(false);
    }, []);

    const updatePolar = useCallback((newData: PolarData, model?: string, src?: string) => {
        setPolarData(newData);
        if (model !== undefined) setBoatModel(model);
        if (src !== undefined) setSource(src as typeof source);

        // Debounce save
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
            savePolar(newData, model ?? boatModel, src ?? source);
        }, 1500);
    }, [boatModel, source, savePolar]);

    if (loadingExisting) {
        return (
            <div className="w-full max-w-2xl mx-auto animate-in fade-in duration-300">
                <div className="flex items-center justify-center py-20">
                    <div className="w-6 h-6 border-2 border-sky-400 border-t-transparent rounded-full animate-spin" />
                    <span className="ml-3 text-sm text-gray-400">Loading polar data…</span>
                </div>
            </div>
        );
    }

    return (
        <div className="w-full max-w-2xl mx-auto animate-in fade-in slide-in-from-right-4 duration-300">
            {/* Header */}
            <div className="mb-6">
                <div className="flex items-center gap-3 mb-2">
                    <div className="p-2.5 rounded-xl bg-gradient-to-br from-sky-500/20 to-cyan-500/20 border border-sky-500/30">
                        <svg className="w-5 h-5 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                    </div>
                    <div>
                        <h2 className="text-lg font-black text-white tracking-wide">POLAR DATA</h2>
                        <p className="text-[10px] text-gray-500 uppercase tracking-widest">Performance matrix for weather routing</p>
                    </div>
                </div>
                {/* Save status */}
                <div className="flex items-center gap-2 mt-2">
                    {saving ? (
                        <span className="text-[10px] text-amber-400 font-bold uppercase tracking-wider flex items-center gap-1.5">
                            <div className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" /> Saving…
                        </span>
                    ) : lastSaved ? (
                        <span className="text-[10px] text-emerald-400/60 font-bold uppercase tracking-wider flex items-center gap-1.5">
                            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> {lastSaved}
                        </span>
                    ) : null}
                </div>
            </div>

            {/* Tab Switcher */}
            <div className="flex bg-black/40 p-1 rounded-xl border border-white/10 mb-6">
                {(['database', 'import', 'manual'] as InputTab[]).map(tab => (
                    <button
                        key={tab}
                        onClick={() => setActiveTab(tab)}
                        className={`flex-1 py-2.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-all ${activeTab === tab
                            ? 'bg-sky-600 text-white shadow-lg shadow-sky-500/30'
                            : 'text-gray-400 hover:text-white'
                            }`}
                    >
                        {tab === 'database' ? '📚 Database' : tab === 'import' ? '📁 Import' : '✏️ Manual'}
                    </button>
                ))}
            </div>

            {/* Tab Content */}
            {activeTab === 'database' && (
                <DatabaseTab
                    polarData={polarData}
                    boatModel={boatModel}
                    onSelect={(entry) => updatePolar(entry.polar, entry.model, 'database')}
                />
            )}
            {activeTab === 'import' && (
                <ImportTab onImport={(data, filename) => updatePolar(data, filename, 'file_import')} />
            )}
            {activeTab === 'manual' && (
                <ManualTab polarData={polarData} onChange={(data) => updatePolar(data, boatModel, 'manual')} />
            )}

            {/* Polar Chart Visualization */}
            <div className="mt-8 bg-white/[0.02] border border-white/[0.06] rounded-2xl p-4">
                <div className="flex items-center gap-2 mb-4">
                    <div className="w-1 h-4 rounded-full bg-cyan-500" />
                    <span className="text-[10px] font-bold text-cyan-400 uppercase tracking-widest">Polar Diagram</span>
                    {boatModel && <span className="text-[10px] text-gray-500 ml-auto">{boatModel}</span>}
                </div>
                <PolarChart data={polarData} />
            </div>
        </div>
    );
};

// ═══════════════════════════════════════════
// TAB A: DATABASE
// ═══════════════════════════════════════════

const DatabaseTab: React.FC<{
    polarData: PolarData;
    boatModel: string;
    onSelect: (entry: PolarDatabaseEntry) => void;
}> = ({ boatModel, onSelect }) => {
    const [search, setSearch] = useState('');
    const [selectedModel, setSelectedModel] = useState(boatModel);
    const results = searchPolarDatabase(search);

    // Group by manufacturer
    const grouped = results.reduce((acc, entry) => {
        if (!acc[entry.manufacturer]) acc[entry.manufacturer] = [];
        acc[entry.manufacturer].push(entry);
        return acc;
    }, {} as Record<string, PolarDatabaseEntry[]>);

    return (
        <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-4">
                <div className="w-1 h-4 rounded-full bg-sky-500" />
                <span className="text-[10px] font-bold text-sky-400 uppercase tracking-widest">Select Your Boat</span>
            </div>

            {/* Search */}
            <div className="relative mb-4">
                <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search by model or manufacturer…"
                    className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white text-sm placeholder-gray-600 outline-none focus:border-sky-500 transition-colors"
                />
                <svg className="absolute right-3 top-3.5 w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
            </div>

            {/* Results */}
            <div className="max-h-72 overflow-y-auto custom-scrollbar space-y-3">
                {Object.entries(grouped).map(([mfr, entries]) => (
                    <div key={mfr}>
                        <p className="text-[9px] font-bold text-gray-500 uppercase tracking-widest mb-1.5 px-1">{mfr}</p>
                        <div className="space-y-1">
                            {entries.map(entry => (
                                <button
                                    key={entry.model}
                                    onClick={() => { setSelectedModel(entry.model); onSelect(entry); }}
                                    className={`w-full flex items-center justify-between p-3 rounded-xl text-left transition-all ${selectedModel === entry.model
                                        ? 'bg-sky-500/15 border border-sky-500/30 text-white'
                                        : 'bg-white/[0.02] border border-transparent text-gray-300 hover:bg-white/[0.05] hover:border-white/10'
                                        }`}
                                >
                                    <div className="flex items-center gap-3">
                                        <span className="text-lg">
                                            {entry.category === 'racer' ? '🏁' : entry.category === 'multihull' ? '⛵' : '⛵'}
                                        </span>
                                        <div>
                                            <p className="text-sm font-bold">{entry.model}</p>
                                            <p className="text-[10px] text-gray-500">{entry.loa}ft • {entry.category}</p>
                                        </div>
                                    </div>
                                    {selectedModel === entry.model && (
                                        <span className="text-[9px] font-bold text-sky-400 uppercase bg-sky-500/10 px-2 py-1 rounded-md">Active</span>
                                    )}
                                </button>
                            ))}
                        </div>
                    </div>
                ))}
                {results.length === 0 && (
                    <p className="text-center text-sm text-gray-500 py-8">No boats match "{search}"</p>
                )}
            </div>

            <p className="text-[10px] text-gray-500 mt-3 text-center">
                {POLAR_DATABASE.length} boats available • Data from ORC/sail designer estimates
            </p>
        </div>
    );
};

// ═══════════════════════════════════════════
// TAB B: FILE IMPORT
// ═══════════════════════════════════════════

const ImportTab: React.FC<{
    onImport: (data: PolarData, filename: string) => void;
}> = ({ onImport }) => {
    const [dragOver, setDragOver] = useState(false);
    const [fileName, setFileName] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [warnings, setWarnings] = useState<string[]>([]);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFile = async (file: File) => {
        setError(null);
        setWarnings([]);
        try {
            const content = await file.text();
            const data = parsePolarFile(content, file.name);
            const validation = validatePolarData(data);
            setWarnings(validation.warnings);
            setFileName(file.name);
            onImport(data, file.name.replace(/\.(pol|csv)$/i, ''));
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to parse file');
        }
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files[0];
        if (file) handleFile(file);
    };

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) handleFile(file);
    };

    return (
        <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-4">
                <div className="w-1 h-4 rounded-full bg-amber-500" />
                <span className="text-[10px] font-bold text-amber-400 uppercase tracking-widest">Import Polar File</span>
            </div>

            {/* Drop zone */}
            <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-all ${dragOver
                    ? 'border-sky-400 bg-sky-500/10'
                    : 'border-white/10 hover:border-white/20 hover:bg-white/[0.02]'
                    }`}
            >
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pol,.csv,.txt"
                    onChange={handleInputChange}
                    className="hidden"
                />
                <div className="text-3xl mb-3">{fileName ? '✅' : '📄'}</div>
                <p className="text-sm font-bold text-white mb-1">
                    {fileName ? fileName : 'Drop polar file here'}
                </p>
                <p className="text-[10px] text-gray-500">
                    Supports .pol (Expedition) and .csv (OpenCPN) formats
                </p>
            </div>

            {/* Error */}
            {error && (
                <div className="mt-3 p-3 bg-red-500/10 border border-red-500/20 rounded-xl">
                    <p className="text-xs text-red-400 font-bold">⚠️ {error}</p>
                </div>
            )}

            {/* Warnings */}
            {warnings.length > 0 && (
                <div className="mt-3 p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl">
                    <p className="text-xs text-amber-400 font-bold mb-1">⚠️ Warnings:</p>
                    {warnings.map((w, i) => (
                        <p key={i} className="text-[10px] text-amber-300/70">• {w}</p>
                    ))}
                </div>
            )}

            {/* Format help */}
            <div className="mt-4 p-3 bg-white/[0.02] rounded-xl">
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Expected Format</p>
                <pre className="text-[9px] text-gray-500 font-mono overflow-x-auto">
                    {`TWA    6    8    10   12   15   20   25
45   4.2  5.1  5.8  6.2  6.5  6.4  6.0
60   4.8  5.7  6.4  6.9  7.2  7.1  6.7
90   5.2  6.2  7.0  7.5  7.9  7.8  7.3`}
                </pre>
            </div>
        </div>
    );
};

// ═══════════════════════════════════════════
// TAB C: MANUAL MATRIX
// ═══════════════════════════════════════════

const ManualTab: React.FC<{
    polarData: PolarData;
    onChange: (data: PolarData) => void;
}> = ({ polarData, onChange }) => {
    const updateCell = (angleIdx: number, windIdx: number, value: string) => {
        const num = parseFloat(value);
        const newMatrix = polarData.matrix.map((row, ai) =>
            row.map((cell, wi) => (ai === angleIdx && wi === windIdx ? (isNaN(num) ? 0 : num) : cell))
        );
        onChange({ ...polarData, matrix: newMatrix });
    };

    return (
        <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-4">
                <div className="w-1 h-4 rounded-full bg-emerald-500" />
                <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-widest">Manual Entry</span>
                <span className="text-[9px] text-gray-500 ml-auto">Boat speed in knots</span>
            </div>

            {/* Scrollable matrix */}
            <div className="overflow-x-auto custom-scrollbar -mx-1 px-1">
                <table className="w-full border-collapse min-w-[500px]">
                    <thead>
                        <tr>
                            <th className="text-[9px] font-bold text-gray-500 uppercase tracking-wider p-2 text-left sticky left-0 bg-slate-950 z-10 min-w-[52px]">
                                TWA\TWS
                            </th>
                            {polarData.windSpeeds.map(ws => (
                                <th key={ws} className="text-[9px] font-bold text-sky-400 uppercase tracking-wider p-2 text-center min-w-[52px]">
                                    {ws}kts
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {polarData.angles.map((angle, aIdx) => (
                            <tr key={angle} className="border-t border-white/5">
                                <td className="text-[10px] font-bold text-amber-400 p-2 sticky left-0 bg-slate-950 z-10">
                                    {angle}°
                                </td>
                                {polarData.windSpeeds.map((_, wIdx) => {
                                    const val = polarData.matrix[aIdx]?.[wIdx] ?? 0;
                                    const isAnomaly = checkAnomaly(polarData, aIdx, wIdx);
                                    return (
                                        <td key={wIdx} className="p-1">
                                            <input
                                                type="number"
                                                step="0.1"
                                                min="0"
                                                max="30"
                                                value={val || ''}
                                                onChange={(e) => updateCell(aIdx, wIdx, e.target.value)}
                                                placeholder="—"
                                                className={`w-full text-center text-xs font-mono py-1.5 px-1 rounded-lg outline-none transition-all ${isAnomaly
                                                    ? 'bg-red-500/20 border border-red-500/40 text-red-300 focus:border-red-400'
                                                    : val > 0
                                                        ? 'bg-white/5 border border-white/10 text-white focus:border-sky-500 focus:bg-sky-500/5'
                                                        : 'bg-white/[0.02] border border-white/5 text-gray-500 focus:border-sky-500'
                                                    }`}
                                            />
                                        </td>
                                    );
                                })}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* Quick actions */}
            <div className="flex gap-2 mt-4">
                <button
                    onClick={() => onChange(createEmptyPolar())}
                    className="text-[10px] font-bold text-gray-400 uppercase tracking-wider px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 transition-colors"
                >
                    Clear All
                </button>
            </div>
        </div>
    );
};

/** Check if a cell value is anomalous (>50% deviation from neighbors) */
function checkAnomaly(data: PolarData, aIdx: number, wIdx: number): boolean {
    const val = data.matrix[aIdx]?.[wIdx] ?? 0;
    if (val <= 0) return false;

    const neighbors: number[] = [];
    if (aIdx > 0) neighbors.push(data.matrix[aIdx - 1]?.[wIdx] ?? 0);
    if (aIdx < data.angles.length - 1) neighbors.push(data.matrix[aIdx + 1]?.[wIdx] ?? 0);
    if (wIdx > 0) neighbors.push(data.matrix[aIdx]?.[wIdx - 1] ?? 0);
    if (wIdx < data.windSpeeds.length - 1) neighbors.push(data.matrix[aIdx]?.[wIdx + 1] ?? 0);

    const validNeighbors = neighbors.filter(n => n > 0);
    if (validNeighbors.length === 0) return false;

    const avg = validNeighbors.reduce((a, b) => a + b, 0) / validNeighbors.length;
    return Math.abs(val - avg) / avg > 0.5;
}
