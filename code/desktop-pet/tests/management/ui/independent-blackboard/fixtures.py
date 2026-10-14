"""Controlled UI inputs from the fixed public store; no model or real thread."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile

source = Path(__file__).resolve().parents[4] / 'workbench/independent-blackboard/store.py'
spec = importlib.util.spec_from_file_location('ui_board_store', source)
store = importlib.util.module_from_spec(spec)
spec.loader.exec_module(store)
scope = {'environmentId': '11111111-1111-4111-8111-111111111111', 'projectId': 'controlled-board-project'}
actors = [{'actorId': actor, 'threadId': 'controlled-independent-' + actor,
           'providerInstanceId': 'codex', 'title': '协调对话' if actor == 'c' else '执行对话' + actor,
           'role': 'coordinator' if actor == 'c' else 'executor',
           'capabilitySha256': hashlib.sha256(('controlled-' + actor).encode()).hexdigest()}
          for actor in ['c', 'a', 'b']]

with tempfile.TemporaryDirectory(prefix='w1-board-ui-') as temp:
    database = Path(temp) / 'board.sqlite'
    states = {}

    def capture(name):
        value = store.snapshot(database)
        for participant in value['participants']:
            participant['identitySource'] = 't3-original-thread-snapshot'
            participant['nativeThreadId'] = None
        states[name] = value
        return value

    def act(actor, kind, body=None):
        version = store.snapshot(database)['revision']
        store.apply(database, {'scope': scope, 'actorId': actor, 'kind': kind, 'body': body or {},
                              'expectedRevision': version, 'operationId': f'controlled:{actor}:{kind}:{version}'},
                    'controlled-' + actor)

    store.initialize(database, {'boardId': 'controlled-ui-board', 'scope': scope, 'participants': actors})
    capture('empty')
    act('c', 'assign', {'tasks': [{'taskId': actor, 'ownerActorId': actor, 'title': '分工' + actor,
                                  'instructions': '只读共享分工，给出独立回报'} for actor in ['a', 'b']]})
    capture('assigned')
    for actor in ['a', 'b']:
        act(actor, 'read')
        act(actor, 'start', {'taskId': actor})
        capture('running-' + actor)
        # A second read during execution is legal; its report proof is the latest read.
        act(actor, 'read')
        act(actor, 'report', {'taskId': actor, 'text': '受控回报' + actor})
    capture('reported')
    act('c', 'read')
    refs = [task['report']['eventId'] for task in store.snapshot(database)['tasks']]
    act('c', 'summary', {'text': '受控协调汇总，引用两份回报', 'reportEventIds': refs})
    capture('final')

print(json.dumps(states, ensure_ascii=False))
