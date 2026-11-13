-- CloudBase PG 网关会改写 SQLSTATE 并丢弃 DETAIL；将安全的业务错误封装到 MESSAGE。
CREATE OR REPLACE FUNCTION swap_private.fail(code text, status integer DEFAULT 409, retry_at timestamptz DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'SWAP_ERROR:' ||
    jsonb_build_object('code',code,'status',status,'retryAt',extract(epoch FROM retry_at)*1000)::text;
END $$;
NOTIFY pgrst, 'reload schema';
