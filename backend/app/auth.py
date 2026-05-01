from datetime import datetime, timedelta
from typing import Optional
import hashlib
from jose import JWTError, jwt
from passlib.context import CryptContext
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.session import get_db

ALGORITHM = "HS256"
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
bearer_scheme = HTTPBearer()


def _normalize_password(password: str) -> str:
    """
    Bcrypt accepts max 72 bytes. For longer secrets, hash first to preserve
    deterministic verification without runtime failures.
    """
    password_bytes = password.encode("utf-8")
    if len(password_bytes) <= 72:
        return password
    return hashlib.sha256(password_bytes).hexdigest()


def hash_password(password: str) -> str:
    return pwd_context.hash(_normalize_password(password))


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(_normalize_password(plain), hashed)


def create_access_token(user_id: str, expires_minutes: Optional[int] = None) -> str:
    expire = datetime.utcnow() + timedelta(
        minutes=expires_minutes or settings.ACCESS_TOKEN_EXPIRE_MINUTES
    )
    return jwt.encode(
        {"sub": user_id, "exp": expire},
        settings.SECRET_KEY,
        algorithm=ALGORITHM,
    )


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
    db: AsyncSession = Depends(get_db),
):
    from sqlalchemy import select
    from app.models import User

    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(credentials.credentials, settings.SECRET_KEY, algorithms=[ALGORITHM])
        user_id: str = payload.get("sub")
        if user_id is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception

    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None or not user.is_active:
        raise credentials_exception
    return user