-- 月谕圣牌交换站：业务身份使用账号 ID；游戏 UID 可重复，且不参与鉴权。
CREATE SCHEMA swap_private;
REVOKE ALL ON SCHEMA swap_private FROM PUBLIC;

CREATE TABLE public.accounts (
  id text PRIMARY KEY,
  auth_user_id text UNIQUE,
  custom_user_id text UNIQUE,
  account_type text NOT NULL CHECK (account_type IN ('anon', 'bili')),
  credential_hash text UNIQUE,
  toy_open_id_hmac text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.players (
  account_id text PRIMARY KEY REFERENCES public.accounts(id),
  uid text,
  server text CHECK (server IN ('celestia','irminsul','asia','america','europe','tw')),
  region text CHECK (region IN ('cn','asia','us','eu','tw')),
  credit integer NOT NULL DEFAULT 100 CHECK (credit BETWEEN 0 AND 150),
  completed_count integer NOT NULL DEFAULT 0 CHECK (completed_count >= 0),
  fail_streak integer NOT NULL DEFAULT 0,
  cooldown_until timestamptz,
  quota_reset_at timestamptz,
  last_bad_at timestamptz,
  recovered_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((uid IS NULL AND server IS NULL AND region IS NULL) OR
         (uid ~ '^[0-9]{9,10}$' AND server IS NOT NULL AND region IS NOT NULL))
);
CREATE TABLE public.listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id text NOT NULL REFERENCES public.accounts(id),
  uid_snapshot text NOT NULL,
  server text NOT NULL,
  region text NOT NULL,
  give jsonb NOT NULL CHECK (jsonb_typeof(give) = 'object'),
  want integer[] NOT NULL,
  reserved_give jsonb NOT NULL DEFAULT '{}',
  reserved_want integer[] NOT NULL DEFAULT '{}',
  mode text NOT NULL CHECK (mode IN ('quick','box')),
  note jsonb,
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','closed')),
  version integer NOT NULL DEFAULT 1,
  priority_boost_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_waiting_listing_per_account ON public.listings(account_id) WHERE status = 'waiting';
CREATE INDEX listings_pool ON public.listings(region, created_at) WHERE status = 'waiting';
CREATE INDEX listings_want ON public.listings USING gin(want) WHERE status = 'waiting';
CREATE TABLE public.matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  region text NOT NULL,
  account_a text NOT NULL REFERENCES public.accounts(id),
  account_b text NOT NULL REFERENCES public.accounts(id),
  listing_a uuid NOT NULL REFERENCES public.listings(id),
  listing_b uuid NOT NULL REFERENCES public.listings(id),
  partner_a jsonb NOT NULL,
  partner_b jsonb NOT NULL,
  pairs jsonb NOT NULL CHECK (jsonb_typeof(pairs) = 'array' AND jsonb_array_length(pairs) BETWEEN 1 AND 3),
  scanned_by text NOT NULL REFERENCES public.accounts(id),
  revealed_at_a timestamptz,
  revealed_at_b timestamptz,
  confirm_a jsonb,
  confirm_b jsonb,
  status text NOT NULL DEFAULT 'matched' CHECK (status IN ('matched','confirming','completed','failed','expired','disputed')),
  settled_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '48 hours'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (account_a <> account_b),
  CHECK (scanned_by = account_a OR scanned_by = account_b)
);
CREATE INDEX matches_owner_a ON public.matches(account_a, created_at DESC, id DESC);
CREATE INDEX matches_owner_b ON public.matches(account_b, created_at DESC, id DESC);
CREATE INDEX matches_due ON public.matches(expires_at) WHERE status IN ('matched','confirming');
CREATE TABLE public.pair_blocks (
  account_a text NOT NULL REFERENCES public.accounts(id),
  account_b text NOT NULL REFERENCES public.accounts(id),
  until_at timestamptz NOT NULL,
  PRIMARY KEY (account_a, account_b),
  CHECK (account_a < account_b)
);
CREATE TABLE public.feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_account_id text NOT NULL REFERENCES public.accounts(id),
  target_account_id text NOT NULL REFERENCES public.accounts(id),
  match_id uuid NOT NULL REFERENCES public.matches(id),
  kind text NOT NULL CHECK (kind IN ('appeal','report')),
  reason text,
  note text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reporter_account_id, match_id, kind)
);
CREATE TABLE public.request_records (
  account_id text NOT NULL REFERENCES public.accounts(id),
  request_key text NOT NULL,
  fingerprint text NOT NULL,
  response jsonb NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  PRIMARY KEY (account_id, request_key)
);
CREATE TABLE swap_private.rate_limits (
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  used integer NOT NULL,
  PRIMARY KEY (bucket, window_start)
);
-- 信用流水仅供结算与申诉冲正，不是面向客户端的通知事件流。
CREATE TABLE swap_private.credit_events (
  event_id text NOT NULL,
  account_id text NOT NULL REFERENCES public.accounts(id),
  kind text NOT NULL CHECK (kind IN ('match','recovery','reset')),
  points integer NOT NULL DEFAULT 0,
  completed integer NOT NULL DEFAULT 0,
  responsible boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, account_id)
);
CREATE INDEX credit_events_owner ON swap_private.credit_events(account_id, created_at, event_id);

CREATE FUNCTION swap_private.fail(code text, status integer DEFAULT 409, retry_at timestamptz DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = code,
    DETAIL = jsonb_build_object('status', status, 'retryAt', extract(epoch FROM retry_at) * 1000)::text;
END $$;

CREATE FUNCTION swap_private.ms(t timestamptz) RETURNS bigint
LANGUAGE sql IMMUTABLE AS $$ SELECT (extract(epoch FROM t) * 1000)::bigint $$;
CREATE FUNCTION swap_private.mask_uid(u text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT left(u,3) || repeat('*',greatest(length(u)-5,0)) || right(u,2) $$;
CREATE FUNCTION swap_private.reset_at(s text, t timestamptz DEFAULT now()) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE offset_hours integer; boundary timestamptz;
BEGIN
  offset_hours := CASE s WHEN 'america' THEN -5 WHEN 'europe' THEN 1 ELSE 8 END;
  boundary := (date_trunc('day', t AT TIME ZONE 'UTC' + make_interval(hours => offset_hours))
               + interval '4 hours' - make_interval(hours => offset_hours)) AT TIME ZONE 'UTC';
  IF boundary <= t THEN boundary := boundary + interval '1 day'; END IF;
  RETURN boundary;
END $$;

CREATE FUNCTION swap_private.rate_limit(keys text[], maximum integer DEFAULT 30) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, swap_private AS $$
DECLARE key text; counter integer; start_at timestamptz := date_trunc('hour', now());
BEGIN
  -- 固定顺序更新，避免多个设备共用同一 IP 时死锁。
  FOR key IN SELECT DISTINCT x FROM unnest(keys) x WHERE x IS NOT NULL ORDER BY x LOOP
    INSERT INTO swap_private.rate_limits(bucket,window_start,used) VALUES (key,start_at,1)
    ON CONFLICT (bucket,window_start) DO UPDATE SET used = rate_limits.used + 1 RETURNING used INTO counter;
    IF counter > maximum THEN PERFORM swap_private.fail('RATE_LIMITED',429,start_at + interval '1 hour'); END IF;
  END LOOP;
END $$;

CREATE FUNCTION swap_private.listing_view(l public.listings) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public, swap_private AS $$
  SELECT CASE WHEN l.id IS NULL THEN NULL ELSE jsonb_build_object(
    'id',l.id,'give',l.give,'want',l.want,'reservedGive',l.reserved_give,'reservedWant',l.reserved_want,
    'mode',l.mode,'note',l.note,'server',l.server,'region',l.region,'version',l.version,
    'createdAt',swap_private.ms(l.created_at),'updatedAt',swap_private.ms(l.updated_at)) END
$$;

CREATE FUNCTION swap_private.match_view(m public.matches, viewer text) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, swap_private AS $$
DECLARE is_a boolean; partner jsonb; revealed timestamptz; other_id text; visible_pairs jsonb; level integer;
BEGIN
  IF m.id IS NULL OR viewer NOT IN (m.account_a,m.account_b) THEN PERFORM swap_private.fail('NOT_FOUND',404); END IF;
  is_a := viewer = m.account_a;
  partner := CASE WHEN is_a THEN m.partner_b ELSE m.partner_a END;
  revealed := CASE WHEN is_a THEN m.revealed_at_a ELSE m.revealed_at_b END;
  other_id := CASE WHEN is_a THEN m.account_b ELSE m.account_a END;
  SELECT CASE WHEN credit >= 90 THEN 5 WHEN credit >= 60 THEN 4 WHEN credit >= 30 THEN 2 ELSE 1 END INTO level
    FROM public.players WHERE account_id = other_id;
  partner := (partner - 'uid') || jsonb_build_object('creditLevel',level);
  IF revealed IS NOT NULL AND m.status IN ('matched','confirming') AND m.expires_at > now() THEN
    partner := partner || jsonb_build_object('uid',CASE WHEN is_a THEN m.partner_b->>'uid' ELSE m.partner_a->>'uid' END);
  END IF;
  SELECT jsonb_agg(jsonb_build_object('give',CASE WHEN is_a THEN p->'aGives' ELSE p->'bGives' END,
    'get',CASE WHEN is_a THEN p->'bGives' ELSE p->'aGives' END) ORDER BY ord) INTO visible_pairs
    FROM jsonb_array_elements(m.pairs) WITH ORDINALITY AS e(p,ord);
  RETURN jsonb_build_object('id',m.id,'partner',partner,'pairs',visible_pairs,'status',m.status,
    'createdAt',swap_private.ms(m.created_at),'expiresAt',swap_private.ms(m.expires_at),
    'revealed',revealed IS NOT NULL,'partnerRevealed',CASE WHEN is_a THEN m.revealed_at_b IS NOT NULL ELSE m.revealed_at_a IS NOT NULL END,
    'scannedBy',CASE WHEN viewer = m.scanned_by THEN 'me' ELSE 'partner' END,
    'myConfirm',CASE WHEN is_a THEN m.confirm_a ELSE m.confirm_b END,
    'partnerConfirm',CASE WHEN is_a THEN m.confirm_b ELSE m.confirm_a END);
END $$;

CREATE FUNCTION swap_private.reserve(lid uuid, giving integer, getting integer) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, swap_private AS $$
DECLARE l public.listings; amount integer;
BEGIN
  SELECT * INTO STRICT l FROM public.listings WHERE id = lid FOR UPDATE;
  amount := coalesce((l.give->>giving::text)::integer,0);
  IF amount < 1 OR NOT getting = ANY(l.want) OR l.status <> 'waiting' THEN PERFORM swap_private.fail('CARDS_LOCKED'); END IF;
  UPDATE public.listings SET
    give = CASE WHEN amount = 1 THEN give - giving::text ELSE jsonb_set(give,ARRAY[giving::text],to_jsonb(amount-1)) END,
    want = array_remove(want,getting),
    reserved_give = jsonb_set(reserved_give,ARRAY[giving::text],to_jsonb(coalesce((reserved_give->>giving::text)::integer,0)+1)),
    reserved_want = array_append(reserved_want,getting),version = version+1,updated_at = now() WHERE id = lid;
END $$;

CREATE FUNCTION swap_private.finish_pair(lid uuid, giving integer, getting integer, completed boolean) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, swap_private AS $$
DECLARE l public.listings; amount integer;
BEGIN
  SELECT * INTO STRICT l FROM public.listings WHERE id = lid FOR UPDATE;
  amount := coalesce((l.reserved_give->>giving::text)::integer,0);
  IF amount < 1 OR NOT getting = ANY(l.reserved_want) THEN PERFORM swap_private.fail('RESERVATION_INCONSISTENT',500); END IF;
  UPDATE public.listings SET
    reserved_give = CASE WHEN amount = 1 THEN reserved_give - giving::text ELSE jsonb_set(reserved_give,ARRAY[giving::text],to_jsonb(amount-1)) END,
    reserved_want = array_remove(reserved_want,getting),version = version+1,updated_at = now() WHERE id = lid;
  -- 撤回的需求保留占用记录，但失败释放时不能重新激活。
  IF NOT completed AND l.status = 'waiting' THEN
    UPDATE public.listings SET give = jsonb_set(give,ARRAY[giving::text],to_jsonb(coalesce((give->>giving::text)::integer,0)+1)),
      want = CASE WHEN getting = ANY(want) THEN want ELSE array_append(want,getting) END WHERE id = lid;
  END IF;
END $$;

CREATE FUNCTION swap_private.rebuild_credit(actor text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, swap_private AS $$
DECLARE e record; score integer := 100; completed integer := 0; failures integer := 0;
  cooldown timestamptz; last_bad timestamptz; recovered timestamptz;
BEGIN
  SELECT created_at INTO recovered FROM public.players WHERE account_id = actor;
  FOR e IN SELECT * FROM swap_private.credit_events WHERE account_id = actor ORDER BY created_at,event_id LOOP
    IF e.kind = 'reset' THEN score := 50; failures := 0; cooldown := NULL; recovered := e.created_at;
    ELSIF e.kind = 'recovery' THEN score := least(100,score+5); recovered := e.created_at;
    ELSE
      score := greatest(0,least(150,score+e.points)); completed := completed+e.completed;
      IF e.completed > 0 THEN failures := 0; ELSIF e.responsible THEN failures := failures+1; END IF;
      IF e.points < 0 THEN last_bad := e.created_at; END IF;
      IF score < 30 OR failures >= 3 THEN cooldown := greatest(cooldown,e.created_at + interval '7 days'); END IF;
    END IF;
  END LOOP;
  UPDATE public.players SET credit = score,completed_count = completed,fail_streak = failures,
    cooldown_until = cooldown,last_bad_at = last_bad,recovered_at = recovered WHERE account_id = actor;
END $$;

CREATE FUNCTION swap_private.settle(mid uuid, outcome text, completed_indices integer[] DEFAULT '{}',
  points_a integer DEFAULT 0, points_b integer DEFAULT 0, fault_a boolean DEFAULT false, fault_b boolean DEFAULT false,
  count_a integer DEFAULT 0, count_b integer DEFAULT 0) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, swap_private AS $$
DECLARE m public.matches; p jsonb; ordinal bigint; happened timestamptz;
BEGIN
  SELECT * INTO STRICT m FROM public.matches WHERE id = mid FOR UPDATE;
  IF m.settled_at IS NULL THEN
    FOR p,ordinal IN SELECT value,ord FROM jsonb_array_elements(m.pairs) WITH ORDINALITY AS e(value,ord) LOOP
      PERFORM swap_private.finish_pair(m.listing_a,(p->>'aGives')::integer,(p->>'bGives')::integer,(ordinal-1)::integer = ANY(completed_indices));
      PERFORM swap_private.finish_pair(m.listing_b,(p->>'bGives')::integer,(p->>'aGives')::integer,(ordinal-1)::integer = ANY(completed_indices));
    END LOOP;
  END IF;
  happened := coalesce(m.settled_at,now());
  UPDATE public.matches SET status = outcome,settled_at = happened WHERE id = mid;
  INSERT INTO swap_private.credit_events(event_id,account_id,kind,points,completed,responsible,created_at)
  VALUES ('match:'||mid,m.account_a,'match',points_a,count_a,fault_a,happened),
         ('match:'||mid,m.account_b,'match',points_b,count_b,fault_b,happened)
  ON CONFLICT (event_id,account_id) DO UPDATE SET points=excluded.points,completed=excluded.completed,responsible=excluded.responsible;
  PERFORM swap_private.rebuild_credit(m.account_a); PERFORM swap_private.rebuild_credit(m.account_b);
  IF outcome IN ('failed','expired','disputed') THEN
    INSERT INTO public.pair_blocks(account_a,account_b,until_at)
    VALUES (least(m.account_a,m.account_b),greatest(m.account_a,m.account_b),now()+interval '30 days')
    ON CONFLICT (account_a,account_b) DO UPDATE SET until_at = greatest(pair_blocks.until_at,excluded.until_at);
    IF NOT fault_a THEN UPDATE public.listings SET priority_boost_until = now()+interval '24 hours' WHERE id=m.listing_a AND status='waiting'; END IF;
    IF NOT fault_b THEN UPDATE public.listings SET priority_boost_until = now()+interval '24 hours' WHERE id=m.listing_b AND status='waiting'; END IF;
  END IF;
END $$;

CREATE FUNCTION swap_private.pool_stats(region_name text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public, swap_private AS $$
  WITH pool AS (SELECT give,want FROM public.listings WHERE region=region_name AND status='waiting' AND give<>'{}' AND cardinality(want)>0),
  supply AS (SELECT card,sum(quantity::integer) AS quantity FROM pool CROSS JOIN LATERAL jsonb_each_text(give) AS e(card,quantity) GROUP BY card),
  demand AS (SELECT card::text AS card,count(*) AS quantity FROM pool CROSS JOIN LATERAL unnest(want) card GROUP BY card),
  rarity AS (SELECT demand.card,demand.quantity::numeric/(coalesce(supply.quantity,0)+1) AS quantity FROM demand LEFT JOIN supply USING(card))
  SELECT jsonb_build_object('waiting',(SELECT count(*) FROM pool),
    'supply',coalesce((SELECT jsonb_object_agg(card,quantity) FROM supply),'{}'),
    'demand',coalesce((SELECT jsonb_object_agg(card,quantity) FROM demand),'{}'),
    'rarity',coalesce((SELECT jsonb_object_agg(card,quantity) FROM rarity),'{}'))
$$;

CREATE FUNCTION swap_private.scan(actor text, lid uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, public, swap_private AS $$
DECLARE a public.listings; b public.listings; candidate record; budget integer := 3; n integer; i integer;
  pairs jsonb; m public.matches; created jsonb := '[]'; pool_stats jsonb;
BEGIN
  IF (SELECT credit FROM public.players WHERE account_id=actor) < 60 THEN RETURN created; END IF;
  LOOP
    EXIT WHEN budget = 0;
    SELECT * INTO STRICT a FROM public.listings WHERE id=lid;
    pool_stats := swap_private.pool_stats(a.region);
    SELECT l.id, x.gives, y.gets, least(cardinality(x.gives),cardinality(y.gets),budget) AS k INTO candidate
    FROM public.listings l JOIN public.players player ON player.account_id=l.account_id
    CROSS JOIN LATERAL (SELECT array_agg(card ORDER BY coalesce((pool_stats->'rarity'->>card::text)::numeric,0) DESC,card) AS gives FROM unnest(l.want) card WHERE coalesce((a.give->>card::text)::integer,0)>0) x
    CROSS JOIN LATERAL (SELECT array_agg(card ORDER BY coalesce((pool_stats->'rarity'->>card::text)::numeric,0) DESC,card) AS gets FROM unnest(a.want) card WHERE coalesce((l.give->>card::text)::integer,0)>0) y
    WHERE l.region=a.region AND l.status='waiting' AND l.account_id<>actor AND player.credit>=30
      AND (player.cooldown_until IS NULL OR player.cooldown_until<=now())
      AND NOT EXISTS (SELECT 1 FROM public.pair_blocks block WHERE block.account_a=least(actor,l.account_id)
        AND block.account_b=greatest(actor,l.account_id) AND block.until_at>now())
      AND cardinality(x.gives)>0 AND cardinality(y.gets)>0
    ORDER BY least(cardinality(x.gives),cardinality(y.gets),budget) DESC,
      (CASE WHEN player.credit>=90 THEN 1.0 WHEN player.credit>=60 THEN 0.6 ELSE 0.3 END)*
      (1+least(extract(epoch FROM now()-l.created_at)/3600,72)/24) +
      CASE WHEN l.priority_boost_until>now() THEN 5 ELSE 0 END +
      (SELECT coalesce(sum((pool_stats->'rarity'->>card::text)::numeric),0) FROM unnest(x.gives||y.gets) card) DESC, l.created_at,l.id LIMIT 1;
    EXIT WHEN NOT FOUND;
    SELECT * INTO STRICT b FROM public.listings WHERE id=candidate.id;
    n := candidate.k; pairs := '[]';
    FOR i IN 1..n LOOP
      PERFORM swap_private.reserve(a.id,candidate.gives[i],candidate.gets[i]);
      PERFORM swap_private.reserve(b.id,candidate.gets[i],candidate.gives[i]);
      pairs := pairs || jsonb_build_array(jsonb_build_object('aGives',candidate.gives[i],'bGives',candidate.gets[i]));
    END LOOP;
    INSERT INTO public.matches(region,account_a,account_b,listing_a,listing_b,partner_a,partner_b,pairs,scanned_by)
    VALUES (a.region,actor,b.account_id,a.id,b.id,
      jsonb_build_object('uid',a.uid_snapshot,'uidMasked',swap_private.mask_uid(a.uid_snapshot),'server',a.server,'note',a.note),
      jsonb_build_object('uid',b.uid_snapshot,'uidMasked',swap_private.mask_uid(b.uid_snapshot),'server',b.server,'note',b.note),pairs,actor) RETURNING * INTO m;
    created := created || jsonb_build_array(swap_private.match_view(m,actor)); budget := budget-n;
  END LOOP;
  RETURN created;
END $$;

CREATE FUNCTION swap_private.state(actor text, cursor_data jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, swap_private AS $$
DECLARE p public.players; a public.accounts; l public.listings; active jsonb; history jsonb; next_cursor jsonb;
  stats jsonb; reset_at timestamptz; more boolean;
BEGIN
  SELECT * INTO STRICT p FROM public.players WHERE account_id=actor;
  SELECT * INTO STRICT a FROM public.accounts WHERE id=actor;
  SELECT * INTO l FROM public.listings WHERE account_id=actor AND status='waiting';
  SELECT coalesce(jsonb_agg(swap_private.match_view(m,actor) ORDER BY m.created_at DESC,m.id DESC),'[]') INTO active
    FROM public.matches m WHERE actor IN (m.account_a,m.account_b) AND m.status IN ('matched','confirming');
  SELECT coalesce(jsonb_agg(swap_private.match_view(m,actor) ORDER BY m.created_at DESC,m.id DESC),'[]') INTO history
    FROM (SELECT * FROM public.matches WHERE actor IN (account_a,account_b) AND status NOT IN ('matched','confirming')
      AND (cursor_data IS NULL OR (created_at,id)<(to_timestamp((cursor_data->>'at')::numeric/1000),(cursor_data->>'id')::uuid))
      ORDER BY created_at DESC,id DESC LIMIT 21) m;
  more := jsonb_array_length(history)>20;
  IF more THEN
    history := history-20; next_cursor := jsonb_build_object('at',(history->19)->'createdAt','id',(history->19)->'id');
  END IF;
  stats := swap_private.pool_stats(p.region);
  reset_at := CASE WHEN p.quota_reset_at>now() THEN p.quota_reset_at ELSE swap_private.reset_at(p.server) END;
  RETURN jsonb_build_object('me',jsonb_build_object('accountId',actor,'accountType',a.account_type,'uid',p.uid,
      'uidMasked',swap_private.mask_uid(p.uid),'server',p.server,'region',p.region,'creditLevel',CASE WHEN p.credit>=90 THEN 5 WHEN p.credit>=60 THEN 4 WHEN p.credit>=30 THEN 2 ELSE 1 END,
      'completedCount',p.completed_count,'cooldownUntil',swap_private.ms(p.cooldown_until)),
    'listing',swap_private.listing_view(l),'matches',active,'history',history,'nextHistoryCursor',next_cursor,
    'quota',jsonb_build_object('left',CASE WHEN p.quota_reset_at>now() THEN 0 ELSE 1 END,'resetAt',swap_private.ms(reset_at)),'stats',stats);
END $$;

CREATE FUNCTION swap_private.confirm_match(actor text, mid uuid, data jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, public, swap_private AS $$
DECLARE m public.matches; mine jsonb; other jsonb; confirmation jsonb; is_a boolean; indices integer[]; other_indices integer[];
  penalty integer; blame_me boolean := false; blame_other boolean := false; outcome text;
BEGIN
  SELECT * INTO m FROM public.matches WHERE id=mid FOR UPDATE;
  IF m.id IS NULL OR actor NOT IN (m.account_a,m.account_b) THEN PERFORM swap_private.fail('NOT_FOUND',404); END IF;
  is_a := actor=m.account_a; mine := CASE WHEN is_a THEN m.confirm_a ELSE m.confirm_b END;
  other := CASE WHEN is_a THEN m.confirm_b ELSE m.confirm_a END;
  IF data->>'result'='completed' AND NOT data ? 'completedPairs' THEN
    data := data || jsonb_build_object('completedPairs',(SELECT jsonb_agg(i) FROM generate_series(0,jsonb_array_length(m.pairs)-1) i));
  END IF;
  IF mine IS NOT NULL THEN
    IF (mine-'at')<>data THEN PERFORM swap_private.fail('CONFIRM_ALREADY_SUBMITTED'); END IF;
    RETURN jsonb_build_object('match',swap_private.match_view(m,actor),'outcome',m.status);
  END IF;
  IF m.status IN ('completed','expired','disputed') OR m.expires_at<=now() THEN PERFORM swap_private.fail('MATCH_CLOSED'); END IF;
  IF data->>'result'='completed' THEN
    SELECT coalesce(array_agg(value::integer ORDER BY value::integer),'{}') INTO indices FROM jsonb_array_elements_text(data->'completedPairs');
    IF cardinality(indices)=0 OR EXISTS (SELECT 1 FROM unnest(indices) x WHERE x<0 OR x>=jsonb_array_length(m.pairs)) THEN PERFORM swap_private.fail('INVALID_COMPLETED_PAIRS',422); END IF;
  END IF;
  confirmation := data || jsonb_build_object('at',swap_private.ms(now()));
  UPDATE public.matches SET confirm_a=CASE WHEN is_a THEN confirmation ELSE confirm_a END,
    confirm_b=CASE WHEN is_a THEN confirm_b ELSE confirmation END WHERE id=mid;
  IF other IS NOT NULL AND (other->>'result'<>data->>'result') THEN
    PERFORM swap_private.settle(mid,'disputed'); outcome := 'disputed';
  ELSIF data->>'result'='completed' AND other IS NOT NULL THEN
    SELECT array_agg(value::integer ORDER BY value::integer) INTO other_indices FROM jsonb_array_elements_text(other->'completedPairs');
    IF indices<>other_indices THEN PERFORM swap_private.settle(mid,'disputed'); outcome := 'disputed';
    ELSE PERFORM swap_private.settle(mid,'completed',indices,2,2,false,false,1,1); outcome := 'completed'; END IF;
  ELSIF data->>'result'='completed' THEN
    UPDATE public.matches SET status='confirming' WHERE id=mid; outcome := 'confirming';
  ELSIF other IS NOT NULL AND other->>'result'='failed' THEN
    -- 两份失败陈述的责任不一致时，撤销先前扣分，交由申诉处理。
    IF (CASE WHEN data->>'reason'='self' THEN actor WHEN data->>'reason' IN ('no_friend','no_response','no_card','changed_mind') THEN
        CASE WHEN is_a THEN m.account_b ELSE m.account_a END ELSE '' END) =
       (CASE WHEN other->>'reason'='self' THEN CASE WHEN is_a THEN m.account_b ELSE m.account_a END
        WHEN other->>'reason' IN ('no_friend','no_response','no_card','changed_mind') THEN actor ELSE '' END) THEN
      outcome := 'failed';
    ELSE PERFORM swap_private.settle(mid,'disputed'); outcome := 'disputed'; END IF;
  ELSE
    blame_other := data->>'reason' IN ('no_friend','no_response','no_card','changed_mind');
    blame_me := data->>'reason'='self';
    penalty := CASE WHEN data->>'reason' IN ('no_card','changed_mind') THEN -10 WHEN blame_other THEN -15 WHEN blame_me THEN -5 ELSE 0 END;
    PERFORM swap_private.settle(mid,'failed','{}',CASE WHEN (is_a AND blame_me) OR (NOT is_a AND blame_other) THEN penalty ELSE 0 END,
      CASE WHEN (is_a AND blame_other) OR (NOT is_a AND blame_me) THEN penalty ELSE 0 END,
      (is_a AND blame_me) OR (NOT is_a AND blame_other),(is_a AND blame_other) OR (NOT is_a AND blame_me));
    outcome := CASE WHEN blame_other THEN 'back_to_pool' ELSE 'released' END;
  END IF;
  SELECT * INTO STRICT m FROM public.matches WHERE id=mid;
  RETURN jsonb_build_object('match',swap_private.match_view(m,actor),'outcome',outcome);
END $$;

CREATE FUNCTION public.swap_bili_session(p_credential_hash text DEFAULT NULL, p_new_id text DEFAULT NULL,
  p_new_credential_hash text DEFAULT NULL, p_rate_keys text[] DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, swap_private AS $$
DECLARE a public.accounts;
BEGIN
  PERFORM swap_private.rate_limit(p_rate_keys);
  IF p_credential_hash IS NOT NULL THEN
    SELECT * INTO a FROM public.accounts WHERE credential_hash=p_credential_hash AND account_type='bili';
    IF NOT FOUND THEN PERFORM swap_private.fail('CREDENTIAL_INVALID',401); END IF;
  ELSE
    IF p_new_id IS NULL OR p_new_credential_hash IS NULL THEN PERFORM swap_private.fail('INVALID_REQUEST',422); END IF;
    INSERT INTO public.accounts(id,custom_user_id,account_type,credential_hash)
      VALUES (p_new_id,p_new_id,'bili',p_new_credential_hash) RETURNING * INTO a;
    INSERT INTO public.players(account_id) VALUES (a.id);
  END IF;
  RETURN jsonb_build_object('customUserId',a.custom_user_id);
END $$;

CREATE FUNCTION public.swap_dispatch(p_auth_id text, p_action text, p_data jsonb DEFAULT '{}', p_custom_id text DEFAULT NULL,
  p_request_key text DEFAULT NULL, p_fingerprint text DEFAULT NULL, p_rate_keys text[] DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, swap_private AS $$
DECLARE actor text; a public.accounts; p public.players; l public.listings; m public.matches; response jsonb;
  cached public.request_records; target_region text; lock_region text; locked_regions text[]; created jsonb;
  mid uuid; feedback_id uuid; target text; match_item jsonb; refreshed jsonb; quota_until timestamptz;
BEGIN
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
  IF p_action='state' THEN RETURN swap_private.state(actor,nullif(p_data->'historyCursor','null'::jsonb)); END IF;
  IF p_request_key IS NULL OR p_fingerprint IS NULL THEN PERFORM swap_private.fail('IDEMPOTENCY_KEY_REQUIRED',400); END IF;

  -- 所有业务写入先锁分区，再锁行；修改服务器时按字典序锁住新旧分区。
  target_region := CASE WHEN p_action='profile' THEN coalesce(p_data->>'region',p.region) ELSE p.region END;
  SELECT array_agg(DISTINCT r ORDER BY r) INTO locked_regions FROM unnest(ARRAY[coalesce(p.region,'unbound:'||actor),coalesce(target_region,'unbound:'||actor)]) r;
  FOREACH lock_region IN ARRAY locked_regions LOOP PERFORM pg_advisory_xact_lock(hashtextextended('swap:'||lock_region,0)); END LOOP;
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
        UPDATE public.listings SET status='closed',give='{}',want='{}',version=version+1,updated_at=now() WHERE id=l.id RETURNING * INTO l;
      END IF;
    END IF;
    IF p_action IN ('publish','rematch') THEN
      quota_until := swap_private.reset_at(p.server);
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

CREATE FUNCTION public.swap_maintenance() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, swap_private AS $$
DECLARE partition text; m public.matches; p public.players; confirmation jsonb; indices integer[]; processed integer := 0;
BEGIN
  FOR partition IN SELECT unnest(ARRAY['asia','cn','eu','tw','us']) LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('swap:'||partition,0));
    FOR m IN SELECT * FROM public.matches WHERE region=partition AND status IN ('matched','confirming') AND expires_at<=now() ORDER BY expires_at,id LIMIT 100 FOR UPDATE LOOP
      confirmation := coalesce(m.confirm_a,m.confirm_b);
      IF confirmation->>'result'='completed' THEN
        SELECT array_agg(value::integer ORDER BY value::integer) INTO indices FROM jsonb_array_elements_text(confirmation->'completedPairs');
        PERFORM swap_private.settle(m.id,'completed',indices,CASE WHEN m.confirm_a IS NOT NULL THEN 2 ELSE 0 END,
          CASE WHEN m.confirm_b IS NOT NULL THEN 2 ELSE 0 END,false,false,1,1);
      ELSE PERFORM swap_private.settle(m.id,'expired','{}',-5,-5,true,true); END IF;
      processed := processed+1;
    END LOOP;
    FOR p IN SELECT * FROM public.players WHERE region=partition AND
      ((cooldown_until IS NOT NULL AND cooldown_until<=now()) OR
       (credit<100 AND greatest(recovered_at,coalesce(last_bad_at,created_at))<=now()-interval '7 days')) FOR UPDATE LOOP
      IF p.cooldown_until IS NOT NULL AND p.cooldown_until<=now() THEN
        INSERT INTO swap_private.credit_events(event_id,account_id,kind) VALUES ('reset:'||p.cooldown_until::text,p.account_id,'reset') ON CONFLICT DO NOTHING;
      ELSE
        INSERT INTO swap_private.credit_events(event_id,account_id,kind,points) VALUES ('recovery:'||date_trunc('day',now())::text,p.account_id,'recovery',5) ON CONFLICT DO NOTHING;
      END IF;
      PERFORM swap_private.rebuild_credit(p.account_id);
    END LOOP;
  END LOOP;
  DELETE FROM public.request_records WHERE expires_at<=now();
  DELETE FROM public.pair_blocks WHERE until_at<=now();
  DELETE FROM swap_private.rate_limits WHERE window_start<now()-interval '2 hours';
  RETURN jsonb_build_object('processed',processed);
END $$;

-- 所有业务数据与 RPC 仅服务端可用；客户端只能通过校验令牌的 HTTP API 操作。
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['accounts','players','listings','matches','pair_blocks','feedback','request_records'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE format('REVOKE ALL ON public.%I FROM anon',t); END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE format('REVOKE ALL ON public.%I FROM authenticated',t); END IF;
  END LOOP;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA swap_private FROM PUBLIC;
REVOKE ALL ON FUNCTION public.swap_dispatch(text,text,jsonb,text,text,text,text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.swap_bili_session(text,text,text,text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.swap_maintenance() FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.swap_dispatch(text,text,jsonb,text,text,text,text[]) FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION public.swap_bili_session(text,text,text,text[]) FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION public.swap_maintenance() FROM %I',role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT EXECUTE ON FUNCTION public.swap_dispatch(text,text,jsonb,text,text,text,text[]) TO service_role;
    GRANT EXECUTE ON FUNCTION public.swap_bili_session(text,text,text,text[]) TO service_role;
    GRANT EXECUTE ON FUNCTION public.swap_maintenance() TO service_role;
  END IF;
END $$;
NOTIFY pgrst, 'reload schema';
