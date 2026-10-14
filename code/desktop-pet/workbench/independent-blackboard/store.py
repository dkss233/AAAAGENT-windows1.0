"""Project-scoped collaboration records; independent conversations keep their own history.

SQLite serializes authenticated role operations, expected-version checks and deduplication.
This is an application boundary, not a filesystem sandbox for same-user processes.
"""
import argparse
import datetime
import hashlib
import hmac
import json
import os
from pathlib import Path
import sqlite3
import sys


class BoardError(Exception):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def utcnow():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def text(value, limit=4000):
    if not isinstance(value, str) or not value.strip() or len(value) > limit or "\x00" in value:
        raise BoardError("invalid_text")
    return value


def initialize(path, registry):
    path = Path(path)
    if path.exists() or path.is_symlink():
        raise BoardError("board_already_exists")
    text(registry["boardId"], 200)
    scope = registry["scope"]
    for key in ("environmentId", "projectId"):
        text(scope[key], 250)
    actors = registry["participants"]
    if len(actors) < 2 or len(actors) > 16:
        raise BoardError("invalid_participants")
    if len({a["actorId"] for a in actors}) != len(actors) or len({a["threadId"] for a in actors}) != len(actors):
        raise BoardError("duplicate_identity")
    if sum(a["role"] == "coordinator" for a in actors) != 1:
        raise BoardError("one_coordinator_required")
    for actor in actors:
        for key in ("actorId", "threadId", "providerInstanceId", "title"):
            text(actor[key], 250)
        if actor["role"] not in ("coordinator", "executor"):
            raise BoardError("invalid_role")
        if len(actor["capabilitySha256"]) != 64:
            raise BoardError("invalid_capability")
    state = {"apiVersion": "0.1.0", "source": "aaaagent-independent-blackboard",
             "boardId": registry["boardId"], "scope": scope, "revision": 0,
             "updatedAt": utcnow(), "participants": actors, "tasks": [], "events": [], "summary": None}
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    with sqlite3.connect(str(path)) as db:
        db.execute("CREATE TABLE state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)")
        db.execute("CREATE TABLE operations (id TEXT PRIMARY KEY, request_sha TEXT NOT NULL, response TEXT NOT NULL)")
        db.execute("INSERT INTO state VALUES (1, ?)", (canonical(state),))
    return project(state)


def project(state):
    result = {k: v for k, v in state.items() if k not in ("participants", "summaryHistory")}
    result["participants"] = [{k: v for k, v in a.items() if k != "capabilitySha256"}
                              for a in state["participants"]]
    coordinator = next(a for a in state["participants"] if a["role"] == "coordinator")
    by_actor = {a["actorId"]: a for a in state["participants"]}
    relations = []
    for event in state["events"]:
        if event["kind"] == "assign":
            for tid in event["taskIds"]:
                task = next(t for t in state["tasks"] if t["taskId"] == tid)
                relations.append({"relationId": event["eventId"] + ":" + tid,
                                  "kind": "assignment", "sourceThreadId": coordinator["threadId"],
                                  "targetThreadId": by_actor[task["ownerActorId"]]["threadId"],
                                  "taskId": tid, "eventId": event["eventId"], "recordRevision": event["revision"]})
        elif event["kind"] == "report":
            relations.append({"relationId": event["eventId"], "kind": "report",
                              "sourceThreadId": by_actor[event["actorId"]]["threadId"],
                              "targetThreadId": coordinator["threadId"], "taskId": event["taskIds"][0],
                              "eventId": event["eventId"], "recordRevision": event["revision"]})
    result["relations"] = relations
    result["status"] = "summarized" if state["summary"] else "in_progress"
    return result


def connect(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise BoardError("board_unavailable")
    # mode=rw cannot silently create a missing board during a resume/read.
    db = sqlite3.connect(path.resolve().as_uri() + "?mode=rw", uri=True, timeout=10)
    return db


def snapshot(path, scope=None):
    with connect(path) as db:
        state = json.loads(db.execute("SELECT value FROM state WHERE id=1").fetchone()[0])
    if scope is not None and scope != state["scope"]:
        raise BoardError("scope_mismatch")
    return project(state)


def apply(path, request, capability):
    if len(canonical(request).encode()) > 65536:
        raise BoardError("request_too_large")
    operation = text(request.get("operationId"), 200)
    digest = hashlib.sha256(canonical(request).encode()).hexdigest()
    with connect(path) as db:
        db.execute("BEGIN IMMEDIATE")
        state = json.loads(db.execute("SELECT value FROM state WHERE id=1").fetchone()[0])
        if request.get("scope") != state["scope"]:
            raise BoardError("scope_mismatch")
        actor = next((a for a in state["participants"] if a["actorId"] == request.get("actorId")), None)
        if actor is None or not hmac.compare_digest(actor["capabilitySha256"], hashlib.sha256(capability.encode()).hexdigest()):
            raise BoardError("actor_not_authorized")
        prior = db.execute("SELECT request_sha, response FROM operations WHERE id=?", (operation,)).fetchone()
        if prior:
            if prior[0] != digest:
                raise BoardError("operation_payload_changed")
            return json.loads(prior[1])
        expected = request.get("expectedRevision")
        if type(expected) is not int or expected != state["revision"]:
            raise BoardError("revision_conflict")
        if len(state["events"]) >= 1000:
            raise BoardError("board_event_limit")
        kind = request.get("kind")
        if state["summary"] is not None and kind not in ("read", "assign"):
            raise BoardError("board_closed")
        body = request.get("body", {})
        task_ids = []
        if kind == "read":
            pass
        elif kind == "assign":
            if actor["role"] != "coordinator":
                raise BoardError("assignment_not_allowed")
            if state["tasks"]:
                summary = state["summary"]
                if summary is None or any(t["status"] != "reported" for t in state["tasks"]):
                    raise BoardError("previous_batch_not_summarized")
                if not any(e["kind"] == "read" and e["actorId"] == actor["actorId"]
                           and e["revision"] > summary["revision"] for e in state["events"]):
                    raise BoardError("previous_summary_not_read")
            tasks = body.get("tasks", [])
            existing_ids = {t["taskId"] for t in state["tasks"]}
            if (not tasks or len(tasks) > 15 or len(state["tasks"]) + len(tasks) > 100
                    or len({t["taskId"] for t in tasks}) != len(tasks)
                    or any(t["taskId"] in existing_ids for t in tasks)):
                raise BoardError("invalid_tasks")
            if state["summary"] is not None:
                # Keep full prior summaries privately; public DTO and source events stay unchanged.
                state.setdefault("summaryHistory", []).append(state["summary"])
                state["summary"] = None
            for t in tasks:
                owner = next((a for a in state["participants"] if a["actorId"] == t["ownerActorId"]), None)
                if owner is None or owner["role"] != "executor":
                    raise BoardError("invalid_task_owner")
                tid = text(t["taskId"], 200)
                state["tasks"].append({"taskId": tid, "ownerActorId": owner["actorId"],
                                       "title": text(t["title"], 250), "instructions": text(t["instructions"]),
                                       "status": "assigned", "assignedRevision": state["revision"] + 1,
                                       "report": None})
                task_ids.append(tid)
        elif kind in ("start", "report"):
            t = next((t for t in state["tasks"] if t["taskId"] == body.get("taskId")), None)
            if t is None or t["ownerActorId"] != actor["actorId"] or actor["role"] != "executor":
                raise BoardError("task_not_owned")
            read_events = [e for e in state["events"] if e["kind"] == "read" and e["actorId"] == actor["actorId"]]
            if not read_events or read_events[-1]["revision"] < t["assignedRevision"]:
                raise BoardError("assignment_not_read")
            task_ids = [t["taskId"]]
            if kind == "start":
                if t["status"] != "assigned":
                    raise BoardError("invalid_task_transition")
                t["status"] = "running"
            else:
                if t["status"] != "running":
                    raise BoardError("invalid_task_transition")
                t["status"] = "reported"
                t["report"] = {"text": text(body.get("text")), "revision": state["revision"] + 1,
                               "eventId": "event:" + operation, "actorId": actor["actorId"],
                               "assignmentReadEventId": read_events[-1]["eventId"]}
        elif kind == "summary":
            if actor["role"] != "coordinator" or not state["tasks"] or any(t["status"] != "reported" for t in state["tasks"]):
                raise BoardError("summary_not_ready")
            references = body.get("reportEventIds")
            actual = [t["report"]["eventId"] for t in state["tasks"]]
            if not isinstance(references, list) or sorted(references) != sorted(actual):
                raise BoardError("summary_sources_mismatch")
            latest_report = max(t["report"]["revision"] for t in state["tasks"])
            if not any(e["kind"] == "read" and e["actorId"] == actor["actorId"] and e["revision"] > latest_report for e in state["events"]):
                raise BoardError("reports_not_read")
            state["summary"] = {"text": text(body.get("text")), "reportEventIds": references,
                                "actorId": actor["actorId"], "revision": state["revision"] + 1,
                                "eventId": "event:" + operation}
            task_ids = [t["taskId"] for t in state["tasks"]]
        else:
            raise BoardError("invalid_operation")
        state["revision"] += 1
        state["updatedAt"] = utcnow()
        state["events"].append({"eventId": "event:" + operation, "operationId": operation,
                                "revision": state["revision"], "actorId": actor["actorId"],
                                "threadId": actor["threadId"], "kind": kind, "taskIds": task_ids,
                                "observedAt": state["updatedAt"]})
        response = {"ok": True, "operationId": operation, "snapshot": project(state)}
        db.execute("UPDATE state SET value=? WHERE id=1", (canonical(state),))
        db.execute("INSERT INTO operations VALUES (?, ?, ?)", (operation, digest, canonical(response)))
        return response


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", required=True)
    parser.add_argument("--capability-file")
    parser.add_argument("--request-file")
    parser.add_argument("--snapshot", action="store_true")
    args = parser.parse_args()
    try:
        if args.snapshot:
            result = snapshot(args.database)
        else:
            if not args.capability_file:
                raise BoardError("capability_required")
            cap = Path(args.capability_file)
            if cap.is_symlink() or not cap.is_file() or cap.stat().st_mode & 0o077:
                raise BoardError("unsafe_capability_file")
            raw = Path(args.request_file).read_text() if args.request_file else sys.stdin.read(65537)
            result = apply(args.database, json.loads(raw), cap.read_text().strip())
        print(canonical(result))
    except (BoardError, KeyError, ValueError, sqlite3.Error) as exc:
        code = str(exc) if isinstance(exc, BoardError) else "invalid_board_request"
        print(canonical({"ok": False, "error": code}))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
