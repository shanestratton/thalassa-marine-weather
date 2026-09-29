/** Separate reviewed TRIAL plotting policy, not inherited from the canal gates.
 * Root reviewed MSQ Moreton Bay Beacon to Beacon MB-4 on 13 September 2026
 * (map information dated 26 August 2021), alongside installed licensed ENC
 * OC-61-10RCS5 ed1 issued 7 March 2022. This covers only finite RECTRC407,
 * whose navigation segment coincides with NAVLNE406. Its landward extension,
 * Scarborough's neighbouring channel and larger shipping channels are excluded.
 * Not an official approval, physical survey, tide or traffic clearance.
 *
 * RETIRED 2026-09-29 with its parent canal-exit review (see `retirement`). */
import { NEWPORT_CANAL_EXIT_PROFILE } from './newportCanalExitProfile';
import { NEWPORT_CHANNEL_TRACK_ID, type ReviewedChannelTrackPolicy } from './channelTrackGuidance';

export const NEWPORT_CHANNEL_TRACK_POLICY: ReviewedChannelTrackPolicy = Object.freeze({
    id: NEWPORT_CHANNEL_TRACK_ID,
    rule: 'reviewed-small-craft-centreline',
    sourceRevision: 'newport-rectrc407-msq-mb4-review-20260913',
    reviewedAt: '2026-09-12T23:30:05Z',
    validUntil: NEWPORT_CANAL_EXIT_PROFILE.validUntil,
    retirement: Object.freeze({
        retiredOn: '2026-09-29',
        decidedBy: 'Shane (owner), Phase 0 approval 2026-09-29',
        reason: 'Its lease ended with the parent Newport canal-exit review at 2026-09-19T21:12:59Z, and that review is retired: Newport stays on a manual canal exit until the new inshore router lands.',
        fallback:
            'No chart-track guidance at Newport. Auto keeps the first SevenCs proposal unchanged, with the notice that channel-track guidance is unavailable and charted tracks need reviewing independently.',
    }),
    span: Object.freeze([
        Object.freeze([153.095128, -27.1675] as const),
        Object.freeze([153.093142, -27.201389] as const),
    ] as const),
});
