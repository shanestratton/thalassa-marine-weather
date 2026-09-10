import React, { Suspense, useId, useState } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { lazyRetry } from '../../utils/lazyRetry';
import { GearIcon } from '../Icons';

const PiCacheTab = lazyRetry(
    () => import('../settings/PiCacheTab').then((module) => ({ default: module.PiCacheTab })),
    'BoatHardwareIntegrations',
);

/** Read live settings only when the skipper opens the setup controls. */
const HardwareControls: React.FC = () => {
    const settings = useSettingsStore((state) => state.settings);
    const onSave = useSettingsStore((state) => state.updateSettings);
    return <PiCacheTab settings={settings} onSave={onSave} />;
};

/** One home for advanced controls, inside Boat Network's existing scroll area. */
export const BoatHardwareIntegrations: React.FC = () => {
    const [expanded, setExpanded] = useState(false);
    const panelId = useId();

    return (
        <section
            className="mb-4 min-w-0 rounded-2xl border"
            data-boat-hardware
            style={{
                background: 'var(--day-ui-surface, rgba(255,255,255,0.03))',
                borderColor: 'var(--day-ui-border, rgba(255,255,255,0.10))',
            }}
        >
            <h2>
                <button
                    type="button"
                    aria-label="Boat hardware & integrations"
                    aria-expanded={expanded}
                    aria-controls={panelId}
                    onClick={() => setExpanded((open) => !open)}
                    className="flex min-h-16 w-full items-center gap-3 rounded-2xl p-4 text-left transition-colors hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
                >
                    <span
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
                        style={{
                            background: 'var(--day-ui-surface-soft, rgba(56,189,248,0.12))',
                            color: 'var(--day-ui-accent, #7dd3fc)',
                        }}
                        aria-hidden="true"
                    >
                        <GearIcon className="h-5 w-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                        <span
                            className="block text-[11px] font-bold uppercase tracking-wider"
                            style={{ color: 'var(--day-ui-accent, #7dd3fc)' }}
                        >
                            Advanced setup
                        </span>
                        <span
                            className="mt-0.5 block text-sm font-bold leading-snug"
                            style={{ color: 'var(--day-ui-text, #f1f5f9)' }}
                        >
                            Boat hardware &amp; integrations
                        </span>
                        <span
                            className="mt-1 block text-xs font-normal leading-relaxed"
                            style={{ color: 'var(--day-ui-muted, #cbd5e1)' }}
                        >
                            Pairing, installation, cache &amp; anchor monitoring
                        </span>
                    </span>
                    <svg
                        className={`h-5 w-5 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
                        style={{ color: 'var(--day-ui-muted, #cbd5e1)' }}
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                        aria-hidden="true"
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
                    </svg>
                </button>
            </h2>
            <div id={panelId} hidden={!expanded}>
                {expanded && (
                    <div
                        className="min-w-0 border-t p-3 sm:p-4"
                        style={{ borderColor: 'var(--day-ui-border, rgba(255,255,255,0.10))' }}
                    >
                        <Suspense
                            fallback={
                                <p role="status" className="py-4 text-sm text-slate-300">
                                    Loading boat hardware controls…
                                </p>
                            }
                        >
                            <HardwareControls />
                        </Suspense>
                    </div>
                )}
            </div>
        </section>
    );
};
