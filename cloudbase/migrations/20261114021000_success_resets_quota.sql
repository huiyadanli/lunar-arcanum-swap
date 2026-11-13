-- 双方确认成功的同一笔交换只恢复一次主动发布 / 重新匹配次数。
-- 单边确认、超时自动完成、失败或争议均不恢复；信用处罚冷却另行处理。
CREATE FUNCTION swap_private.reset_successful_trade_quota() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, swap_private AS $$
BEGIN
  UPDATE public.players SET quota_reset_at=NULL WHERE account_id IN (NEW.account_a,NEW.account_b);
  RETURN NEW;
END $$;

CREATE TRIGGER reset_successful_trade_quota
AFTER UPDATE OF status ON public.matches
FOR EACH ROW WHEN (OLD.status <> 'completed' AND NEW.status = 'completed'
  AND NEW.confirm_a->>'result' = 'completed' AND NEW.confirm_b->>'result' = 'completed')
EXECUTE FUNCTION swap_private.reset_successful_trade_quota();

REVOKE ALL ON FUNCTION swap_private.reset_successful_trade_quota() FROM PUBLIC;
NOTIFY pgrst, 'reload schema';
