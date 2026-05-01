"""
Celery workers for async document processing.
"""
from celery import Celery
from app.config import settings

celery_app = Celery(
    "tendermind",
    broker=settings.REDIS_URL,
    backend=settings.REDIS_URL,
    include=["app.workers.tasks"],
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="Asia/Kolkata",
    enable_utc=True,
    task_track_started=True,
    task_acks_late=True,
    worker_prefetch_multiplier=1,  # One task at a time per worker (heavy LLM calls)
    task_routes={
        "app.workers.tasks.parse_tender_document": {"queue": "parsing"},
        "app.workers.tasks.parse_bidder_document": {"queue": "parsing"},
        "app.workers.tasks.evaluate_matrix_cell": {"queue": "evaluation"},
        "app.workers.tasks.evaluate_all_cells_for_tender": {"queue": "evaluation"},
    },
)