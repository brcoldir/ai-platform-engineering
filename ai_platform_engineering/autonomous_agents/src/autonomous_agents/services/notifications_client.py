"""Fire-and-forget publisher for the UI server's internal notification endpoint.

Contract: POST {NOTIFICATIONS_INTERNAL_URL}/api/internal/notifications/events with
``Authorization: Bearer $NOTIFICATIONS_INTERNAL_TOKEN``.

Guarantees:
  - Never raises into the caller; failures are logged as warnings with context.
  - No-op when NOTIFICATION_EVENTS_ENABLED == "false" or the token is unset.
  - Short timeout, and at most one quick retry on 503 or a connection error.
  - Standard library only, so it can be copied into separately packaged
    services without a new dependency. NOTE: this file is copied verbatim
    (re-indented where needed) into rag/common, autonomous_agents and
    dynamic_agents; keep the copies in sync.
"""

import asyncio
import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

DEFAULT_URL = "http://caipe-ui:3000"
EVENTS_PATH = "/api/internal/notifications/events"
TIMEOUT_SECONDS = 3.0
RETRY_DELAY_SECONDS = 0.5
MAX_RECIPIENTS = 50
MAX_TITLE = 200
MAX_SUMMARY = 500
# Publishing uses a small dedicated pool so a hung UI server can never occupy
# workers of the default asyncio executor. Events beyond the pending bound are
# dropped (notifications are optional) rather than queued without limit.
PUBLISH_WORKERS = 2
MAX_PENDING_PUBLISHES = 16

_executor = ThreadPoolExecutor(max_workers=PUBLISH_WORKERS, thread_name_prefix="notif-publish")
_pending = 0
_pending_lock = threading.Lock()

# Strong references so fire-and-forget tasks are not garbage collected mid-flight.
_background_tasks: "set[asyncio.Task[bool]]" = set()


def events_enabled() -> bool:
    """Return True unless the kill switch is set or no internal token is configured."""
    if os.getenv("NOTIFICATION_EVENTS_ENABLED", "").strip().lower() == "false":
        return False
    return bool(os.getenv("NOTIFICATIONS_INTERNAL_TOKEN", "").strip())


def _truncate(value: str, limit: int) -> str:
    return value if len(value) <= limit else value[: limit - 1] + "…"


def build_event(
    *,
    event_type: str,
    resource_type: str,
    resource_id: str,
    attempt_id: str,
    status: str,
    title: str,
    summary: str,
    recipients: List[Dict[str, str]],
    href: Optional[str] = None,
    correlation_id: Optional[str] = None,
    include_org_admins: bool = False,
) -> Dict[str, Any]:
    """Build an envelope matching the internal endpoint contract (version 1)."""
    data: Dict[str, Any] = {"status": status, "title": _truncate(title, MAX_TITLE), "summary": _truncate(summary, MAX_SUMMARY)}
    if href and href.startswith("/"):
        data["href"] = href
    event: Dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "type": event_type,
        "version": 1,
        "occurred_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "resource": {"type": resource_type, "id": resource_id},
        "attempt_id": attempt_id,
        "data": data,
        "recipients": recipients[:MAX_RECIPIENTS],
    }
    if correlation_id:
        event["correlation_id"] = correlation_id
    if include_org_admins:
        event["include_org_admins"] = True
    return event


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse redirects so the POST is never replayed as a GET and the token is never forwarded."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def _post(url: str, token: str, body: bytes) -> int:
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
    )
    try:
        with _opener.open(request, timeout=TIMEOUT_SECONDS) as response:  # noqa: S310 - URL comes from operator config
            return int(response.status)
    except urllib.error.HTTPError as error:
        return int(error.code)


def publish_event_sync(event: Dict[str, Any]) -> bool:
    """POST one event. Returns True if accepted (202). Never raises."""
    if not events_enabled():
        return False
    event_type = event.get("type")
    attempt_id = event.get("attempt_id")
    try:
        base = os.getenv("NOTIFICATIONS_INTERNAL_URL", "").strip() or DEFAULT_URL
        url = base.rstrip("/") + EVENTS_PATH
        token = os.getenv("NOTIFICATIONS_INTERNAL_TOKEN", "").strip()
        body = json.dumps(event).encode("utf-8")
        for attempt in (1, 2):
            try:
                status = _post(url, token, body)
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as error:
                if attempt == 1:
                    time.sleep(RETRY_DELAY_SECONDS)
                    continue
                logger.warning("notification publish failed type=%s attempt_id=%s error=%s", event_type, attempt_id, error)
                return False
            if status == 202:
                return True
            if status == 503 and attempt == 1:
                time.sleep(RETRY_DELAY_SECONDS)
                continue
            logger.warning("notification publish rejected type=%s attempt_id=%s status=%s", event_type, attempt_id, status)
            return False
    except Exception as error:  # noqa: BLE001 - producer must never break the caller
        logger.warning("notification publish error type=%s attempt_id=%s error=%s", event_type, attempt_id, error)
    return False


def _submit(event: Dict[str, Any]) -> "Optional[Future[bool]]":
    """Queue a publish on the dedicated pool, or drop it with a warning when too many are pending."""
    global _pending
    with _pending_lock:
        if _pending >= MAX_PENDING_PUBLISHES:
            full = True
        else:
            full = False
            _pending += 1
    if full:
        logger.warning("notification dropped (publisher busy) type=%s attempt_id=%s", event.get("type"), event.get("attempt_id"))
        return None

    def run() -> bool:
        global _pending
        try:
            return publish_event_sync(event)
        finally:
            with _pending_lock:
                _pending -= 1

    try:
        return _executor.submit(run)
    except RuntimeError as error:  # executor shut down
        with _pending_lock:
            _pending -= 1
        logger.warning("notification schedule error type=%s error=%s", event.get("type"), error)
        return None


async def _await_future(future: "Future[bool]") -> bool:
    try:
        return await asyncio.wrap_future(future)
    except Exception as error:  # noqa: BLE001
        logger.warning("notification publish error error=%s", error)
        return False


async def publish_event(event: Dict[str, Any]) -> bool:
    """Async wrapper; runs the blocking POST on the dedicated pool. Never raises; False if dropped."""
    if not events_enabled():
        return False
    future = _submit(event)
    if future is None:
        return False
    return await _await_future(future)


def schedule_publish(event: Dict[str, Any]) -> "Optional[asyncio.Task[bool]]":
    """Publish in the background without awaiting. Safe to call from sync or async code.

    Inside a running event loop this returns a tracked task; otherwise the
    publish runs on the dedicated pool and None is returned. Returns None and
    logs a warning when the event is dropped because too many are pending.
    Never raises.
    """
    if not events_enabled():
        return None
    future = _submit(event)
    if future is None:
        return None
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return None
    try:
        task = loop.create_task(_await_future(future))
    except Exception as error:  # noqa: BLE001
        logger.warning("notification schedule error type=%s error=%s", event.get("type"), error)
        return None
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return task
