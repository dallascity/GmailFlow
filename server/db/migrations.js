import { upsertContacts } from '../services/contacts.js';

// Her eleman bir şema sürümüdür. Yeni değişiklikler her zaman SONA eklenir.
export const migrations = [
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE account (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    email        TEXT NOT NULL,
    connected_at TEXT NOT NULL
  );

  CREATE TABLE lists (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    source_file  TEXT,
    email_column TEXT NOT NULL,
    columns_json TEXT NOT NULL,
    stats_json   TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );

  CREATE TABLE recipients (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    list_id        INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    row_no         INTEGER NOT NULL,
    email          TEXT NOT NULL,
    email_norm     TEXT NOT NULL,
    data_json      TEXT NOT NULL,
    valid          INTEGER NOT NULL,
    invalid_reason TEXT
  );
  CREATE INDEX idx_recipients_list ON recipients(list_id, valid);
  CREATE UNIQUE INDEX idx_recipients_unique ON recipients(list_id, email_norm) WHERE valid = 1;

  CREATE TABLE campaigns (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    name                 TEXT NOT NULL,
    list_id              INTEGER REFERENCES lists(id) ON DELETE SET NULL,
    subject              TEXT NOT NULL DEFAULT '',
    body_html            TEXT NOT NULL DEFAULT '',
    body_text            TEXT NOT NULL DEFAULT '',
    format               TEXT NOT NULL DEFAULT 'html' CHECK (format IN ('html','text')),
    delay_sec            INTEGER NOT NULL DEFAULT 10,
    order_mode           TEXT NOT NULL DEFAULT 'list' CHECK (order_mode IN ('list','alpha','random')),
    skip_previously_sent INTEGER NOT NULL DEFAULT 1,
    status               TEXT NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft','running','paused','completed','cancelled')),
    pause_reason         TEXT,
    resume_after         TEXT,
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL,
    started_at           TEXT,
    finished_at          TEXT
  );

  CREATE TABLE campaign_attachments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    filename    TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    mime        TEXT NOT NULL,
    size        INTEGER NOT NULL
  );

  CREATE TABLE sends (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id      INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    recipient_id     INTEGER,
    email            TEXT NOT NULL,
    email_norm       TEXT NOT NULL,
    data_json        TEXT NOT NULL,
    seq              INTEGER NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','sending','sent','failed','skipped','unknown')),
    gmail_message_id TEXT,
    error_code       TEXT,
    error_message    TEXT,
    attempts         INTEGER NOT NULL DEFAULT 0,
    attempted_at     TEXT,
    sent_at          TEXT,
    UNIQUE (campaign_id, email_norm)
  );
  CREATE INDEX idx_sends_campaign ON sends(campaign_id, status, seq);
  CREATE INDEX idx_sends_email ON sends(email_norm, status);
  CREATE INDEX idx_sends_sent_at ON sends(sent_at);

  CREATE TABLE events_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT NOT NULL,
    level       TEXT NOT NULL CHECK (level IN ('info','warn','error')),
    campaign_id INTEGER,
    code        TEXT,
    message     TEXT NOT NULL
  );
  CREATE INDEX idx_events_ts ON events_log(ts);
  `,

  // v2: Kayıtlı mailler (adres defteri) + mevcut listelerden geriye dönük doldurma
  (db) => {
    db.exec(`
      CREATE TABLE contacts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        email       TEXT NOT NULL,
        email_norm  TEXT NOT NULL UNIQUE,
        name        TEXT,
        name_locked INTEGER NOT NULL DEFAULT 0,
        data_json   TEXT NOT NULL DEFAULT '{}',
        source      TEXT NOT NULL DEFAULT 'import' CHECK (source IN ('import','manual')),
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX idx_recipients_email ON recipients(email_norm, valid);
    `);
    for (const list of db.prepare('SELECT id, email_column, columns_json FROM lists ORDER BY id').all()) {
      const items = db
        .prepare('SELECT email, email_norm, data_json FROM recipients WHERE list_id = ? AND valid = 1 ORDER BY row_no')
        .all(list.id)
        .map((r) => ({ email: r.email, emailNorm: r.email_norm, data: JSON.parse(r.data_json) }));
      upsertContacts(db, items, { emailColumn: list.email_column, columns: JSON.parse(list.columns_json) });
    }
  },

  // v3: Posta istemcisi (önbellek, FTS) + kampanya takibi (yanıt / bounce / abonelikten çıkma)
  `
  CREATE TABLE mail_labels (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    type            TEXT NOT NULL,
    messages_total  INTEGER NOT NULL DEFAULT 0,
    messages_unread INTEGER NOT NULL DEFAULT 0,
    threads_unread  INTEGER NOT NULL DEFAULT 0,
    color_bg        TEXT,
    color_text      TEXT,
    updated_at      TEXT NOT NULL
  );

  CREATE TABLE mail_messages (
    id                TEXT PRIMARY KEY,
    thread_id         TEXT NOT NULL,
    history_id        TEXT,
    internal_date     INTEGER NOT NULL,
    from_name         TEXT,
    from_email        TEXT,
    to_json           TEXT NOT NULL DEFAULT '[]',
    cc_json           TEXT NOT NULL DEFAULT '[]',
    bcc_json          TEXT NOT NULL DEFAULT '[]',
    reply_to          TEXT,
    subject           TEXT NOT NULL DEFAULT '',
    snippet           TEXT NOT NULL DEFAULT '',
    message_id_header TEXT,
    in_reply_to       TEXT,
    references_header TEXT,
    list_unsubscribe  TEXT,
    size              INTEGER NOT NULL DEFAULT 0,
    has_attachments   INTEGER NOT NULL DEFAULT 0,
    attachments_json  TEXT NOT NULL DEFAULT '[]',
    body_text         TEXT,
    body_html         TEXT,
    delivery_status   TEXT,
    failed_recipients TEXT,
    body_fetched      INTEGER NOT NULL DEFAULT 0,
    opened            INTEGER NOT NULL DEFAULT 0,
    tracked           INTEGER NOT NULL DEFAULT 0,
    synced_at         TEXT NOT NULL
  );
  CREATE INDEX idx_mail_thread ON mail_messages(thread_id, internal_date);
  CREATE INDEX idx_mail_date ON mail_messages(internal_date);

  CREATE TABLE mail_message_labels (
    message_id TEXT NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
    label_id   TEXT NOT NULL,
    PRIMARY KEY (message_id, label_id)
  );
  CREATE INDEX idx_mml_label ON mail_message_labels(label_id, message_id);

  CREATE VIRTUAL TABLE mail_fts USING fts5(subject, people, body, tokenize = 'unicode61 remove_diacritics 2');

  CREATE TABLE mail_drafts (
    draft_id   TEXT PRIMARY KEY,
    message_id TEXT NOT NULL UNIQUE
  );

  CREATE TABLE mail_sync_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE mail_sender_prefs (
    email       TEXT PRIMARY KEY,
    show_images INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE manual_sends (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         TEXT NOT NULL,
    recipients INTEGER NOT NULL
  );
  CREATE INDEX idx_manual_sends_ts ON manual_sends(ts);

  ALTER TABLE sends ADD COLUMN gmail_thread_id TEXT;
  ALTER TABLE sends ADD COLUMN replied_at TEXT;
  ALTER TABLE sends ADD COLUMN bounced_at TEXT;
  ALTER TABLE sends ADD COLUMN bounce_reason TEXT;
  CREATE INDEX idx_sends_thread ON sends(gmail_thread_id);

  ALTER TABLE contacts ADD COLUMN replied_at TEXT;
  ALTER TABLE contacts ADD COLUMN bounced_at TEXT;
  ALTER TABLE contacts ADD COLUMN unsubscribed_at TEXT;
  ALTER TABLE contacts ADD COLUMN suppressed TEXT CHECK (suppressed IN ('bounced','unsubscribed','manual'));

  ALTER TABLE campaigns ADD COLUMN list_unsubscribe INTEGER NOT NULL DEFAULT 1;
  `,
];
