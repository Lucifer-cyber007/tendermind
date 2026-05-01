from datetime import datetime
from uuid import UUID

import pytz
import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user, get_db
from app.models import (
    ActorType,
    Bidder,
    FlagType,
    MatrixCell,
    OfficerVerdict,
    Tender,
    TenderCriterion,
    TenderDecisionLog,
    User,
)

logger = structlog.get_logger()
router = APIRouter(prefix="/evaluation", tags=["evaluation"])
IST = pytz.timezone("Asia/Kolkata")
AMBER_CONFIDENCE_THRESHOLD = 0.75


class OfficerDecisionRequest(BaseModel):
    officer_verdict: OfficerVerdict
    officer_note: str | None = None


def _ai_to_officer_verdict(ai_verdict) -> OfficerVerdict | None:
    if ai_verdict is None:
        return None
    if ai_verdict.value == "pass":
        return OfficerVerdict.qualifying
    if ai_verdict.value == "fail":
        return OfficerVerdict.disqualifying
    return OfficerVerdict.deferred


def _is_amber(cell: MatrixCell) -> bool:
    has_flag = cell.flag_type is not None and cell.flag_type != FlagType.none
    low_confidence = cell.confidence_score is not None and cell.confidence_score < AMBER_CONFIDENCE_THRESHOLD
    return has_flag or low_confidence


def _cell_payload(cell: MatrixCell, criterion: TenderCriterion) -> dict:
    return {
        "cell_id": str(cell.id),
        "criterion_id": str(criterion.id),
        "criterion_text": criterion.criterion_text,
        "ai_verdict": cell.ai_verdict,
        "confidence_score": cell.confidence_score,
        "flag_type": cell.flag_type,
        "flag_detail": cell.flag_detail,
        "extracted_claim": cell.extracted_claim,
        "source_page": cell.source_page,
        "source_text_snippet": cell.source_text_snippet,
        "officer_verdict": cell.officer_verdict,
        "officer_note": cell.officer_note,
    }


@router.get("/{tender_id}/matrix")
async def get_compliance_matrix(
    tender_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    tender_result = await db.execute(select(Tender).where(Tender.id == tender_id))
    tender = tender_result.scalar_one_or_none()
    if not tender:
        raise HTTPException(status_code=404, detail="Tender not found")

    bidders_result = await db.execute(
        select(Bidder).where(Bidder.tender_id == tender_id).order_by(Bidder.rank.asc().nullslast(), Bidder.name.asc())
    )
    bidders = bidders_result.scalars().all()

    cells_result = await db.execute(
        select(MatrixCell, TenderCriterion)
        .join(TenderCriterion, TenderCriterion.id == MatrixCell.tender_criterion_id)
        .where(TenderCriterion.tender_id == tender_id, MatrixCell.is_superseded == False)
        .order_by(TenderCriterion.display_order.asc())
    )
    cell_rows = cells_result.all()

    grouped: dict[UUID, list[dict]] = {}
    for cell, criterion in cell_rows:
        grouped.setdefault(cell.bidder_id, []).append(_cell_payload(cell, criterion))

    return {
        "tender_id": str(tender_id),
        "bidders": [
            {
                "bidder_id": str(b.id),
                "bidder_name": b.name,
                "rank": b.rank,
                "is_l1": b.is_l1,
                "cells": grouped.get(b.id, []),
            }
            for b in bidders
        ],
    }


@router.get("/{tender_id}/matrix/amber")
async def get_amber_matrix_cells(
    tender_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    tender_result = await db.execute(select(Tender).where(Tender.id == tender_id))
    tender = tender_result.scalar_one_or_none()
    if not tender:
        raise HTTPException(status_code=404, detail="Tender not found")

    cells_result = await db.execute(
        select(MatrixCell, TenderCriterion, Bidder)
        .join(TenderCriterion, TenderCriterion.id == MatrixCell.tender_criterion_id)
        .join(Bidder, Bidder.id == MatrixCell.bidder_id)
        .where(TenderCriterion.tender_id == tender_id, MatrixCell.is_superseded == False)
        .order_by(Bidder.rank.asc().nullslast(), TenderCriterion.display_order.asc())
    )
    rows = cells_result.all()

    amber_cells = []
    for cell, criterion, bidder in rows:
        if _is_amber(cell):
            item = _cell_payload(cell, criterion)
            item.update(
                {
                    "bidder_id": str(bidder.id),
                    "bidder_name": bidder.name,
                    "rank": bidder.rank,
                }
            )
            amber_cells.append(item)

    return {"tender_id": str(tender_id), "amber_cells": amber_cells}


@router.put("/{tender_id}/matrix/{cell_id}/decide")
async def decide_matrix_cell(
    tender_id: UUID,
    cell_id: UUID,
    data: OfficerDecisionRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    cell_result = await db.execute(
        select(MatrixCell, TenderCriterion, Bidder)
        .join(TenderCriterion, TenderCriterion.id == MatrixCell.tender_criterion_id)
        .join(Bidder, Bidder.id == MatrixCell.bidder_id)
        .where(MatrixCell.id == cell_id, MatrixCell.is_superseded == False)
    )
    row = cell_result.first()
    if not row:
        raise HTTPException(status_code=404, detail="Matrix cell not found")

    cell, criterion, bidder = row
    if criterion.tender_id != tender_id:
        raise HTTPException(status_code=404, detail="Matrix cell not found for this tender")

    expected_verdict = _ai_to_officer_verdict(cell.ai_verdict)
    is_override = expected_verdict is not None and data.officer_verdict != expected_verdict
    if is_override and not data.officer_note:
        raise HTTPException(
            status_code=400,
            detail="officer_note is mandatory when overriding AI verdict",
        )

    cell.officer_verdict = data.officer_verdict
    cell.officer_note = data.officer_note
    cell.officer_id = current_user.id
    cell.officer_timestamp = datetime.now(IST)

    log = TenderDecisionLog(
        tender_id=tender_id,
        action_type="matrix_cell_decided",
        actor_type=ActorType.officer,
        actor_user_id=current_user.id,
        summary=(
            f"Officer decided '{data.officer_verdict.value}' for criterion "
            f"'{(criterion.criterion_text or '')[:60]}' — "
            f"Bidder: {bidder.name} — "
            f"Note: {(data.officer_note or '')[:100]}"
        ),
        after_state={
            "cell_id": str(cell.id),
            "criterion_id": str(criterion.id),
            "criterion_text": criterion.criterion_text,
            "bidder_id": str(bidder.id),
            "bidder_name": bidder.name,
            "bidder_company": bidder.company,
            "bidder_email": bidder.email,
            "ai_verdict": cell.ai_verdict.value if cell.ai_verdict else None,
            "confidence_score": cell.confidence_score,
            "flag_type": cell.flag_type.value if cell.flag_type else None,
            "flag_detail": cell.flag_detail,
            "officer_verdict": data.officer_verdict.value,
            "override": is_override,
            "officer_note": data.officer_note,
        },
    )
    db.add(log)
    await db.commit()

    logger.info("Officer decision submitted", tender_id=str(tender_id), cell_id=str(cell_id), override=is_override)
    return {"status": "decision_recorded", "cell_id": str(cell.id)}


@router.get("/{tender_id}/summary")
async def get_evaluation_summary(
    tender_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    tender_result = await db.execute(select(Tender).where(Tender.id == tender_id))
    tender = tender_result.scalar_one_or_none()
    if not tender:
        raise HTTPException(status_code=404, detail="Tender not found")

    bidders_result = await db.execute(
        select(Bidder).where(Bidder.tender_id == tender_id).order_by(Bidder.rank.asc().nullslast(), Bidder.name.asc())
    )
    bidders = bidders_result.scalars().all()

    cells_result = await db.execute(
        select(MatrixCell, TenderCriterion)
        .join(TenderCriterion, TenderCriterion.id == MatrixCell.tender_criterion_id)
        .where(TenderCriterion.tender_id == tender_id, MatrixCell.is_superseded == False)
    )
    rows = cells_result.all()

    by_bidder: dict[UUID, list[MatrixCell]] = {}
    for cell, _criterion in rows:
        by_bidder.setdefault(cell.bidder_id, []).append(cell)

    summary = []
    for bidder in bidders:
        cells = by_bidder.get(bidder.id, [])
        green = 0
        amber = 0
        red = 0

        for cell in cells:
            final_verdict = cell.officer_verdict
            if final_verdict == OfficerVerdict.disqualifying:
                red += 1
                continue
            if final_verdict == OfficerVerdict.qualifying:
                green += 1
                continue
            if final_verdict == OfficerVerdict.deferred:
                amber += 1
                continue

            if cell.ai_verdict is not None and cell.ai_verdict.value == "fail":
                red += 1
            elif _is_amber(cell) or (cell.ai_verdict is not None and cell.ai_verdict.value in {"ambiguous", "missing"}):
                amber += 1
            elif cell.ai_verdict is not None and cell.ai_verdict.value == "pass":
                green += 1
            else:
                amber += 1

        if red > 0:
            overall_status = "disqualified"
        elif amber > 0:
            overall_status = "needs_review"
        elif green > 0:
            overall_status = "qualified"
        else:
            overall_status = "pending"

        summary.append(
            {
                "bidder_id": str(bidder.id),
                "bidder_name": bidder.name,
                "rank": bidder.rank,
                "is_l1": bidder.is_l1,
                "green": green,
                "amber": amber,
                "red": red,
                "overall_status": overall_status,
            }
        )

    return {"tender_id": str(tender_id), "summary": summary}
