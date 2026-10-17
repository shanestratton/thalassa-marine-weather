import React, { useEffect, useRef } from 'react';
import { recommendSailPlan, type SailRecommendation, type SailWindSample } from '../../services/sailing/sailInventory';

export default function SailAdviceLine(props: {
    inventory: unknown;
    vesselType?: string;
    scopeKey: string;
    sample: SailWindSample | null;
}) {
    const previous = useRef<SailRecommendation | null>(null);
    const value = recommendSailPlan({ ...props, previous: previous.current });
    useEffect(() => {
        previous.current = value;
    });
    return (
        <p className="px-2 py-1 text-xs leading-relaxed text-amber-200" data-testid="passage-sail-plan">
            {value
                ? `Suggested sails: ${value.text}${value.held ? ' · holding reduced sail' : ''}`
                : 'Sail plan unavailable'}
            <span className="block text-gray-400">
                {value
                    ? `Your crossover at ${value.windKn.toFixed(1)} kn including known gusts; check conditions aboard.`
                    : 'Needs your sail inventory, crossover and covered forecast wind.'}
            </span>
        </p>
    );
}
