#!/usr/bin/env python3
"""Read-only submission preflight; this is not access control or a publication service."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('--canonical-root', type=Path, required=True)
p.add_argument('--task', required=True)
a = p.parse_args()
root = a.canonical_root.resolve()
board = json.loads((root / 'docs/agent/blackboard/CURRENT.json').read_text())
registry = json.loads((root / board['ownership_registry']).read_text())
task = next(t for t in registry['tasks'] if t['task_id'] == a.task)
worktree = Path(task['worktree']).resolve()
errors = []
if str(root) != registry['canonical_root']:
    errors.append('canonical root mismatch')
if board.get('publication_pending'):
    errors.append('formal publication is pending')
if task.get('implementation_authorized') is False:
    errors.append('task implementation is not released')
if not task.get('workspace_ready'):
    errors.append('workspace is not ready')
if task['base_version'] != board['base_version']:
    errors.append('Base version changed; refresh task inputs')
if task['contract_version'] != board.get('contract_version'):
    errors.append('contract version changed; refresh task inputs')
for entry in board['sources']:
    source = (root / entry['path']).resolve()
    if root not in source.parents or not source.is_file():
        errors.append('invalid source: ' + entry['path'])
    elif hashlib.sha256(source.read_bytes()).hexdigest() != entry['sha256']:
        errors.append('source fingerprint changed: ' + entry['path'])
def git(*args):
    return subprocess.check_output(['git', '-C', str(worktree), *args])
def exact_public_input_consumption(path):
    """Accept a registered receipt only while all three copies retain exact bytes."""
    scope = task.get('public_input_consumption_scope', [])
    expected = task.get('public_input_consumption_sha256', {}).get(path)
    received = task.get('accepted_public_input_consumption_commit')
    source = task.get('required_public_input_commit')
    current = worktree / path
    if path not in scope or not expected or not received or not source:
        return False
    if current.is_symlink() or not current.is_file() or worktree not in current.resolve().parents:
        return False
    try:
        git('merge-base', '--is-ancestor', received, 'HEAD')
        receipt_paths = {x.decode() for x in git('diff-tree', '--no-commit-id', '--name-only', '-r', '-z', received).split(b'\0') if x}
        if not receipt_paths or not receipt_paths.issubset(set(scope)):
            return False
        copies = [current.read_bytes(), git('show', received + ':' + path), git('show', source + ':' + path)]
        return all(hashlib.sha256(value).hexdigest() == expected for value in copies)
    except (OSError, subprocess.CalledProcessError):
        return False
paths = set()
if task.get('branch'):
    if git('branch', '--show-current').decode().strip() != task['branch']:
        errors.append('branch does not match task registration')
    base = task.get('code_base')
    if base:
        for cmd in [('diff', '--name-only', '-z', base, 'HEAD'), ('diff', '--name-only', '-z', 'HEAD')]:
            paths.update(x.decode() for x in git(*cmd).split(b'\0') if x)
    paths.update(x.decode() for x in git('ls-files', '--others', '--exclude-standard', '-z').split(b'\0') if x)
    for path in sorted(paths):
        if not any(path.startswith(rule) if rule.endswith('/') else path == rule for rule in task['writable_paths']) and not exact_public_input_consumption(path):
            errors.append('outside assigned scope: ' + path)
print(json.dumps({'ok': not errors, 'task': a.task, 'worktree': str(worktree), 'board_revision': board['revision'], 'changed_paths': sorted(paths), 'errors': errors, 'limits': ['read-only check, not an OS sandbox', 'no semantic review, live device evidence or automatic publication']}, indent=2))
raise SystemExit(0 if not errors else 1)
