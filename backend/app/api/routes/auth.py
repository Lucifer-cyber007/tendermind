from typing import Optional

import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import (
    create_access_token,
    get_current_user,
    get_db,
    hash_password,
    verify_password,
)
from app.models import User
from app.schemas import LoginRequest, Token, UserOut

logger = structlog.get_logger()
router = APIRouter(prefix="/auth", tags=["auth"])


class RegisterRequest(BaseModel):
    name: str
    email: EmailStr
    password: str
    designation: Optional[str] = None
    department: Optional[str] = None


@router.post("/register", response_model=UserOut, status_code=status.HTTP_201_CREATED)
async def register(
    data: RegisterRequest,
    db: AsyncSession = Depends(get_db),
):
    existing_user_result = await db.execute(select(User).where(User.email == data.email))
    existing_user = existing_user_result.scalar_one_or_none()
    if existing_user:
        raise HTTPException(status_code=400, detail="Email is already registered")

    user = User(
        name=data.name,
        email=data.email,
        hashed_password=hash_password(data.password),
        designation=data.designation,
        department=data.department,
        is_active=True,
    )

    db.add(user)
    await db.flush()
    await db.commit()
    await db.refresh(user)
    logger.info("User registered", user_id=str(user.id), email=user.email)
    return user


@router.post("/login", response_model=Token)
async def login(
    data: LoginRequest,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(User).where(User.email == data.email))
    user = result.scalar_one_or_none()
    if user is None or not verify_password(data.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User account is inactive",
        )

    access_token = create_access_token(str(user.id))
    logger.info("User logged in", user_id=str(user.id), email=user.email)
    return {"access_token": access_token, "token_type": "bearer"}


@router.get("/me", response_model=UserOut)
async def me(
    current_user: User = Depends(get_current_user),
):
    return current_user
