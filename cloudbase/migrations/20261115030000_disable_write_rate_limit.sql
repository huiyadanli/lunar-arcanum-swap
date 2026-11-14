-- 取消设备 / IP 每小时请求限流，避免共享代理或网络的多个用户共用额度。
-- 保留旧函数签名及默认参数，兼容已部署的 RPC；不再读取或更新限流计数。
CREATE OR REPLACE FUNCTION swap_private.rate_limit(keys text[], maximum integer DEFAULT 30) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, swap_private AS $$
BEGIN
  RETURN;
END $$;
