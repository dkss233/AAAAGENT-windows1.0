#!/usr/bin/env python3
"""Structural and known-pattern audit; does not establish asset ownership."""
import hashlib,json,re,sys
from pathlib import Path
root=Path(__file__).resolve().parents[1]
forbidden_dirs={'.git','node_modules','dist','build','data','artifacts','.local','.cache','__pycache__'}
forbidden_suffixes={'.moc3','.onnx','.sqlite','.db','.webm','.mp4','.wav','.mp3','.wasm','.dylib','.so','.apk','.pkg','.dmg','.p12','.pfx','.pem','.key','.log','.jsonl'}
# Reviewed T3 build assets only; see THIRD_PARTY_NOTICES.md and adjacent notices.
# Both the exact Windows-root-relative path and reviewed bytes must match.
approved_resources={
 't3-source/apps/web/src/assets/notification-completion.mp3':'910311c1dbe3191834ce984cfbc7cfcc258f20038d41f94f08711b28063cd286',
 't3-source/apps/web/src/assets/notification-input.mp3':'5708991465e01730bdfac605708b578844039532c51db26174aa362bd71b22e2',
 't3-source/apps/web/src/assets/snap-shot-whoosh.mp3':'2cf13b9a9af15b616e255256cd773efa3fdd17c7346475f5b13097ef40b12ad3',
 't3-source/apps/web/src/assets/snap-shot-click.mp3':'65960f2121ed8db98c6e924a7c9c55199141adae6a67623806038fb833dd552d',
 't3-source/apps/web/src/terminal/ghostty/vendor/ghostty-vt.wasm':'51b016a6aa3c29ead71c7c8acf8c01d43b064bae19957a9c9f9e2bf469267629',
 't3-source/apps/web/src/terminal/ghostty/vendor/ghostty-write-pty.wasm':'75cb147e98ede3f85f3cd6236a30f6d12565b0b237e1d8db941f5f3e8ad3d903',
}
rules={
 'personal_home':re.compile(rb'/(?:Users|home)/[A-Za-z0-9_.-]+/'),
 'credential':re.compile(rb'\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|LTAI[A-Za-z0-9]{16,})\b'),
 'private_key':re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
 'clone_voice':re.compile(rb'Dania(?:Compare|CnHD)[A-Za-z0-9]+'),
 'private_task_id':re.compile(rb'01a0[a-f0-9]{4}-[a-f0-9-]{27,}'),
}
issues=[];manifest=[]
for path in sorted(root.rglob('*')):
 rel=path.relative_to(root)
 if path.is_symlink():issues.append({'path':str(rel),'rule':'symlink'});continue
 if not path.is_file():continue
 data=path.read_bytes();digest=hashlib.sha256(data).hexdigest()
 approved=approved_resources.get(rel.as_posix())==digest
 if any(p in forbidden_dirs for p in rel.parts) or (path.suffix.lower() in forbidden_suffixes and not approved) or path.name.endswith(('.model3.json','.exp3.json','.motion3.json')):
  issues.append({'path':str(rel),'rule':'excluded_resource'})
 if path.stat().st_size>50*1024*1024:issues.append({'path':str(rel),'rule':'oversized_file'})
 if path.name.startswith('.env') or path.name.startswith(('id_rsa','id_ed25519')):issues.append({'path':str(rel),'rule':'private_config'})
 # This scanner's pattern definitions are intentional, not packaged credentials.
 if path.resolve()!=Path(__file__).resolve():
  for name,pattern in rules.items():
   if pattern.search(data):issues.append({'path':str(rel),'rule':name})
 manifest.append({'path':str(rel),'bytes':len(data),'sha256':digest})
print(json.dumps({'ok':not issues,'files':len(manifest),'issues':issues,'manifest':manifest},ensure_ascii=False,indent=2))
sys.exit(bool(issues))
