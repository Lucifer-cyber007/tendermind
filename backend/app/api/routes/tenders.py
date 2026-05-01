from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, status, BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from uuid import UUID
import structlog

from app.session import get_db
from app.auth import get_current_user
from app.models import Tender, TenderDocument, TenderStatus, TenderDecisionLog, ActorType, User
from app.schemas import TenderCreate, TenderOut, TenderSummary
from app.services.storage import storage_service
from app.workers.tasks import parse_tender_document

logger = structlog.get_logger()
router = APIRouter(prefix="/tenders", tags=["tenders"])


@router.post("/", response_model=TenderOut, status_code=status.HTTP_201_CREATED)
async def create_tender(
    data: TenderCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    tender = Tender(
        title=data.title,
        tender_number=data.tender_number,
        department=data.department,
        tender_type=data.tender_type,
        notes=data.notes,
        created_by=current_user.id,
    )
    db.add(tender)
    await db.flush()

    # Log creation
    log = TenderDecisionLog(
        tender_id=tender.id,
        action_type="tender_created",
        actor_type=ActorType.officer,
        actor_user_id=current_user.id,
        summary=f"Tender '{tender.title}' created by {current_user.name}",
        after_state={"title": tender.title, "tender_number": tender.tender_number},
    )
    db.add(log)
    await db.commit()
    return tender


@router.get("/", response_model=list[TenderSummary])
async def list_tenders(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(Tender).where(Tender.created_by == current_user.id).order_by(Tender.created_at.desc())
    )
    tenders = result.scalars().all()
    return tenders


@router.get("/{tender_id}", response_model=TenderOut)
async def get_tender(
    tender_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(Tender).where(Tender.id == tender_id))
    tender = result.scalar_one_or_none()
    if not tender:
        raise HTTPException(status_code=404, detail="Tender not found")
    return tender


@router.delete("/{tender_id}")
async def delete_tender(
    tender_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(Tender).where(Tender.id == tender_id))
    tender = result.scalar_one_or_none()
    if not tender:
        raise HTTPException(status_code=404, detail="Tender not found")

    if tender.created_by != current_user.id:
        raise HTTPException(status_code=403, detail="You can delete only your own tenders")

    await db.delete(tender)
    await db.commit()
    return {"status": "deleted"}


@router.post("/{tender_id}/document", status_code=status.HTTP_202_ACCEPTED)
async def upload_tender_document(
    tender_id: UUID,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Upload the tender document. Triggers async parsing and criteria extraction."""
    result = await db.execute(select(Tender).where(Tender.id == tender_id))
    tender = result.scalar_one_or_none()
    if not tender:
        raise HTTPException(status_code=404, detail="Tender not found")

    allowed_types = {"application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}
    if file.content_type not in allowed_types:
        raise HTTPException(status_code=400, detail="Only PDF and DOCX files are accepted")

    file_bytes = await file.read()
    storage_url = storage_service.upload(file_bytes, file.filename, folder=f"tenders/{tender_id}")

    doc = TenderDocument(
        tender_id=tender_id,
        filename=file.filename,
        storage_url=storage_url,
        file_size_bytes=len(file_bytes),
    )
    db.add(doc)
    await db.flush()

    log = TenderDecisionLog(
        tender_id=tender_id,
        action_type="tender_document_uploaded",
        actor_type=ActorType.officer,
        actor_user_id=current_user.id,
        summary=f"Tender document '{file.filename}' uploaded. Parsing queued.",
        after_state={"document_id": str(doc.id), "filename": file.filename},
    )
    db.add(log)
    await db.commit()

    # Queue parsing job
    parse_tender_document.delay(str(doc.id))

    return {"document_id": str(doc.id), "status": "parsing_queued"}


@router.get("/{tender_id}/document/status")
async def get_document_parse_status(
    tender_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(TenderDocument).where(TenderDocument.tender_id == tender_id).order_by(TenderDocument.uploaded_at.desc())
    )
    doc = result.scalars().first()
    if not doc:
        raise HTTPException(status_code=404, detail="No document uploaded yet")
    return {"status": doc.parse_status, "page_count": doc.page_count, "error": doc.parse_error}


@router.post("/{tender_id}/start-evaluation", status_code=status.HTTP_202_ACCEPTED)
async def start_evaluation(
    tender_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Start the matrix evaluation. Only callable after criteria are confirmed.
    Queues cell evaluation tasks for all criteria × bidders.
    """
    from app.workers.tasks import evaluate_all_cells_for_tender
    from app.models import TenderCriterion
    from datetime import datetime
    import pytz

    result = await db.execute(select(Tender).where(Tender.id == tender_id))
    tender = result.scalar_one_or_none()
    if not tender:
        raise HTTPException(status_code=404, detail="Tender not found")

    if tender.status != TenderStatus.criteria_confirmed:
        raise HTTPException(
            status_code=400,
            detail="All criteria must be confirmed by the officer before evaluation can begin.",
        )

    tender.status = TenderStatus.evaluation_active
    tender.evaluation_started_at = datetime.now(pytz.timezone("Asia/Kolkata"))

    log = TenderDecisionLog(
        tender_id=tender_id,
        action_type="evaluation_started",
        actor_type=ActorType.officer,
        actor_user_id=current_user.id,
        summary="Officer started matrix evaluation.",
    )
    db.add(log)
    await db.commit()

    evaluate_all_cells_for_tender.delay(str(tender_id))
    return {"status": "evaluation_queued"}


@router.post("/{tender_id}/close")
async def close_tender(
    tender_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Close tender and feed confirmed criteria back into the library."""
    from app.models import TenderCriterion
    from app.services.criteria_library import criteria_library
    from datetime import datetime
    import pytz

    result = await db.execute(select(Tender).where(Tender.id == tender_id))
    tender = result.scalar_one_or_none()
    if not tender:
        raise HTTPException(status_code=404, detail="Tender not found")

    # Feed confirmed criteria into library
    crit_result = await db.execute(
        select(TenderCriterion).where(
            TenderCriterion.tender_id == tender_id,
            TenderCriterion.confirmed_by_officer == True,
        )
    )
    for criterion in crit_result.scalars().all():
        await criteria_library.upsert_template(
            db,
            criterion_text=criterion.criterion_text,
            criterion_type=criterion.criterion_type,
            source=criterion.source,
            typical_threshold=criterion.threshold,
            department=tender.department,
        )

    tender.status = TenderStatus.closed
    tender.closed_at = datetime.now(pytz.timezone("Asia/Kolkata"))

    log = TenderDecisionLog(
        tender_id=tender_id,
        action_type="tender_closed",
        actor_type=ActorType.officer,
        actor_user_id=current_user.id,
        summary="Tender closed. Criteria fed into library.",
    )
    db.add(log)
    await db.commit()
    return {"status": "closed"}


@router.get("/{tender_id}/report")
async def generate_report(
    tender_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Generate the audit trail PDF report."""
    from fastapi.responses import Response
    from app.services.report_generator import report_generator
    from app.models import TenderCriterion, Bidder, MatrixCell

    result = await db.execute(select(Tender).where(Tender.id == tender_id))
    tender = result.scalar_one_or_none()
    if not tender:
        raise HTTPException(status_code=404, detail="Tender not found")

    criteria_result = await db.execute(select(TenderCriterion).where(TenderCriterion.tender_id == tender_id))
    bidder_result = await db.execute(select(Bidder).where(Bidder.tender_id == tender_id))
    log_result = await db.execute(select(TenderDecisionLog).where(TenderDecisionLog.tender_id == tender_id).order_by(TenderDecisionLog.timestamp))

    criteria = criteria_result.scalars().all()
    bidders = bidder_result.scalars().all()
    log_entries = log_result.scalars().all()

    from datetime import datetime
    import pytz

    tender_data = {
        "tender": {
            "id": str(tender.id),
            "title": tender.title,
            "tender_number": tender.tender_number,
            "department": tender.department,
            "tender_type": tender.tender_type,
        },
        "officer": {
            "name": current_user.name,
            "designation": current_user.designation,
            "department": current_user.department,
        },
        "criteria": [
            {
                "id": str(c.id),
                "criterion_text": c.criterion_text,
                "criterion_type": c.criterion_type,
                "source": c.source,
                "threshold": c.threshold,
                "is_mandatory": c.is_mandatory,
            }
            for c in criteria
        ],
        "bidders": [
            {"id": str(b.id), "name": b.name, "bid_amount": b.bid_amount, "rank": b.rank}
            for b in bidders
        ],
        "matrix": {},
        "decision_log": [
            {
                "timestamp": e.timestamp,
                "actor_name": None,
                "actor_ai_version": e.actor_ai_version,
                "action_type": e.action_type,
                "summary": e.summary,
            }
            for e in log_entries
        ],
        "generated_at": datetime.now(pytz.timezone("Asia/Kolkata")),
    }

    pdf_bytes = report_generator.generate(tender_data)

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="evaluation_report_{tender.tender_number}.pdf"'
        },
    )