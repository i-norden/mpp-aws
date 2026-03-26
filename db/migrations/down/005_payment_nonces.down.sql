-- Reverse of 005_payment_nonces.sql
DROP FUNCTION IF EXISTS cleanup_expired_payment_nonces();
DROP TABLE IF EXISTS payment_nonces CASCADE;
