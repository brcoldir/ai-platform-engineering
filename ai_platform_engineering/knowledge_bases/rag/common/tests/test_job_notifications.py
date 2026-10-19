"""Notification emission from JobManager.upsert_job (ingestion.* events)."""

import asyncio
import itertools
import json
import urllib.error
from typing import Any, Dict, List, Optional
from unittest.mock import patch

import pytest

from common import notifications_client as nc
from common.constants import REDIS_DATASOURCE_PREFIX
from common.constants import REDIS_JOB_DATASOURCE_TOUCHED_PREFIX
from common.job_manager import JobManager, JobStatus
from common.metadata_storage import MetadataStorage

PUBLISH = "common.job_manager.schedule_publish"


class FakeRedis:
    """Tiny in-memory stand-in for the redis.asyncio calls JobManager uses."""

    def __init__(self) -> None:
        self.hashes: Dict[str, Dict[str, str]] = {}
        self.sets: Dict[str, set] = {}
        self.strings: Dict[str, str] = {}

    async def exists(self, key: str) -> int:
        await asyncio.sleep(0)
        return int(key in self.hashes)

    async def hget(self, key: str, field: str) -> Optional[str]:
        await asyncio.sleep(0)
        return self.hashes.get(key, {}).get(field)

    async def hmget(self, key: str, fields: List[str]) -> List[Optional[str]]:
        await asyncio.sleep(0)
        return [self.hashes.get(key, {}).get(f) for f in fields]

    async def hset(self, key: str, mapping: Dict[str, str]) -> int:
        await asyncio.sleep(0)
        self.hashes.setdefault(key, {}).update(mapping)
        return len(mapping)

    async def hsetnx(self, key: str, field: str, value: str) -> int:
        await asyncio.sleep(0)
        job = self.hashes.setdefault(key, {})
        if field in job:
            return 0
        job[field] = value
        return 1

    async def hdel(self, key: str, *fields: str) -> int:
        await asyncio.sleep(0)
        job = self.hashes.get(key, {})
        return sum(1 for f in fields if job.pop(f, None) is not None)

    async def hincrby(self, key: str, field: str, amount: int = 1) -> int:
        await asyncio.sleep(0)
        job = self.hashes.setdefault(key, {})
        job[field] = str(int(job.get(field, "0")) + amount)
        return int(job[field])

    async def eval(self, script: str, numkeys: int, key: str, *args: str) -> int:
        """Emulates the compare-and-set script used by fail_stale_pending_job."""
        await asyncio.sleep(0)
        expected, new_status, message, completed_at = args
        job = self.hashes.get(key, {})
        if job.get("status") != expected:
            return 0
        job.update({"status": new_status, "message": message, "completed_at": completed_at})
        return 1

    async def sadd(self, key: str, *values: str) -> int:
        self.sets.setdefault(key, set()).update(values)
        return len(values)

    async def srem(self, key: str, *values: str) -> int:
        self.sets.get(key, set()).difference_update(values)
        return 1

    async def smembers(self, key: str) -> set:
        return set(self.sets.get(key, set()))

    async def get(self, key: str) -> Optional[str]:
        return self.strings.get(key)

    async def keys(self, pattern: str) -> List[str]:
        prefix = pattern.rstrip("*")
        found = [k for store in (self.hashes, self.sets, self.strings) for k in store if k.startswith(prefix)]
        return found

    async def delete(self, *keys: str) -> int:
        for key in keys:
            for store in (self.hashes, self.sets, self.strings):
                store.pop(key, None)
        return len(keys)


@pytest.fixture
def redis_fake() -> FakeRedis:
    fake = FakeRedis()
    fake.strings[f"{REDIS_DATASOURCE_PREFIX}ds-1"] = json.dumps(
        {"datasource_id": "ds-1", "name": "Team Wiki", "creator_subject": "sub-creator", "owner_subject": "sub-owner"}
    )
    return fake


@pytest.fixture
def manager(redis_fake: FakeRedis) -> JobManager:
    return JobManager(redis_fake)  # type: ignore[arg-type]


def _events(publish: Any) -> List[Dict[str, Any]]:
    return [call.args[0] for call in publish.call_args_list]


@pytest.mark.asyncio
async def test_completed_emits_once_with_touched_recipients(manager: JobManager, redis_fake: FakeRedis) -> None:
    with patch(PUBLISH) as publish:
        await manager.upsert_job("j1", status=JobStatus.PENDING, datasource_id="ds-1", triggered_by_subject="sub-a", triggered_by_email="a@example.com")
        await manager.upsert_job("j1", status=JobStatus.IN_PROGRESS, message="working on SECRET-DOC", datasource_id="ds-1", triggered_by_subject="sub-b", triggered_by_email="b@example.com")
        redis_fake.hashes["job:j1"]["document_count"] = "3"
        redis_fake.hashes["job:j1"]["chunk_count"] = "9"
        await manager.upsert_job("j1", status=JobStatus.COMPLETED, message="SECRET-DOC done", datasource_id="ds-1")
        # a later non-status upsert and a repeated terminal upsert must not re-emit
        await manager.upsert_job("j1", message="late message", datasource_id="ds-1")
        await manager.upsert_job("j1", status=JobStatus.COMPLETED, datasource_id="ds-1")

    events = _events(publish)
    types = [e["type"] for e in events]
    assert types == ["ingestion.started", "ingestion.completed"]
    done = events[-1]
    assert done["attempt_id"] == "j1"
    assert done["resource"] == {"type": "datasource", "id": "ds-1"}
    assert done["include_org_admins"] is True
    assert done["data"]["status"] == "completed"
    assert "Team Wiki" in done["data"]["title"]
    assert "3 documents" in done["data"]["summary"] and "9 chunks" in done["data"]["summary"]
    assert "SECRET" not in json.dumps(done)
    subjects = {r.get("subject") for r in done["recipients"]}
    assert {"sub-creator", "sub-owner", "sub-a", "sub-b"} <= subjects
    assert {"email": "a@example.com", "subject": "sub-a"} in done["recipients"]
    assert len(done["recipients"]) == 4


@pytest.mark.parametrize(
    "status,event_type,expected_status",
    [
        (JobStatus.COMPLETED, "ingestion.completed", "completed"),
        (JobStatus.COMPLETED_WITH_ERRORS, "ingestion.completed", "completed_with_errors"),
        (JobStatus.FAILED, "ingestion.failed", "failed"),
        (JobStatus.TERMINATED, "ingestion.failed", "terminated"),
    ],
)
@pytest.mark.asyncio
async def test_each_terminal_state_emits(manager: JobManager, status: JobStatus, event_type: str, expected_status: str) -> None:
    with patch(PUBLISH) as publish:
        await manager.upsert_job("j2", status=JobStatus.PENDING, datasource_id="ds-1")
        await manager.upsert_job("j2", status=status, datasource_id="ds-1")
    events = _events(publish)
    assert len(events) == 1
    assert events[0]["type"] == event_type
    assert events[0]["data"]["status"] == expected_status


@pytest.mark.asyncio
async def test_non_terminal_upserts_do_not_emit(manager: JobManager) -> None:
    with patch(PUBLISH) as publish:
        await manager.upsert_job("j3", status=JobStatus.PENDING, datasource_id="ds-1")
        await manager.upsert_job("j3", message="still pending", datasource_id="ds-1")
        await manager.upsert_job("j3", total=10, datasource_id="ds-1")
    assert publish.call_count == 0


@pytest.mark.asyncio
async def test_terminal_state_does_not_emit_twice_on_status_change(manager: JobManager) -> None:
    with patch(PUBLISH) as publish:
        await manager.upsert_job("j4", status=JobStatus.PENDING, datasource_id="ds-1")
        await manager.upsert_job("j4", status=JobStatus.FAILED, datasource_id="ds-1")
        await manager.upsert_job("j4", status=JobStatus.COMPLETED, datasource_id="ds-1")
    assert [e["type"] for e in _events(publish)] == ["ingestion.failed"]


@pytest.mark.asyncio
async def test_scheduled_job_without_user_still_notifies_creator_and_admins(manager: JobManager) -> None:
    with patch(PUBLISH) as publish:
        await manager.upsert_job("j5", status=JobStatus.PENDING, datasource_id="ds-1")
        await manager.upsert_job("j5", status=JobStatus.FAILED, datasource_id="ds-1")
    event = _events(publish)[0]
    assert event["include_org_admins"] is True
    assert {r["subject"] for r in event["recipients"]} == {"sub-creator", "sub-owner"}


@pytest.mark.asyncio
async def test_touched_users_persist_across_jobs(manager: JobManager) -> None:
    with patch(PUBLISH) as publish:
        await manager.upsert_job("ja", status=JobStatus.COMPLETED, datasource_id="ds-1", triggered_by_subject="sub-a", triggered_by_email="a@example.com")
        await manager.upsert_job("jb", status=JobStatus.COMPLETED, datasource_id="ds-1")
    second = _events(publish)[1]
    assert "sub-a" in {r.get("subject") for r in second["recipients"]}


@pytest.mark.asyncio
async def test_creating_job_directly_in_terminal_state_emits(manager: JobManager) -> None:
    with patch(PUBLISH) as publish:
        await manager.upsert_job("jc", status=JobStatus.FAILED, datasource_id="ds-1")
    assert [e["type"] for e in _events(publish)] == ["ingestion.failed"]


@pytest.mark.asyncio
async def test_publish_failure_does_not_change_job_outcome(manager: JobManager, redis_fake: FakeRedis) -> None:
    with patch(PUBLISH, side_effect=RuntimeError("publisher exploded")):
        ok = await manager.upsert_job("jd", status=JobStatus.COMPLETED, datasource_id="ds-1")
    assert ok is True
    assert redis_fake.hashes["job:jd"]["status"] == "completed"


@pytest.mark.parametrize("failure", [urllib.error.URLError("refused"), TimeoutError("slow")])
@pytest.mark.asyncio
async def test_real_client_swallows_network_errors(manager: JobManager, redis_fake: FakeRedis, monkeypatch: pytest.MonkeyPatch, failure: Exception) -> None:
    monkeypatch.setenv("NOTIFICATIONS_INTERNAL_TOKEN", "test-token")
    monkeypatch.setattr(nc.time, "sleep", lambda _s: None)

    def boom(*_args: object) -> int:
        raise failure

    monkeypatch.setattr(nc, "_post", boom)
    assert await manager.upsert_job("je", status=JobStatus.FAILED, datasource_id="ds-1") is True
    for pending in list(nc._background_tasks):
        assert await pending is False
    assert redis_fake.hashes["job:je"]["status"] == "failed"


@pytest.mark.asyncio
async def test_real_client_5xx_swallowed(manager: JobManager, redis_fake: FakeRedis, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("NOTIFICATIONS_INTERNAL_TOKEN", "test-token")
    monkeypatch.setattr(nc.time, "sleep", lambda _s: None)
    monkeypatch.setattr(nc, "_post", lambda *_a: 500)
    assert await manager.upsert_job("jf", status=JobStatus.COMPLETED, datasource_id="ds-1") is True
    for pending in list(nc._background_tasks):
        assert await pending is False


@pytest.mark.asyncio
async def test_kill_switch_and_missing_token_send_nothing(manager: JobManager, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: List[Any] = []
    monkeypatch.setattr(nc, "_post", lambda *a: calls.append(a) or 202)
    monkeypatch.setenv("NOTIFICATIONS_INTERNAL_TOKEN", "test-token")
    monkeypatch.setenv("NOTIFICATION_EVENTS_ENABLED", "false")
    await manager.upsert_job("jg", status=JobStatus.COMPLETED, datasource_id="ds-1")
    monkeypatch.delenv("NOTIFICATION_EVENTS_ENABLED")
    monkeypatch.setenv("NOTIFICATIONS_INTERNAL_TOKEN", "")
    await manager.upsert_job("jh", status=JobStatus.COMPLETED, datasource_id="ds-1")
    assert calls == []


def _types(publish: Any) -> List[str]:
    return [e["type"] for e in _events(publish)]


@pytest.mark.asyncio
async def test_concurrent_contradictory_terminal_writers_emit_one_event(manager: JobManager) -> None:
    with patch(PUBLISH) as publish:
        await manager.upsert_job("jx", status=JobStatus.IN_PROGRESS, datasource_id="ds-1")
        await asyncio.gather(
            manager.upsert_job("jx", status=JobStatus.COMPLETED, datasource_id="ds-1"),
            manager.upsert_job("jx", status=JobStatus.FAILED, datasource_id="ds-1"),
        )
    terminal = [t for t in _types(publish) if t != "ingestion.started"]
    assert len(terminal) == 1


@pytest.mark.asyncio
async def test_retry_cycles_notify_each_outcome_with_distinct_attempt_ids(manager: JobManager) -> None:
    with patch(PUBLISH) as publish:
        await manager.upsert_job("jr", status=JobStatus.PENDING, datasource_id="ds-1")
        await manager.upsert_job("jr", status=JobStatus.IN_PROGRESS, datasource_id="ds-1")
        await manager.upsert_job("jr", status=JobStatus.FAILED, datasource_id="ds-1")
        await manager.upsert_job("jr", status=JobStatus.IN_PROGRESS, datasource_id="ds-1")
        await manager.upsert_job("jr", status=JobStatus.FAILED, datasource_id="ds-1")
        await manager.upsert_job("jr", status=JobStatus.IN_PROGRESS, datasource_id="ds-1")
        await manager.upsert_job("jr", status=JobStatus.COMPLETED, datasource_id="ds-1")
    events = _events(publish)
    terminal = [e for e in events if e["type"] != "ingestion.started"]
    assert [e["type"] for e in terminal] == ["ingestion.failed", "ingestion.failed", "ingestion.completed"]
    assert len({e["attempt_id"] for e in terminal}) == 3
    assert terminal[0]["attempt_id"] == "jr"


@pytest.mark.asyncio
async def test_stale_pending_job_failure_emits_failed_event(manager: JobManager, redis_fake: FakeRedis) -> None:
    with patch(PUBLISH) as publish:
        await manager.upsert_job("js", status=JobStatus.PENDING, datasource_id="ds-1", triggered_by_subject="sub-a")
        assert await manager.fail_stale_pending_job("js") is True
        assert await manager.fail_stale_pending_job("js") is False
    events = _events(publish)
    assert [e["type"] for e in events] == ["ingestion.failed"]
    assert events[0]["resource"] == {"type": "datasource", "id": "ds-1"}
    assert "sub-a" in {r.get("subject") for r in events[0]["recipients"]}


@pytest.mark.asyncio
async def test_non_numeric_counters_do_not_lose_the_event(manager: JobManager, redis_fake: FakeRedis) -> None:
    with patch(PUBLISH) as publish:
        await manager.upsert_job("jn", status=JobStatus.IN_PROGRESS, datasource_id="ds-1")
        redis_fake.hashes["job:jn"]["document_count"] = "1.0"
        redis_fake.hashes["job:jn"]["chunk_count"] = "garbage"
        await manager.upsert_job("jn", status=JobStatus.COMPLETED, datasource_id="ds-1")
    assert _types(publish)[-1] == "ingestion.completed"
    assert "0 documents" in _events(publish)[-1]["data"]["summary"]


@pytest.mark.asyncio
async def test_recipient_merge_is_order_independent(manager: JobManager, redis_fake: FakeRedis) -> None:
    entries = [{"email": "A@example.com"}, {"subject": "S"}, {"subject": "S", "email": "a@example.com"}]
    for order in itertools.permutations(entries):
        redis_fake.sets[f"{REDIS_JOB_DATASOURCE_TOUCHED_PREFIX}dsp"] = set()
        redis_fake.sets[f"{REDIS_JOB_DATASOURCE_TOUCHED_PREFIX}dsp"].update(json.dumps(e, sort_keys=True) for e in order)
        # smembers order is arbitrary: force every permutation
        async def ordered(_key: str, order: Any = order) -> List[str]:
            return [json.dumps(e, sort_keys=True) for e in order]

        redis_fake.smembers = ordered  # type: ignore[method-assign]
        result = await manager._notification_recipients("none", "dsp", {})
        assert len(result) == 1, order
        assert result[0]["subject"] == "S"
        assert result[0]["email"].lower() == "a@example.com"


@pytest.mark.asyncio
async def test_touched_set_is_capped_and_creator_first(manager: JobManager, redis_fake: FakeRedis) -> None:
    key = f"{REDIS_JOB_DATASOURCE_TOUCHED_PREFIX}ds-1"
    for i in range(500):
        redis_fake.sets.setdefault(key, set()).add(json.dumps({"subject": f"u{i:04d}"}))
    first = await manager._notification_recipients("none", "ds-1", {"creator_subject": "sub-creator"})
    second = await manager._notification_recipients("none", "ds-1", {"creator_subject": "sub-creator"})
    assert first == second
    assert first[0] == {"subject": "sub-creator"}
    assert len(first) == 50
    assert [r["subject"] for r in first[1:4]] == ["u0000", "u0001", "u0002"]


@pytest.mark.asyncio
async def test_delete_datasource_removes_touched_set(redis_fake: FakeRedis) -> None:
    key = f"{REDIS_JOB_DATASOURCE_TOUCHED_PREFIX}ds-1"
    redis_fake.sets[key] = {json.dumps({"subject": "sub-a"})}
    await MetadataStorage(redis_fake).delete_datasource_info("ds-1")  # type: ignore[arg-type]
    assert key not in redis_fake.sets
