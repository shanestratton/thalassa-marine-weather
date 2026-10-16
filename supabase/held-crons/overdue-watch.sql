-- HELD: explicit deployment/ACL/provider/real-attempt-hook review required.
-- No schedule is executed by app build or this source checkpoint.
SELECT cron.schedule('overdue-watch','* * * * *',
  $$SELECT public.invoke_edge_function('overdue-watch', 25000, '{"action":"work"}'::jsonb)$$);
