from pydantic import BaseModel, EmailStr, UUID4
from typing import Optional, List, Any
from datetime import datetime
from app.models import (
    TenderStatus, CriterionType, CriterionSource,
    AIVerdict, FlagType, OfficerVerdict, ParseStatus
)


# ─── Auth ─────────────────────────────────────────────────────────────────────

class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    id: UUID4
    name: str
    designation: Optional[str]
    department: Optional[str]
    email: str

    class Config:
        from_attributes = True


# ─── Tender ───────────────────────────────────────────────────────────────────

class TenderCreate(BaseModel):
    title: str
    tender_number: str
    department: str
    tender_type: Optional[str] = None
    notes: Optional[str] = None


class TenderOut(BaseModel):
    id: UUID4
    title: str
    tender_number: str
    department: str
    tender_type: Optional[str]
    status: TenderStatus
    created_at: datetime
    criteria_confirmed_at: Optional[datetime]

    class Config:
        from_attributes = True


class TenderSummary(TenderOut):
    bidder_count: int = 0
    criteria_count: int = 0
    cells_needing_review: int = 0


# ─── Criteria ─────────────────────────────────────────────────────────────────

class CriterionOut(BaseModel):
    id: UUID4
    criterion_text: str
    criterion_type: CriterionType
    source: CriterionSource
    source_page: Optional[int]
    source_section: Optional[str]
    threshold: Optional[str]
    exception_clause: Optional[str]
    is_mandatory: bool
    hindi_english_conflict: bool
    conflict_note: Optional[str]
    confirmed_by_officer: bool
    officer_edit: Optional[str]
    confirmation_timestamp: Optional[datetime]
    display_order: int

    class Config:
        from_attributes = True


class CriterionConfirmRequest(BaseModel):
    criterion_id: UUID4
    officer_edit: Optional[str] = None  # what the officer changed, if anything
    confirmed: bool = True


class BulkConfirmRequest(BaseModel):
    confirmations: List[CriterionConfirmRequest]


class CriterionCreate(BaseModel):
    """Officer manually adds a criterion."""
    criterion_text: str
    criterion_type: CriterionType
    threshold: Optional[str] = None
    is_mandatory: bool = True


# ─── Bidder ───────────────────────────────────────────────────────────────────

class BidderCreate(BaseModel):
    name: str
    company: Optional[str] = None
    email: Optional[EmailStr] = None
    bid_amount: Optional[float] = None


class BidderOut(BaseModel):
    id: UUID4
    name: str
    company: Optional[str]
    email: Optional[EmailStr]
    bid_amount: Optional[float]
    rank: Optional[int]
    is_l1: bool
    parse_status: ParseStatus

    class Config:
        from_attributes = True


# ─── Matrix ───────────────────────────────────────────────────────────────────

class MatrixCellOut(BaseModel):
    id: UUID4
    tender_criterion_id: UUID4
    bidder_id: UUID4

    extracted_claim: Optional[str]
    source_page: Optional[int]
    source_section: Optional[str]
    source_text_snippet: Optional[str]

    ai_verdict: Optional[AIVerdict]
    confidence_score: Optional[float]
    ai_reasoning: Optional[str]
    flag_type: FlagType
    flag_detail: Optional[str]
    escalated_for_l1: bool

    officer_verdict: Optional[OfficerVerdict]
    officer_note: Optional[str]
    officer_timestamp: Optional[datetime]

    class Config:
        from_attributes = True


class MatrixRow(BaseModel):
    """One criterion row in the matrix, with all bidder cells."""
    criterion: CriterionOut
    cells: List[MatrixCellOut]


class MatrixView(BaseModel):
    tender_id: UUID4
    bidders: List[BidderOut]
    rows: List[MatrixRow]
    summary: "MatrixSummary"


class MatrixSummary(BaseModel):
    total_criteria: int
    total_bidders: int
    cells_pass: int
    cells_fail: int
    cells_ambiguous: int
    cells_missing: int
    cells_needing_review: int
    bidders_with_disqualification: List[UUID4]


MatrixView.model_rebuild()


# ─── Officer decision ─────────────────────────────────────────────────────────

class OfficerDecisionRequest(BaseModel):
    verdict: OfficerVerdict
    note: str  # required — always logged


# ─── Audit log ────────────────────────────────────────────────────────────────

class LogEntryOut(BaseModel):
    id: UUID4
    action_type: str
    actor_type: str
    actor_name: Optional[str]
    actor_ai_version: Optional[str]
    summary: Optional[str]
    timestamp: datetime

    class Config:
        from_attributes = True


# ─── Criteria library ────────────────────────────────────────────────────────

class TemplateOut(BaseModel):
    id: UUID4
    text: str
    criterion_type: CriterionType
    source: CriterionSource
    typical_threshold: Optional[str]
    seen_in_tender_count: int

    class Config:
        from_attributes = True


# ─── Document parse status ───────────────────────────────────────────────────

class ParseStatusOut(BaseModel):
    document_id: UUID4
    status: ParseStatus
    page_count: Optional[int]
    error: Optional[str]