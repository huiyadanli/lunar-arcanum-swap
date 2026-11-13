-- 游标保留数据库时间戳的微秒精度，避免按毫秒序列化后翻页重复或漏项。
CREATE OR REPLACE FUNCTION swap_private.state(actor text, cursor_data jsonb DEFAULT NULL) RETURNS jsonb
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
      AND (cursor_data IS NULL OR (created_at,id)<((cursor_data->>'at')::timestamptz,(cursor_data->>'id')::uuid))
      ORDER BY created_at DESC,id DESC LIMIT 21) m;
  more := jsonb_array_length(history)>20;
  IF more THEN
    history := history-20;
    next_cursor := jsonb_build_object('at',(SELECT created_at FROM public.matches WHERE id=(history->19->>'id')::uuid),'id',history->19->'id');
  END IF;
  stats := swap_private.pool_stats(p.region);
  reset_at := CASE WHEN p.quota_reset_at>now() THEN p.quota_reset_at ELSE swap_private.reset_at(p.server) END;
  RETURN jsonb_build_object('me',jsonb_build_object('accountId',actor,'accountType',a.account_type,'uid',p.uid,
      'uidMasked',swap_private.mask_uid(p.uid),'server',p.server,'region',p.region,'creditLevel',CASE WHEN p.credit>=90 THEN 5 WHEN p.credit>=60 THEN 4 WHEN p.credit>=30 THEN 2 ELSE 1 END,
      'completedCount',p.completed_count,'cooldownUntil',swap_private.ms(p.cooldown_until)),
    'listing',swap_private.listing_view(l),'matches',active,'history',history,'nextHistoryCursor',next_cursor,
    'quota',jsonb_build_object('left',CASE WHEN p.quota_reset_at>now() THEN 0 ELSE 1 END,'resetAt',swap_private.ms(reset_at)),'stats',stats);
END $$;

CREATE OR REPLACE FUNCTION swap_private.pool_stats(region_name text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public, swap_private AS $$
  WITH pool AS (SELECT l.give,l.want FROM public.listings l JOIN public.players p ON p.account_id=l.account_id
    WHERE l.region=region_name AND l.status='waiting' AND l.give<>'{}' AND cardinality(l.want)>0
      AND p.credit>=30 AND (p.cooldown_until IS NULL OR p.cooldown_until<=now())),
  supply AS (SELECT card,sum(quantity::integer) AS quantity FROM pool CROSS JOIN LATERAL jsonb_each_text(give) AS e(card,quantity) GROUP BY card),
  demand AS (SELECT card::text AS card,count(*) AS quantity FROM pool CROSS JOIN LATERAL unnest(want) card GROUP BY card),
  rarity AS (SELECT demand.card,demand.quantity::numeric/(coalesce(supply.quantity,0)+1) AS quantity FROM demand LEFT JOIN supply USING(card))
  SELECT jsonb_build_object('waiting',(SELECT count(*) FROM pool),
    'supply',coalesce((SELECT jsonb_object_agg(card,quantity) FROM supply),'{}'),
    'demand',coalesce((SELECT jsonb_object_agg(card,quantity) FROM demand),'{}'),
    'rarity',coalesce((SELECT jsonb_object_agg(card,quantity) FROM rarity),'{}'))
$$;
NOTIFY pgrst, 'reload schema';
