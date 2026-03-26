-- Reverse of 002_function_specs.sql
DROP INDEX IF EXISTS idx_lambda_functions_tags;
ALTER TABLE lambda_functions
    DROP COLUMN IF EXISTS input_schema,
    DROP COLUMN IF EXISTS output_schema,
    DROP COLUMN IF EXISTS examples,
    DROP COLUMN IF EXISTS tags,
    DROP COLUMN IF EXISTS version,
    DROP COLUMN IF EXISTS author,
    DROP COLUMN IF EXISTS documentation_url;
