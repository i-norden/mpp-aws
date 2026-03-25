-- 015_seed_lease_resources.down.sql
-- Remove seeded lease resources
DELETE FROM lease_resources WHERE id IN (
    't3-medium', 't3-large', 't3-xlarge',
    'm6i-large', 'm6i-xlarge', 'c6i-large'
);
