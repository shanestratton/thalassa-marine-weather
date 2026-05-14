/**
 * Voyage Log — Settings tab.
 *
 * Manages the punter's public Voyage Log: the master on/off switch, their
 * public page URL, and the publishable API key + raw endpoint for anyone
 * who wants to build their own front-end against the voyage-log API.
 *
 * Diary entries are published one-by-one via the modal that appears after
 * saving an entry — this tab is the account-level control surface.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Browser } from '@capacitor/browser';
import {
    VoyageLogService,
    voyageLogApiUrl,
    voyageLogPublicUrl,
    type VoyageLogConfig,
} from '../../services/VoyageLogService';
import { triggerHaptic } from '../../utils/system';
import { Row, Section, Toggle, type SettingsTabProps } from './SettingsPrimitives';

export const VoyageLogTab: React.FC<SettingsTabProps> = () => {
    const [config, setConfig] = useState<VoyageLogConfig | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [keyRevealed, setKeyRevealed] = useState(false);
    const [copiedField, setCopiedField] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        void VoyageLogService.getConfig().then((c) => {
            if (!cancelled) {
                setConfig(c);
                setLoading(false);
            }
        });
        return () => {
            cancelled = true;
        };
    }, []);

    const copy = useCallback(async (field: string, value: string) => {
        try {
            await navigator.clipboard.writeText(value);
            setCopiedField(field);
            triggerHaptic('light');
            setTimeout(() => setCopiedField((f) => (f === field ? null : f)), 2000);
        } catch {
            /* clipboard unavailable — value is still visible to copy by hand */
        }
    }, []);

    const handleSetUp = useCallback(async () => {
        setBusy(true);
        const c = await VoyageLogService.ensureEnabled();
        setConfig(c);
        setBusy(false);
        triggerHaptic('medium');
    }, []);

    const handleToggle = useCallback(async (next: boolean) => {
        setBusy(true);
        const c = await VoyageLogService.setEnabled(next);
        if (c) setConfig(c);
        setBusy(false);
        triggerHaptic('light');
    }, []);

    if (loading) {
        return (
            <div className="px-4 pb-8">
                <div className="h-24 rounded-2xl bg-white/[0.03] border border-white/[0.06] animate-pulse" />
            </div>
        );
    }

    // ── Not set up yet ─────────────────────────────────────────────
    if (!config) {
        return (
            <div className="px-4 pb-8">
                <p className="text-sm text-gray-400 mb-6">
                    Your Voyage Log is a public page where the folks at home can follow your passage — your published
                    diary entries, your track on a map, and your latest position and barometer reading.
                </p>
                <Section title="Get started">
                    <Row>
                        <div className="flex-1">
                            <div className="text-sm text-white font-bold">Set up your Voyage Log</div>
                            <div className="text-xs text-gray-400 mt-1">
                                Creates your public page and a shareable link. Nothing goes public until you publish an
                                entry — your diary stays private by default.
                            </div>
                        </div>
                        <button
                            onClick={() => void handleSetUp()}
                            disabled={busy}
                            aria-label="Set up your voyage log"
                            className="shrink-0 text-sm font-bold text-sky-400 hover:text-sky-300 px-3 py-1.5 rounded border border-sky-400/40 hover:border-sky-300/60 transition-colors disabled:opacity-50"
                        >
                            {busy ? 'Setting up…' : 'Set up'}
                        </button>
                    </Row>
                </Section>
            </div>
        );
    }

    // ── Set up — full control surface ──────────────────────────────
    const publicUrl = voyageLogPublicUrl(config.handle, config.api_key);
    const apiUrl = voyageLogApiUrl(config.handle, config.api_key);
    const maskedKey = `${config.api_key.slice(0, 6)}${'•'.repeat(18)}`;

    return (
        <div className="px-4 pb-8">
            <p className="text-sm text-gray-400 mb-6">
                Your public Voyage Log. Publish individual diary entries from the prompt that appears after you save one
                — this tab controls the page itself.
            </p>

            <Section title="Voyage Log">
                <Row>
                    <div className="flex-1">
                        <div className="text-sm text-white font-bold">Public Voyage Log</div>
                        <div className="text-xs text-gray-400 mt-1">
                            {config.enabled
                                ? 'Your log is live. Published entries, track, and telemetry are publicly readable.'
                                : 'Your log is switched off. The public page and API return nothing until you turn it back on.'}
                        </div>
                    </div>
                    <Toggle
                        checked={config.enabled}
                        onChange={(v) => void handleToggle(v)}
                        label="Public voyage log on/off"
                    />
                </Row>
            </Section>

            <Section title="Your public page">
                <Row>
                    <div className="flex-1 min-w-0">
                        <div className="text-sm text-white font-bold">Share link</div>
                        <div className="text-xs font-mono text-sky-300 mt-1 truncate">{publicUrl}</div>
                    </div>
                    <button
                        onClick={() => void copy('url', publicUrl)}
                        aria-label="Copy your voyage log share link"
                        className="shrink-0 text-xs font-bold text-sky-400 hover:text-sky-300 px-2.5 py-1 rounded border border-sky-400/40 hover:border-sky-300/60 transition-colors uppercase tracking-wider"
                    >
                        {copiedField === 'url' ? 'Copied' : 'Copy'}
                    </button>
                </Row>
                <Row>
                    <div className="flex-1">
                        <div className="text-xs text-gray-500">
                            Vessel handle: <span className="text-gray-300 font-mono">{config.handle}</span> — derived
                            from your vessel name.
                        </div>
                    </div>
                </Row>
            </Section>

            <Section title="API access">
                <Row>
                    <div className="flex-1">
                        <div className="text-xs text-gray-400">
                            Building your own front-end? The voyage-log API serves your published log as JSON. The key
                            below is a publishable token — it's safe to ship in a public page, and you can rotate it by
                            turning the log off and on.
                        </div>
                    </div>
                </Row>
                <Row>
                    <div className="flex-1 min-w-0">
                        <div className="text-sm text-white font-bold">API key</div>
                        <div className="text-xs font-mono text-gray-300 mt-1 truncate">
                            {keyRevealed ? config.api_key : maskedKey}
                        </div>
                    </div>
                    <div className="shrink-0 flex items-center gap-2">
                        <button
                            onClick={() => setKeyRevealed((r) => !r)}
                            aria-label={keyRevealed ? 'Hide API key' : 'Reveal API key'}
                            className="text-xs font-bold text-gray-400 hover:text-gray-200 px-2.5 py-1 rounded border border-white/10 hover:border-white/20 transition-colors uppercase tracking-wider"
                        >
                            {keyRevealed ? 'Hide' : 'Show'}
                        </button>
                        <button
                            onClick={() => void copy('key', config.api_key)}
                            aria-label="Copy API key"
                            className="text-xs font-bold text-sky-400 hover:text-sky-300 px-2.5 py-1 rounded border border-sky-400/40 hover:border-sky-300/60 transition-colors uppercase tracking-wider"
                        >
                            {copiedField === 'key' ? 'Copied' : 'Copy'}
                        </button>
                    </div>
                </Row>
                <Row>
                    <div className="flex-1 min-w-0">
                        <div className="text-sm text-white font-bold">API endpoint</div>
                        <div className="text-xs font-mono text-gray-400 mt-1 truncate">{apiUrl}</div>
                    </div>
                    <button
                        onClick={() => void copy('api', apiUrl)}
                        aria-label="Copy API endpoint URL"
                        className="shrink-0 text-xs font-bold text-sky-400 hover:text-sky-300 px-2.5 py-1 rounded border border-sky-400/40 hover:border-sky-300/60 transition-colors uppercase tracking-wider"
                    >
                        {copiedField === 'api' ? 'Copied' : 'Copy'}
                    </button>
                </Row>
                <Row>
                    <div className="flex-1">
                        <div className="text-xs text-gray-400">
                            Full response shape, error codes, and a fetch example are in the API docs.
                        </div>
                    </div>
                    <button
                        onClick={() => void Browser.open({ url: 'https://thalassawx.app/voyage-log-api' })}
                        aria-label="Open the Voyage Log API documentation"
                        className="shrink-0 text-xs font-bold text-sky-400 hover:text-sky-300 px-2.5 py-1 rounded border border-sky-400/40 hover:border-sky-300/60 transition-colors uppercase tracking-wider"
                    >
                        API docs
                    </button>
                </Row>
            </Section>
        </div>
    );
};
