-- Reverse of 008_seed_sandbox_functions.sql
DELETE FROM lambda_functions WHERE function_name IN ('open-compute-sandbox-python', 'open-compute-sandbox-node');
