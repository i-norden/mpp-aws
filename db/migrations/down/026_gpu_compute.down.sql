DELETE FROM lambda_functions WHERE function_name = 'open-compute-gpu-inference';
ALTER TABLE lambda_functions DROP CONSTRAINT IF EXISTS chk_gpu_type;
ALTER TABLE lambda_functions DROP COLUMN IF EXISTS gpu_memory_mb;
ALTER TABLE lambda_functions DROP COLUMN IF EXISTS gpu_type;
