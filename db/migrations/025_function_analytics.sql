-- Migration 025: Function analytics materialized view
-- Provides pre-computed usage stats: call volume, latency percentiles, revenue

CREATE MATERIALIZED VIEW IF NOT EXISTS function_analytics AS
SELECT
  function_name,
  COUNT(*) AS total_invocations,
  COUNT(*) FILTER (WHERE success = true) AS successful_invocations,
  COUNT(*) FILTER (WHERE success = false) AS failed_invocations,
  ROUND(AVG(duration_ms)) AS avg_duration_ms,
  PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY duration_ms) AS p50_duration_ms,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_duration_ms,
  PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration_ms) AS p99_duration_ms,
  SUM(amount_paid) AS total_revenue,
  COUNT(DISTINCT payer_address) AS unique_callers,
  MAX(created_at) AS last_invoked_at,
  COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS invocations_24h,
  SUM(amount_paid) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS revenue_24h
FROM lambda_invocations
GROUP BY function_name;

CREATE UNIQUE INDEX IF NOT EXISTS idx_function_analytics_name ON function_analytics (function_name);
