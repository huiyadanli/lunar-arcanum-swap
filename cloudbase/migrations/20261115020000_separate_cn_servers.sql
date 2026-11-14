-- 已有线上环境的区服隔离修复；保留全部业务数据与函数权限。
-- 先按业务锁顺序锁住两个国服分区，避免与发布及维护并发。
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('swap:cn',0));
SELECT pg_advisory_xact_lock(hashtextextended('swap:cn_bili',0));
ALTER TABLE public.players DROP CONSTRAINT players_region_check,
  ADD CONSTRAINT players_region_check CHECK (region IN ('cn','cn_bili','asia','us','eu','tw'));

CREATE OR REPLACE FUNCTION swap_private.scan(actor text, lid uuid) RETURNS jsonb
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
    -- 分区和实际区服均须一致，不能把天空岛与世界树配到一起。
    WHERE l.region=a.region AND l.server=a.server AND l.status='waiting' AND l.account_id<>actor AND player.credit>=30
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

CREATE OR REPLACE FUNCTION public.swap_maintenance() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, swap_private AS $$
DECLARE partition text; m public.matches; p public.players; confirmation jsonb; indices integer[]; processed integer := 0; next_due timestamptz;
BEGIN
  FOR partition IN SELECT unnest(ARRAY['asia','cn','cn_bili','eu','tw','us']) LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('swap:'||partition,0));
    FOR m IN SELECT * FROM public.matches WHERE region=partition AND status IN ('matched','confirming') AND expires_at<=now() ORDER BY expires_at,id LIMIT 100 FOR UPDATE LOOP
      confirmation := coalesce(m.confirm_a,m.confirm_b);
      IF confirmation->>'result'='completed' THEN
        SELECT array_agg(value::integer ORDER BY value::integer) INTO indices FROM jsonb_array_elements_text(confirmation->'completedPairs');
        PERFORM swap_private.settle(m.id,'completed',indices,CASE WHEN m.confirm_a IS NOT NULL THEN 6 ELSE 2 END,
          CASE WHEN m.confirm_b IS NOT NULL THEN 6 ELSE 2 END,false,false,1,1);
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
  -- 调度只需这个时间，不返回账号、UID 或内部流水。清理任务允许合并到下一次实际访问。
  SELECT min(due_at) INTO next_due FROM (
    SELECT expires_at AS due_at FROM public.matches WHERE status IN ('matched','confirming')
    UNION ALL SELECT cooldown_until FROM public.players WHERE region IS NOT NULL AND cooldown_until IS NOT NULL
    UNION ALL SELECT greatest(recovered_at,coalesce(last_bad_at,created_at))+interval '7 days'
      FROM public.players WHERE region IS NOT NULL AND credit<100
    UNION ALL SELECT min(expires_at) FROM public.request_records
    UNION ALL SELECT min(until_at) FROM public.pair_blocks
    UNION ALL SELECT min(window_start)+interval '1 day' FROM swap_private.rate_limits
  ) due;
  RETURN jsonb_build_object('processed',processed,'nextDueAt',swap_private.ms(next_due));
END $$;
COMMIT;
