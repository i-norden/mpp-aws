-- Migration 024: Full-text search for function discovery
-- Adds tsvector column with GIN index for fast natural language search

-- Add tsvector column for full-text search
ALTER TABLE lambda_functions ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- GIN index for fast full-text search
CREATE INDEX IF NOT EXISTS idx_functions_search ON lambda_functions USING GIN (search_vector);

-- Trigger to auto-update search_vector on INSERT/UPDATE
CREATE OR REPLACE FUNCTION update_search_vector() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', COALESCE(NEW.function_name, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(array_to_string(NEW.tags, ' '), '')), 'A');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_search_vector ON lambda_functions;
CREATE TRIGGER trg_search_vector
  BEFORE INSERT OR UPDATE OF function_name, description, tags
  ON lambda_functions
  FOR EACH ROW EXECUTE FUNCTION update_search_vector();

-- Backfill existing rows
UPDATE lambda_functions SET search_vector =
  setweight(to_tsvector('english', COALESCE(function_name, '')), 'A') ||
  setweight(to_tsvector('english', COALESCE(description, '')), 'B') ||
  setweight(to_tsvector('english', COALESCE(array_to_string(tags, ' '), '')), 'A');
