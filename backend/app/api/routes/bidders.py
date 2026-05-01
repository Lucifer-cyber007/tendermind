from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, status, BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from uuid import UUID
import structlog

from app.auth import get_db, get_current_user
from app.models import ActorType, Bidder, BidderDocument, ParseStatus, Tender, TenderDecisionLog, TenderStatus, User
from app.schemas import BidderCreate, BidderOut
from app.services.storage import storage_service
from app.workers.tasks import parse_bidder_document

logger = structlog.get_logger()
router = APIRouter(prefix="/bidders", tags=["bidders"])


async def _recalculate_bidder_rankings(db: AsyncSession, tender_id: UUID) -> None:
    result = await db.execute(
        select(Bidder).where(Bidder.tender_id == tender_id).order_by(Bidder.bid_amount.asc())
    )
    bidders = result.scalars().all()

    # Reset all ranks first so bidders without bid amount are not incorrectly marked as L1.
    for bidder in bidders:
        bidder.rank = None
        bidder.is_l1 = False

    ranked_bidders = [b for b in bidders if b.bid_amount is not None]
    for i, bidder in enumerate(ranked_bidders):
        bidder.rank = i + 1
        bidder.is_l1 = i == 0


@router.post("/{tender_id}/bidders", response_model=BidderOut, status_code=status.HTTP_201_CREATED)
async def create_bidder(
    tender_id: UUID,
    data: BidderCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    tender_result = await db.execute(select(Tender).where(Tender.id == tender_id))
    tender = tender_result.scalar_one_or_none()
    if not tender:
        raise HTTPException(status_code=404, detail="Tender not found")

    bidder = Bidder(
        tender_id=tender_id,
        name=data.name,
        company=data.company,
        email=data.email,
        bid_amount=data.bid_amount,
    )
    db.add(bidder)
    await db.flush()

    await _recalculate_bidder_rankings(db, tender_id)
    await db.commit()
    await db.refresh(bidder)

    logger.info("Bidder created", tender_id=str(tender_id), bidder_id=str(bidder.id), name=bidder.name)
    return bidder


@router.get("/{tender_id}/bidders", response_model=list[BidderOut])
async def list_bidders(
    tender_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    tender_result = await db.execute(select(Tender).where(Tender.id == tender_id))
    tender = tender_result.scalar_one_or_none()
    if not tender:
        raise HTTPException(status_code=404, detail="Tender not found")

    result = await db.execute(
        select(Bidder)
        .where(Bidder.tender_id == tender_id)
        .order_by(func.coalesce(Bidder.rank, 10**9), Bidder.created_at.asc())
    )
    return result.scalars().all()


@router.post("/{tender_id}/bidders/{bidder_id}/document", status_code=status.HTTP_202_ACCEPTED)
async def upload_bidder_document(
    tender_id: UUID,
    bidder_id: UUID,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    bidder_result = await db.execute(
        select(Bidder).where(Bidder.id == bidder_id, Bidder.tender_id == tender_id)
    )
    bidder = bidder_result.scalar_one_or_none()
    if not bidder:
        raise HTTPException(status_code=404, detail="Bidder not found for this tender")

    allowed_types = {"application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}
    if file.content_type not in allowed_types:
        raise HTTPException(status_code=400, detail="Only PDF and DOCX files are accepted")

    file_bytes = await file.read()
    storage_url = storage_service.upload(file_bytes, file.filename, folder=f"bidders/{bidder_id}")

    doc = BidderDocument(
        bidder_id=bidder_id,
        filename=file.filename,
        storage_url=storage_url,
        file_size_bytes=len(file_bytes),
        parse_status=ParseStatus.pending,
    )
    db.add(doc)
    await db.flush()
    company = bidder.company or "Unknown company"
    log = TenderDecisionLog(
        tender_id=tender_id,
        action_type="bidder_document_uploaded",
        actor_type=ActorType.officer,
        actor_user_id=current_user.id,
        summary=f"Bidder document uploaded for '{bidder.name}' ({company}). Parsing queued.",
        after_state={
            "bidder_id": str(bidder.id),
            "bidder_name": bidder.name,
            "bidder_company": bidder.company,
            "document_id": str(doc.id),
            "filename": file.filename,
        },
    )
    db.add(log)
    await db.commit()

    parse_bidder_document.delay(str(doc.id))
    logger.info("Bidder document uploaded", tender_id=str(tender_id), bidder_id=str(bidder_id), document_id=str(doc.id))

    return {"document_id": str(doc.id), "status": "parsing_queued"}


@router.get("/{tender_id}/bidders/{bidder_id}/document/status")
async def get_bidder_document_status(
    tender_id: UUID,
    bidder_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    bidder_result = await db.execute(
        select(Bidder).where(Bidder.id == bidder_id, Bidder.tender_id == tender_id)
    )
    bidder = bidder_result.scalar_one_or_none()
    if not bidder:
        raise HTTPException(status_code=404, detail="Bidder not found for this tender")

    doc_result = await db.execute(
        select(BidderDocument)
        .where(BidderDocument.bidder_id == bidder_id)
        .order_by(BidderDocument.uploaded_at.desc())
    )
    doc = doc_result.scalars().first()
    if not doc:
        raise HTTPException(status_code=404, detail="No bidder document uploaded yet")

    return {"status": doc.parse_status, "page_count": doc.page_count, "error": doc.parse_error}


@router.delete("/{tender_id}/bidders/{bidder_id}")
async def delete_bidder(
    tender_id: UUID,
    bidder_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    tender_result = await db.execute(select(Tender).where(Tender.id == tender_id))
    tender = tender_result.scalar_one_or_none()
    if not tender:
        raise HTTPException(status_code=404, detail="Tender not found")

    if tender.status in {TenderStatus.evaluation_active, TenderStatus.awaiting_approval, TenderStatus.closed}:
        raise HTTPException(status_code=400, detail="Cannot remove bidder after evaluation has started")

    bidder_result = await db.execute(
        select(Bidder).where(Bidder.id == bidder_id, Bidder.tender_id == tender_id)
    )
    bidder = bidder_result.scalar_one_or_none()
    if not bidder:
        raise HTTPException(status_code=404, detail="Bidder not found for this tender")

    await db.delete(bidder)
    await db.flush()
    await _recalculate_bidder_rankings(db, tender_id)
    await db.commit()

    logger.info("Bidder deleted", tender_id=str(tender_id), bidder_id=str(bidder_id))
    return {"status": "deleted"}
