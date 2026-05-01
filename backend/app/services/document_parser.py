"""
Document parsing service.
Handles: text-layer PDFs, scanned PDFs (OCR), Word documents.
Maintains positional references: page, section, paragraph.
"""
import io
import re
from pathlib import Path
from typing import Optional
import structlog

import pdfplumber
import fitz  # pymupdf
import pytesseract
from PIL import Image
from docx import Document as DocxDocument

logger = structlog.get_logger()


class ParsedChunk:
    """A chunk of parsed text with positional metadata."""
    def __init__(self, text: str, page: int, section: str, paragraph: int):
        self.text = text
        self.page = page
        self.section = section
        self.paragraph = paragraph

    def to_dict(self):
        return {
            "text": self.text,
            "page": self.page,
            "section": self.section,
            "paragraph": self.paragraph,
        }


class DocumentParser:
    """
    Parses government procurement documents.
    Returns structured chunks with positional metadata.
    """

    # Section heading patterns (English + Hindi transliteration common in GOI docs)
    SECTION_PATTERNS = [
        r"^(SECTION|PART|CHAPTER|ANNEXURE|SCHEDULE|APPENDIX)\s+[A-Z0-9]+",
        r"^\d+\.\s+[A-Z][A-Z\s]{5,}$",  # "1. ELIGIBILITY CRITERIA"
        r"^[A-Z][A-Z\s]{10,}:?\s*$",     # "TECHNICAL SPECIFICATIONS:"
    ]

    def parse(self, file_bytes: bytes, filename: str) -> dict:
        """
        Parse a document and return full text + structured chunks.

        Returns:
            {
                "full_text": str,
                "chunks": [{"text", "page", "section", "paragraph"}],
                "page_count": int,
                "method": "pdfplumber" | "ocr" | "docx",
                "language_detected": "en" | "hi" | "mixed",
            }
        """
        suffix = Path(filename).suffix.lower()

        if suffix in (".pdf",):
            return self._parse_pdf(file_bytes)
        elif suffix in (".docx", ".doc"):
            return self._parse_docx(file_bytes)
        else:
            raise ValueError(f"Unsupported file type: {suffix}")

    def _parse_pdf(self, file_bytes: bytes) -> dict:
        """Try text-layer extraction first, fall back to OCR."""
        try:
            result = self._parse_pdf_text_layer(file_bytes)
            # If we got very little text, the PDF is likely scanned
            if len(result["full_text"].strip()) < 200:
                logger.info("Text layer sparse, falling back to OCR")
                return self._parse_pdf_ocr(file_bytes)
            return result
        except Exception as e:
            logger.warning("Text layer extraction failed, trying OCR", error=str(e))
            return self._parse_pdf_ocr(file_bytes)

    def _parse_pdf_text_layer(self, file_bytes: bytes) -> dict:
        """Extract text from PDF with text layer using pdfplumber."""
        chunks = []
        full_text_parts = []
        current_section = "General"

        with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
            page_count = len(pdf.pages)

            for page_num, page in enumerate(pdf.pages, start=1):
                page_text = page.extract_text() or ""
                full_text_parts.append(page_text)

                # Split into paragraphs
                paragraphs = [p.strip() for p in page_text.split("\n\n") if p.strip()]

                for para_num, para in enumerate(paragraphs):
                    # Detect section headings
                    if self._is_section_heading(para):
                        current_section = para[:200]

                    if len(para) > 20:  # Skip very short fragments
                        chunks.append(ParsedChunk(
                            text=para,
                            page=page_num,
                            section=current_section,
                            paragraph=para_num,
                        ).to_dict())

        full_text = "\n\n".join(full_text_parts)
        return {
            "full_text": full_text,
            "chunks": chunks,
            "page_count": page_count,
            "method": "pdfplumber",
            "language_detected": self._detect_language(full_text),
        }

    def _parse_pdf_ocr(self, file_bytes: bytes) -> dict:
        """OCR a scanned PDF using Tesseract with Hindi + English language packs."""
        chunks = []
        full_text_parts = []
        current_section = "General"

        doc = fitz.open(stream=file_bytes, filetype="pdf")
        page_count = len(doc)

        for page_num in range(page_count):
            page = doc[page_num]
            # Render at 300 DPI for good OCR quality
            pix = page.get_pixmap(dpi=300)
            img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)

            # OCR with Hindi + English
            try:
                page_text = pytesseract.image_to_string(
                    img,
                    lang="eng+hin",
                    config="--psm 6",  # Assume uniform block of text
                )
            except Exception:
                # Hindi pack may not be installed — fall back to English only
                page_text = pytesseract.image_to_string(img, config="--psm 6")

            full_text_parts.append(page_text)

            paragraphs = [p.strip() for p in page_text.split("\n\n") if p.strip()]
            for para_num, para in enumerate(paragraphs):
                if self._is_section_heading(para):
                    current_section = para[:200]
                if len(para) > 20:
                    chunks.append(ParsedChunk(
                        text=para,
                        page=page_num + 1,
                        section=current_section,
                        paragraph=para_num,
                    ).to_dict())

        full_text = "\n\n".join(full_text_parts)
        return {
            "full_text": full_text,
            "chunks": chunks,
            "page_count": page_count,
            "method": "ocr",
            "language_detected": self._detect_language(full_text),
        }

    def _parse_docx(self, file_bytes: bytes) -> dict:
        """Parse a Word document."""
        doc = DocxDocument(io.BytesIO(file_bytes))
        chunks = []
        full_text_parts = []
        current_section = "General"
        page_estimate = 1

        for para_num, para in enumerate(doc.paragraphs):
            text = para.text.strip()
            if not text:
                continue

            full_text_parts.append(text)

            # Detect section headings by Word style
            if para.style.name.startswith("Heading") or self._is_section_heading(text):
                current_section = text[:200]

            # Rough page estimation: ~40 paragraphs per page
            page_estimate = max(1, para_num // 40 + 1)

            if len(text) > 20:
                chunks.append(ParsedChunk(
                    text=text,
                    page=page_estimate,
                    section=current_section,
                    paragraph=para_num,
                ).to_dict())

        full_text = "\n".join(full_text_parts)
        return {
            "full_text": full_text,
            "chunks": chunks,
            "page_count": page_estimate,
            "method": "docx",
            "language_detected": self._detect_language(full_text),
        }

    def _is_section_heading(self, text: str) -> bool:
        """Detect whether a text fragment is a section heading."""
        text = text.strip()
        if len(text) > 200:
            return False
        for pattern in self.SECTION_PATTERNS:
            if re.match(pattern, text, re.IGNORECASE):
                return True
        # All caps short line
        if text.isupper() and 10 < len(text) < 100:
            return True
        return False

    def _detect_language(self, text: str) -> str:
        """Rough detection of Hindi vs English vs mixed."""
        # Count Devanagari characters
        devanagari_count = sum(1 for c in text if "\u0900" <= c <= "\u097F")
        total_alpha = sum(1 for c in text if c.isalpha())
        if total_alpha == 0:
            return "en"
        ratio = devanagari_count / total_alpha
        if ratio > 0.5:
            return "hi"
        elif ratio > 0.1:
            return "mixed"
        return "en"