-- Migration 026: GPU compute metadata columns
-- Adds GPU type and memory info to lambda_functions for ML/AI workloads

ALTER TABLE lambda_functions ADD COLUMN IF NOT EXISTS gpu_type TEXT;
ALTER TABLE lambda_functions ADD COLUMN IF NOT EXISTS gpu_memory_mb INTEGER;

-- Constraint for valid GPU types (NULL means no GPU)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_gpu_type'
  ) THEN
    ALTER TABLE lambda_functions ADD CONSTRAINT chk_gpu_type
      CHECK (gpu_type IS NULL OR gpu_type IN ('nvidia-t4', 'nvidia-a10g', 'nvidia-a100'));
  END IF;
END $$;

-- Seed GPU inference function
INSERT INTO lambda_functions (
  function_arn, function_name, description, memory_mb, timeout_seconds,
  estimated_duration_ms, enabled, tags, gpu_type, gpu_memory_mb,
  input_schema, output_schema, examples, pricing_model, visibility
) VALUES
(
  'arn:aws:lambda:us-east-1:ACCOUNT:function:open-compute-gpu-inference',
  'open-compute-gpu-inference',
  'Run ML inference on GPU-accelerated Lambda (NVIDIA T4)',
  10240, 120, 5000, true,
  ARRAY['gpu', 'ml', 'inference', 'ai'],
  'nvidia-t4', 16384,
  '{"type":"object","properties":{"model":{"type":"string"},"input":{"type":"object"}},"required":["model","input"]}',
  '{"type":"object","properties":{"output":{"type":"object"},"inference_time_ms":{"type":"number"}}}',
  '[{"input":{"model":"resnet50","input":{"image":"<base64>"}},"output":{"output":{"class":"cat","confidence":0.97},"inference_time_ms":45}}]',
  'metered', 'public'
)
ON CONFLICT (function_arn) DO UPDATE SET
  description = EXCLUDED.description,
  gpu_type = EXCLUDED.gpu_type,
  gpu_memory_mb = EXCLUDED.gpu_memory_mb,
  tags = EXCLUDED.tags;
