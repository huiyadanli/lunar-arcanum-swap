-- 自动确认成功与双方主动确认成功一样，首次结算时恢复双方各 1 次发布 / 重新匹配额度。
-- 沿用原有恢复函数，仅扩大触发条件；重复结算已完成的交换不会再次刷新次数。
DROP TRIGGER reset_successful_trade_quota ON public.matches;

CREATE TRIGGER reset_successful_trade_quota
AFTER UPDATE OF status ON public.matches
FOR EACH ROW WHEN (OLD.status <> 'completed' AND NEW.status = 'completed'
  AND (NEW.confirm_a->>'result' = 'completed' OR NEW.confirm_b->>'result' = 'completed'))
EXECUTE FUNCTION swap_private.reset_successful_trade_quota();

NOTIFY pgrst, 'reload schema';
