from contextlib import asynccontextmanager
import importlib
import logging
import pkgutil
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings

logger = logging.getLogger(__name__)


def _register_all_routers(app: FastAPI) -> None:
    """Auto-load and register all APIRouter instances from app.api.routes.* modules."""
    import app.api.routes as routes_pkg

    for module_info in pkgutil.iter_modules(routes_pkg.__path__):
        if module_info.name.startswith("_"):
            continue

        module = importlib.import_module(f"app.api.routes.{module_info.name}")
        router = getattr(module, "router", None)
        if router is not None:
            app.include_router(router, prefix="/api/v1")


def _build_minio_client():
    from minio import Minio

    endpoint = settings.S3_ENDPOINT.replace("http://", "").replace("https://", "")
    return Minio(
        endpoint,
        access_key=settings.S3_ACCESS_KEY,
        secret_key=settings.S3_SECRET_KEY,
        secure=settings.S3_ENDPOINT.startswith("https://"),
    )


@asynccontextmanager
async def lifespan(_: FastAPI):
    try:
        client = _build_minio_client()
        if not client.bucket_exists(settings.S3_BUCKET):
            client.make_bucket(settings.S3_BUCKET, location=settings.S3_REGION)
            logger.info("Created MinIO bucket '%s'", settings.S3_BUCKET)
        logger.info("TenderMind API is ready")
    except Exception as exc:
        logger.exception("Storage startup check failed: %s", exc)

    yield


app = FastAPI(title="TenderMind API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_register_all_routers(app)


@app.get("/health")
async def health_check() -> dict[str, Any]:
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    db_status = {"ok": False, "details": ""}
    storage_status = {"ok": False, "details": ""}

    temp_engine = create_async_engine(settings.DATABASE_URL, future=True)
    try:
        async with temp_engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        db_status = {"ok": True, "details": "Database reachable"}
    except Exception as exc:
        db_status = {"ok": False, "details": str(exc)}
    finally:
        await temp_engine.dispose()

    try:
        client = _build_minio_client()
        bucket_exists = client.bucket_exists(settings.S3_BUCKET)
        if not bucket_exists:
            storage_status = {
                "ok": False,
                "details": f"Bucket '{settings.S3_BUCKET}' not found",
            }
        else:
            storage_status = {"ok": True, "details": "Bucket reachable"}
    except Exception as exc:
        storage_status = {"ok": False, "details": str(exc)}

    overall_ok = db_status["ok"] and storage_status["ok"]
    return {
        "status": "ok" if overall_ok else "degraded",
        "services": {
            "database": db_status,
            "storage": storage_status,
        },
    }

