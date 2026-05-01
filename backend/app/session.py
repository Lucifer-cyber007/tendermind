from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.config import settings

# Async engine for FastAPI
async_engine = create_async_engine(
    settings.DATABASE_URL,
    echo=settings.APP_ENV == "development",
    pool_size=10,
    max_overflow=20,
)

AsyncSessionLocal = sessionmaker(
    bind=async_engine,
    class_=AsyncSession,
    expire_on_commit=False,
)

# Sync engine for Celery workers
sync_engine = create_engine(
    settings.DATABASE_URL_SYNC,
    echo=False,
    pool_size=5,
    max_overflow=10,
)


async def get_db() -> AsyncSession:
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


__all__ = [
    "create_async_engine",
    "AsyncSession",
    "sessionmaker",
    "AsyncSessionLocal",
    "get_db",
]