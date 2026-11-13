-- 首次确认完成后等待 10 分钟。主动确认者 +6 分，超时未确认者 +2 分。
-- 沿用 expires_at 与现有到期索引、定时维护；双方均未确认时仍保留 48 小时有效期。
CREATE OR REPLACE FUNCTION swap_private.confirm_match(actor text, mid uuid, data jsonb) RETURNS jsonb
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
    ELSE PERFORM swap_private.settle(mid,'completed',indices,6,6,false,false,1,1); outcome := 'completed'; END IF;
  ELSIF data->>'result'='completed' THEN
    -- 首次成功声明后给予另一方完整的 10 分钟；重复提交在上方返回，不延长截止时间。
    UPDATE public.matches SET status='confirming',expires_at=now()+interval '10 minutes' WHERE id=mid; outcome := 'confirming';
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

CREATE OR REPLACE FUNCTION public.swap_maintenance() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, swap_private AS $$
DECLARE partition text; m public.matches; p public.players; confirmation jsonb; indices integer[]; processed integer := 0;
BEGIN
  FOR partition IN SELECT unnest(ARRAY['asia','cn','eu','tw','us']) LOOP
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
  RETURN jsonb_build_object('processed',processed);
END $$;

-- 已经进入等待确认的交换，按首次成功声明时间补齐新的截止时间。
UPDATE public.matches SET expires_at=to_timestamp((coalesce(confirm_a,confirm_b)->>'at')::double precision/1000)+interval '10 minutes'
WHERE status='confirming' AND coalesce(confirm_a,confirm_b)->>'result'='completed';

NOTIFY pgrst, 'reload schema';
