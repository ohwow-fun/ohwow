-- =====================================================================
-- Migration 052: A2A Rate Limit Alignment
-- Reduce default rate limits to match production-safe values
-- =====================================================================

-- @statement
UPDATE a2a_connections SET rate_limit_per_minute = 30, rate_limit_per_hour = 500
  WHERE rate_limit_per_minute = 60 AND rate_limit_per_hour = 1000;
