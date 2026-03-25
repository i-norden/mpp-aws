DROP TRIGGER IF EXISTS trg_search_vector ON lambda_functions;
DROP FUNCTION IF EXISTS update_search_vector();
DROP INDEX IF EXISTS idx_functions_search;
ALTER TABLE lambda_functions DROP COLUMN IF EXISTS search_vector;
