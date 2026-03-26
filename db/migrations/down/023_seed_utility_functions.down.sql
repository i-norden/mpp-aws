-- Reverse of 023_seed_utility_functions.sql
DELETE FROM lambda_functions WHERE function_name IN (
    'open-compute-headless-browser',
    'open-compute-pdf-processor',
    'open-compute-ocr',
    'open-compute-image-processor'
);
