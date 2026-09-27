import React from 'react';
import type { PassageStat } from './voyageStory';

interface PassageStatsProps {
    stats: PassageStat[];
    /** Layout only (grid, visibility, margins): the component adds none. */
    className?: string;
    label?: string;
}

/**
 * The passage facts as a description list of tiles. Deliberately no
 * headings inside: the diary list's entry titles are its only h3s.
 */
export function PassageStats({ stats, className = '', label = 'Passage facts' }: PassageStatsProps) {
    if (stats.length === 0) return null;
    return (
        <dl className={`pv-stats ${className}`} aria-label={label}>
            {stats.map((stat) => (
                <div key={stat.key} className="pv-stat" data-key={stat.key}>
                    <dt className="pv-stat__label">{stat.label}</dt>
                    <dd className="pv-stat__value pv-num">
                        {stat.parts.map((part, index) => (
                            <React.Fragment key={index}>
                                {index > 0 && ' '}
                                {part.value}
                                {part.unit && <span className="pv-stat__unit">{part.unit}</span>}
                            </React.Fragment>
                        ))}
                    </dd>
                    {stat.note && <dd className="pv-stat__note">{stat.note}</dd>}
                </div>
            ))}
        </dl>
    );
}
