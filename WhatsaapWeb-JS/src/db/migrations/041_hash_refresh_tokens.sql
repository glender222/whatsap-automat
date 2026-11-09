UPDATE refresh_tokens
SET token = 'sha256:' || encode(sha256(convert_to(token, 'UTF8')), 'hex')
WHERE token !~ '^sha256:[0-9a-f]{64}$';

ALTER TABLE refresh_tokens
  ADD CONSTRAINT refresh_tokens_digest_check
  CHECK (token ~ '^sha256:[0-9a-f]{64}$');
