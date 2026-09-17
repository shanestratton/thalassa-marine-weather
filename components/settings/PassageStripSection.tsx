/**
 * PassageStripSection — the switch for the Obs chart's passage strip.
 *
 * Shane, 2026-09-17: "i dont really know which screen to look at … a new layer
 * on the obs page." The strip answers that, and it starts OFF: the chart is the
 * most crowded page in the app, three review rounds each found new furniture
 * in the strip's column, and a public beta is no place to discover the fourth
 * on somebody else's phone. Device-remembered, like the strip's open state.
 */
import React from 'react';
import { Row, Section, Toggle } from './SettingsPrimitives';
import { setPassageHudEnabled, usePassageHudEnabled } from '../../stores/passageHudStore';

export const PassageStripSection: React.FC = () => {
    const enabled = usePassageHudEnabled();
    return (
        <Section title="Chart">
            <Row>
                <div className="flex-1">
                    <label className="text-sm text-white font-medium block">Passage strip on the chart</label>
                    <p className="text-xs text-gray-400">
                        A slim strip down the left of the Obs chart: distance left along the route you are following,
                        SOG, COG, true and apparent wind. Opens from a small tab on the left edge. Not shown in
                        landscape on a phone, while planning, or while a storm card is up.
                    </p>
                </div>
                <Toggle checked={enabled} onChange={setPassageHudEnabled} label="Passage strip on the chart" />
            </Row>
        </Section>
    );
};
