CREATE OR REPLACE FUNCTION notify_access_session_revocation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify('auth_session_revoked', OLD.id::text);
    RETURN OLD;
  END IF;
  IF OLD.revocado IS DISTINCT FROM true AND NEW.revocado = true THEN
    PERFORM pg_notify('auth_session_revoked', NEW.id::text);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS refresh_token_revocation_notification ON refresh_tokens;
CREATE TRIGGER refresh_token_revocation_notification
AFTER UPDATE OF revocado OR DELETE ON refresh_tokens
FOR EACH ROW EXECUTE FUNCTION notify_access_session_revocation();
