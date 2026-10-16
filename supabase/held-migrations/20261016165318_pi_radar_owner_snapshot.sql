-- HELD: after 20261016162758_pi_radar_relay. Fixed owner-only read; no cron,
-- acquisition, relay writes, notifications or new grants on credential tables.
BEGIN;

CREATE FUNCTION thalassa_radar_private.owner_relay_enabled(p_relay_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT auth.uid() IS NOT NULL AND p_relay_id ~ '^[A-Za-z0-9_-]{16,128}$'
 AND EXISTS(SELECT 1 FROM public.pi_diary_relays r
  WHERE r.relay_id=p_relay_id AND r.owner_id=auth.uid() AND r.enabled);
$$;
REVOKE ALL ON FUNCTION thalassa_radar_private.owner_relay_enabled(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION thalassa_radar_private.owner_relay_enabled(text) TO authenticated;

CREATE INDEX pi_radar_contexts_owner_pi_idx ON public.pi_radar_contexts(owner_id,((profile->'binding')->>'piDeviceId'));

CREATE FUNCTION public.pi_radar_owner_snapshot(p_pi_device_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller uuid:=auth.uid(); stamp bigint:=floor(extract(epoch FROM statement_timestamp())*1000)::bigint;
 empty_result jsonb; candidates text[]; c public.pi_radar_contexts%ROWTYPE;
 facts jsonb; fact_count integer;
BEGIN
 empty_result:=jsonb_build_object('schema',1,'checkedAt',stamp,'owner',NULL,'context',NULL,
  'contextRevision',NULL,'retired',false,'evaluatedAt',NULL,'more',false,'alarms','[]'::jsonb);
 IF caller IS NULL OR p_pi_device_id IS NULL THEN RETURN empty_result; END IF;
 -- Count at most two BEFORE freshness filtering: an old enabled alias cannot
 -- make us silently choose a newer context for the same physical Pi identity.
 SELECT array_agg(candidate.relay_id) INTO candidates FROM (
  SELECT x.relay_id FROM public.pi_radar_contexts x
  WHERE x.owner_id=caller AND x.profile->'binding'->>'piDeviceId'=p_pi_device_id::text
   AND thalassa_radar_private.owner_relay_enabled(x.relay_id)
  LIMIT 2
 ) candidate;
 IF coalesce(array_length(candidates,1),0)<>1 THEN RETURN empty_result; END IF;
 SELECT * INTO c FROM public.pi_radar_contexts
 WHERE relay_id=candidates[1] AND owner_id=caller;
 IF NOT FOUND OR c.updated_at<statement_timestamp()-interval '30 seconds' OR
  c.updated_at>statement_timestamp()+interval '1 second' OR
  c.profile->'binding'->>'ownerId' IS DISTINCT FROM caller::text OR
  c.profile->'binding'->>'piDeviceId' IS DISTINCT FROM p_pi_device_id::text OR
  (c.profile->'binding'->>'feedId') !~ ('^pi:'||p_pi_device_id::text||':[0-9a-f]{24}$') OR
  c.profile->'binding'->>'pairingId' IS DISTINCT FROM encode(sha256(convert_to(replace(
   jsonb_build_array(caller::text,p_pi_device_id::text,c.relay_id)::text,', ',','),'UTF8')),'hex') OR
  (c.retired AND c.evaluated_at_ms IS NOT NULL) OR
  (NOT c.retired AND (c.evaluated_at_ms IS NULL OR c.evaluated_at_ms<stamp-30000 OR c.evaluated_at_ms>stamp+1000))
 THEN RETURN empty_result; END IF;
 -- Original DB clocks and fixed facts only. A fresh context is NOT proof of
 -- connected radar or fresh assessments; old/lost latches remain dated old.
 IF c.retired THEN facts:='[]'::jsonb; fact_count:=0;
 ELSE
  SELECT coalesce(jsonb_agg(rows.fact ORDER BY rows.ordinal) FILTER(WHERE rows.ordinal<=20),'[]'::jsonb),count(*)::integer
  INTO facts,fact_count FROM (
   SELECT jsonb_build_object('key',e.alarm_key,'contactKey',e.contact_key,'episodeId',e.episode_id,'kind',e.kind,
    'raisedAt',e.raised_at_ms,'sourceAt',e.source_at_ms,'reportAt',e.report_at_ms,
    'cpaNm',e.cpa_nm,'tcpaMin',e.tcpa_min,'rangeNm',e.range_nm,'bearingDeg',e.bearing_deg,'lost',e.lost,
    'ackedAt',CASE WHEN e.acked_at IS NULL THEN NULL ELSE floor(extract(epoch FROM e.acked_at)*1000)::bigint END) AS fact,
    row_number() OVER(ORDER BY CASE WHEN e.kind='radar-close-quarters' THEN 0 ELSE 1 END,(e.acked_at IS NOT NULL),e.raised_at_ms DESC,e.alarm_key,e.id) AS ordinal
   FROM public.pi_radar_events e
   WHERE e.owner_id=caller AND e.relay_id=c.relay_id AND e.context_revision=c.revision AND e.resolved_at IS NULL
   ORDER BY CASE WHEN e.kind='radar-close-quarters' THEN 0 ELSE 1 END,(e.acked_at IS NOT NULL),e.raised_at_ms DESC,e.alarm_key,e.id
   LIMIT 21
  ) rows;
 END IF;
 RETURN jsonb_build_object('schema',1,'checkedAt',stamp,
  'owner',jsonb_build_object('ownerId',caller,'piDeviceId',p_pi_device_id,'pairingId',c.profile->'binding'->>'pairingId','feedId',c.profile->'binding'->>'feedId'),
  'context',c.profile,'contextRevision',c.revision,'retired',c.retired,'evaluatedAt',c.evaluated_at_ms,'more',fact_count>20,'alarms',facts);
END;
$$;
REVOKE ALL ON FUNCTION public.pi_radar_owner_snapshot(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pi_radar_owner_snapshot(uuid) TO authenticated;

COMMIT;
