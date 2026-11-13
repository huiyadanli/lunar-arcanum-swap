-- 任一方声明已在游戏中完成交换后，本次双方需求结束；已有匹配和占用继续保留供确认结算。
-- 未完成的其他匹配仍可继续处理，但剩余选牌不会自动进入下一轮匹配。
CREATE FUNCTION swap_private.close_confirmed_listings() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, swap_private AS $$
BEGIN
  UPDATE public.listings SET status='closed',give='{}',want='{}',version=version+1,updated_at=now()
    WHERE id IN (NEW.listing_a,NEW.listing_b) AND status='waiting';
  RETURN NEW;
END $$;

CREATE TRIGGER close_confirmed_listings
AFTER UPDATE OF status,confirm_a,confirm_b ON public.matches
FOR EACH ROW WHEN (NEW.status IN ('confirming','completed'))
EXECUTE FUNCTION swap_private.close_confirmed_listings();

-- 与页面保持一致：当前匹配处理完后才能开启下一轮，避免重新发布已在交换中的卡牌。
CREATE FUNCTION swap_private.require_finished_trades() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, swap_private AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.matches
    WHERE NEW.account_id IN (account_a,account_b) AND status IN ('matched','confirming')) THEN
    PERFORM swap_private.fail('ACTIVE_EXCHANGE');
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER require_finished_trades
BEFORE INSERT ON public.listings
FOR EACH ROW EXECUTE FUNCTION swap_private.require_finished_trades();

REVOKE ALL ON FUNCTION swap_private.close_confirmed_listings() FROM PUBLIC;
REVOKE ALL ON FUNCTION swap_private.require_finished_trades() FROM PUBLIC;

-- 兼容已经单边确认及已结算的旧记录，只结束对应需求，不更改任何匹配或确认结果。
UPDATE public.listings l SET status='closed',give='{}',want='{}',version=version+1,updated_at=now()
WHERE l.status='waiting' AND EXISTS (SELECT 1 FROM public.matches m
  WHERE l.id IN (m.listing_a,m.listing_b) AND m.status IN ('confirming','completed'));

NOTIFY pgrst, 'reload schema';
