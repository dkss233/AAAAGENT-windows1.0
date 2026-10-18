"""Receipt-backed group summaries; never reads private companion memory or sends QQ messages."""
import datetime as dt
import hashlib
import json
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from core import redact


def channel_id(kind,value):
    return 'qq-'+kind+'-'+hashlib.sha256(str(value).encode('utf-8')).hexdigest()[:40]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None


class SocialBridge:
    def __init__(self,root,config_file=None,request=None,autostart=True):
        self.root=Path(root);self.lock=threading.RLock();self.stop=threading.Event()
        self.last_error='';self.enabled=False;self.thread=None;self.db=None
        self.request=request or self._post
        filename=Path(config_file) if config_file else self.root/'social-channel.json'
        if not filename.exists():return
        try:
            if filename.is_symlink() or filename.stat().st_size>16000:raise ValueError()
            config=json.loads(filename.read_text(encoding='utf-8'))
            if config.get('enabled') is False:return
            endpoint=urllib.parse.urlsplit(config['endpoint'])
            if endpoint.username or endpoint.password or endpoint.query or endpoint.fragment or endpoint.path not in ('','/'):raise ValueError()
            if endpoint.scheme!='https' and not (endpoint.scheme=='http' and endpoint.hostname in ('127.0.0.1','localhost','::1')):raise ValueError()
            if config.get('version')!=1 or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}',config['roleId']):raise ValueError()
            if not isinstance(config['channelToken'],str) or len(config['channelToken'])<32:raise ValueError()
            if not isinstance(config['groups'],list) or not config['groups'] or not all(isinstance(g,str) and g for g in config['groups']):raise ValueError()
            self.config=config
            self.db=sqlite3.connect(self.root/'social-outbox.sqlite',check_same_thread=False,timeout=5)
            self.db.execute('PRAGMA journal_mode=WAL')
            self.db.executescript("CREATE TABLE IF NOT EXISTS binding(value TEXT PRIMARY KEY);CREATE TABLE IF NOT EXISTS outbox(event_id TEXT PRIMARY KEY,payload TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt REAL NOT NULL DEFAULT 0,error TEXT);")
            binding=json.dumps([config['endpoint'],config['roleId']])
            old=self.db.execute('SELECT value FROM binding LIMIT 1').fetchone()
            if old and old[0]!=binding:raise ValueError()
            self.db.execute('INSERT OR IGNORE INTO binding VALUES(?)',(binding,));self.db.commit()
            self.enabled=True
            if autostart:
                self.thread=threading.Thread(target=self._run,daemon=True);self.thread.start()
        except Exception:
            if self.db:self.db.close();self.db=None
            self.last_error='社交记忆连接配置未通过检查，QQ 原有功能继续运行'

    def record_delivery(self,item,reply,receipt):
        if not self.enabled:return False
        try:
            if item['group'] not in self.config['groups'] or not isinstance(receipt,str) or not receipt:return False
            content=redact(item['content']);reply=redact(reply)
            if not content or len(content)>6000 or not reply or len(reply)>1200:raise ValueError()
            stamp=dt.datetime.fromisoformat(item['sent_at'].replace('Z','+00:00'))
            if stamp.tzinfo is None:stamp=stamp.replace(tzinfo=dt.timezone.utc)
            event={'eventId':channel_id('event',item['group']+'\0'+item['id']),'roleId':self.config['roleId'],'scope':'group','groupId':channel_id('group',item['group']),
                   'actorId':channel_id('member',item['group']+'\0'+item['sender']),'actorName':redact(item.get('name') or '群友')[:80],
                   'text':content,'occurredAt':stamp.astimezone(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z'),'addressed':bool(item.get('mentioned'))}
            payload=json.dumps({'event':event,'reply':reply,'receipt':channel_id('receipt',receipt)},ensure_ascii=False,separators=(',',':'))
            digest=hashlib.sha256(payload.encode()).hexdigest()
            with self.lock,self.db:
                old=self.db.execute('SELECT digest FROM outbox WHERE event_id=?',(event['eventId'],)).fetchone()
                if old:
                    if old[0]!=digest:raise ValueError()
                    return True
                if self.db.execute("SELECT COUNT(*) FROM outbox WHERE state='pending'").fetchone()[0]>=1000:raise ValueError()
                self.db.execute("INSERT INTO outbox(event_id,payload,digest,state) VALUES(?,?,?,'pending')",(event['eventId'],payload,digest))
            return True
        except Exception:
            self.last_error='这条已送达回复暂未加入社交记忆队列'
            return False

    def _post(self,payload):
        url=self.config['endpoint'].rstrip('/')+'/v1/'+self.config['roleId']+'/participations'
        request=urllib.request.Request(url,data=payload.encode('utf-8'),headers={'Content-Type':'application/json','Authorization':'Bearer '+self.config['channelToken']})
        with urllib.request.build_opener(NoRedirect()).open(request,timeout=10) as response:
            result=json.loads(response.read(16000))
            if not isinstance(result,dict) or not isinstance(result.get('eventId'),str):raise ValueError()

    def flush_one(self):
        if not self.enabled:return False
        with self.lock:
            row=self.db.execute("SELECT event_id,payload,attempts FROM outbox WHERE state='pending' AND next_attempt<=? ORDER BY rowid LIMIT 1",(time.time(),)).fetchone()
        if not row:return False
        event_id,payload,attempts=row
        try:
            self.request(payload)
            with self.lock,self.db:self.db.execute("UPDATE outbox SET state='submitted',error=NULL WHERE event_id=?",(event_id,))
            self.last_error=''
        except Exception as error:
            permanent=isinstance(error,urllib.error.HTTPError) and error.code in (400,401,403,404,409,413)
            note='HTTP '+str(error.code) if isinstance(error,urllib.error.HTTPError) else type(error).__name__
            with self.lock,self.db:self.db.execute('UPDATE outbox SET state=?,attempts=attempts+1,next_attempt=?,error=? WHERE event_id=?',('failed' if permanent else 'pending',time.time()+min(60,2**min(attempts+1,6)),note,event_id))
            self.last_error='社交摘要同步尚未完成 · '+note
        return True

    def _run(self):
        while not self.stop.is_set():
            try:work=self.flush_one()
            except Exception:work=False;self.last_error='社交摘要队列暂时不可用'
            if not work:self.stop.wait(2)

    def snapshot(self):
        counts={}
        if self.db:
            with self.lock:counts=dict(self.db.execute('SELECT state,COUNT(*) FROM outbox GROUP BY state'))
        return {'enabled':self.enabled,'pending':counts.get('pending',0),'submitted':counts.get('submitted',0),'failed':counts.get('failed',0),'last_error':self.last_error}

    def close(self):
        self.stop.set()
        if self.thread:self.thread.join(12)
        if self.db:self.db.close();self.db=None
