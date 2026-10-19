import importlib.util
import contextlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("consolidation", Path(__file__).resolve().parents[1] / "script/codex-session-consolidation.py")
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)

ID = "00000000-0000-4000-8000-000000000011"
OTHER = "00000000-0000-4000-8000-000000000012"
SCHEMAS = {
 "state_5.sqlite": '''
 CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT);
 CREATE TABLE project_roots(project_id TEXT,position INTEGER,path TEXT,PRIMARY KEY(project_id,position));
 CREATE TABLE project_idempotency_keys(key TEXT PRIMARY KEY,project_id TEXT,created_at_ms INTEGER);
 CREATE TABLE thread_sections(id TEXT PRIMARY KEY,name TEXT);
 CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,cwd TEXT,history_mode TEXT,title TEXT,project_id TEXT REFERENCES projects(id),thread_section_id TEXT REFERENCES thread_sections(id));
 CREATE TABLE thread_attachments(id TEXT PRIMARY KEY,thread_id TEXT REFERENCES threads(id),payload TEXT);
 CREATE TABLE thread_dynamic_tools(thread_id TEXT REFERENCES threads(id),position INTEGER,input_schema TEXT,PRIMARY KEY(thread_id,position));
 CREATE TABLE thread_read_receipts(thread_id TEXT PRIMARY KEY,revision TEXT);
 CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT PRIMARY KEY,status TEXT);
 CREATE TABLE guardian_review_feedback(id TEXT PRIMARY KEY,thread_id TEXT REFERENCES threads(id),record BLOB);
 ''',
 "thread_history_1.sqlite": '''
 CREATE TABLE thread_history_projection_state(thread_id TEXT PRIMARY KEY,next_rollout_byte_offset INTEGER,next_rollout_ordinal INTEGER);
 CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,status TEXT,rollout_byte_offset INTEGER,PRIMARY KEY(thread_id,turn_id));
 CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,item_json TEXT,PRIMARY KEY(thread_id,turn_id,item_id));
 CREATE TABLE thread_realtime_items(thread_id TEXT,item_id TEXT,item_json TEXT,PRIMARY KEY(thread_id,item_id));
 ''',
 "goals_1.sqlite": '''
 CREATE TABLE thread_goals(thread_id TEXT PRIMARY KEY,goal_id TEXT,objective TEXT,status TEXT,tokens_used INTEGER);
 CREATE TABLE thread_goal_continuation_deferrals(thread_id TEXT PRIMARY KEY REFERENCES thread_goals(thread_id));
 ''',
 "queue_1.sqlite": '''
 CREATE TABLE queued_items(id TEXT PRIMARY KEY,thread_id TEXT,payload_json TEXT);
 CREATE TABLE queued_thread_revisions(revision INTEGER PRIMARY KEY AUTOINCREMENT,thread_id TEXT UNIQUE);
 ''',
 "memories_1.sqlite": '''
 CREATE TABLE stage1_outputs(thread_id TEXT PRIMARY KEY,raw_memory TEXT);
 CREATE TABLE jobs(kind TEXT,job_key TEXT,PRIMARY KEY(kind,job_key));
 ''',
}


class MigrationTest(unittest.TestCase):
 def setUp(self):
  self.temp = tempfile.TemporaryDirectory()
  self.root = Path(self.temp.name).resolve()
  self.source, self.primary = self.root / "source", self.root / "primary"
  for home in (self.source, self.primary):
   home.mkdir()
   (home / "sessions/2000/01/01").mkdir(parents=True)
   for name, schema in SCHEMAS.items():
    db=sqlite3.connect(home / name);db.executescript(schema);db.close()
  for name in ("source-app", "primary-app"): (self.root/name).mkdir()
  self.req={"version":1,"source":{"codexHome":str(self.source),"appData":str(self.root/"source-app")},
            "primary":{"codexHome":str(self.primary),"appData":str(self.root/"primary-app")},"journalDirectory":str(self.root/"journal")}
  self.rollout=self.source/"sessions/2000/01/01"/f"rollout-2000-01-01T00-00-00-{ID}.jsonl"
  self.body=(json.dumps({"type":"session_meta","payload":{"id":ID,"cwd":"/work/original"}})+"\n"+json.dumps({"type":"event_msg","payload":{"type":"task_complete"}})+"\n").encode()
  self.rollout.write_bytes(self.body)
  self.sql(self.source,"state_5.sqlite","INSERT INTO projects VALUES ('project','Project')")
  self.sql(self.source,"state_5.sqlite","INSERT INTO project_roots VALUES ('project',0,'/work/original')")
  self.sql(self.source,"state_5.sqlite","INSERT INTO project_idempotency_keys VALUES ('key','project',10)")
  self.sql(self.source,"state_5.sqlite","INSERT INTO thread_sections VALUES ('section','Section')")
  self.sql(self.source,"state_5.sqlite","INSERT INTO threads VALUES (?,?,?,?,?,?,?)",(ID,str(self.rollout),"/work/original","paginated","Title","project","section"))
  self.sql(self.source,"state_5.sqlite","INSERT INTO thread_attachments VALUES ('attachment',?,'{"+ '"path":"/work/file"' +"}')",(ID,))
  self.sql(self.source,"state_5.sqlite","INSERT INTO thread_dynamic_tools VALUES (?,0,'{}')",(ID,))
  self.sql(self.source,"state_5.sqlite","INSERT INTO thread_read_receipts VALUES (?,'revision')",(ID,))
  self.sql(self.source,"state_5.sqlite","INSERT INTO guardian_review_feedback VALUES ('feedback',?,?)",(ID,b'feedback'))
  self.sql(self.source,"thread_history_1.sqlite","INSERT INTO thread_history_projection_state VALUES (?,?,5)",(ID,len(self.body)))
  self.sql(self.source,"thread_history_1.sqlite","INSERT INTO thread_turns VALUES (?,'turn','completed',18)",(ID,))
  self.sql(self.source,"thread_history_1.sqlite","INSERT INTO thread_items VALUES (?,'turn','item','{"+ '"text":"original"' +"}')",(ID,))
  self.sql(self.source,"thread_history_1.sqlite","INSERT INTO thread_realtime_items VALUES (?,'realtime','{}')",(ID,))
  self.sql(self.source,"goals_1.sqlite","INSERT INTO thread_goals VALUES (?,'goal','Original objective','paused',123)",(ID,))
  self.sql(self.source,"goals_1.sqlite","INSERT INTO thread_goal_continuation_deferrals VALUES (?)",(ID,))
  self.sql(self.source,"queue_1.sqlite","INSERT INTO queued_thread_revisions VALUES (1,?)",(ID,))
  self.sql(self.primary,"queue_1.sqlite","INSERT INTO queued_thread_revisions VALUES (1,?)",(OTHER,))
  self.sql(self.source,"memories_1.sqlite","INSERT INTO stage1_outputs VALUES (?,'memory')",(ID,))
  self.guard_calls=0

 def tearDown(self): self.temp.cleanup()

 def sql(self,home,name,sql,args=()):
  with contextlib.closing(sqlite3.connect(home/name)) as db:
   with db:return db.execute(sql,args).fetchall()

 def absent(self,_): self.guard_calls+=1

 def apply(self,**kwargs): return m.run(self.req,"apply",guard=self.absent,**kwargs)

 def test_preserves_ids_history_goals_and_metadata_without_source_writes(self):
  original={p.name:m.file_hash(p) for p in self.source.glob('*.sqlite')}
  result=self.apply()
  self.assertEqual(result['state'],'complete')
  row=self.sql(self.primary,'state_5.sqlite','SELECT id,rollout_path,cwd,project_id,thread_section_id FROM threads')[0]
  self.assertEqual(row,(ID,str(self.primary/self.rollout.relative_to(self.source)),'/work/original','project','section'))
  self.assertEqual(Path(row[1]).read_bytes(),self.body)
  self.assertEqual(self.sql(self.primary,'thread_history_1.sqlite','SELECT * FROM thread_items'),self.sql(self.source,'thread_history_1.sqlite','SELECT * FROM thread_items'))
  self.assertEqual(self.sql(self.primary,'goals_1.sqlite','SELECT * FROM thread_goals'),self.sql(self.source,'goals_1.sqlite','SELECT * FROM thread_goals'))
  self.assertEqual(self.sql(self.primary,'state_5.sqlite','SELECT * FROM guardian_review_feedback'),self.sql(self.source,'state_5.sqlite','SELECT * FROM guardian_review_feedback'))
  self.assertEqual({p.name:m.file_hash(p) for p in self.source.glob('*.sqlite')},original)
  manifest=json.loads(Path(result['manifestPath']).read_bytes())
  self.assertEqual(manifest['threadIds'],[ID]);self.assertEqual(m.file_hash(Path(result['manifestPath'])),result['manifestSHA256'])
  self.assertEqual(self.sql(self.primary,'queue_1.sqlite','SELECT revision FROM queued_thread_revisions WHERE thread_id=?',(ID,)),[(2,)])
  self.assertGreaterEqual(self.guard_calls,5)
  self.assertEqual(self.apply(),result)

 def test_running_source_waits_without_creating_journal_or_writing_target(self):
  def busy(_):raise m.Refuse('source-host-running',True)
  self.assertEqual(m.run(self.req,'plan',guard=busy)['state'],'waiting')
  with self.assertRaisesRegex(m.Refuse,'source-host-running'):m.run(self.req,'apply',guard=busy)
  self.assertFalse((self.root/'journal').exists())
  self.assertEqual(self.sql(self.primary,'state_5.sqlite','SELECT count(*) FROM threads'),[(0,)])

 def test_restart_after_history_commit_is_idempotent(self):
  def fail(stage):
   if stage=='after-thread_history_1.sqlite':raise RuntimeError('crash')
  with self.assertRaisesRegex(RuntimeError,'crash'):self.apply(failpoint=fail)
  self.assertEqual(self.sql(self.primary,'state_5.sqlite','SELECT count(*) FROM threads'),[(0,)])
  self.assertEqual(self.sql(self.primary,'thread_history_1.sqlite','SELECT count(*) FROM thread_turns'),[(1,)])
  self.assertEqual(self.apply()['state'],'complete')
  self.assertEqual(self.sql(self.primary,'thread_history_1.sqlite','SELECT count(*) FROM thread_turns'),[(1,)])

 def test_restart_after_state_commit_does_not_duplicate(self):
  def fail(stage):
   if stage=='after-state-commit':raise RuntimeError('crash')
  with self.assertRaises(RuntimeError):self.apply(failpoint=fail)
  self.assertEqual(self.apply()['state'],'complete')
  self.assertEqual(self.sql(self.primary,'state_5.sqlite','SELECT count(*) FROM threads'),[(1,)])

 def test_crash_before_state_commit_recovers_published_files(self):
  def fail(stage):
   if stage=='before-state-commit':raise RuntimeError('crash')
  with self.assertRaises(RuntimeError):self.apply(failpoint=fail)
  self.assertEqual(self.sql(self.primary,'state_5.sqlite','SELECT count(*) FROM threads'),[(0,)])
  self.assertEqual((self.primary/self.rollout.relative_to(self.source)).read_bytes(),self.body)
  self.assertEqual(self.apply()['state'],'complete')

 def test_commit_receipt_survives_primary_continuation_before_marker(self):
  def fail(stage):
   if stage=='after-state-commit':raise RuntimeError('crash')
  with self.assertRaises(RuntimeError):self.apply(failpoint=fail)
  target=self.primary/self.rollout.relative_to(self.source)
  with target.open('ab') as stream:stream.write(b'new primary continuation\n')
  self.sql(self.primary,'state_5.sqlite',"UPDATE threads SET title='New title',cwd='/new/cwd' WHERE id=?",(ID,))
  self.sql(self.primary,'thread_history_1.sqlite',"INSERT INTO thread_items VALUES (?,'new-turn','new-item','{}')",(ID,))
  self.assertEqual(self.apply()['state'],'complete')
  self.assertTrue(target.read_bytes().endswith(b'new primary continuation\n'))
  self.assertEqual(self.sql(self.primary,'state_5.sqlite','SELECT cwd FROM threads WHERE id=?',(ID,)),[('/new/cwd',)])
  self.assertEqual(self.sql(self.primary,'thread_history_1.sqlite','SELECT count(*) FROM thread_items'),[(2,)])

 def test_state_conflict_does_not_publish_any_history(self):
  self.sql(self.primary,'state_5.sqlite','INSERT INTO threads VALUES (?,?,?,?,?,NULL,NULL)',(ID,'/different','/other','paginated','Other'))
  with self.assertRaisesRegex(m.Refuse,'target-row-conflict'):self.apply()
  self.assertEqual(self.sql(self.primary,'thread_history_1.sqlite','SELECT count(*) FROM thread_items'),[(0,)])

 def test_existing_rollout_conflict_is_never_overwritten(self):
  target=self.primary/self.rollout.relative_to(self.source);target.write_bytes(b'different')
  with self.assertRaisesRegex(m.Refuse,'target-file-conflict'):self.apply()
  self.assertEqual(target.read_bytes(),b'different')

 def test_schema_with_unhandled_rows_is_refused(self):
  self.sql(self.source,'state_5.sqlite','CREATE TABLE future_state(id TEXT PRIMARY KEY)')
  self.sql(self.source,'state_5.sqlite',"INSERT INTO future_state VALUES ('x')")
  with self.assertRaisesRegex(m.Refuse,'unknown-nonempty-table'):self.apply()

 def test_symlink_rollout_refused(self):
  saved=self.root/'external';self.rollout.rename(saved);self.rollout.symlink_to(saved)
  with self.assertRaisesRegex(m.Refuse,'symlink-path'):self.apply()

 def test_paginated_missing_rollout_preserves_db_history(self):
  self.rollout.unlink()
  self.assertEqual(self.apply()['state'],'complete')
  self.assertFalse((self.primary/self.rollout.relative_to(self.source)).exists())
  self.assertEqual(self.sql(self.primary,'thread_history_1.sqlite','SELECT count(*) FROM thread_items'),[(1,)])

 def test_missing_rollout_without_history_is_refused(self):
  self.rollout.unlink();self.sql(self.source,'thread_history_1.sqlite','DELETE FROM thread_items')
  with self.assertRaisesRegex(m.Refuse,'rollout-missing-without-history'):self.apply()

 def test_source_queue_and_active_turn_and_goal_are_waiting(self):
  cases=[('queue_1.sqlite',"INSERT INTO queued_items VALUES ('queue',?,'{}')",'source-queue-not-empty'),
         ('thread_history_1.sqlite',"UPDATE thread_turns SET status='inProgress' WHERE thread_id=?",'source-turn-in-progress'),
         ('goals_1.sqlite',"UPDATE thread_goals SET status='active' WHERE thread_id=?",'source-goal-active')]
  for name,sql,reason in cases:
   self.sql(self.source,name,sql,(ID,))
   with self.assertRaises(m.Refuse) as error:self.apply()
   self.assertEqual(error.exception.reason,reason);self.assertTrue(error.exception.waiting)
   if name=='queue_1.sqlite':self.sql(self.source,name,'DELETE FROM queued_items')
   elif name=='thread_history_1.sqlite':self.sql(self.source,name,"UPDATE thread_turns SET status='completed'")

 def test_source_changes_after_snapshot_never_publish_state(self):
  def fail(stage):
   if stage=='after-preflight':self.sql(self.source,'state_5.sqlite',"UPDATE threads SET cwd='/changed'")
  with self.assertRaisesRegex(m.Refuse,'source-changed-before-publication'):self.apply(failpoint=fail)
  self.assertEqual(self.sql(self.primary,'state_5.sqlite','SELECT count(*) FROM threads'),[(0,)])

 def test_partial_preparation_is_reused_and_retried_without_archiving(self):
  real=m.backup
  calls=0
  def interrupted(source,destination):
   nonlocal calls
   calls+=1
   if calls==2:raise RuntimeError('prepare crash')
   return real(source,destination)
  with patch.object(m,'backup',interrupted):
   with self.assertRaisesRegex(RuntimeError,'prepare crash'):self.apply()
  journal=m.request_paths(self.req)[2]
  preserved=journal/'source-backup/state_5.sqlite'
  original=(preserved.stat().st_ino,m.file_hash(preserved))
  self.assertEqual(self.apply()['state'],'complete')
  self.assertEqual((preserved.stat().st_ino,m.file_hash(preserved)),original)
  self.assertEqual(list(journal.glob('interrupted-preparation-*')),[])

 def test_wal_source_backups_are_sealed_without_changing_live_journal_modes(self):
  with contextlib.ExitStack() as stack:
   # Keep fixture live sidecars available, as in the actual stores. The target
   # of this regression is the sealed copy, not immutable access to a live DB.
   for home in (self.source,self.primary):
    for name in SCHEMAS:
     db=stack.enter_context(contextlib.closing(sqlite3.connect(home/name)))
     self.assertEqual(db.execute('PRAGMA journal_mode=WAL').fetchone(),('wal',))
     db.execute('SELECT count(*) FROM sqlite_master').fetchone()
   self.assertEqual(self.apply()['state'],'complete')
   journal=m.request_paths(self.req)[2]
   for home in (self.source,self.primary):
    for name in SCHEMAS:self.assertEqual(self.sql(home,name,'PRAGMA journal_mode'),[('wal',)])
   for kind in ('source-backup','primary-before'):
    for name in SCHEMAS:
     path=journal/kind/name
     self.assertEqual(path.read_bytes()[18:20],b'\x01\x01')
     with contextlib.closing(m.connect(path)) as db:self.assertEqual(db.execute('PRAGMA quick_check').fetchone()[0],'ok')
     for suffix in ('-wal','-shm','-journal'):self.assertFalse(Path(str(path)+suffix).exists())

 def test_legacy_wal_header_snapshots_reopen_immutably_without_recopies(self):
  journal=m.request_paths(self.req)[2]
  for home,kind in ((self.source,'source-backup'),(self.primary,'primary-before')):
   m.mkdir(journal/kind)
   for name in SCHEMAS:
    self.sql(home,name,'PRAGMA journal_mode=WAL')
    with contextlib.closing(sqlite3.connect(home/name)) as src,contextlib.closing(sqlite3.connect(journal/kind/name)) as dst:src.backup(dst)
    self.assertEqual((journal/kind/name).read_bytes()[18:20],b'\x02\x02')
  original={str(path):(path.stat().st_ino,m.file_hash(path)) for path in journal.glob('*-*/[!-.]*.sqlite')}
  self.assertEqual(len(original),10)
  with patch.object(m,'backup',side_effect=AssertionError('must reuse completed snapshots')):
   self.assertEqual(self.apply()['state'],'complete')
  for raw,identity in original.items():
   path=Path(raw);self.assertEqual((path.stat().st_ino,m.file_hash(path)),identity)
   self.assertFalse(Path(raw+'-wal').exists());self.assertFalse(Path(raw+'-shm').exists())

 def test_cold_source_uses_only_private_snapshot_without_live_writer_or_immutable(self):
  path=self.source/'state_5.sqlite'
  self.sql(self.source,'state_5.sqlite','PRAGMA journal_mode=WAL')
  self.assertFalse(Path(str(path)+'-wal').exists());self.assertFalse(Path(str(path)+'-shm').exists())
  before={item.name:m.file_hash(item) for item in self.source.glob('*.sqlite')}
  try:
   with contextlib.closing(m.connect(path)) as db:db.execute('SELECT count(*) FROM threads').fetchone()
  except sqlite3.OperationalError as error:
   self.assertEqual(m.database_failure(error),{'version':1,'state':'blocked','reason':'store-open-failed'})
  else:self.skipTest('This SQLite supports read-only live WAL without existing sidecars')
  original=m.connect_store
  calls=[]
  def checked(candidate,readonly=True):
   if candidate.parent==self.source:
    calls.append(candidate);self.assertTrue(readonly)
   return original(candidate,readonly)
  with patch.object(m,'connect_store',side_effect=checked):self.assertEqual(self.apply()['state'],'complete')
  self.assertTrue(calls)
  self.assertEqual({item.name:m.file_hash(item) for item in self.source.glob('*.sqlite')},before)
  self.assertEqual(self.sql(self.primary,'state_5.sqlite','SELECT count(*) FROM threads'),[(1,)])
  snapshot=m.request_paths(self.req)[2]/'cold-source-read/state_5.sqlite'
  self.assertEqual(snapshot.read_bytes(),path.read_bytes())
  self.assertFalse(Path(str(path)+'-wal').exists());self.assertFalse(Path(str(path)+'-shm').exists())

 def cold(self,name):
  self.sql(self.source,name,'PRAGMA journal_mode=WAL')
  self.assertFalse(Path(str(self.source/name)+'-wal').exists())

 def test_cold_state_count_never_copies_before_source_absence(self):
  self.cold('state_5.sqlite')
  def active(_):raise m.Refuse('source-host-running',True)
  with patch.object(m,'copy_file',side_effect=AssertionError('source not authorized for cold copying')):
   self.assertEqual(m.run(self.req,'plan',guard=active)['state'],'waiting')
   with self.assertRaisesRegex(m.Refuse,'source-host-running'):m.run(self.req,'apply',guard=active)
  self.assertFalse((self.root/'journal').exists())

 def test_cold_goals_and_queue_still_block_active_or_queued_work(self):
  for name,statement,reason in (
    ('goals_1.sqlite',"UPDATE thread_goals SET status='active'",'source-goal-active'),
    ('queue_1.sqlite',"INSERT INTO queued_items VALUES ('q','t','{}')",'source-queue-not-empty')):
   self.sql(self.source,name,statement);self.cold(name)
   with self.assertRaisesRegex(m.Refuse,reason):self.apply()
   self.assertEqual(self.sql(self.primary,'state_5.sqlite','SELECT count(*) FROM threads'),[(0,)])
   if name=='goals_1.sqlite':self.sql(self.source,name,"UPDATE thread_goals SET status='paused'")

 def test_cold_source_change_or_sidecar_before_commit_rolls_back_state(self):
  for alteration in ('main','sidecar'):
   with self.subTest(alteration=alteration):
    # Each path gets its own fixture; a prior refused snapshot is intentionally
    # not silently replaced when the original source changes.
    f=MigrationTest();f.setUp()
    try:
     f.cold('goals_1.sqlite');path=f.source/'goals_1.sqlite'
     def changed(stage):
      if stage!='before-state-commit':return
      if alteration=='main':f.sql(f.source,'goals_1.sqlite',"UPDATE thread_goals SET tokens_used=tokens_used+1")
      else:Path(str(path)+'-wal').touch(mode=0o600)
     with self.assertRaisesRegex(m.Refuse,'cold-source-(changed|sidecar-present)'):f.apply(failpoint=changed)
     self.assertEqual(f.sql(f.primary,'state_5.sqlite','SELECT count(*) FROM threads'),[(0,)])
    finally:f.tearDown()

 def test_cold_source_snapshot_reuse_is_bounded_and_original_fenced(self):
  self.cold('goals_1.sqlite')
  directory=m.request_paths(self.req)[2]
  self.assertEqual(m.run(self.req,'plan',guard=self.absent)['state'],'ready')
  snapshot=directory/'cold-source-read/goals_1.sqlite';before=(snapshot.stat().st_ino,m.file_hash(snapshot))
  self.assertEqual(m.run(self.req,'plan',guard=self.absent)['state'],'ready')
  self.assertEqual((snapshot.stat().st_ino,m.file_hash(snapshot)),before)
  self.assertEqual(len(list((directory/'cold-source-read').iterdir())),1)
  self.assertEqual(self.apply()['state'],'complete')

 def test_cold_snapshot_publication_crash_reuses_one_partial_and_never_live_data(self):
  self.cold('goals_1.sqlite');path=self.source/'goals_1.sqlite';before=m.file_hash(path)
  original=m.publish_file
  def interrupted(source,target):
   if target.parent.name=='cold-source-read':raise RuntimeError('cold publication interrupted')
   return original(source,target)
  directory=m.request_paths(self.req)[2]/'cold-source-read'
  with patch.object(m,'publish_file',side_effect=interrupted):
   for _ in range(2):
    with self.assertRaisesRegex(RuntimeError,'cold publication interrupted'):self.apply()
    self.assertEqual([item.name for item in directory.iterdir()],['goals_1.sqlite.partial'])
  self.assertEqual(self.apply()['state'],'complete');self.assertEqual(m.file_hash(path),before)
  self.assertEqual([item.name for item in directory.iterdir()],['goals_1.sqlite'])

 def test_cold_source_owner_returning_during_state_merge_prevents_commit(self):
  self.cold('goals_1.sqlite');active=False
  def quick():
   if active:raise m.Refuse('source-host-running',True)
  def guard(_):quick();return quick
  def returned(stage):
   nonlocal active
   if stage=='before-state-commit':active=True
  with self.assertRaisesRegex(m.Refuse,'source-host-running'):m.run(self.req,'apply',guard=guard,failpoint=returned)
  self.assertEqual(self.sql(self.primary,'state_5.sqlite','SELECT count(*) FROM threads'),[(0,)])

 def test_cold_fallback_is_never_available_to_primary_or_corrupt_source(self):
  original=m.connect_store
  for scenario in ('primary','corrupt'):
   def denied(path,readonly=True):
    if path==(self.primary/'state_5.sqlite' if scenario=='primary' else self.source/'goals_1.sqlite'):
     raise sqlite3.OperationalError('unable to open database file' if scenario=='primary' else 'database disk image is malformed')
    return original(path,readonly)
   with patch.object(m,'connect_store',side_effect=denied):
    with self.assertRaises(sqlite3.OperationalError):self.apply()
   self.assertFalse((m.request_paths(self.req)[2]/'cold-source-read').exists())

 def test_repeated_transient_preparation_failures_do_not_grow_backups(self):
  original=m.backup
  journal=m.request_paths(self.req)[2]
  with patch.object(m,'backup',wraps=original) as copied,patch.object(m,'copy_file',side_effect=sqlite3.OperationalError('database is locked')):
   previous=None
   for _ in range(3):
    with self.assertRaises(sqlite3.OperationalError):self.apply()
    current={str(path):(path.stat().st_ino,path.stat().st_size) for path in journal.rglob('*.sqlite')}
    self.assertEqual(len(current),10)
    if previous is not None:self.assertEqual(current,previous)
    previous=current
   self.assertEqual(copied.call_count,10)
  self.assertEqual(list(journal.glob('interrupted-preparation-*')),[])
  self.assertEqual(self.sql(self.primary,'state_5.sqlite','SELECT count(*) FROM threads'),[(0,)])
  self.assertEqual(self.apply()['state'],'complete')

 def test_repeated_backup_publication_crashes_keep_one_private_partial(self):
  original=m.publish_file
  def fail(source,target):
   if target.name=='state_5.sqlite':raise RuntimeError('backup publication interrupted')
   return original(source,target)
  journal=m.request_paths(self.req)[2]
  with patch.object(m,'publish_file',side_effect=fail):
   for _ in range(3):
    with self.assertRaisesRegex(RuntimeError,'publication interrupted'):self.apply()
    self.assertEqual([path.name for path in (journal/'source-backup').iterdir()],['state_5.sqlite.partial'])
  self.assertEqual(self.apply()['state'],'complete')
  self.assertEqual(list(journal.rglob('*.partial')),[])

 def test_snapshot_reader_rejects_live_paths_sidecars_and_empty_primary_backups(self):
  with self.assertRaisesRegex(m.Refuse,'snapshot-location-unverified'):m.connect_snapshot(self.source/'state_5.sqlite')
  journal=m.request_paths(self.req)[2];m.mkdir(journal/'primary-before')
  path=journal/'primary-before/state_5.sqlite';path.touch(mode=0o600)
  with self.assertRaisesRegex(m.Refuse,'snapshot-schema-mismatch'):self.apply()
  self.assertEqual(path.stat().st_size,0)
  path.unlink();m.backup(self.primary/'state_5.sqlite',path)
  Path(str(path)+'-wal').touch(mode=0o600)
  with self.assertRaisesRegex(m.Refuse,'snapshot-sidecar-present'):m.connect_snapshot(path)

 def test_sqlite_busy_is_distinct_from_open_read_and_schema_failures(self):
  for message in ('database is locked','database table is locked','database schema is locked: main'):
   self.assertEqual(m.database_failure(sqlite3.OperationalError(message)),{'version':1,'state':'waiting','reason':'store-busy'})
  for message,reason in (('unable to open database file','store-open-failed'),('no such column: rowid','store-read-failed'),('disk I/O error','store-read-failed')):
   self.assertEqual(m.database_failure(sqlite3.OperationalError(message)),{'version':1,'state':'blocked','reason':reason})

 def test_tampered_prepared_report_or_backup_is_rejected(self):
  def fail(stage):
   if stage=='after-preflight':raise RuntimeError('stop')
  with self.assertRaises(RuntimeError):self.apply(failpoint=fail)
  journal=m.request_paths(self.req)[2]
  original=(journal/'report.json').read_bytes()
  report=json.loads(original);report['threads'][0]['targetPath']='/unrelated'
  (journal/'report.json').write_bytes(m.encode(report))
  with self.assertRaisesRegex(m.Refuse,'report-integrity-failed'):self.apply()
  (journal/'report.json').write_bytes(original)
  self.sql(journal/'source-backup','state_5.sqlite',"UPDATE threads SET title='altered'")
  with self.assertRaisesRegex(m.Refuse,'backup-integrity-failed'):self.apply()

 def test_primary_unrelated_activity_is_preserved(self):
  def primary_work(stage):
   if stage=='after-thread_history_1.sqlite':
    self.sql(self.primary,'state_5.sqlite','INSERT INTO threads VALUES (?,?,?,?,?,NULL,NULL)',(OTHER,'/primary/live','/work/live','paginated','Active primary'))
  self.assertEqual(self.apply(failpoint=primary_work)['state'],'complete')
  self.assertEqual(self.sql(self.primary,'state_5.sqlite','SELECT count(*) FROM threads'),[(2,)])
  self.assertEqual(self.sql(self.primary,'state_5.sqlite','SELECT cwd FROM threads WHERE id=?',(OTHER,)),[('/work/live',)])

 def test_existing_rollout_hashing_never_holds_primary_state_writer_lock(self):
  target=self.primary/self.rollout.relative_to(self.source);target.write_bytes(self.body)
  original=m.file_hash
  def checked(path):
   with contextlib.closing(sqlite3.connect(self.primary/'state_5.sqlite',timeout=0)) as db:
    db.execute('BEGIN IMMEDIATE');db.rollback()
   return original(path)
  with patch.object(m,'file_hash',checked):self.assertEqual(self.apply()['state'],'complete')

 def test_source_returning_before_publish_leaves_state_unpublished(self):
  def guard(_):
   self.guard_calls+=1
   if self.guard_calls==6:raise m.Refuse('source-host-running',True)
  with self.assertRaisesRegex(m.Refuse,'source-host-running'):m.run(self.req,'apply',guard=guard)
  self.assertEqual(self.sql(self.primary,'state_5.sqlite','SELECT count(*) FROM threads'),[(0,)])
  self.assertEqual(self.apply()['state'],'complete')


if __name__=='__main__':unittest.main()
