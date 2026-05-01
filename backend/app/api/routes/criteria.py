from datetime import datetime
from typing import Optional
from uuid import UUID

import pytz
import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user, get_db
from app.models import (
    ActorType,
    CriterionSource,
    Tender,
    TenderCriterion,
    TenderDecisionLog,
    TenderStatus,
    User,
)
from app.schemas import CriterionCreate, CriterionOut

logger = structlog.get_logger()
router = APIRouter(prefix="/criteria", tags=["criteria"])
IST = pytz.timezone("Asia/Kolkata")


class CriterionConfirmRequest(BaseModel):
    officer_edit: Optional[str] = None


class CriterionUpdateRequest(BaseModel):
    criterion_text: Optional[str] = None
    threshold: Optional[str] = None
    is_mandatory: Optional[bool] = None


@router.get("/{tender_id}/criteria", response_model=list[CriterionOut])
async def list_criteria(
    tender_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    tender_result = await db.execute(select(Tender).where(Tender.id == tender_id))
    tender = tender_result.scalar_one_or_none()
    if not tender:
        raise HTTPException(status_code=404, detail="Tender not found")

    result = await db.execute(
        select(TenderCriterion)
        .where(TenderCriterion.tender_id == tender_id)
        .order_by(TenderCriterion.display_order.asc())
    )
    return result.scalars().all()


@router.put("/{tender_id}/criteria/{criterion_id}/confirm")
async def confirm_criterion(
    tender_id: UUID,
    criterion_id: UUID,
    data: CriterionConfirmRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    criterion_result = await db.execute(
        select(TenderCriterion).where(
            TenderCriterion.id == criterion_id,
            TenderCriterion.tender_id == tender_id,
        )
    )
    criterion = criterion_result.scalar_one_or_none()
    if not criterion:
        raise HTTPException(status_code=404, detail="Criterion not found for this tender")

    criterion.confirmed_by_officer = True
    criterion.officer_edit = data.officer_edit
    criterion.confirmation_timestamp = datetime.now(IST)
    criterion.confirmed_by = current_user.id

    log = TenderDecisionLog(
        tender_id=tender_id,
        action_type="criterion_confirmed",
        actor_type=ActorType.officer,
        actor_user_id=current_user.id,
        summary="Officer confirmed a criterion.",
        after_state={
            "criterion_id": str(criterion.id),
            "officer_edit": data.officer_edit,
            "confirmed_by": str(current_user.id),
        },
    )
    db.add(log)
    await db.commit()

    return {"status": "confirmed", "criterion_id": str(criterion.id)}


@router.post("/{tender_id}/criteria/confirm-all")
async def confirm_all_criteria(
    tender_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    tender_result = await db.execute(select(Tender).where(Tender.id == tender_id))
    tender = tender_result.scalar_one_or_none()
    if not tender:
        raise HTTPException(status_code=404, detail="Tender not found")

    criteria_result = await db.execute(
        select(TenderCriterion).where(TenderCriterion.tender_id == tender_id)
    )
    criteria = criteria_result.scalars().all()
    if not criteria:
        raise HTTPException(status_code=400, detail="No criteria available to confirm")

    confirmation_time = datetime.now(IST)
    for criterion in criteria:
        criterion.confirmed_by_officer = True
        if criterion.confirmed_by is None:
            criterion.confirmed_by = current_user.id
        if criterion.confirmation_timestamp is None:
            criterion.confirmation_timestamp = confirmation_time

    tender.status = TenderStatus.criteria_confirmed
    tender.criteria_confirmed_at = confirmation_time

    log = TenderDecisionLog(
        tender_id=tender_id,
        action_type="all_criteria_confirmed",
        actor_type=ActorType.officer,
        actor_user_id=current_user.id,
        summary="Officer confirmed all criteria. Tender moved to criteria_confirmed.",
        after_state={"criteria_count": len(criteria), "new_status": TenderStatus.criteria_confirmed.value},
    )
    db.add(log)
    await db.commit()

    return {"status": "criteria_confirmed", "criteria_count": len(criteria)}


@router.post("/{tender_id}/criteria", response_model=CriterionOut, status_code=status.HTTP_201_CREATED)
async def add_manual_criterion(
    tender_id: UUID,
    data: CriterionCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    tender_result = await db.execute(select(Tender).where(Tender.id == tender_id))
    tender = tender_result.scalar_one_or_none()
    if not tender:
        raise HTTPException(status_code=404, detail="Tender not found")

    if tender.status in {TenderStatus.evaluation_active, TenderStatus.awaiting_approval, TenderStatus.closed}:
        raise HTTPException(status_code=400, detail="Cannot add criteria after evaluation has started")

    max_order_result = await db.execute(
        select(TenderCriterion)
        .where(TenderCriterion.tender_id == tender_id)
        .order_by(TenderCriterion.display_order.desc())
    )
    last_criterion = max_order_result.scalar_one_or_none()
    next_order = (last_criterion.display_order + 1) if last_criterion else 0

    criterion = TenderCriterion(
        tender_id=tender_id,
        criterion_text=data.criterion_text,
        criterion_type=data.criterion_type,
        source=CriterionSource.manual,
        threshold=data.threshold,
        is_mandatory=data.is_mandatory,
        display_order=next_order,
    )
    db.add(criterion)
    await db.flush()
    await db.commit()
    await db.refresh(criterion)

    return criterion


@router.put("/{tender_id}/criteria/{criterion_id}", response_model=CriterionOut)
async def edit_criterion(
    tender_id: UUID,
    criterion_id: UUID,
    data: CriterionUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    tender_result = await db.execute(select(Tender).where(Tender.id == tender_id))
    tender = tender_result.scalar_one_or_none()
    if not tender:
        raise HTTPException(status_code=404, detail="Tender not found")

    if tender.status in {TenderStatus.evaluation_active, TenderStatus.awaiting_approval, TenderStatus.closed}:
        raise HTTPException(status_code=400, detail="Cannot edit criteria after evaluation has started")

    criterion_result = await db.execute(
        select(TenderCriterion).where(
            TenderCriterion.id == criterion_id,
            TenderCriterion.tender_id == tender_id,
        )
    )
    criterion = criterion_result.scalar_one_or_none()
    if not criterion:
        raise HTTPException(status_code=404, detail="Criterion not found for this tender")

    if criterion.confirmed_by_officer:
        raise HTTPException(status_code=400, detail="Cannot edit a confirmed criterion")

    if data.criterion_text is not None:
        criterion.criterion_text = data.criterion_text
    if data.threshold is not None:
        criterion.threshold = data.threshold
    if data.is_mandatory is not None:
        criterion.is_mandatory = data.is_mandatory

    await db.commit()
    await db.refresh(criterion)
    return criterion


@router.delete("/{tender_id}/criteria/{criterion_id}")
async def delete_criterion(
    tender_id: UUID,
    criterion_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    tender_result = await db.execute(select(Tender).where(Tender.id == tender_id))
    tender = tender_result.scalar_one_or_none()
    if not tender:
        raise HTTPException(status_code=404, detail="Tender not found")

    if tender.status in {TenderStatus.evaluation_active, TenderStatus.awaiting_approval, TenderStatus.closed}:
        raise HTTPException(status_code=400, detail="Cannot delete criteria after evaluation has started")

    criterion_result = await db.execute(
        select(TenderCriterion).where(
            TenderCriterion.id == criterion_id,
            TenderCriterion.tender_id == tender_id,
        )
    )
    criterion = criterion_result.scalar_one_or_none()
    if not criterion:
        raise HTTPException(status_code=404, detail="Criterion not found for this tender")

    await db.delete(criterion)
    await db.commit()

    logger.info("Criterion deleted", tender_id=str(tender_id), criterion_id=str(criterion_id))
    return {"status": "deleted"}
