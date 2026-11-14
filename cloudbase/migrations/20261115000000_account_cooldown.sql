-- 发布与重新匹配冷却按账号类型区分：B站授权账号 1 分钟，匿名账号 20 分钟。
-- 匹配不再要求 B站授权（前端已去掉闸门，后端本就不做限制）；其余逻辑与上一版迁移一致。

CREATE OR REPLACE FUNCTION public.swap_dispatch(p_auth_id text, p_action text, p_data jsonb DEFAULT '{}', p_custom_id text DEFAULT NULL,
  p_request_key text DEFAULT NULL, p_fingerprint text DEFAULT NULL, p_rate_keys text[] DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, swap_private AS $$
DECLARE actor text; a public.accounts; p public.players; l public.listings; m public.matches; response jsonb;
  cached public.request_records; target_region text; lock_region text; locked_regions text[]; created jsonb;
  mid uuid; feedback_id uuid; target text; match_item jsonb; refreshed jsonb; quota_until timestamptz;
BEGIN
  -- 过期信号已由维护任务接管；等待分区锁后再次检查，防止晚到的业务写入丢失唤醒。
  IF p_data ? '_maintenanceLeaseUntil' AND clock_timestamp() >= to_timestamp((p_data->>'_maintenanceLeaseUntil')::double precision/1000) THEN
    PERFORM swap_private.fail('MAINTENANCE_LEASE_EXPIRED',409);
  END IF;
  IF p_auth_id IS NULL OR length(p_auth_id)<1 OR length(p_auth_id)>128 THEN PERFORM swap_private.fail('UNAUTHENTICATED',401); END IF;
  IF p_custom_id IS NOT NULL THEN
    SELECT * INTO a FROM public.accounts WHERE custom_user_id=p_custom_id;
    IF NOT FOUND OR (a.auth_user_id IS NOT NULL AND a.auth_user_id<>p_auth_id) THEN PERFORM swap_private.fail('UNAUTHENTICATED',401); END IF;
    UPDATE public.accounts SET auth_user_id=p_auth_id WHERE id=a.id AND auth_user_id IS NULL;
  ELSE
    INSERT INTO public.accounts(id,auth_user_id,account_type) VALUES ('anon:'||p_auth_id,p_auth_id,'anon') ON CONFLICT (auth_user_id) DO NOTHING;
    SELECT * INTO STRICT a FROM public.accounts WHERE auth_user_id=p_auth_id;
  END IF;
  actor := a.id;
  INSERT INTO public.players(account_id) VALUES (actor) ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT p FROM public.players WHERE account_id=actor;
  IF p_action='state' THEN RETURN swap_private.state(actor,CASE WHEN p_data->>'light'='true' THEN '{"light":true}'::jsonb ELSE nullif(p_data->'historyCursor','null'::jsonb) END); END IF;
  IF p_request_key IS NULL OR p_fingerprint IS NULL THEN PERFORM swap_private.fail('IDEMPOTENCY_KEY_REQUIRED',400); END IF;

  -- 所有业务写入先锁分区，再锁行；修改服务器时按字典序锁住新旧分区。
  target_region := CASE WHEN p_action='profile' THEN coalesce(p_data->>'region',p.region) ELSE p.region END;
  SELECT array_agg(DISTINCT r ORDER BY r) INTO locked_regions FROM unnest(ARRAY[coalesce(p.region,'unbound:'||actor),coalesce(target_region,'unbound:'||actor)]) r;
  FOREACH lock_region IN ARRAY locked_regions LOOP PERFORM pg_advisory_xact_lock(hashtextextended('swap:'||lock_region,0)); END LOOP;
  -- 过期信号已由维护任务接管；等待分区锁后再次检查，防止晚到的业务写入丢失唤醒。
  IF p_data ? '_maintenanceLeaseUntil' AND clock_timestamp() >= to_timestamp((p_data->>'_maintenanceLeaseUntil')::double precision/1000) THEN
    PERFORM swap_private.fail('MAINTENANCE_LEASE_EXPIRED',409);
  END IF;
  p_data := p_data-'_maintenanceLeaseUntil';
  SELECT * INTO STRICT p FROM public.players WHERE account_id=actor FOR UPDATE;
  IF NOT coalesce(p.region,'unbound:'||actor)=ANY(locked_regions) THEN PERFORM swap_private.fail('STATE_CHANGED'); END IF;
  SELECT * INTO cached FROM public.request_records WHERE account_id=actor AND request_key=p_request_key AND expires_at>now();
  IF FOUND THEN
    IF cached.fingerprint<>p_fingerprint THEN PERFORM swap_private.fail('IDEMPOTENCY_CONFLICT'); END IF;
    response := cached.response;
    -- 重放时重新生成匹配视图，不能从旧幂等响应泄露已经结束的对方 UID。
    IF response ? 'match' THEN
      SELECT * INTO m FROM public.matches WHERE id=(response->'match'->>'id')::uuid;
      response := jsonb_set(response,'{match}',swap_private.match_view(m,actor));
    END IF;
    IF response ? 'matches' THEN
      refreshed := '[]';
      FOR match_item IN SELECT value FROM jsonb_array_elements(response->'matches') LOOP
        SELECT * INTO m FROM public.matches WHERE id=(match_item->>'id')::uuid;
        refreshed := refreshed || jsonb_build_array(swap_private.match_view(m,actor));
      END LOOP;
      response := jsonb_set(response,'{matches}',refreshed);
    END IF;
    IF p_action='reveal' THEN
      SELECT * INTO m FROM public.matches WHERE id=(p_data->>'matchId')::uuid;
      IF m.status NOT IN ('matched','confirming') OR m.expires_at<=now() THEN PERFORM swap_private.fail('MATCH_CLOSED'); END IF;
      response := jsonb_build_object('uid',CASE WHEN actor=m.account_a THEN m.partner_b->>'uid' ELSE m.partner_a->>'uid' END);
    END IF;
    RETURN response;
  END IF;
  PERFORM swap_private.rate_limit(p_rate_keys);

  IF p_action='profile' THEN
    IF p_data ? 'uid' AND p.uid IS DISTINCT FROM p_data->>'uid' THEN
      IF EXISTS (SELECT 1 FROM public.listings WHERE account_id=actor AND status='waiting') OR
         EXISTS (SELECT 1 FROM public.matches WHERE actor IN (account_a,account_b) AND status IN ('matched','confirming')) THEN PERFORM swap_private.fail('ACTIVE_EXCHANGE'); END IF;
      UPDATE public.players SET uid=p_data->>'uid',server=p_data->>'server',region=p_data->>'region' WHERE account_id=actor;
    END IF;
    IF p_data ? 'toyOpenIdHmac' THEN
      IF a.account_type<>'bili' THEN PERFORM swap_private.fail('BILI_REQUIRED',403); END IF;
      IF EXISTS (SELECT 1 FROM public.accounts WHERE toy_open_id_hmac=p_data->>'toyOpenIdHmac' AND id<>actor) THEN PERFORM swap_private.fail('BILI_ALREADY_LINKED'); END IF;
      UPDATE public.accounts SET toy_open_id_hmac=p_data->>'toyOpenIdHmac' WHERE id=actor;
    END IF;
    response := jsonb_build_object('me',swap_private.state(actor)->'me');
  ELSIF p_action IN ('publish','edit','withdraw','rematch') THEN
    IF p.uid IS NULL THEN PERFORM swap_private.fail('UID_REQUIRED',422); END IF;
    IF p_action IN ('publish','rematch') THEN
      IF p.cooldown_until>now() THEN PERFORM swap_private.fail('COOLDOWN',429,p.cooldown_until); END IF;
      IF p.quota_reset_at>now() THEN PERFORM swap_private.fail('DAILY_LIMIT',429,p.quota_reset_at); END IF;
    END IF;
    IF p_data->'note' ? 'text' AND a.account_type<>'bili' THEN PERFORM swap_private.fail('NOTE_TEXT_FORBIDDEN',403); END IF;
    SELECT * INTO l FROM public.listings WHERE account_id=actor AND status='waiting' FOR UPDATE;
    IF p_action='publish' THEN
      IF l.id IS NOT NULL THEN PERFORM swap_private.fail('LISTING_EXISTS'); END IF;
      INSERT INTO public.listings(account_id,uid_snapshot,server,region,give,want,mode,note)
      VALUES (actor,p.uid,p.server,p.region,p_data->'give',ARRAY(SELECT value::integer FROM jsonb_array_elements_text(p_data->'want')),
        p_data->>'mode',p_data->'note') RETURNING * INTO l;
    ELSE
      IF l.id IS NULL THEN PERFORM swap_private.fail('NO_LISTING',404); END IF;
      IF p_action='edit' THEN
        IF l.version<>(p_data->>'version')::integer THEN PERFORM swap_private.fail('VERSION_CONFLICT'); END IF;
        IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_data->'want') card WHERE card::integer=ANY(l.reserved_want)) THEN PERFORM swap_private.fail('CARDS_LOCKED'); END IF;
        UPDATE public.listings SET give=p_data->'give',want=ARRAY(SELECT value::integer FROM jsonb_array_elements_text(p_data->'want')),
          note=p_data->'note',version=version+1,updated_at=now() WHERE id=l.id RETURNING * INTO l;
      ELSIF p_action='withdraw' THEN
        -- 撤回需求立即恢复本账号额度；已有匹配、信用处罚不变。
        UPDATE public.players SET quota_reset_at=NULL WHERE account_id=actor;
        UPDATE public.listings SET status='closed',give='{}',want='{}',version=version+1,updated_at=now() WHERE id=l.id RETURNING * INTO l;
      END IF;
    END IF;
    IF p_action IN ('publish','rematch') THEN
      quota_until := now()+CASE WHEN a.account_type='bili' THEN interval '1 minute' ELSE interval '20 minutes' END;
      UPDATE public.players SET quota_reset_at=quota_until WHERE account_id=actor;
      created := swap_private.scan(actor,l.id);
      SELECT * INTO STRICT l FROM public.listings WHERE id=l.id;
      response := jsonb_build_object('listing',swap_private.listing_view(l),'matches',created);
    ELSIF p_action='withdraw' THEN response := jsonb_build_object('listing',NULL);
    ELSE response := jsonb_build_object('listing',swap_private.listing_view(l)); END IF;
  ELSIF p_action IN ('reveal','confirm','feedback') THEN
    mid := (p_data->>'matchId')::uuid;
    SELECT * INTO m FROM public.matches WHERE id=mid FOR UPDATE;
    IF m.id IS NULL OR actor NOT IN (m.account_a,m.account_b) THEN PERFORM swap_private.fail('NOT_FOUND',404); END IF;
    IF p_action='reveal' THEN
      IF m.status NOT IN ('matched','confirming') OR m.expires_at<=now() THEN PERFORM swap_private.fail('MATCH_CLOSED'); END IF;
      UPDATE public.matches SET revealed_at_a=CASE WHEN actor=account_a THEN coalesce(revealed_at_a,now()) ELSE revealed_at_a END,
        revealed_at_b=CASE WHEN actor=account_b THEN coalesce(revealed_at_b,now()) ELSE revealed_at_b END WHERE id=mid;
      response := jsonb_build_object('uid',CASE WHEN actor=m.account_a THEN m.partner_b->>'uid' ELSE m.partner_a->>'uid' END);
    ELSIF p_action='confirm' THEN
      response := swap_private.confirm_match(actor,mid,p_data-'matchId');
    ELSE
      target := CASE WHEN actor=m.account_a THEN m.account_b ELSE m.account_a END;
      IF p_data->>'kind'='appeal' THEN
        IF m.status NOT IN ('failed','expired','disputed') OR m.settled_at<now()-interval '24 hours' THEN PERFORM swap_private.fail('APPEAL_CLOSED'); END IF;
        IF m.status<>'disputed' THEN PERFORM swap_private.settle(mid,'disputed'); END IF;
      END IF;
      INSERT INTO public.feedback(reporter_account_id,target_account_id,match_id,kind,reason,note)
      VALUES (actor,target,mid,p_data->>'kind',p_data->>'reason',p_data->>'note')
      ON CONFLICT (reporter_account_id,match_id,kind) DO UPDATE SET reason=excluded.reason,note=excluded.note RETURNING id INTO feedback_id;
      response := jsonb_build_object('id',feedback_id,'status','pending');
    END IF;
  ELSE PERFORM swap_private.fail('NOT_FOUND',404);
  END IF;
  -- UID 揭示本身天然幂等，记录中只保存操作完成，不保存对方完整 UID。
  INSERT INTO public.request_records(account_id,request_key,fingerprint,response)
  VALUES (actor,p_request_key,p_fingerprint,CASE WHEN p_action='reveal' THEN '{}'::jsonb ELSE response END)
  ON CONFLICT (account_id,request_key) DO UPDATE SET fingerprint=excluded.fingerprint,response=excluded.response,expires_at=now()+interval '24 hours';
  RETURN response;
END $$;

-- 已有冷却平滑切换：B站账号剩余等待最多 1 分钟；匿名账号保持原到期时间（原冷却不超过 10 分钟）。
UPDATE public.players SET quota_reset_at=least(quota_reset_at,now()+interval '1 minute')
WHERE quota_reset_at>now() AND account_id IN (SELECT id FROM public.accounts WHERE account_type='bili');
