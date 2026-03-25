-- Enhanced function registry for agent discovery
-- Adds rich metadata, schemas, and examples for autonomous agents

-- Add new columns to lambda_functions
ALTER TABLE lambda_functions ADD COLUMN IF NOT EXISTS input_schema JSONB;
ALTER TABLE lambda_functions ADD COLUMN IF NOT EXISTS output_schema JSONB;
ALTER TABLE lambda_functions ADD COLUMN IF NOT EXISTS examples JSONB DEFAULT '[]'::jsonb;
ALTER TABLE lambda_functions ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';
ALTER TABLE lambda_functions ADD COLUMN IF NOT EXISTS version TEXT DEFAULT '1.0.0';
ALTER TABLE lambda_functions ADD COLUMN IF NOT EXISTS author TEXT;
ALTER TABLE lambda_functions ADD COLUMN IF NOT EXISTS documentation_url TEXT;

-- Create index for tag-based discovery
CREATE INDEX IF NOT EXISTS idx_lambda_functions_tags ON lambda_functions USING GIN(tags);

-- Example of a well-documented function entry:
-- INSERT INTO lambda_functions (
--     function_arn, function_name, description,
--     input_schema, output_schema, examples, tags
-- ) VALUES (
--     'arn:aws:lambda:us-east-1:123456789:function:code-sandbox',
--     'code-sandbox',
--     'Execute arbitrary Python or Node.js code in an isolated sandbox environment. Returns stdout, stderr, exit code, and execution time.',
--     '{
--         "type": "object",
--         "properties": {
--             "language": {"type": "string", "enum": ["python", "node"], "description": "Programming language to execute"},
--             "code": {"type": "string", "description": "Source code to execute"},
--             "timeout": {"type": "integer", "default": 30, "description": "Maximum execution time in seconds"},
--             "stdin": {"type": "string", "description": "Optional stdin input"}
--         },
--         "required": ["language", "code"]
--     }'::jsonb,
--     '{
--         "type": "object",
--         "properties": {
--             "stdout": {"type": "string"},
--             "stderr": {"type": "string"},
--             "exitCode": {"type": "integer"},
--             "executionTimeMs": {"type": "integer"}
--         }
--     }'::jsonb,
--     '[
--         {
--             "name": "Hello World",
--             "input": {"language": "python", "code": "print(\"Hello, World!\")"},
--             "output": {"stdout": "Hello, World!\\n", "stderr": "", "exitCode": 0}
--         },
--         {
--             "name": "Calculate Fibonacci",
--             "input": {"language": "python", "code": "def fib(n):\\n    if n <= 1: return n\\n    return fib(n-1) + fib(n-2)\\nprint(fib(10))"},
--             "output": {"stdout": "55\\n", "stderr": "", "exitCode": 0}
--         }
--     ]'::jsonb,
--     ARRAY['code-execution', 'sandbox', 'python', 'node']
-- );
