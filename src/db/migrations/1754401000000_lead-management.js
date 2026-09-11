exports.up = pgm => pgm.sql(`
  CREATE TABLE platform_administrators (
    owner_id UUID PRIMARY KEY REFERENCES owners(id),
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE leads ADD COLUMN status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','contacted','closed'));
  ALTER TABLE leads ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
  ALTER TABLE leads ADD COLUMN notified_at TIMESTAMPTZ;
  ALTER TABLE leads ADD COLUMN notify_attempts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE leads ADD COLUMN notify_next_at TIMESTAMPTZ NOT NULL DEFAULT now();
  ALTER TABLE leads ADD COLUMN notify_requested_at TIMESTAMPTZ;
  ALTER TABLE leads ADD COLUMN notify_error TEXT;
  ALTER TABLE leads ADD COLUMN notification_message_id BIGINT;
  CREATE INDEX leads_notification_pending ON leads(notify_next_at,created_at) WHERE notified_at IS NULL;
  CREATE TABLE lead_notification_settings (
    id BOOLEAN PRIMARY KEY DEFAULT true CHECK(id),
    token_ciphertext TEXT,
    bot_username TEXT,
    chat_id TEXT,
    enabled_since TIMESTAMPTZ,
    pending_token_ciphertext TEXT,
    pending_bot_username TEXT,
    pending_hash TEXT,
    pending_expires_at TIMESTAMPTZ,
    pending_owner_id UUID REFERENCES owners(id),
    update_offset BIGINT NOT NULL DEFAULT 0,
    last_checked_at TIMESTAMPTZ,
    last_delivered_at TIMESTAMPTZ,
    last_error TEXT,
    updated_by UUID REFERENCES owners(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  INSERT INTO lead_notification_settings(id) VALUES(true);
  ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
  CREATE POLICY lead_submit ON leads FOR INSERT WITH CHECK(true);
  CREATE POLICY lead_admin_read ON leads FOR SELECT USING (
    EXISTS (SELECT 1 FROM platform_administrators a WHERE a.active AND a.owner_id::text=current_setting('app.platform_owner_id',true))
  );
  CREATE POLICY lead_admin_update ON leads FOR UPDATE USING (
    EXISTS (SELECT 1 FROM platform_administrators a WHERE a.active AND a.owner_id::text=current_setting('app.platform_owner_id',true))
  );
  ALTER TABLE lead_notification_settings ENABLE ROW LEVEL SECURITY;
  CREATE POLICY lead_settings_admin ON lead_notification_settings USING (
    EXISTS (SELECT 1 FROM platform_administrators a WHERE a.active AND a.owner_id::text=current_setting('app.platform_owner_id',true))
  );
  DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='argus_app') THEN
    GRANT SELECT ON platform_administrators TO argus_app;
    GRANT SELECT,UPDATE ON leads,lead_notification_settings TO argus_app;
  END IF; END $$;
`);

exports.down = pgm => pgm.sql(`
  DROP TABLE lead_notification_settings;
  DROP POLICY lead_submit ON leads;
  DROP POLICY lead_admin_read ON leads;
  DROP POLICY lead_admin_update ON leads;
  ALTER TABLE leads DISABLE ROW LEVEL SECURITY;
  DROP TABLE platform_administrators;
  DROP INDEX leads_notification_pending;
  ALTER TABLE leads DROP COLUMN status,DROP COLUMN updated_at,DROP COLUMN notified_at,
    DROP COLUMN notify_attempts,DROP COLUMN notify_next_at,DROP COLUMN notify_requested_at,
    DROP COLUMN notify_error,DROP COLUMN notification_message_id;
  DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='argus_app') THEN
    REVOKE SELECT,UPDATE ON leads FROM argus_app;
  END IF; END $$;
`);
