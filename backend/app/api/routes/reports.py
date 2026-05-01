from datetime import datetime
from uuid import UUID

import pytz
import structlog
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user, get_db
from app.models import Bidder, MatrixCell, Tender, TenderCriterion, TenderDecisionLog, User
from app.services.report_generator import report_generator

logger = structlog.get_logger()
router = APIRouter(prefix="/reports", tags=["reports"])


@router.get("/{tender_id}/report")
async def generate_report(
    tender_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    tender_result = await db.execute(select(Tender).where(Tender.id == tender_id))
    tender = tender_result.scalar_one_or_none()
    if not tender:
        raise HTTPException(status_code=404, detail="Tender not found")

    criteria_result = await db.execute(
        select(TenderCriterion)
        .where(TenderCriterion.tender_id == tender_id)
        .order_by(TenderCriterion.display_order.asc())
    )
    bidders_result = await db.execute(
        select(Bidder)
        .where(Bidder.tender_id == tender_id)
        .order_by(Bidder.rank.asc().nullslast(), Bidder.name.asc())
    )
    matrix_result = await db.execute(
        select(MatrixCell)
        .join(TenderCriterion, TenderCriterion.id == MatrixCell.tender_criterion_id)
        .where(TenderCriterion.tender_id == tender_id, MatrixCell.is_superseded == False)
    )
    log_result = await db.execute(
        select(TenderDecisionLog)
        .where(TenderDecisionLog.tender_id == tender_id)
        .order_by(TenderDecisionLog.timestamp.asc())
    )

    criteria = criteria_result.scalars().all()
    bidders = bidders_result.scalars().all()
    matrix_cells = matrix_result.scalars().all()
    log_entries = log_result.scalars().all()
    matrix_lookup = {
        f"{str(cell.tender_criterion_id)}_{str(cell.bidder_id)}": {
            "ai_verdict": cell.ai_verdict.value if cell.ai_verdict else None,
            "officer_verdict": cell.officer_verdict.value if cell.officer_verdict else None,
            "confidence_score": cell.confidence_score,
            "flag_type": cell.flag_type.value if cell.flag_type else None,
            "flag_detail": cell.flag_detail,
        }
        for cell in matrix_cells
    }

    tender_data = {
        "tender": {
            "id": str(tender.id),
            "title": tender.title,
            "tender_number": tender.tender_number,
            "department": tender.department,
            "tender_type": tender.tender_type,
            "status": tender.status,
            "created_at": tender.created_at,
        },
        "officer": {
            "name": current_user.name,
            "designation": current_user.designation,
            "department": current_user.department,
            "email": current_user.email,
        },
        "criteria": [
            {
                "id": str(c.id),
                "criterion_text": c.criterion_text,
                "criterion_type": c.criterion_type,
                "source": c.source,
                "threshold": c.threshold,
                "is_mandatory": c.is_mandatory,
                "display_order": c.display_order,
                "confirmed_by_officer": c.confirmed_by_officer,
            }
            for c in criteria
        ],
        "bidders": [
            {
                "id": str(b.id),
                "name": b.name,
                "company": b.company,
                "email": b.email,
                "bid_amount": b.bid_amount,
                "rank": b.rank,
                "is_l1": b.is_l1,
            }
            for b in bidders
        ],
        "matrix": matrix_lookup,
        "decision_log": [
            {
                "id": str(e.id),
                "timestamp": e.timestamp,
                "actor_type": e.actor_type,
                "actor_ai_version": e.actor_ai_version,
                "action_type": e.action_type,
                "summary": e.summary,
                "before_state": e.before_state,
                "after_state": e.after_state,
            }
            for e in log_entries
        ],
        "generated_at": datetime.now(pytz.timezone("Asia/Kolkata")),
    }

    pdf_bytes = report_generator.generate(tender_data)
    logger.info("Tender report generated", tender_id=str(tender_id), by_user=str(current_user.id))

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="evaluation_report_{tender.tender_number}.pdf"'
        },
    )


@router.get("/{tender_id}/decision-log")
async def get_decision_log(
    tender_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    tender_result = await db.execute(select(Tender).where(Tender.id == tender_id))
    tender = tender_result.scalar_one_or_none()
    if not tender:
        raise HTTPException(status_code=404, detail="Tender not found")

    result = await db.execute(
        select(TenderDecisionLog)
        .where(TenderDecisionLog.tender_id == tender_id)
        .order_by(TenderDecisionLog.timestamp.asc())
    )
    entries = result.scalars().all()
    criteria_result = await db.execute(select(TenderCriterion).where(TenderCriterion.tender_id == tender_id))
    bidders_result = await db.execute(select(Bidder).where(Bidder.tender_id == tender_id))
    criteria_map = {str(c.id): c.criterion_text for c in criteria_result.scalars().all()}
    bidders_map = {
        str(b.id): {
            "name": b.name,
            "company": b.company,
            "email": b.email,
        }
        for b in bidders_result.scalars().all()
    }

    return {
        "tender_id": str(tender_id),
        "decision_log": [
            {
                "timestamp": entry.timestamp,
                "actor_type": entry.actor_type,
                "actor_ai_version": entry.actor_ai_version,
                "action_type": entry.action_type,
                "summary": entry.summary,
                "before_state": entry.before_state,
                "after_state": {
                    **(entry.after_state or {}),
                    "criterion_text": (entry.after_state or {}).get("criterion_text")
                    or criteria_map.get(str((entry.after_state or {}).get("criterion_id")), "—"),
                    "bidder_name": (entry.after_state or {}).get("bidder_name")
                    or bidders_map.get(str((entry.after_state or {}).get("bidder_id")), {}).get("name", "—"),
                    "bidder_company": (entry.after_state or {}).get("bidder_company")
                    or bidders_map.get(str((entry.after_state or {}).get("bidder_id")), {}).get("company"),
                    "bidder_email": (entry.after_state or {}).get("bidder_email")
                    or bidders_map.get(str((entry.after_state or {}).get("bidder_id")), {}).get("email"),
                },
            }
            for entry in entries
        ],
    }
