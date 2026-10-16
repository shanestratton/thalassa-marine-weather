-- HELD: build138 reviewed route replacement. Apply only after exact-source
-- disposable PostgreSQL privacy/concurrency proof and deployment review.
-- No route geometry, forecast grid, chart fact, trigger or scheduled writer.
CREATE TABLE public.route_replan_receipts (
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    request_id uuid NOT NULL,
    boat_id uuid NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,
    voyage_id uuid NOT NULL REFERENCES public.voyages(id) ON DELETE CASCADE,
    session_id text NOT NULL,
    payload_hash text NOT NULL,
    plan_voyage_id text NOT NULL,
    device_id text NOT NULL,
    link_updated_at timestamptz NOT NULL,
    PRIMARY KEY (user_id, request_id)
);
ALTER TABLE public.route_replan_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.route_replan_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.route_replan_receipts TO authenticated;
CREATE POLICY route_replan_receipts_owner_read ON public.route_replan_receipts
    FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE FUNCTION public.accept_reviewed_route_replan(
    p_request_id uuid, p_boat_id uuid, p_voyage_id uuid,
    p_expected_plan text, p_expected_device text, p_expected_updated_at timestamptz,
    p_plan text, p_device text, p_device_name text,
    p_session_id text, p_reviewed_at timestamptz, p_fix_at timestamptz,
    p_source_key text, p_plan_rows integer, p_geometry_sha256 text, p_authority jsonb,
    p_expected_geometry_sha256 text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog SET lock_timeout = '3s'
AS $$
DECLARE
    caller uuid := auth.uid();
    session_id text := auth.jwt()->>'session_id';
    payload_hash text;
    link public.voyage_plan_links%ROWTYPE;
    receipt public.route_replan_receipts%ROWTYPE;
    stamp timestamptz;
    policy jsonb;
    authority jsonb;
    saved_rows integer;
BEGIN
    IF caller IS NULL OR session_id IS NULL OR session_id = '' OR session_id <> p_session_id THEN
        RAISE EXCEPTION 'An unchanged authenticated session is required' USING ERRCODE = '42501';
    END IF;
    IF session_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
        RAISE EXCEPTION 'A valid authenticated session is required' USING ERRCODE = '42501';
    END IF;
    PERFORM 1 FROM auth.sessions WHERE id=session_id::uuid AND user_id=caller FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'The reviewed session has ended' USING ERRCODE = '42501'; END IF;
    IF p_request_id IS NULL OR p_boat_id IS NULL OR p_voyage_id IS NULL
       OR p_expected_updated_at IS NULL OR p_expected_plan IS NULL OR length(p_expected_plan) NOT BETWEEN 1 AND 200
       OR p_plan IS NULL OR length(p_plan) NOT BETWEEN 1 AND 200 OR p_plan = p_expected_plan
       OR p_device IS NULL OR length(p_device) NOT BETWEEN 4 AND 128
       OR (p_expected_device IS NOT NULL AND length(p_expected_device)>128)
       OR p_device_name IS NULL OR length(p_device_name) NOT BETWEEN 1 AND 128
       OR p_source_key IS NULL OR length(p_source_key) NOT BETWEEN 1 AND 512
       OR p_plan_rows IS NULL OR p_plan_rows NOT BETWEEN 2 AND 258
       OR p_geometry_sha256 IS NULL OR p_geometry_sha256 !~ '^[a-f0-9]{64}$'
       OR p_expected_geometry_sha256 IS NULL OR p_expected_geometry_sha256 !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION 'Invalid reviewed replacement' USING ERRCODE = '22023';
    END IF;
    payload_hash := encode(sha256(convert_to(jsonb_build_array(p_boat_id,p_voyage_id,p_expected_plan,p_expected_device,
        p_expected_updated_at,p_plan,p_device,p_device_name,p_session_id,p_reviewed_at,p_fix_at,p_source_key,p_plan_rows,p_geometry_sha256,p_authority,p_expected_geometry_sha256)::text,'UTF8')),'hex');

    -- Lock the actual boat/selection/voyage before the link. A fleet switch,
    -- release or completed voyage cannot race this commit into a new context.
    PERFORM 1 FROM public.boats WHERE id=p_boat_id AND owner_id=caller AND archived_at IS NULL FOR SHARE;
    IF NOT FOUND THEN RETURN jsonb_build_object('applied',false,'reason','context-changed'); END IF;
    PERFORM 1 FROM public.user_active_vessels WHERE user_id=caller AND boat_id=p_boat_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('applied',false,'reason','context-changed'); END IF;
    PERFORM 1 FROM public.voyages WHERE id=p_voyage_id AND user_id=caller AND boat_id=p_boat_id AND status='active' FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('applied',false,'reason','context-changed'); END IF;
    SELECT settings INTO policy FROM public.user_settings WHERE user_id=caller FOR SHARE;
    IF NOT FOUND THEN RETURN jsonb_build_object('applied',false,'reason','authority-changed'); END IF;
    authority:=jsonb_build_object('mode',CASE WHEN policy->>'routeAuthority'='skipper' THEN 'skipper' ELSE 'confirm' END,
        'deviceId',policy->'skipperDevice'->>'deviceId','claimedAt',policy->'skipperDevice'->>'claimedAt');
    IF p_authority IS DISTINCT FROM authority OR (authority->>'mode'='skipper' AND authority->>'deviceId' IS DISTINCT FROM p_device) THEN
        RETURN jsonb_build_object('applied',false,'reason','authority-changed');
    END IF;
    SELECT * INTO link FROM public.voyage_plan_links WHERE user_id=caller AND voyage_id=p_voyage_id::text FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('applied',false,'reason','link-changed'); END IF;
    SELECT * INTO receipt FROM public.route_replan_receipts WHERE user_id=caller AND request_id=p_request_id;
    IF FOUND THEN
        IF receipt.payload_hash <> payload_hash OR receipt.session_id <> session_id THEN
            RAISE EXCEPTION 'Request identity conflict' USING ERRCODE = '22023';
        END IF;
        IF link.plan_voyage_id=receipt.plan_voyage_id AND link.device_id=receipt.device_id
           AND link.updated_at=receipt.link_updated_at THEN
            RETURN jsonb_build_object('applied',true,'repeated',true,'updatedAt',receipt.link_updated_at);
        END IF;
        RETURN jsonb_build_object('applied',false,'reason','link-changed');
    END IF;
    IF p_reviewed_at IS NULL OR p_fix_at IS NULL
       OR p_reviewed_at < clock_timestamp()-interval '5 minutes' OR p_reviewed_at > clock_timestamp()+interval '5 seconds'
       OR p_fix_at < clock_timestamp()-interval '60 seconds' OR p_fix_at > clock_timestamp()+interval '5 seconds' THEN
        RETURN jsonb_build_object('applied',false,'reason','review-expired');
    END IF;
    IF link.plan_voyage_id<>p_expected_plan OR link.device_id IS DISTINCT FROM p_expected_device
       OR link.updated_at<>p_expected_updated_at THEN
        RETURN jsonb_build_object('applied',false,'reason','link-changed');
    END IF;
    -- Cast Off follows the active passage UUID locally, while its public
    -- link names the saved-plan mirror. Require the original exact line too.
    PERFORM 1 FROM public.ship_logs WHERE user_id=caller AND voyage_id=p_expected_plan LIMIT 259 FOR SHARE;
    GET DIAGNOSTICS saved_rows = ROW_COUNT;
    IF saved_rows NOT BETWEEN 2 AND 258
       OR EXISTS (SELECT 1 FROM public.ship_logs WHERE user_id=caller AND voyage_id=p_expected_plan
          AND (boat_id IS DISTINCT FROM p_boat_id OR source IS DISTINCT FROM 'planned_route'))
       OR NOT EXISTS (SELECT 1 FROM public.ship_logs WHERE user_id=caller AND boat_id=p_boat_id
          AND voyage_id=p_expected_plan AND source='planned_route' AND left(notes,20)='__route_geometry__::'
          AND octet_length(notes)<=1048576
          AND encode(sha256(convert_to(split_part(substr(notes,21),E'\n',1),'UTF8')),'hex')=p_expected_geometry_sha256) THEN
        RETURN jsonb_build_object('applied',false,'reason','original-route-changed');
    END IF;
    -- A queued/offline save is insufficient. Lock at most the bounded owner's
    -- complete plan plus one overflow row before checking its exact geometry.
    -- Deletion/editing cannot race the checked rows before the link commit.
    -- A different owner's coincident text ID is never read or borrowed.
    PERFORM 1 FROM public.ship_logs WHERE user_id=caller AND voyage_id=p_plan LIMIT 259 FOR SHARE;
    GET DIAGNOSTICS saved_rows = ROW_COUNT;
    IF saved_rows <> p_plan_rows
       OR EXISTS (SELECT 1 FROM public.ship_logs WHERE user_id=caller AND voyage_id=p_plan
          AND (boat_id IS DISTINCT FROM p_boat_id OR source IS DISTINCT FROM 'planned_route')) THEN
        RETURN jsonb_build_object('applied',false,'reason','plan-not-ready');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.ship_logs WHERE user_id=caller AND boat_id=p_boat_id
       AND voyage_id=p_plan AND source='planned_route' AND left(notes,20)='__route_geometry__::'
       AND octet_length(notes)<=1048576
       AND encode(sha256(convert_to(split_part(substr(notes,21),E'\n',1),'UTF8')),'hex')=p_geometry_sha256) THEN
        RETURN jsonb_build_object('applied',false,'reason','plan-not-ready');
    END IF;
    UPDATE public.voyage_plan_links SET plan_voyage_id=p_plan,device_id=p_device,device_name=p_device_name,
        updated_at=clock_timestamp() WHERE user_id=caller AND voyage_id=p_voyage_id::text RETURNING updated_at INTO stamp;
    INSERT INTO public.route_replan_receipts VALUES
        (caller,p_request_id,p_boat_id,p_voyage_id,session_id,payload_hash,p_plan,p_device,stamp);
    -- Old receipt eviction cannot resurrect an old request: its old exact
    -- link stamp no longer matches. Bound the account ledger to 512 receipts.
    DELETE FROM public.route_replan_receipts WHERE user_id=caller AND request_id IN
        (SELECT request_id FROM public.route_replan_receipts WHERE user_id=caller
            ORDER BY link_updated_at DESC,request_id DESC OFFSET 512);
    RETURN jsonb_build_object('applied',true,'repeated',false,'updatedAt',stamp);
END;
$$;
REVOKE ALL ON FUNCTION public.accept_reviewed_route_replan(uuid,uuid,uuid,text,text,timestamptz,text,text,text,text,timestamptz,timestamptz,text,integer,text,jsonb,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.accept_reviewed_route_replan(uuid,uuid,uuid,text,text,timestamptz,text,text,text,text,timestamptz,timestamptz,text,integer,text,jsonb,text) TO authenticated;
