-- Seed sandbox functions so /functions returns them and agents can discover them.
-- Uses ON CONFLICT to be idempotent — safe to re-run on existing deployments.

INSERT INTO lambda_functions (
    function_arn, function_name, description,
    memory_mb, timeout_seconds, estimated_duration_ms,
    enabled, input_schema, output_schema, examples, tags
) VALUES (
    'arn:aws:lambda:us-east-1:000000000000:function:open-compute-sandbox-python',
    'open-compute-sandbox-python',
    'Execute arbitrary Python 3.11 code in an isolated sandbox. Supports stdin input and returns stdout, stderr, exit code, and execution time. Max 60s timeout, 512MB memory.',
    512, 60, 1000,
    true,
    '{
        "type": "object",
        "properties": {
            "code": {"type": "string", "description": "Python source code to execute"},
            "timeout": {"type": "integer", "default": 30, "maximum": 60, "description": "Max execution time in seconds"},
            "stdin": {"type": "string", "description": "Optional stdin input for the program"}
        },
        "required": ["code"]
    }'::jsonb,
    '{
        "type": "object",
        "properties": {
            "stdout": {"type": "string", "description": "Standard output from execution"},
            "stderr": {"type": "string", "description": "Standard error from execution"},
            "exitCode": {"type": "integer", "description": "Process exit code (0 = success)"},
            "executionTimeMs": {"type": "integer", "description": "Wall-clock execution time in milliseconds"}
        }
    }'::jsonb,
    '[
        {
            "name": "Hello World",
            "input": {"code": "print(\"Hello, World!\")"},
            "output": {"stdout": "Hello, World!\n", "stderr": "", "exitCode": 0}
        },
        {
            "name": "Fibonacci",
            "input": {"code": "def fib(n):\n    if n <= 1: return n\n    return fib(n-1) + fib(n-2)\nprint(fib(10))"},
            "output": {"stdout": "55\n", "stderr": "", "exitCode": 0}
        },
        {
            "name": "Read stdin",
            "input": {"code": "import sys\ndata = sys.stdin.read()\nprint(f\"Got: {data}\")", "stdin": "hello"},
            "output": {"stdout": "Got: hello\n", "stderr": "", "exitCode": 0}
        }
    ]'::jsonb,
    ARRAY['sandbox', 'code-execution', 'python']
) ON CONFLICT (function_arn) DO UPDATE SET
    description = EXCLUDED.description,
    input_schema = EXCLUDED.input_schema,
    output_schema = EXCLUDED.output_schema,
    examples = EXCLUDED.examples,
    tags = EXCLUDED.tags,
    enabled = true;

INSERT INTO lambda_functions (
    function_arn, function_name, description,
    memory_mb, timeout_seconds, estimated_duration_ms,
    enabled, input_schema, output_schema, examples, tags
) VALUES (
    'arn:aws:lambda:us-east-1:000000000000:function:open-compute-sandbox-node',
    'open-compute-sandbox-node',
    'Execute arbitrary Node.js 20 code in an isolated sandbox using the vm module. Supports console output capture and returns stdout, stderr, exit code, and execution time. Max 60s timeout, 512MB memory.',
    512, 60, 1000,
    true,
    '{
        "type": "object",
        "properties": {
            "code": {"type": "string", "description": "JavaScript source code to execute"},
            "timeout": {"type": "integer", "default": 30, "maximum": 60, "description": "Max execution time in seconds"},
            "stdin": {"type": "string", "description": "Optional stdin input (available as global variable)"}
        },
        "required": ["code"]
    }'::jsonb,
    '{
        "type": "object",
        "properties": {
            "stdout": {"type": "string", "description": "Captured console.log output"},
            "stderr": {"type": "string", "description": "Captured console.error output"},
            "exitCode": {"type": "integer", "description": "0 if no error, 1 if execution threw"},
            "executionTimeMs": {"type": "integer", "description": "Wall-clock execution time in milliseconds"}
        }
    }'::jsonb,
    '[
        {
            "name": "Hello World",
            "input": {"code": "console.log(\"Hello, World!\")"},
            "output": {"stdout": "Hello, World!\n", "stderr": "", "exitCode": 0}
        },
        {
            "name": "JSON Processing",
            "input": {"code": "const data = {name: \"open-compute\", version: 1};\nconsole.log(JSON.stringify(data, null, 2))"},
            "output": {"stdout": "{\n  \"name\": \"open-compute\",\n  \"version\": 1\n}\n", "stderr": "", "exitCode": 0}
        }
    ]'::jsonb,
    ARRAY['sandbox', 'code-execution', 'node', 'javascript']
) ON CONFLICT (function_arn) DO UPDATE SET
    description = EXCLUDED.description,
    input_schema = EXCLUDED.input_schema,
    output_schema = EXCLUDED.output_schema,
    examples = EXCLUDED.examples,
    tags = EXCLUDED.tags,
    enabled = true;
