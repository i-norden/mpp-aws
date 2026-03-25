-- Reverse of 001_initial.sql
DROP TRIGGER IF EXISTS update_lambda_functions_updated_at ON lambda_functions;
DROP FUNCTION IF EXISTS update_updated_at_column();
DROP TABLE IF EXISTS pricing_config CASCADE;
DROP TABLE IF EXISTS lambda_invocations CASCADE;
DROP TABLE IF EXISTS lambda_functions CASCADE;
