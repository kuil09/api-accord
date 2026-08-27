ALTER TABLE operations DROP COLUMN IF EXISTS op_id;
ALTER TABLE api_contracts DROP COLUMN IF EXISTS import_source_url;
ALTER TABLE api_contracts DROP COLUMN IF EXISTS import_source;
ALTER TABLE api_contracts DROP COLUMN IF EXISTS imported_at;
ALTER TABLE services DROP COLUMN IF EXISTS environments;
ALTER TABLE services DROP COLUMN IF EXISTS repository_url;
