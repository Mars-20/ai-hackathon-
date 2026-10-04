create extension if not exists pgcrypto;

UPDATE workspace_invites SET token_hash = encode(
  digest(token::text, 'sha256'), 'hex')
WHERE token_hash IS NULL AND status = 'pending'
  AND token IS NOT NULL;
