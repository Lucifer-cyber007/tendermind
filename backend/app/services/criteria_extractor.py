"""
Criteria extraction service.

Extracts evaluation criteria from tender documents using Claude.
Handles:
- Three sources: GFR/CVC rules, tender document, officer-defined
- Conflict resolution: annexure > main body, later > earlier, specific > general
- Hindi/English conflicts
- Under-specified criteria flagging
- Precedent matching against the criteria library (pgvector)
"""
import json
from typing import List, Optional
from uuid import UUID
import structlog

from app.services.llm_service import llm_service
from app.models import CriterionType, CriterionSource

logger = structlog.get_logger()

# ─── GFR / CVC standing rules ─────────────────────────────────────────────────
# These are always included regardless of what the tender document says.

GFR_STANDING_RULES = [
    {
        "text": "Earnest Money Deposit (EMD) must be submitted as specified in tender notice",
        "criterion_type": "hard_binary",
        "source": "gfr",
        "threshold": "As specified in tender",
        "rule_ref": "GFR Rule 170",
    },
    {
        "text": "Bidder must not be on Central Vigilance Commission debarred vendors list",
        "criterion_type": "hard_binary",
        "source": "cvc",
        "threshold": "Not debarred",
        "rule_ref": "CVC guidelines",
    },
    {
        "text": "Bidder must have valid GST registration",
        "criterion_type": "hard_binary",
        "source": "gfr",
        "threshold": "Valid as of bid submission date",
        "rule_ref": "GST Act 2017",
    },
    {
        "text": "Bidder must submit valid PAN card",
        "criterion_type": "hard_binary",
        "source": "gfr",
        "threshold": "Valid PAN",
        "rule_ref": "Income Tax Act",
    },
    {
        "text": "Bidder must not be insolvent or under liquidation proceedings",
        "criterion_type": "hard_binary",
        "source": "gfr",
        "threshold": "No insolvency proceedings",
        "rule_ref": "GFR Rule 144",
    },
]


EXTRACTION_SYSTEM_PROMPT = """You are an expert in Indian government procurement regulations.
Your task is to extract evaluation criteria from a tender document.

For each criterion you find, classify it as:
- "hard_binary": clear pass/fail (e.g., EMD submitted, turnover above threshold, registration valid)
- "soft_qualitative": requires interpretation (e.g., "adequate experience", "similar work", "satisfactory performance")
- "documentary": requires a specific document to be submitted

Also note:
- The threshold or condition (e.g., "≥ ₹50 Crore", "minimum 3 years")
- Any exception clauses
- Whether it is mandatory or desirable
- The exact page number and section where you found it

CONFLICT RESOLUTION RULES (apply these strictly):
1. If the same criterion appears in both the main document and an annexure, the ANNEXURE version takes precedence
2. If a criterion appears multiple times with different values, the LATER occurrence takes precedence
3. If a general and a specific version conflict, the SPECIFIC version takes precedence

HINDI/ENGLISH: If you see the same criterion stated differently in Hindi and English, flag it with "hindi_english_conflict": true

UNDER-SPECIFIED: If a criterion is vague (e.g., "similar nature of work" with no definition of similar), set "under_specified": true so the officer can clarify.

Return a JSON array of criteria objects. Each object must have:
{
  "criterion_text": "...",
  "criterion_type": "hard_binary" | "soft_qualitative" | "documentary",
  "threshold": "..." or null,
  "exception_clause": "..." or null,
  "is_mandatory": true | false,
  "source_page": number,
  "source_section": "...",
  "source_paragraph": "verbatim text where found",
  "hindi_english_conflict": false,
  "conflict_note": null,
  "under_specified": false,
  "display_order": number
}"""


class CriteriaExtractor:

    def extract_from_document(self, parsed_chunks: List[dict]) -> List[dict]:
        """
        Extract criteria from parsed document chunks using Claude.
        Returns list of criterion dicts ready to insert into TenderCriterion.
        """
        # Prepare document text with positional metadata
        doc_text = self._format_chunks_for_llm(parsed_chunks)

        user_prompt = f"""Extract all evaluation criteria from the following tender document.
Focus on: eligibility criteria, technical qualification criteria, financial criteria, documentary requirements.
Ignore: boilerplate, instructions to bidders (unless they contain criteria), contact details.

TENDER DOCUMENT:
{doc_text[:50000]}  
"""
        # Note: truncate to ~50k chars; real implementation would chunk intelligently

        try:
            result = llm_service.complete_json(EXTRACTION_SYSTEM_PROMPT, user_prompt, max_tokens=4000)
            criteria = result if isinstance(result, list) else result.get("criteria", [])
            logger.info("Criteria extracted", count=len(criteria))
            return criteria
        except Exception as e:
            logger.error("Criteria extraction failed", error=str(e))
            return []

    def get_standing_rules(self) -> List[dict]:
        """Return GFR/CVC standing rules that apply to all tenders."""
        return GFR_STANDING_RULES

    def flag_precedent_deviations(
        self,
        extracted_criteria: List[dict],
        similar_templates: List[dict],
    ) -> List[dict]:
        """
        Compare extracted criteria against historical library.
        Flag where this tender deviates significantly from precedent.
        E.g., turnover requirement suddenly 5× higher than previous similar tenders.
        """
        if not similar_templates:
            return extracted_criteria

        for criterion in extracted_criteria:
            for template in similar_templates:
                if (
                    criterion.get("threshold")
                    and template.get("typical_threshold")
                    and self._is_threshold_anomaly(
                        criterion["threshold"], template["typical_threshold"]
                    )
                ):
                    criterion["precedent_deviation"] = True
                    criterion["precedent_note"] = (
                        f"Previous similar tenders used threshold: {template['typical_threshold']}. "
                        f"This tender specifies: {criterion['threshold']}. "
                        "Please confirm this is intentional."
                    )
        return extracted_criteria

    def _format_chunks_for_llm(self, chunks: List[dict]) -> str:
        """Format parsed chunks with positional metadata for the LLM."""
        parts = []
        for chunk in chunks:
            parts.append(
                f"[Page {chunk['page']} | Section: {chunk['section']}]\n{chunk['text']}"
            )
        return "\n\n---\n\n".join(parts)

    def _is_threshold_anomaly(self, new_threshold: str, typical_threshold: str) -> bool:
        """
        Very rough check: if a numeric threshold is >3× or <1/3 of the typical,
        flag it as an anomaly.
        """
        import re

        def extract_number(s: str) -> Optional[float]:
            numbers = re.findall(r"[\d,]+\.?\d*", s.replace(",", ""))
            if numbers:
                try:
                    return float(numbers[0])
                except ValueError:
                    pass
            return None

        new_val = extract_number(new_threshold)
        typical_val = extract_number(typical_threshold)

        if new_val and typical_val and typical_val > 0:
            ratio = new_val / typical_val
            return ratio > 3 or ratio < 0.33
        return False


criteria_extractor = CriteriaExtractor()