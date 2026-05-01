from sqlalchemy import (
    Column, String, Integer, Float, Boolean, Text, DateTime,
    ForeignKey, Enum as SAEnum, JSON, Index
)
from sqlalchemy.orm import relationship, DeclarativeBase
from sqlalchemy.dialects.postgresql import UUID
from pgvector.sqlalchemy import Vector
import uuid
import enum
from datetime import datetime
import pytz

IST = pytz.timezone("Asia/Kolkata")


def now_ist():
    return datetime.now(IST)


class Base(DeclarativeBase):
    pass


# ─── Enums ────────────────────────────────────────────────────────────────────

class TenderStatus(str, enum.Enum):
    draft = "draft"
    criteria_confirmed = "criteria_confirmed"
    evaluation_active = "evaluation_active"
    awaiting_approval = "awaiting_approval"
    closed = "closed"


class CriterionType(str, enum.Enum):
    hard_binary = "hard_binary"
    soft_qualitative = "soft_qualitative"
    documentary = "documentary"


class CriterionSource(str, enum.Enum):
    gfr = "gfr"
    cvc = "cvc"
    extracted = "extracted"
    manual = "manual"


class AIVerdict(str, enum.Enum):
    pass_ = "pass"
    fail = "fail"
    ambiguous = "ambiguous"
    missing = "missing"


class FlagType(str, enum.Enum):
    none = "none"
    disqualifying = "disqualifying"
    needs_verification = "needs_verification"
    ambiguous_language = "ambiguous_language"
    anomaly = "anomaly"


class OfficerVerdict(str, enum.Enum):
    qualifying = "qualifying"
    disqualifying = "disqualifying"
    deferred = "deferred"


class ParseStatus(str, enum.Enum):
    pending = "pending"
    processing = "processing"
    completed = "completed"
    failed = "failed"


class ActorType(str, enum.Enum):
    ai = "ai"
    officer = "officer"
    system = "system"


# ─── Models ───────────────────────────────────────────────────────────────────

class User(Base):
    """Procurement officer / system user."""
    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(255), nullable=False)
    designation = Column(String(255))
    department = Column(String(255))
    email = Column(String(255), unique=True, nullable=False)
    hashed_password = Column(String(255), nullable=False)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), default=now_ist)

    tenders = relationship("Tender", back_populates="created_by_user")
    decisions = relationship("MatrixCell", back_populates="officer")
    log_entries = relationship("TenderDecisionLog", back_populates="actor_user")


class Tender(Base):
    """A single government procurement tender."""
    __tablename__ = "tenders"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    title = Column(String(500), nullable=False)
    tender_number = Column(String(100), unique=True, nullable=False)
    department = Column(String(255), nullable=False)
    tender_type = Column(String(100))  # works / goods / services
    status = Column(SAEnum(TenderStatus), default=TenderStatus.draft, nullable=False)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), default=now_ist)
    criteria_confirmed_at = Column(DateTime(timezone=True))
    evaluation_started_at = Column(DateTime(timezone=True))
    closed_at = Column(DateTime(timezone=True))
    notes = Column(Text)

    created_by_user = relationship("User", back_populates="tenders")
    documents = relationship("TenderDocument", back_populates="tender", cascade="all, delete-orphan")
    criteria = relationship("TenderCriterion", back_populates="tender", cascade="all, delete-orphan")
    bidders = relationship("Bidder", back_populates="tender", cascade="all, delete-orphan")
    decision_log = relationship("TenderDecisionLog", back_populates="tender", cascade="all, delete-orphan")


class TenderDocument(Base):
    """The uploaded tender document (PDF/Word)."""
    __tablename__ = "tender_documents"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tender_id = Column(UUID(as_uuid=True), ForeignKey("tenders.id"), nullable=False)
    filename = Column(String(500), nullable=False)
    storage_url = Column(String(1000), nullable=False)
    file_size_bytes = Column(Integer)
    page_count = Column(Integer)
    parse_status = Column(SAEnum(ParseStatus), default=ParseStatus.pending)
    parsed_text = Column(Text)
    parse_error = Column(Text)
    uploaded_at = Column(DateTime(timezone=True), default=now_ist)
    parsed_at = Column(DateTime(timezone=True))

    tender = relationship("Tender", back_populates="documents")


class CriterionTemplate(Base):
    """
    Org-level criteria library. Every processed tender adds to this.
    Enables precedent matching for new tenders.
    """
    __tablename__ = "criterion_templates"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    text = Column(Text, nullable=False)
    criterion_type = Column(SAEnum(CriterionType), nullable=False)
    source = Column(SAEnum(CriterionSource), nullable=False)
    typical_threshold = Column(String(500))
    seen_in_tender_count = Column(Integer, default=1)
    department = Column(String(255))
    embedding = Column(Vector(1536))  # pgvector embedding for semantic search
    created_at = Column(DateTime(timezone=True), default=now_ist)
    updated_at = Column(DateTime(timezone=True), default=now_ist, onupdate=now_ist)

    __table_args__ = (
        Index("ix_criterion_templates_embedding", "embedding", postgresql_using="ivfflat"),
    )


class TenderCriterion(Base):
    """
    A single criterion for a specific tender.
    Extracted from the tender document, GFR/CVC rules, or added manually.
    Must be confirmed by the officer before evaluation begins.
    """
    __tablename__ = "tender_criteria"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tender_id = Column(UUID(as_uuid=True), ForeignKey("tenders.id"), nullable=False)
    template_id = Column(UUID(as_uuid=True), ForeignKey("criterion_templates.id"))

    criterion_text = Column(Text, nullable=False)
    criterion_type = Column(SAEnum(CriterionType), nullable=False)
    source = Column(SAEnum(CriterionSource), nullable=False)

    # Where it was found in the document
    source_page = Column(Integer)
    source_section = Column(String(500))
    source_paragraph = Column(Text)

    # Parsed structure
    threshold = Column(String(500))
    exception_clause = Column(Text)
    is_mandatory = Column(Boolean, default=True)

    # Hindi/English conflict flag
    hindi_english_conflict = Column(Boolean, default=False)
    conflict_note = Column(Text)

    # Officer confirmation (mandatory before evaluation)
    confirmed_by_officer = Column(Boolean, default=False)
    officer_edit = Column(Text)  # what the officer changed
    confirmation_timestamp = Column(DateTime(timezone=True))
    confirmed_by = Column(UUID(as_uuid=True), ForeignKey("users.id"))

    # Ordering
    display_order = Column(Integer, default=0)
    created_at = Column(DateTime(timezone=True), default=now_ist)

    tender = relationship("Tender", back_populates="criteria")
    matrix_cells = relationship("MatrixCell", back_populates="criterion", cascade="all, delete-orphan")


class Bidder(Base):
    """A single bidder in a tender."""
    __tablename__ = "bidders"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tender_id = Column(UUID(as_uuid=True), ForeignKey("tenders.id"), nullable=False)
    name = Column(String(500), nullable=False)
    company = Column(String(500))
    email = Column(String(255))
    bid_amount = Column(Float)
    rank = Column(Integer)  # L1=1, L2=2, etc.
    is_l1 = Column(Boolean, default=False)

    parse_status = Column(SAEnum(ParseStatus), default=ParseStatus.pending)
    created_at = Column(DateTime(timezone=True), default=now_ist)

    tender = relationship("Tender", back_populates="bidders")
    documents = relationship("BidderDocument", back_populates="bidder", cascade="all, delete-orphan")
    matrix_cells = relationship("MatrixCell", back_populates="bidder", cascade="all, delete-orphan")


class BidderDocument(Base):
    """A document submitted by a bidder."""
    __tablename__ = "bidder_documents"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    bidder_id = Column(UUID(as_uuid=True), ForeignKey("bidders.id"), nullable=False)
    filename = Column(String(500), nullable=False)
    storage_url = Column(String(1000), nullable=False)
    file_size_bytes = Column(Integer)
    page_count = Column(Integer)
    parse_status = Column(SAEnum(ParseStatus), default=ParseStatus.pending)
    parsed_text = Column(Text)
    parsed_chunks = Column(JSON)  # [{page, section, paragraph, text}]
    parse_error = Column(Text)
    uploaded_at = Column(DateTime(timezone=True), default=now_ist)
    parsed_at = Column(DateTime(timezone=True))

    bidder = relationship("Bidder", back_populates="documents")


class MatrixCell(Base):
    """
    A single cell in the compliance matrix: one criterion × one bidder.
    The core evaluation unit.
    """
    __tablename__ = "matrix_cells"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tender_criterion_id = Column(UUID(as_uuid=True), ForeignKey("tender_criteria.id"), nullable=False)
    bidder_id = Column(UUID(as_uuid=True), ForeignKey("bidders.id"), nullable=False)

    # What the AI found in the bid document
    extracted_claim = Column(Text)  # verbatim text from bid doc
    source_page = Column(Integer)
    source_section = Column(String(500))
    source_paragraph = Column(Integer)
    source_text_snippet = Column(Text)

    # AI verdict
    ai_verdict = Column(SAEnum(AIVerdict))
    confidence_score = Column(Float)  # 0.0 to 1.0
    ai_reasoning = Column(Text)  # human-readable explanation
    flag_type = Column(SAEnum(FlagType), default=FlagType.none)
    flag_detail = Column(Text)

    # L1 escalation: always escalate borderline L1 cases
    escalated_for_l1 = Column(Boolean, default=False)

    # AI model version used (for audit)
    ai_model_version = Column(String(100))
    rule_version = Column(String(50))
    evaluated_at = Column(DateTime(timezone=True))

    # Officer decision
    officer_verdict = Column(SAEnum(OfficerVerdict))
    officer_note = Column(Text)
    officer_id = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    officer_timestamp = Column(DateTime(timezone=True))

    # Immutability: once finalized, create a new superseding record
    is_superseded = Column(Boolean, default=False)
    superseded_by = Column(UUID(as_uuid=True), ForeignKey("matrix_cells.id"))

    created_at = Column(DateTime(timezone=True), default=now_ist)

    criterion = relationship("TenderCriterion", back_populates="matrix_cells")
    bidder = relationship("Bidder", back_populates="matrix_cells")
    officer = relationship("User", back_populates="decisions")


class TenderDecisionLog(Base):
    """
    Immutable audit log for every action in a tender.
    CVC/CAG-ready. No deletes, no updates — append only.
    """
    __tablename__ = "tender_decision_log"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tender_id = Column(UUID(as_uuid=True), ForeignKey("tenders.id"), nullable=False)
    action_type = Column(String(100), nullable=False)
    actor_type = Column(SAEnum(ActorType), nullable=False)
    actor_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    actor_ai_version = Column(String(100))

    # JSON snapshots of state before and after
    before_state = Column(JSON)
    after_state = Column(JSON)

    # Human-readable summary
    summary = Column(Text)

    timestamp = Column(DateTime(timezone=True), default=now_ist, nullable=False)

    tender = relationship("Tender", back_populates="decision_log")
    actor_user = relationship("User", back_populates="log_entries")