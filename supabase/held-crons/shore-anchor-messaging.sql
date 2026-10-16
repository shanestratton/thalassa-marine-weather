-- REVIEW/ACTIVATION ONLY. Not part of a migration or default installation.
-- Requires reviewed source, provider/account consent, secrets, verified sender,
-- private Telegram webhook, actual race/ACL proofs and explicit control lease.
SELECT cron.schedule('shore-anchor-messaging','* * * * *',
 $$SELECT public.invoke_edge_function('anchor-alert-messaging', 25000, '{"action":"work"}'::jsonb)$$);
