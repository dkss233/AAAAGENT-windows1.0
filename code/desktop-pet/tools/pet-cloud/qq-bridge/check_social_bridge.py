"""Isolated QQ worker checks. The optional cloud mode still uses a synthetic QQ sender."""
import collections
import json
from pathlib import Path
import queue
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock

import core
from app import Runtime
from core import Brain, Store, now
from social_bridge import SocialBridge, channel_id

ROOT=Path(__file__).resolve().parent.parent

def make_runtime(data,config_file,brain,credentials):
    runtime=Runtime.__new__(Runtime);runtime.store=Store(data);runtime.brain=brain or Brain(runtime.store)
    runtime.queue=queue.Queue();runtime.model_times=collections.deque();runtime.paused=False;runtime.last_error=''
    runtime.config={'model_enabled':True,'model_provider':'deepseek','web_search_enabled':False,'stickers_enabled':False,'daily_budget_usd':.10,'daily_max_calls':4}
    runtime.credentials=credentials;runtime.stickers=Mock();runtime.stickers.select.return_value=None
    runtime.gateway=Mock();runtime.gateway.send.return_value='SYNTHETIC_QQ_RECEIPT_NOT_A_REAL_POST'
    runtime.social=SocialBridge(data,config_file,autostart=False)
    return runtime

def process(runtime,message):
    item=runtime.store.ingest(message['group'],{'id':message['id'],'author':{'member_openid':message['actor'],'username':message['name']},'timestamp':now(),'content':message['text']})
    item['mentioned']=True;runtime.queue.put(item)
    threading.Thread(target=runtime.worker,daemon=True).start()
    deadline=time.monotonic()+85
    while runtime.queue.unfinished_tasks and time.monotonic()<deadline:time.sleep(.02)
    assert runtime.queue.unfinished_tasks==0,'Synthetic QQ worker timed out'
    return item

class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='social-check-',dir=ROOT/'logs');self.root=Path(self.temp.name).resolve()
        assert self.root.is_relative_to((ROOT/'logs').resolve());self.addCleanup(self.temp.cleanup)
        self.file=self.root/'connection.json';self.file.write_text(json.dumps({'version':1,'enabled':True,'roleId':'test-role','endpoint':'http://127.0.0.1:18766','channelToken':'c'*40,'groups':['test-group']}),encoding='utf-8')
        self.message={'group':'test-group','id':'test-message','actor':'test-member','name':'测试群友','text':'我今天学会给 Blender 小恐龙上色了。'}
    def runtime(self):
        brain=Mock();brain.reply.return_value='好耶，小恐龙完成啦～'
        runtime=make_runtime(self.root,self.file,brain,lambda:{})
        self.addCleanup(runtime.store.close);self.addCleanup(runtime.social.close);return runtime
    def test_accepted_qq_receipt_creates_one_durable_event(self):
        runtime=self.runtime();item=process(runtime,self.message)
        self.assertEqual(runtime.store.chat.execute('SELECT status FROM messages').fetchone()[0],'replied')
        self.assertEqual(runtime.social.snapshot()['pending'],1)
        self.assertTrue(runtime.social.record_delivery(item,runtime.brain.reply.return_value,runtime.gateway.send.return_value))
        self.assertEqual(runtime.social.snapshot()['pending'],1)
        payload=json.loads(runtime.social.db.execute('SELECT payload FROM outbox').fetchone()[0])
        self.assertEqual(payload['event']['scope'],'group');self.assertEqual(payload['event']['actorName'],'测试群友')
        self.assertEqual(payload['event']['groupId'],channel_id('group','test-group'));self.assertTrue(payload['receipt'].startswith('qq-receipt-'))
    def test_failed_or_uncertain_qq_send_never_creates_participation(self):
        runtime=self.runtime();runtime.gateway.send.side_effect=TimeoutError('synthetic timeout')
        process(runtime,self.message)
        self.assertEqual(runtime.store.chat.execute('SELECT status FROM messages').fetchone()[0],'failed_or_uncertain')
        self.assertEqual(runtime.social.snapshot()['pending'],0)
    def test_failed_social_sync_keeps_the_same_event_for_idempotent_retry(self):
        runtime=self.runtime();process(runtime,self.message)
        seen=[]
        def fail(payload):seen.append(payload);raise TimeoutError()
        runtime.social.request=fail;runtime.social.flush_one();self.assertEqual(runtime.social.snapshot()['pending'],1)
        runtime.social.db.execute('UPDATE outbox SET next_attempt=0');runtime.social.db.commit()
        runtime.social.request=lambda payload:seen.append(payload);runtime.social.flush_one()
        self.assertEqual(seen[0],seen[1]);self.assertEqual(runtime.social.snapshot()['submitted'],1)
    def test_unconfigured_bridge_never_touches_qq_or_opens_a_database(self):
        bridge=SocialBridge(self.root,self.root/'absent.json',autostart=False)
        self.assertFalse(bridge.enabled);self.assertIsNone(bridge.db);bridge.close()

def cloud_roundtrip(config_file,data,message,credential_file):
    trace=[];original=core.request_model
    def tracked(messages,route):
        assert route['provider']=='deepseek' and route['base']=='https://api.deepseek.com' and route['model']=='deepseek-flash'
        result=original(messages,route)
        trace.append({'provider':route['provider'],'model':route['model'],'host':'api.deepseek.com','usage':result[1]})
        return result
    core.request_model=tracked
    runtime=make_runtime(Path(data),Path(config_file),None,lambda:json.loads(Path(credential_file).read_text(encoding='utf-8')))
    try:
        item=process(runtime,message)
        row=runtime.store.chat.execute('SELECT status,reply FROM messages').fetchone()
        assert row['status']=='replied' and trace,'Cloud-backed QQ answer did not complete'
        runtime.social.flush_one();assert runtime.social.snapshot()['submitted']==1,runtime.social.last_error
        return {'synthetic_qq_sender':True,'actual_qq_messages_sent':0,'status':row['status'],'reply':row['reply'],'model_calls':trace,'event_id':channel_id('event',item['group']+'\0'+item['id'])}
    finally:runtime.social.close();runtime.store.close();core.request_model=original

if __name__=='__main__':
    import sys
    if len(sys.argv)>1 and sys.argv[1]=='--cloud-roundtrip':
        value=json.loads(Path(sys.argv[2]).read_text(encoding='utf-8'))
        result=cloud_roundtrip(value['connectionFile'],value['data'],value['message'],value['credentialFile'])
        print(json.dumps(result,ensure_ascii=False))
    else:unittest.main(verbosity=2)
