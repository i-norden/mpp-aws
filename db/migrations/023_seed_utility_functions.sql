-- Seed utility Lambda functions so /functions returns them and agents can discover them.
-- Uses ON CONFLICT to be idempotent — safe to re-run on existing deployments.

-- Headless Browser
INSERT INTO lambda_functions (
    function_arn, function_name, description,
    memory_mb, timeout_seconds, estimated_duration_ms,
    enabled, input_schema, output_schema, examples, tags, pricing_model
) VALUES (
    'arn:aws:lambda:us-east-1:000000000000:function:open-compute-headless-browser',
    'open-compute-headless-browser',
    'Render web pages using headless Chromium. Take screenshots (PNG), generate PDFs, extract visible text, or get fully rendered HTML after JavaScript execution. 2048MB memory, 60s timeout.',
    2048, 60, 3000,
    true,
    '{
        "type": "object",
        "properties": {
            "url": {"type": "string", "description": "URL to navigate to (http:// or https:// only)"},
            "operation": {"type": "string", "enum": ["screenshot", "pdf", "extract", "html"], "default": "screenshot", "description": "Operation to perform"},
            "viewport": {
                "type": "object",
                "properties": {
                    "width": {"type": "integer", "default": 1280},
                    "height": {"type": "integer", "default": 720}
                },
                "description": "Browser viewport dimensions"
            },
            "waitFor": {"type": "integer", "default": 0, "maximum": 30000, "description": "Milliseconds to wait after page load"},
            "fullPage": {"type": "boolean", "default": true, "description": "Capture full page (screenshot/pdf only)"}
        },
        "required": ["url"]
    }'::jsonb,
    '{
        "type": "object",
        "properties": {
            "success": {"type": "boolean"},
            "data": {"type": "string", "description": "Base64-encoded PNG/PDF or text/HTML content"},
            "contentType": {"type": "string", "description": "MIME type of returned data"},
            "error": {"type": "string", "description": "Error message if success is false"},
            "executionTimeMs": {"type": "integer", "description": "Wall-clock execution time in milliseconds"}
        }
    }'::jsonb,
    '[
        {
            "name": "Screenshot a webpage",
            "input": {"url": "https://example.com", "operation": "screenshot"},
            "output": {"success": true, "contentType": "image/png", "executionTimeMs": 2340}
        },
        {
            "name": "Extract text from rendered page",
            "input": {"url": "https://example.com", "operation": "extract"},
            "output": {"success": true, "data": "Example Domain\nThis domain is for use in illustrative examples...", "contentType": "text/plain", "executionTimeMs": 1800}
        },
        {
            "name": "Generate PDF",
            "input": {"url": "https://example.com", "operation": "pdf"},
            "output": {"success": true, "contentType": "application/pdf", "executionTimeMs": 3100}
        }
    ]'::jsonb,
    ARRAY['browser', 'screenshot', 'web-scraping', 'pdf', 'rendering'],
    'fixed'
) ON CONFLICT (function_arn) DO UPDATE SET
    description = EXCLUDED.description,
    input_schema = EXCLUDED.input_schema,
    output_schema = EXCLUDED.output_schema,
    examples = EXCLUDED.examples,
    tags = EXCLUDED.tags,
    pricing_model = EXCLUDED.pricing_model,
    enabled = true;

-- PDF Processor
INSERT INTO lambda_functions (
    function_arn, function_name, description,
    memory_mb, timeout_seconds, estimated_duration_ms,
    enabled, input_schema, output_schema, examples, tags, pricing_model
) VALUES (
    'arn:aws:lambda:us-east-1:000000000000:function:open-compute-pdf-processor',
    'open-compute-pdf-processor',
    'Extract text, tables, and metadata from PDF documents using PyMuPDF. Supports per-page extraction, table detection, and metadata retrieval. 1024MB memory, 60s timeout.',
    1024, 60, 500,
    true,
    '{
        "type": "object",
        "properties": {
            "data": {"type": "string", "description": "Base64-encoded PDF document"},
            "operation": {"type": "string", "enum": ["extract_text", "extract_pages", "extract_tables", "metadata", "page_count"], "default": "extract_text", "description": "Operation to perform"},
            "pages": {
                "type": "array",
                "items": {"type": "integer"},
                "description": "Optional list of 0-indexed page numbers to process"
            }
        },
        "required": ["data"]
    }'::jsonb,
    '{
        "type": "object",
        "properties": {
            "success": {"type": "boolean"},
            "result": {
                "type": "object",
                "description": "Operation result (structure varies by operation)",
                "properties": {
                    "text": {"type": "string", "description": "Extracted text (extract_text)"},
                    "pages": {"type": "array", "description": "Per-page text (extract_pages)"},
                    "tables": {"type": "array", "description": "Detected tables (extract_tables)"},
                    "pageCount": {"type": "integer", "description": "Total page count"},
                    "title": {"type": "string"}, "author": {"type": "string"}
                }
            },
            "error": {"type": "string", "description": "Error message if success is false"},
            "executionTimeMs": {"type": "integer", "description": "Wall-clock execution time in milliseconds"}
        }
    }'::jsonb,
    '[
        {
            "name": "Extract all text",
            "input": {"data": "<base64-encoded-pdf>", "operation": "extract_text"},
            "output": {"success": true, "result": {"text": "Full document text...", "pageCount": 5}, "executionTimeMs": 450}
        },
        {
            "name": "Get page count",
            "input": {"data": "<base64-encoded-pdf>", "operation": "page_count"},
            "output": {"success": true, "result": {"pageCount": 15}, "executionTimeMs": 50}
        },
        {
            "name": "Extract metadata",
            "input": {"data": "<base64-encoded-pdf>", "operation": "metadata"},
            "output": {"success": true, "result": {"title": "Report Q4", "author": "Jane Doe", "pageCount": 15}, "executionTimeMs": 40}
        }
    ]'::jsonb,
    ARRAY['pdf', 'text-extraction', 'document', 'tables', 'metadata'],
    'fixed'
) ON CONFLICT (function_arn) DO UPDATE SET
    description = EXCLUDED.description,
    input_schema = EXCLUDED.input_schema,
    output_schema = EXCLUDED.output_schema,
    examples = EXCLUDED.examples,
    tags = EXCLUDED.tags,
    pricing_model = EXCLUDED.pricing_model,
    enabled = true;

-- OCR
INSERT INTO lambda_functions (
    function_arn, function_name, description,
    memory_mb, timeout_seconds, estimated_duration_ms,
    enabled, input_schema, output_schema, examples, tags, pricing_model
) VALUES (
    'arn:aws:lambda:us-east-1:000000000000:function:open-compute-ocr',
    'open-compute-ocr',
    'Extract text from images using Tesseract OCR. Supports plain text extraction and bounding-box output with confidence scores. Configurable language and page segmentation mode. 1024MB memory, 60s timeout.',
    1024, 60, 1500,
    true,
    '{
        "type": "object",
        "properties": {
            "data": {"type": "string", "description": "Base64-encoded image (PNG, JPEG, TIFF, BMP, etc.)"},
            "operation": {"type": "string", "enum": ["ocr", "ocr_with_boxes"], "default": "ocr", "description": "Operation: plain text or text with bounding boxes"},
            "language": {"type": "string", "default": "eng", "description": "Tesseract language code (e.g. eng, fra, deu)"},
            "psm": {"type": "integer", "default": 3, "minimum": 0, "maximum": 13, "description": "Tesseract page segmentation mode"}
        },
        "required": ["data"]
    }'::jsonb,
    '{
        "type": "object",
        "properties": {
            "success": {"type": "boolean"},
            "result": {
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "Extracted text (ocr operation)"},
                    "blocks": {
                        "type": "array",
                        "description": "Text blocks with bounding boxes (ocr_with_boxes)",
                        "items": {
                            "type": "object",
                            "properties": {
                                "text": {"type": "string"},
                                "confidence": {"type": "number"},
                                "bbox": {
                                    "type": "object",
                                    "properties": {"x": {"type": "integer"}, "y": {"type": "integer"}, "w": {"type": "integer"}, "h": {"type": "integer"}}
                                }
                            }
                        }
                    }
                }
            },
            "error": {"type": "string", "description": "Error message if success is false"},
            "executionTimeMs": {"type": "integer", "description": "Wall-clock execution time in milliseconds"}
        }
    }'::jsonb,
    '[
        {
            "name": "Extract text from image",
            "input": {"data": "<base64-encoded-image>", "operation": "ocr"},
            "output": {"success": true, "result": {"text": "Hello World\nThis is sample text extracted from an image."}, "executionTimeMs": 1200}
        },
        {
            "name": "OCR with bounding boxes",
            "input": {"data": "<base64-encoded-image>", "operation": "ocr_with_boxes"},
            "output": {"success": true, "result": {"blocks": [{"text": "Hello", "confidence": 95.2, "bbox": {"x": 10, "y": 20, "w": 100, "h": 30}}]}, "executionTimeMs": 1500}
        }
    ]'::jsonb,
    ARRAY['ocr', 'text-extraction', 'image', 'tesseract'],
    'fixed'
) ON CONFLICT (function_arn) DO UPDATE SET
    description = EXCLUDED.description,
    input_schema = EXCLUDED.input_schema,
    output_schema = EXCLUDED.output_schema,
    examples = EXCLUDED.examples,
    tags = EXCLUDED.tags,
    pricing_model = EXCLUDED.pricing_model,
    enabled = true;

-- Image Processor
INSERT INTO lambda_functions (
    function_arn, function_name, description,
    memory_mb, timeout_seconds, estimated_duration_ms,
    enabled, input_schema, output_schema, examples, tags, pricing_model
) VALUES (
    'arn:aws:lambda:us-east-1:000000000000:function:open-compute-image-processor',
    'open-compute-image-processor',
    'Resize, crop, convert, compress, and analyze images using Pillow. Supports PNG, JPEG, WebP, and GIF formats. 512MB memory, 60s timeout.',
    512, 60, 200,
    true,
    '{
        "type": "object",
        "properties": {
            "data": {"type": "string", "description": "Base64-encoded image"},
            "operation": {"type": "string", "enum": ["resize", "crop", "convert", "compress", "thumbnail", "info"], "default": "resize", "description": "Operation to perform"},
            "width": {"type": "integer", "description": "Target width in pixels (resize/thumbnail)"},
            "height": {"type": "integer", "description": "Target height in pixels (resize/thumbnail)"},
            "format": {"type": "string", "enum": ["png", "jpeg", "webp", "gif"], "description": "Output format (convert operation)"},
            "quality": {"type": "integer", "minimum": 1, "maximum": 100, "default": 85, "description": "Output quality (compress/convert, 1-100)"},
            "crop": {
                "type": "object",
                "properties": {
                    "x": {"type": "integer", "default": 0},
                    "y": {"type": "integer", "default": 0},
                    "w": {"type": "integer", "description": "Crop width"},
                    "h": {"type": "integer", "description": "Crop height"}
                },
                "required": ["w", "h"],
                "description": "Crop region (crop operation)"
            }
        },
        "required": ["data"]
    }'::jsonb,
    '{
        "type": "object",
        "properties": {
            "success": {"type": "boolean"},
            "data": {"type": "string", "description": "Base64-encoded output image"},
            "contentType": {"type": "string", "description": "MIME type of output image"},
            "width": {"type": "integer", "description": "Output image width"},
            "height": {"type": "integer", "description": "Output image height"},
            "result": {
                "type": "object",
                "description": "Image info (info operation only)",
                "properties": {
                    "width": {"type": "integer"}, "height": {"type": "integer"},
                    "format": {"type": "string"}, "mode": {"type": "string"},
                    "sizeBytes": {"type": "integer"}
                }
            },
            "error": {"type": "string", "description": "Error message if success is false"},
            "executionTimeMs": {"type": "integer", "description": "Wall-clock execution time in milliseconds"}
        }
    }'::jsonb,
    '[
        {
            "name": "Resize image",
            "input": {"data": "<base64-encoded-image>", "operation": "resize", "width": 800},
            "output": {"success": true, "contentType": "image/png", "width": 800, "height": 600, "executionTimeMs": 150}
        },
        {
            "name": "Convert to WebP",
            "input": {"data": "<base64-encoded-image>", "operation": "convert", "format": "webp", "quality": 80},
            "output": {"success": true, "contentType": "image/webp", "width": 1920, "height": 1080, "executionTimeMs": 200}
        },
        {
            "name": "Get image info",
            "input": {"data": "<base64-encoded-image>", "operation": "info"},
            "output": {"success": true, "result": {"width": 1920, "height": 1080, "format": "JPEG", "mode": "RGB", "sizeBytes": 524288}, "executionTimeMs": 50}
        }
    ]'::jsonb,
    ARRAY['image', 'resize', 'crop', 'convert', 'compress', 'thumbnail'],
    'fixed'
) ON CONFLICT (function_arn) DO UPDATE SET
    description = EXCLUDED.description,
    input_schema = EXCLUDED.input_schema,
    output_schema = EXCLUDED.output_schema,
    examples = EXCLUDED.examples,
    tags = EXCLUDED.tags,
    pricing_model = EXCLUDED.pricing_model,
    enabled = true;
