"""Celery tasks for async document parsing and matrix evaluation."""

import asyncio
import io
from datetime import datetime
from uuid import UUID

import pdfplumber
import pytz
import structlog
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.services import llm_service
from app.services.storage import storage_service
from app.workers.celery_app import celery_app

logger = structlog.get_logger()
IST = pytz.timezone("Asia/Kolkata")

sync_engine = create_engine(settings.DATABASE_URL_SYNC, future=True)
SessionLocal = sessionmaker(bind=sync_engine, autoflush=False, autocommit=False, future=True)


def _extract_pdf_text(file_bytes: bytes) -> str:
    all_pages: list[str] = []
    with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
        for page in pdf.pages:
            all_pages.append(page.extract_text() or "")
    return "\n".join(all_pages).strip()


def _to_uuid(value):
    if value is None:
        return None
    if isinstance(value, UUID):
        return value
    return UUID(str(value))


def _criterion_type_from_llm(criterion_type: str):
    from app.models import CriterionType

    if criterion_type == "preferential":
        return CriterionType.soft_qualitative
    return CriterionType.hard_binary


@celery_app.task(bind=True, max_retries=3)
def parse_tender_document(self, tender_id: int = None, document_id: int = None, minio_key: str = None):
    from app.models import CriterionSource, ParseStatus, TenderCriterion, TenderDocument

    db: Session = SessionLocal()
    try:
        doc_id = _to_uuid(document_id if document_id is not None else tender_id)
        if doc_id is None:
            raise ValueError("document_id is required")

        tender_doc = db.query(TenderDocument).filter(TenderDocument.id == doc_id).first()
        if not tender_doc:
            raise ValueError(f"Tender document not found: {doc_id}")

        tender_doc.parse_status = ParseStatus.processing
        db.commit()

        storage_key = minio_key or tender_doc.storage_url
        file_bytes = storage_service.download(storage_key)
        text = _extract_pdf_text(file_bytes)

        criteria = asyncio.run(llm_service.extract_criteria_from_document(text))

        # Re-upload behavior: replace previously extracted criteria for this tender
        # to avoid duplicates across multiple document uploads.
        db.query(TenderCriterion).filter(
            TenderCriterion.tender_id == tender_doc.tender_id
        ).delete()
        db.commit()

        display_order = 0
        for criterion in criteria:
            record = TenderCriterion(
                tender_id=tender_doc.tender_id,
                criterion_text=criterion.get("description", "").strip()[:2000],
                criterion_type=_criterion_type_from_llm(criterion.get("type", "mandatory")),
                source=CriterionSource.extracted,
                source_section=criterion.get("source", "")[:500] or None,
                is_mandatory=criterion.get("type") != "preferential",
                confirmed_by_officer=False,
                display_order=display_order,
            )
            db.add(record)
            display_order += 1

        tender_doc.parsed_text = text
        tender_doc.page_count = max(1, text.count("\n\n"))
        tender_doc.parsed_at = datetime.now(IST)
        tender_doc.parse_status = ParseStatus.completed
        db.commit()
        logger.info("Tender document parsed", document_id=str(doc_id), criteria_count=len(criteria))
    except Exception as exc:
        logger.error("parse_tender_document failed", error=str(exc), document_id=document_id)
        if document_id:
            doc = db.query(TenderDocument).filter(TenderDocument.id == _to_uuid(document_id)).first()
            if doc:
                doc.parse_status = ParseStatus.failed
                doc.parse_error = str(exc)
                db.commit()
        raise self.retry(exc=exc)
    finally:
        db.close()


@celery_app.task(bind=True, max_retries=3)
def parse_bidder_document(self, bidder_id: int = None, document_id: int = None, minio_key: str = None):
    from app.models import BidderDocument, ParseStatus

    db: Session = SessionLocal()
    try:
        doc_id = _to_uuid(document_id if document_id is not None else bidder_id)
        if doc_id is None:
            raise ValueError("document_id is required")

        bidder_doc = db.query(BidderDocument).filter(BidderDocument.id == doc_id).first()
        if not bidder_doc:
            raise ValueError(f"Bidder document not found: {doc_id}")

        bidder_doc.parse_status = ParseStatus.processing
        db.commit()

        storage_key = minio_key or bidder_doc.storage_url
        file_bytes = storage_service.download(storage_key)
        text = _extract_pdf_text(file_bytes)

        bidder_doc.parsed_text = text
        bidder_doc.page_count = max(1, text.count("\n\n"))
        bidder_doc.parsed_at = datetime.now(IST)
        bidder_doc.parse_status = ParseStatus.completed
        db.commit()
        logger.info("Bidder document parsed", document_id=str(doc_id))
    except Exception as exc:
        logger.error("parse_bidder_document failed", error=str(exc), document_id=document_id)
        if document_id:
            doc = db.query(BidderDocument).filter(BidderDocument.id == _to_uuid(document_id)).first()
            if doc:
                doc.parse_status = ParseStatus.failed
                doc.parse_error = str(exc)
                db.commit()
        raise self.retry(exc=exc)
    finally:
        db.close()


@celery_app.task(bind=True, max_retries=3)
def run_matrix_evaluation(self, tender_id: int):
    from app.models import AIVerdict, Bidder, BidderDocument, FlagType, MatrixCell, Tender, TenderCriterion, TenderStatus

    db: Session = SessionLocal()
    try:
        tender_uuid = _to_uuid(tender_id)
        tender = db.query(Tender).filter(Tender.id == tender_uuid).first()
        if not tender:
            raise ValueError(f"Tender not found: {tender_id}")

        tender.status = TenderStatus.evaluation_active
        db.commit()

        criteria = (
            db.query(TenderCriterion)
            .filter(
                TenderCriterion.tender_id == tender_uuid,
                TenderCriterion.confirmed_by_officer.is_(True),
            )
            .all()
        )
        bidders = db.query(Bidder).filter(Bidder.tender_id == tender_uuid).all()

        for criterion in criteria:
            criterion_payload = {
                "description": criterion.criterion_text,
                "type": "mandatory" if criterion.is_mandatory else "preferential",
            }
            for bidder in bidders:
                bidder_doc = (
                    db.query(BidderDocument)
                    .filter(BidderDocument.bidder_id == bidder.id)
                    .order_by(BidderDocument.uploaded_at.desc())
                    .first()
                )
                parsed_text = (bidder_doc.parsed_text if bidder_doc else None) or ""

                if not parsed_text.strip():
                    eval_result = {
                        "verdict": "amber",
                        "confidence": 0.5,
                        "reasoning": "No document uploaded",
                        "evidence": "Not found",
                    }
                else:
                    eval_result = asyncio.run(
                        llm_service.evaluate_cell(criterion_payload, parsed_text, bidder.name)
                    )

                verdict = eval_result.get("verdict", "amber")
                ai_verdict = AIVerdict.ambiguous
                flag_type = FlagType.none
                if verdict == "green":
                    ai_verdict = AIVerdict.pass_
                elif verdict == "red":
                    ai_verdict = AIVerdict.fail
                    flag_type = FlagType.disqualifying
                else:
                    ai_verdict = AIVerdict.ambiguous
                    flag_type = FlagType.needs_verification

                cell = (
                    db.query(MatrixCell)
                    .filter(
                        MatrixCell.tender_criterion_id == criterion.id,
                        MatrixCell.bidder_id == bidder.id,
                        MatrixCell.is_superseded.is_(False),
                    )
                    .first()
                )
                if not cell:
                    cell = MatrixCell(tender_criterion_id=criterion.id, bidder_id=bidder.id)
                    db.add(cell)

                cell.ai_verdict = ai_verdict
                cell.confidence_score = float(eval_result.get("confidence", 0.5))
                cell.ai_reasoning = eval_result.get("reasoning", "")
                cell.source_text_snippet = eval_result.get("evidence", "Not found")
                cell.flag_type = flag_type
                cell.flag_detail = "Flagged for officer review" if flag_type != FlagType.none else None
                cell.evaluated_at = datetime.now(IST)
                cell.ai_model_version = settings.GROQ_MODEL
                cell.rule_version = "groq-v1"

        tender.status = TenderStatus.awaiting_approval
        db.commit()
        logger.info("run_matrix_evaluation complete", tender_id=str(tender_id))
    except Exception as exc:
        logger.error("run_matrix_evaluation failed", tender_id=str(tender_id), error=str(exc))
        raise self.retry(exc=exc)
    finally:
        db.close()


# Compatibility alias for existing route calls.
@celery_app.task(bind=True, max_retries=3, name="app.workers.tasks.evaluate_all_cells_for_tender")
def evaluate_all_cells_for_tender(self, tender_id: int):
    return run_matrix_evaluation(tender_id)