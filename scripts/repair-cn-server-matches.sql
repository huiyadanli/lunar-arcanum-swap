-- 运维修复：只作废天空岛与世界树之间的错误匹配，保留历史和正常同服交换。
-- 应先应用 separate_cn_servers 迁移并部署包含新 UID 分区的 swap-api。
-- 整个 DO 块是一个事务；按业务锁顺序锁定分区，可安全重跑，不重复返还卡牌。
DO $repair$
DECLARE m public.matches; l public.listings; side record; pair record; actor text;
  giving integer; getting integer; indices integer[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('swap:cn',0));
  PERFORM pg_advisory_xact_lock(hashtextextended('swap:cn_bili',0));
  CREATE TEMP TABLE repair_bad_matches ON COMMIT DROP AS
    SELECT * FROM public.matches
    WHERE ((partner_a->>'server'='celestia' AND partner_b->>'server'='irminsul')
        OR (partner_a->>'server'='irminsul' AND partner_b->>'server'='celestia'))
      AND status<>'disputed';
  CREATE TEMP TABLE repair_affected_accounts ON COMMIT DROP AS
    SELECT account_a AS account_id FROM repair_bad_matches UNION SELECT account_b FROM repair_bad_matches;

  -- 资料、需求快照及正常世界树内部匹配均归入独立分区。
  UPDATE public.players SET region='cn_bili' WHERE server='irminsul' AND region IS DISTINCT FROM 'cn_bili';
  UPDATE public.listings SET region='cn_bili' WHERE server='irminsul' AND region IS DISTINCT FROM 'cn_bili';
  UPDATE public.matches SET region='cn_bili'
    WHERE partner_a->>'server'='irminsul' AND partner_b->>'server'='irminsul' AND region IS DISTINCT FROM 'cn_bili';

  -- 仅重新打开仍有错误占用、或因错误自动完成而关闭的当前一轮需求。
  -- 已有更新一轮需求、换过 UID、或已完成正常交换时，保留用户后续选择。
  FOR l IN SELECT DISTINCT listing.* FROM public.listings listing
    JOIN repair_bad_matches bad ON listing.id IN (bad.listing_a,bad.listing_b)
    JOIN public.players player ON player.account_id=listing.account_id
    WHERE listing.status='closed' AND listing.uid_snapshot=player.uid
      AND (bad.settled_at IS NULL OR bad.status='completed')
      AND NOT EXISTS (SELECT 1 FROM public.listings newer WHERE newer.account_id=listing.account_id
        AND (newer.created_at,newer.id)>(listing.created_at,listing.id))
      AND NOT EXISTS (SELECT 1 FROM public.listings current_listing
        WHERE current_listing.account_id=listing.account_id AND current_listing.status='waiting')
      AND NOT EXISTS (SELECT 1 FROM public.matches valid_match
        WHERE listing.id IN (valid_match.listing_a,valid_match.listing_b) AND valid_match.status='completed'
          AND valid_match.partner_a->>'server'=valid_match.partner_b->>'server')
  LOOP
    UPDATE public.listings SET status='waiting',version=version+1,updated_at=now() WHERE id=l.id;
  END LOOP;

  FOR m IN SELECT * FROM repair_bad_matches ORDER BY created_at,id LOOP
    -- 未结算的占用交给现有事务函数释放；已失败记录不能重复返还。
    -- disputed 是现有的终态，既不处罚用户，也拒绝后续确认再结算。
    PERFORM swap_private.settle(m.id,'disputed');
    IF m.status='completed' THEN
      SELECT array_agg(value::integer) INTO indices
        FROM jsonb_array_elements_text(coalesce(m.confirm_a,m.confirm_b)->'completedPairs');
      FOR pair IN SELECT value,ord FROM jsonb_array_elements(m.pairs) WITH ORDINALITY AS e(value,ord)
        WHERE (ord-1)::integer=ANY(indices)
      LOOP
        FOR side IN SELECT m.listing_a AS lid,true AS is_a UNION ALL SELECT m.listing_b,false LOOP
          SELECT * INTO STRICT l FROM public.listings WHERE id=side.lid;
          -- 已自动消耗的卡牌仅恢复到该账号仍在使用的原轮次，不覆盖后来发布的新库存。
          IF l.status='waiting' AND NOT EXISTS (SELECT 1 FROM public.listings newer
            WHERE newer.account_id=l.account_id AND (newer.created_at,newer.id)>(l.created_at,l.id)) THEN
            giving := (pair.value->>CASE WHEN side.is_a THEN 'aGives' ELSE 'bGives' END)::integer;
            getting := (pair.value->>CASE WHEN side.is_a THEN 'bGives' ELSE 'aGives' END)::integer;
            UPDATE public.listings SET
              give=jsonb_set(give,ARRAY[giving::text],to_jsonb(coalesce((give->>giving::text)::integer,0)+1)),
              want=CASE WHEN getting=ANY(want) OR getting=ANY(reserved_want) THEN want ELSE array_append(want,getting) END,
              version=version+1,updated_at=now() WHERE id=l.id;
          END IF;
        END LOOP;
      END LOOP;
    END IF;
  END LOOP;

  -- settle 以中性流水冲正错误扣分、奖励及完成数；保留正常同服交换的信用流水。
  -- 重新计算只取消由错误流水导致的信用冷却，再返还受影响账号的发布机会。
  FOR actor IN SELECT account_id FROM repair_affected_accounts ORDER BY account_id LOOP
    PERFORM swap_private.rebuild_credit(actor);
    UPDATE public.players SET quota_reset_at=NULL WHERE account_id=actor;
  END LOOP;
  DELETE FROM public.pair_blocks block USING repair_bad_matches bad
    WHERE block.account_a=least(bad.account_a,bad.account_b) AND block.account_b=greatest(bad.account_a,bad.account_b);

  -- 保留幂等键，更新其中的旧资料、旧需求和结算结果，避免重放恢复错误状态。
  UPDATE public.request_records r SET response=jsonb_set(r.response,'{me}',swap_private.state(r.account_id)->'me')
    WHERE r.account_id IN (SELECT account_id FROM repair_affected_accounts) AND r.response ? 'me';
  UPDATE public.request_records r SET response=jsonb_set(r.response,'{listing}',swap_private.listing_view(cached_listing))
    FROM public.listings cached_listing WHERE r.account_id IN (SELECT account_id FROM repair_affected_accounts)
      AND r.response->'listing'->>'id'=cached_listing.id::text;
  UPDATE public.request_records r SET response=jsonb_set(r.response,'{outcome}','"released"'::jsonb)
    WHERE r.response->'match'->>'id' IN (SELECT id::text FROM repair_bad_matches) AND r.response ? 'outcome';
END $repair$;
