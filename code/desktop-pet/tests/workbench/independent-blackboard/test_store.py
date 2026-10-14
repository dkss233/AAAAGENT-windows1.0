import concurrent.futures
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

source = Path(__file__).resolve().parents[3] / 'workbench/independent-blackboard/store.py'
spec = importlib.util.spec_from_file_location('board_store', source)
store = importlib.util.module_from_spec(spec)
spec.loader.exec_module(store)


class CollaborationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'board.sqlite'
        self.scope = {'environmentId': 'environment', 'projectId': 'test-project'}
        participants = [{'actorId': a, 'threadId': 'independent-' + a, 'providerInstanceId': 'codex',
                         'title': a, 'role': 'coordinator' if a == 'c' else 'executor',
                         'capabilitySha256': hashlib.sha256(a.encode()).hexdigest()} for a in ['c', 'a', 'b']]
        store.initialize(self.path, {'boardId': 'test-board', 'scope': self.scope, 'participants': participants})

    def request(self, actor, kind, body=None, revision=None, operation=None):
        current = store.snapshot(self.path)['revision']
        return {'actorId': actor, 'scope': self.scope, 'kind': kind, 'body': body or {},
                'expectedRevision': current if revision is None else revision,
                'operationId': operation or actor + ':' + kind + ':' + str(current)}

    def act(self, actor, kind, body=None):
        return store.apply(self.path, self.request(actor, kind, body), actor)['snapshot']

    def assign(self):
        self.act('c', 'assign', {'tasks': [{'taskId': a, 'ownerActorId': a, 'title': a,
                                          'instructions': 'read the shared task and calculate'} for a in ['a', 'b']]})

    def report(self, actor):
        self.act(actor, 'read')
        self.act(actor, 'start', {'taskId': actor})
        return self.act(actor, 'report', {'taskId': actor, 'text': 'computed-' + actor})

    def test_actual_independent_record_chain_and_summary_sources(self):
        self.assign()
        with self.assertRaisesRegex(store.BoardError, 'assignment_not_read'):
            self.act('a', 'start', {'taskId': 'a'})
        self.report('a')
        self.report('b')
        with self.assertRaisesRegex(store.BoardError, 'reports_not_read'):
            self.act('c', 'summary', {'text': 'combined', 'reportEventIds': [t['report']['eventId'] for t in store.snapshot(self.path)['tasks']]})
        value = self.act('c', 'read')
        refs = [t['report']['eventId'] for t in value['tasks']]
        with self.assertRaisesRegex(store.BoardError, 'summary_sources_mismatch'):
            self.act('c', 'summary', {'text': 'combined', 'reportEventIds': ['forged']})
        final = self.act('c', 'summary', {'text': 'combined', 'reportEventIds': refs})
        self.assertEqual(final['status'], 'summarized')
        self.assertEqual(len(final['relations']), 4)
        self.assertEqual({r['kind'] for r in final['relations']}, {'assignment', 'report'})
        self.assertNotIn('capabilitySha256', str(final))
        self.assertEqual(len({p['threadId'] for p in final['participants']}), 3)
        self.assertEqual(store.snapshot(self.path), final)

    def test_scope_capability_and_ownership_rejected_before_mutation(self):
        self.assign()
        before = store.snapshot(self.path)
        for actor, cap, body, error in [('a', 'wrong', {'taskId': 'a'}, 'actor_not_authorized'),
                                      ('b', 'b', {'taskId': 'a'}, 'task_not_owned')]:
            with self.assertRaisesRegex(store.BoardError, error):
                store.apply(self.path, self.request(actor, 'start', body), cap)
        req = self.request('a', 'read'); req['scope'] = {'environmentId': 'other', 'projectId': 'test-project'}
        with self.assertRaisesRegex(store.BoardError, 'scope_mismatch'):
            store.apply(self.path, req, 'a')
        self.assertEqual(store.snapshot(self.path), before)

    def test_operation_retry_returns_original_and_changed_payload_denied(self):
        req = self.request('a', 'read', operation='stable-read')
        first = store.apply(self.path, req, 'a')
        self.assertEqual(first, store.apply(self.path, req, 'a'))
        req['body'] = {'different': True}
        with self.assertRaisesRegex(store.BoardError, 'operation_payload_changed'):
            store.apply(self.path, req, 'a')
        self.assertEqual(store.snapshot(self.path)['revision'], 1)

    def test_two_concurrent_versions_accept_exactly_one(self):
        def submit(a):
            try:
                store.apply(self.path, self.request(a, 'read', revision=0), a)
                return 'accepted'
            except store.BoardError as e:
                return str(e)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            result = list(pool.map(submit, ['a', 'b']))
        self.assertCountEqual(result, ['accepted', 'revision_conflict'])
        self.assertEqual(store.snapshot(self.path)['revision'], 1)

    def test_missing_database_does_not_create_or_reinitialize(self):
        missing = Path(self.tmp.name) / 'missing.sqlite'
        with self.assertRaisesRegex(store.BoardError, 'board_unavailable'):
            store.snapshot(missing)
        self.assertFalse(missing.exists())
        with self.assertRaisesRegex(store.BoardError, 'board_already_exists'):
            store.initialize(self.path, {})


if __name__ == '__main__':
    unittest.main()
