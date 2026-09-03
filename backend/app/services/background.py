import asyncio
from dataclasses import dataclass, field

@dataclass
class Job:
    id: str
    user_id: int
    kind: str          # test / exam / lecture
    title: str
    status: str = "running"   # running / done / error
    result: dict = field(default_factory=dict)
    error: str = ""

# id -> Job
JOBS: dict = {}
# user_id -> список id завершённых, ещё не просмотренных задач
PENDING: dict = {}


def create_job(user_id: int, kind: str, title: str) -> Job:
    import uuid
    job = Job(id=uuid.uuid4().hex, user_id=user_id, kind=kind, title=title)
    JOBS[job.id] = job
    return job


def run_job(job: Job, coro):
    """Запускает корутину в фоне, пишет статус в job."""
    async def _runner():
        try:
            job.result = await coro
            job.status = "done"
            PENDING.setdefault(job.user_id, []).append(job.id)
        except Exception as e:
            job.status = "error"
            job.error = str(e)[:300]
            PENDING.setdefault(job.user_id, []).append(job.id)

    return asyncio.create_task(_runner())


def claim_notifications(user_id: int) -> list:
    """Забрать уведомления (и пометить просмотренными)."""
    ids = PENDING.pop(user_id, [])
    return [{"id": jid, "kind": JOBS[jid].kind, "title": JOBS[jid].title,
             "status": JOBS[jid].status, "error": JOBS[jid].error}
            for jid in ids if jid in JOBS]