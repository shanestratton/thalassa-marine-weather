/** Fixed radar alarm family. No target positions, names, NMEA frames or arbitrary commands. */
export type RadarRelayKind = 'radar-collision' | 'radar-close-quarters';
export interface RadarRelayBinding {
    ownerId: string;
    piDeviceId: string;
    pairingId: string;
    deviceId: string;
    enrollmentRevision: string;
    feedId: string;
}
export interface RadarRelayContext {
    binding: RadarRelayBinding;
    configurationRevision: string;
    instance: string;
    watchEpoch: string;
}
export interface RadarRelayIdentity {
    key: string;
    contactKey: string;
    episodeId: string;
    kind: RadarRelayKind;
}
export interface RadarRelayUpsert extends RadarRelayIdentity {
    raisedAt: number;
    reportAt: number;
    sourceAt: number;
    cpaNm: number | null;
    tcpaMin: number | null;
    rangeNm: number | null;
    bearingDeg: number | null;
    lost: 'no-fix' | 'own-motion-unknown' | 'target-motion-unknown' | 'report-too-old' | 'gone' | null;
}
export interface RadarRelayAck extends RadarRelayIdentity {
    ackedAt: number;
}
export interface RadarRelayResolved extends RadarRelayIdentity {
    how: 'passed' | 'lost';
    endedAt: number;
}
export type RadarRelayRequest =
    | { family: 'radar'; action: 'probe' }
    | { family: 'radar'; action: 'bind'; context: RadarRelayContext; expectedContextRevision: string | null }
    | { family: 'radar'; action: 'retire'; context: RadarRelayContext; contextRevision: string }
    | {
          family: 'radar';
          action: 'sync';
          context: RadarRelayContext;
          contextRevision: string;
          evaluatedAt: number;
          upserts: RadarRelayUpsert[];
          acks: RadarRelayAck[];
          resolved: RadarRelayResolved[];
          more: boolean;
      };
export const RADAR_RELAY_BATCH = 8;
export const RADAR_RELAY_CONTACT = /^radar:pi:[0-9a-f]{32}:[A-Z0-9]{2}:(?:0|[1-9][0-9]{0,2})$/;
export const RADAR_RELAY_EPISODE = /^[0-9a-f]{32}:[1-9][0-9]{0,8}$/;
export const RADAR_RELAY_KEY = /^radar-(collision|close-quarters):[0-9a-f]{12}:[0-9]{10,13}$/;
/** SHA256 these exact UTF-8 bytes; only the first12 lowercase hex digits enter the bounded event key. */
export function radarRelayKeyCanonical(
    context: RadarRelayContext,
    episode: Pick<RadarRelayUpsert, 'episodeId' | 'contactKey' | 'raisedAt' | 'kind'>,
): string {
    const b = context.binding;
    return JSON.stringify([
        1,
        [b.ownerId, b.piDeviceId, b.pairingId, b.deviceId, b.enrollmentRevision, b.feedId],
        context.configurationRevision,
        context.instance,
        episode.episodeId,
        episode.contactKey,
        episode.raisedAt,
        episode.kind,
    ]);
}
