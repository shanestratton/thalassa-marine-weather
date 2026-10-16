import React, { lazy, Suspense, useState } from 'react';
import { Row, RowChevron, Section } from './SettingsPrimitives';
const WakeRulesEditor = lazy(() => import('./WakeRulesEditor'));
export function WakeRulesSection() {
    const [open, setOpen] = useState(false);
    return (
        <>
            <Section title="Wake rules">
                <Row
                    label="Wake rules: choose sensor alarm presets"
                    onClick={(event) => {
                        event.currentTarget.focus({ preventScroll: true });
                        setOpen(true);
                    }}
                >
                    <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-white">Wake rules</p>
                        <p className="text-xs text-gray-400">Sensor presets, off until you enable them</p>
                    </div>
                    <RowChevron />
                </Row>
            </Section>
            {open && (
                <Suspense fallback={<p role="status">Opening wake rules...</p>}>
                    <WakeRulesEditor onClose={() => setOpen(false)} />
                </Suspense>
            )}
        </>
    );
}
