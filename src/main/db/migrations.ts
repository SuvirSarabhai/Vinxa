import type Database from 'better-sqlite3'

export const migrations = [{
  version: 1,
  sql: `
    CREATE TABLE meetings (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, startedAt INTEGER NOT NULL, endedAt INTEGER,
      duration INTEGER NOT NULL DEFAULT 0, recordingStatus TEXT NOT NULL,
      notesStatus TEXT NOT NULL DEFAULT 'pending', microphoneAudioPath TEXT, systemAudioPath TEXT,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, error TEXT, notesMessage TEXT
    );
    CREATE TABLE transcript_segments (
      id TEXT NOT NULL, meetingId TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      source TEXT NOT NULL CHECK(source IN ('mic','system')), speakerId TEXT NOT NULL,
      text TEXT NOT NULL, startMs INTEGER NOT NULL, endMs INTEGER NOT NULL,
      isFinal INTEGER NOT NULL CHECK(isFinal = 1), PRIMARY KEY(meetingId,id),
      CHECK(startMs >= 0 AND endMs >= startMs)
    );
    CREATE INDEX transcript_timeline ON transcript_segments(meetingId,startMs,endMs,id);
    CREATE TABLE meeting_notes (
      meetingId TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
      summary TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, generatedAt INTEGER NOT NULL
    );
    CREATE TABLE decisions (
      id TEXT PRIMARY KEY, meetingId TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      text TEXT NOT NULL, atMs INTEGER NOT NULL CHECK(atMs >= 0)
    );
    CREATE INDEX decisions_meeting ON decisions(meetingId,atMs);
    CREATE TABLE action_items (
      id TEXT PRIMARY KEY, meetingId TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      task TEXT NOT NULL, owner TEXT, due TEXT, status TEXT NOT NULL CHECK(status IN ('pending','done'))
    );
    CREATE INDEX actions_meeting_status ON action_items(meetingId,status);
    CREATE TABLE speakers (
      meetingId TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      source TEXT NOT NULL CHECK(source IN ('mic','system')), displayName TEXT NOT NULL,
      PRIMARY KEY(meetingId,source)
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `
}, {
  version: 2,
  sql: `
    CREATE VIRTUAL TABLE transcript_fts USING fts5(text,meetingId UNINDEXED,source UNINDEXED,
      startMs UNINDEXED,endMs UNINDEXED,content='transcript_segments',content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2',prefix='2 3 4');
    CREATE TRIGGER transcript_fts_insert AFTER INSERT ON transcript_segments BEGIN
      INSERT INTO transcript_fts(rowid,text,meetingId,source,startMs,endMs)
        VALUES(new.rowid,new.text,new.meetingId,new.source,new.startMs,new.endMs);
    END;
    CREATE TRIGGER transcript_fts_delete AFTER DELETE ON transcript_segments BEGIN
      INSERT INTO transcript_fts(transcript_fts,rowid,text,meetingId,source,startMs,endMs)
        VALUES('delete',old.rowid,old.text,old.meetingId,old.source,old.startMs,old.endMs);
    END;
    CREATE TRIGGER transcript_fts_update AFTER UPDATE ON transcript_segments BEGIN
      INSERT INTO transcript_fts(transcript_fts,rowid,text,meetingId,source,startMs,endMs)
        VALUES('delete',old.rowid,old.text,old.meetingId,old.source,old.startMs,old.endMs);
      INSERT INTO transcript_fts(rowid,text,meetingId,source,startMs,endMs)
        VALUES(new.rowid,new.text,new.meetingId,new.source,new.startMs,new.endMs);
    END;
    INSERT INTO transcript_fts(transcript_fts) VALUES('rebuild');
  `
}, {
  version: 3,
  sql: `
    CREATE VIRTUAL TABLE notes_fts USING fts5(text,meetingId UNINDEXED,category UNINDEXED,targetId UNINDEXED,atMs UNINDEXED,
      tokenize='unicode61 remove_diacritics 2',prefix='2 3 4');
    INSERT INTO notes_fts SELECT summary,meetingId,'Summary',meetingId,NULL FROM meeting_notes;
    INSERT INTO notes_fts SELECT text,meetingId,'Decision',id,atMs FROM decisions;
    INSERT INTO notes_fts SELECT task || ' ' || COALESCE(owner,'') || ' ' || COALESCE(due,''),meetingId,'Action item',id,NULL FROM action_items;
    CREATE TRIGGER notes_search_insert AFTER INSERT ON meeting_notes BEGIN
      INSERT INTO notes_fts VALUES(new.summary,new.meetingId,'Summary',new.meetingId,NULL); END;
    CREATE TRIGGER notes_search_update AFTER UPDATE ON meeting_notes BEGIN
      DELETE FROM notes_fts WHERE meetingId=old.meetingId AND category='Summary';
      INSERT INTO notes_fts VALUES(new.summary,new.meetingId,'Summary',new.meetingId,NULL); END;
    CREATE TRIGGER notes_search_delete AFTER DELETE ON meeting_notes BEGIN
      DELETE FROM notes_fts WHERE meetingId=old.meetingId AND category='Summary'; END;
    CREATE TRIGGER decisions_search_insert AFTER INSERT ON decisions BEGIN
      INSERT INTO notes_fts VALUES(new.text,new.meetingId,'Decision',new.id,new.atMs); END;
    CREATE TRIGGER decisions_search_delete AFTER DELETE ON decisions BEGIN
      DELETE FROM notes_fts WHERE targetId=old.id AND category='Decision'; END;
    CREATE TRIGGER decisions_search_update AFTER UPDATE ON decisions BEGIN
      DELETE FROM notes_fts WHERE targetId=old.id AND category='Decision';
      INSERT INTO notes_fts VALUES(new.text,new.meetingId,'Decision',new.id,new.atMs); END;
    CREATE TRIGGER actions_search_insert AFTER INSERT ON action_items BEGIN
      INSERT INTO notes_fts VALUES(new.task || ' ' || COALESCE(new.owner,'') || ' ' || COALESCE(new.due,''),new.meetingId,'Action item',new.id,NULL); END;
    CREATE TRIGGER actions_search_delete AFTER DELETE ON action_items BEGIN
      DELETE FROM notes_fts WHERE targetId=old.id AND category='Action item'; END;
    CREATE TRIGGER actions_search_update AFTER UPDATE ON action_items BEGIN
      DELETE FROM notes_fts WHERE targetId=old.id AND category='Action item';
      INSERT INTO notes_fts VALUES(new.task || ' ' || COALESCE(new.owner,'') || ' ' || COALESCE(new.due,''),new.meetingId,'Action item',new.id,NULL); END;
    CREATE TABLE deletion_jobs(meetingId TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE, phase TEXT NOT NULL, error TEXT);
    CREATE TABLE notes_queue(meetingId TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE, attempts INTEGER NOT NULL DEFAULT 0, nextAt INTEGER NOT NULL DEFAULT 0);
  `
}, {
  version: 4,
  sql: `
    CREATE TABLE note_sources (
      meetingId TEXT NOT NULL, targetId TEXT NOT NULL, segmentId TEXT NOT NULL,
      PRIMARY KEY(meetingId,targetId),
      FOREIGN KEY(meetingId,segmentId) REFERENCES transcript_segments(meetingId,id) ON DELETE CASCADE
    );
    INSERT INTO note_sources
      SELECT d.meetingId,d.id,MIN(t.id) FROM decisions d JOIN transcript_segments t
        ON t.meetingId=d.meetingId AND d.atMs BETWEEN t.startMs AND t.endMs
      GROUP BY d.meetingId,d.id HAVING COUNT(*)=1;
    UPDATE meetings SET notesStatus='pending',notesMessage='Waiting for the notes provider.'
      WHERE notesStatus='failed' AND notesMessage='Automatic retries exhausted. Start the provider, then choose Retry pending notes in Settings.'
        AND id IN (SELECT meetingId FROM notes_queue);
  `
}, {
  version: 5,
  sql: `
    CREATE TABLE bookmarks(id TEXT PRIMARY KEY, meetingId TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      atMs INTEGER NOT NULL CHECK(atMs>=0), note TEXT NOT NULL);
    CREATE INDEX bookmarks_timeline ON bookmarks(meetingId,atMs);
    CREATE TABLE crm_deliveries(meetingId TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      recordId TEXT NOT NULL, endpoint TEXT NOT NULL, status TEXT NOT NULL, sentAt INTEGER,
      PRIMARY KEY(meetingId,recordId,endpoint));
    CREATE TABLE remote_speakers(meetingId TEXT NOT NULL, segmentId TEXT NOT NULL, label TEXT NOT NULL,
      PRIMARY KEY(meetingId,segmentId),
      FOREIGN KEY(meetingId,segmentId) REFERENCES transcript_segments(meetingId,id) ON DELETE CASCADE);
  `
}]

export function migrate(db: Database.Database): void {
  db.pragma('foreign_keys = ON')
  db.pragma('journal_mode = WAL')
  db.pragma('secure_delete = ON')
  db.pragma('busy_timeout = 5000')
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, appliedAt INTEGER NOT NULL)')
  const current = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }
  if ((current.version ?? 0) > migrations.at(-1)!.version) throw new Error('This database requires a newer Vinxa version.')
  for (const migration of migrations) {
    db.transaction(() => {
      if (db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(migration.version)) return
      db.exec(migration.sql)
      db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(migration.version, Date.now())
    }).immediate()
  }
}
