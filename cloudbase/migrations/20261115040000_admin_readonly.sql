-- 附加只读后台：不替换业务函数，不添加业务触发器，不写入业务数据。
CREATE TABLE swap_private.admin_accounts (
  account_id text PRIMARY KEY REFERENCES public.accounts(id)
);
REVOKE ALL ON swap_private.admin_accounts FROM PUBLIC, anon, authenticated;

-- p_password_verified 仅由 HTTP 后端计算；客户端角色没有此函数的执行权限。
CREATE FUNCTION public.swap_admin_query(p_auth_id text, p_custom_id text DEFAULT NULL,
  p_password_verified boolean DEFAULT false, p_query jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, swap_private AS $$
DECLARE
  view_name text := coalesce(p_query->>'view','overview');
  server_name text := nullif(p_query->>'server','');
  status_name text := nullif(p_query->>'status','');
  account_type_name text := nullif(p_query->>'accountType','');
  owner_id text := nullif(p_query->>'accountId','');
  record_id text := nullif(p_query->>'id','');
  search_text text := coalesce(p_query->>'search','');
  page_number integer := coalesce((p_query->>'page')::integer,1);
  page_size integer := coalesce((p_query->>'pageSize')::integer,50);
  result jsonb;
BEGIN
  IF p_auth_id IS NULL OR length(p_auth_id) NOT BETWEEN 1 AND 128 THEN
    PERFORM swap_private.fail('UNAUTHENTICATED',401);
  END IF;
  IF p_custom_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM swap_private.admin_accounts adm JOIN public.accounts a ON a.id=adm.account_id
      WHERE a.custom_user_id=p_custom_id AND a.auth_user_id=p_auth_id AND a.account_type='bili') THEN
      PERFORM swap_private.fail('ADMIN_FORBIDDEN',403);
    END IF;
  ELSIF p_password_verified IS DISTINCT FROM true THEN
    PERFORM swap_private.fail('ADMIN_FORBIDDEN',403);
  END IF;
  IF page_number NOT BETWEEN 1 AND 1000000 OR page_size NOT BETWEEN 1 AND 100 OR
    view_name NOT IN ('overview','waiting','matches','users','feedback') OR
    (server_name IS NOT NULL AND server_name NOT IN ('celestia','irminsul','asia','america','europe','tw')) THEN
    PERFORM swap_private.fail('INVALID_ADMIN_QUERY',422);
  END IF;

  IF view_name='overview' THEN
    WITH eligible AS MATERIALIZED (
      SELECT l.* FROM public.listings l JOIN public.players p ON p.account_id=l.account_id
      WHERE l.status='waiting' AND l.give<>'{}' AND cardinality(l.want)>0 AND p.credit>=30
        AND (p.cooldown_until IS NULL OR p.cooldown_until<=now()) AND (server_name IS NULL OR l.server=server_name)
    ), active AS MATERIALIZED (
      SELECT m.* FROM public.matches m WHERE m.status IN ('matched','confirming')
        AND (server_name IS NULL OR m.partner_a->>'server'=server_name)
    ), participants AS (
      SELECT account_id FROM eligible UNION SELECT account_a FROM active UNION SELECT account_b FROM active
    ), servers(server) AS (
      VALUES ('celestia'),('irminsul'),('asia'),('america'),('europe'),('tw')
    ), supply AS (
      SELECT e.server, card, sum(quantity::integer) AS amount
      FROM eligible e CROSS JOIN LATERAL jsonb_each_text(e.give) AS g(card,quantity) GROUP BY e.server,card
    ), demand AS (
      SELECT e.server, card, count(*) AS amount FROM eligible e CROSS JOIN LATERAL unnest(e.want) card GROUP BY e.server,card
    )
    SELECT jsonb_build_object(
      'poolUsers',(SELECT count(*) FROM participants), 'waitingUsers',(SELECT count(*) FROM eligible),
      'activeUsers',(SELECT count(*) FROM (SELECT account_a FROM active UNION SELECT account_b FROM active) x),
      'activeMatches',(SELECT count(*) FROM active), 'confirming',(SELECT count(*) FROM active WHERE status='confirming'),
      'overdueMatches',(SELECT count(*) FROM active WHERE expires_at<=now()),
      'registeredUsers',(SELECT count(*) FROM public.accounts a LEFT JOIN public.players p ON p.account_id=a.id WHERE server_name IS NULL OR p.server=server_name),
      'statuses',coalesce((SELECT jsonb_object_agg(status,n) FROM (
        SELECT m.status,count(*) n FROM public.matches m WHERE server_name IS NULL OR m.partner_a->>'server'=server_name GROUP BY m.status) x),'{}'),
      'servers',(SELECT jsonb_agg(jsonb_build_object('server',s.server,
        'waiting',(SELECT count(*) FROM eligible e WHERE e.server=s.server),
        'supply',coalesce((SELECT jsonb_object_agg(card,amount) FROM supply x WHERE x.server=s.server),'{}'),
        'demand',coalesce((SELECT jsonb_object_agg(card,amount) FROM demand x WHERE x.server=s.server),'{}')))
        FROM servers s WHERE server_name IS NULL OR s.server=server_name)
    ) INTO result;
    RETURN result || jsonb_build_object('updatedAt',swap_private.ms(now()));
  ELSIF view_name='waiting' THEN
    WITH filtered AS MATERIALIZED (
      SELECT l.created_at,l.id,jsonb_build_object('id',l.id,'accountId',l.account_id,'accountType',a.account_type,
        'uid',l.uid_snapshot,'server',l.server,'status',l.status,'give',l.give,'want',l.want,
        'reservedGive',l.reserved_give,'reservedWant',l.reserved_want,'mode',l.mode,'note',l.note,'version',l.version,
        'credit',p.credit,'cooldownUntil',swap_private.ms(p.cooldown_until),
        'eligible',l.status='waiting' AND l.give<>'{}' AND cardinality(l.want)>0 AND p.credit>=30 AND (p.cooldown_until IS NULL OR p.cooldown_until<=now()),
        'createdAt',swap_private.ms(l.created_at),'updatedAt',swap_private.ms(l.updated_at)) item
      FROM public.listings l JOIN public.accounts a ON a.id=l.account_id JOIN public.players p ON p.account_id=l.account_id
      WHERE (status_name IS NULL AND l.status='waiting' OR l.status=status_name)
        AND (server_name IS NULL OR l.server=server_name) AND (owner_id IS NULL OR l.account_id=owner_id)
        AND (record_id IS NULL OR l.id::text=record_id) AND (account_type_name IS NULL OR a.account_type=account_type_name)
        AND (search_text='' OR strpos(l.account_id,search_text)>0 OR strpos(l.uid_snapshot,search_text)>0)
    )
    SELECT jsonb_build_object('total',(SELECT count(*) FROM filtered),'items',coalesce((SELECT jsonb_agg(item ORDER BY created_at DESC,id DESC)
      FROM (SELECT * FROM filtered ORDER BY created_at DESC,id DESC LIMIT page_size OFFSET (page_number-1)*page_size) x),'[]')) INTO result;
  ELSIF view_name='matches' THEN
    WITH filtered AS MATERIALIZED (
      SELECT m.created_at,m.id,jsonb_build_object('id',m.id,'accountA',m.account_a,'accountB',m.account_b,
        'accountTypeA',a.account_type,'accountTypeB',b.account_type,'listingA',m.listing_a,'listingB',m.listing_b,
        'partnerA',m.partner_a,'partnerB',m.partner_b,'pairs',m.pairs,'status',m.status,'scannedBy',m.scanned_by,
        'confirmA',m.confirm_a,'confirmB',m.confirm_b,'revealedAtA',swap_private.ms(m.revealed_at_a),
        'revealedAtB',swap_private.ms(m.revealed_at_b),'createdAt',swap_private.ms(m.created_at),
        'expiresAt',swap_private.ms(m.expires_at),'settledAt',swap_private.ms(m.settled_at)) item
      FROM public.matches m JOIN public.accounts a ON a.id=m.account_a JOIN public.accounts b ON b.id=m.account_b
      WHERE (server_name IS NULL OR m.partner_a->>'server'=server_name) AND (status_name IS NULL OR m.status=status_name)
        AND (owner_id IS NULL OR owner_id IN (m.account_a,m.account_b)) AND (record_id IS NULL OR m.id::text=record_id)
        AND (account_type_name IS NULL OR account_type_name IN (a.account_type,b.account_type))
        AND (search_text='' OR strpos(m.id::text,search_text)>0 OR strpos(m.account_a,search_text)>0 OR strpos(m.account_b,search_text)>0
          OR strpos(m.partner_a->>'uid',search_text)>0 OR strpos(m.partner_b->>'uid',search_text)>0)
    )
    SELECT jsonb_build_object('total',(SELECT count(*) FROM filtered),'items',coalesce((SELECT jsonb_agg(item ORDER BY created_at DESC,id DESC)
      FROM (SELECT * FROM filtered ORDER BY created_at DESC,id DESC LIMIT page_size OFFSET (page_number-1)*page_size) x),'[]')) INTO result;
  ELSIF view_name='users' THEN
    WITH filtered AS MATERIALIZED (
      SELECT a.created_at,a.id,jsonb_build_object('id',a.id,'accountType',a.account_type,'uid',p.uid,'server',p.server,'region',p.region,
        'credit',p.credit,'completedCount',p.completed_count,'failStreak',p.fail_streak,
        'cooldownUntil',swap_private.ms(p.cooldown_until),'quotaResetAt',swap_private.ms(p.quota_reset_at),'createdAt',swap_private.ms(a.created_at)) item
      FROM public.accounts a LEFT JOIN public.players p ON p.account_id=a.id
      WHERE (server_name IS NULL OR p.server=server_name) AND (account_type_name IS NULL OR a.account_type=account_type_name)
        AND (record_id IS NULL OR a.id=record_id) AND (owner_id IS NULL OR a.id=owner_id)
        AND (search_text='' OR strpos(a.id,search_text)>0 OR strpos(p.uid,search_text)>0)
    )
    SELECT jsonb_build_object('total',(SELECT count(*) FROM filtered),'items',coalesce((SELECT jsonb_agg(item ORDER BY created_at DESC,id DESC)
      FROM (SELECT * FROM filtered ORDER BY created_at DESC,id DESC LIMIT page_size OFFSET (page_number-1)*page_size) x),'[]')) INTO result;
  ELSE
    WITH filtered AS MATERIALIZED (
      SELECT f.created_at,f.id,jsonb_build_object('id',f.id,'reporterAccountId',f.reporter_account_id,'targetAccountId',f.target_account_id,
        'matchId',f.match_id,'kind',f.kind,'reason',f.reason,'note',f.note,'status',f.status,'createdAt',swap_private.ms(f.created_at)) item
      FROM public.feedback f JOIN public.matches m ON m.id=f.match_id JOIN public.accounts a ON a.id=f.reporter_account_id
        JOIN public.accounts b ON b.id=f.target_account_id
      WHERE (server_name IS NULL OR m.partner_a->>'server'=server_name) AND (status_name IS NULL OR f.status=status_name)
        AND (account_type_name IS NULL OR account_type_name IN (a.account_type,b.account_type))
        AND (owner_id IS NULL OR owner_id IN (f.reporter_account_id,f.target_account_id)) AND (record_id IS NULL OR f.id::text=record_id)
        AND (search_text='' OR strpos(f.reporter_account_id,search_text)>0 OR strpos(f.target_account_id,search_text)>0
          OR strpos(m.partner_a->>'uid',search_text)>0 OR strpos(m.partner_b->>'uid',search_text)>0)
    )
    SELECT jsonb_build_object('total',(SELECT count(*) FROM filtered),'items',coalesce((SELECT jsonb_agg(item ORDER BY created_at DESC,id DESC)
      FROM (SELECT * FROM filtered ORDER BY created_at DESC,id DESC LIMIT page_size OFFSET (page_number-1)*page_size) x),'[]')) INTO result;
  END IF;
  RETURN result || jsonb_build_object('page',page_number,'pageSize',page_size,'updatedAt',swap_private.ms(now()));
END $$;
REVOKE ALL ON FUNCTION public.swap_admin_query(text,text,boolean,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.swap_admin_query(text,text,boolean,jsonb) TO service_role;
