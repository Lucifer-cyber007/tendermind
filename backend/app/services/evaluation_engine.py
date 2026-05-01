"""
Evaluation engine.

Scores each matrix cell (criterion × bidder) using Claude.
Implements the three-tier classification and four flag types.
Applies L1-aware escalation logic.
"""
from typing import Optional
import structlog

from app.services.llm_service import llm_service
from app.models import AIVerdict, FlagType, CriterionType

logger = structlog.get_logger()


HARD_BINARY_SYSTEM = """You are evaluating a single eligibility criterion for an Indian government tender bid.
The criterion is a HARD BINARY check — it either passes or fails. There is no grey area.

You will be given:
1. The criterion text and threshold
2. The relevant text extracted from the bidder's document

Your job:
- Determine if the bid PASSES or FAILS this criterion
- If the bidder has not addressed this criterion at all, return verdict "missing"
- Be conservative: if the evidence is ambiguous for a hard binary criterion, return "ambiguous" (not pass)
- Cite the exact text that led to your verdict

Return JSON:
{
  "verdict": "pass" | "fail" | "ambiguous" | "missing",
  "confidence": 0.0-1.0,
  "reasoning": "one sentence explaining verdict",
  "extracted_claim": "verbatim text from bid document supporting verdict",
  "flag_type": "none" | "disqualifying" | "needs_verification",
  "flag_detail": "..." or null
}

Flag rules:
- If verdict is "fail" for a mandatory criterion: flag_type = "disqualifying"
- If verdict is "pass" but you cannot verify the claim externally (e.g., turnover claimed but audited accounts not attached): flag_type = "needs_verification"
- Otherwise: flag_type = "none"
"""

SOFT_QUALITATIVE_SYSTEM = """You are evaluating a SOFT QUALITATIVE criterion for an Indian government tender bid.
These criteria require judgment — words like "adequate", "similar", "satisfactory" are inherently interpretive.

You will be given:
1. The criterion text and any threshold
2. The relevant text from the bidder's document

Your job:
- Extract what the bidder claims
- Assess whether it likely meets the criterion
- Be explicit about your uncertainty — soft qualitative criteria ALWAYS go to the officer for review
- Do NOT mark as definitive pass or fail — mark as "pass" only if overwhelmingly clear, otherwise "ambiguous"

Return JSON:
{
  "verdict": "pass" | "fail" | "ambiguous" | "missing",
  "confidence": 0.0-1.0,
  "reasoning": "explain what you found and why you are uncertain",
  "extracted_claim": "verbatim text from bid document",
  "alternative_reading": "if the text is genuinely ambiguous, what is the other plausible interpretation",
  "flag_type": "ambiguous_language" | "needs_verification" | "none",
  "flag_detail": "plain language description of what the officer needs to review"
}

Confidence guidance:
- 0.9+: The text unambiguously meets or fails the criterion. Rare for soft qualitative.
- 0.6-0.9: Strong evidence but some interpretation required.
- 0.4-0.6: Genuinely unclear. Officer must decide.
- <0.4: Very little evidence either way.
"""

ANOMALY_DETECTION_SYSTEM = """You are reviewing bid prices for an Indian government tender.
Identify statistical anomalies that the evaluation officer should be aware of.
Do NOT make any judgment about whether anomalies are valid or invalid — just surface them.

Return JSON:
{
  "anomalies": [
    {
      "bidder_name": "...",
      "description": "plain language description of the anomaly",
      "statistical_note": "e.g., 41% below field median",
      "flag_type": "anomaly"
    }
  ]
}
"""


class EvaluationEngine:
    """
    Evaluates a single matrix cell (criterion × bidder).
    """

    def evaluate_cell(
        self,
        criterion_text: str,
        criterion_type: str,
        threshold: Optional[str],
        is_mandatory: bool,
        bidder_name: str,
        is_l1: bool,
        relevant_chunks: list[dict],
    ) -> dict:
        """
        Evaluate one cell in the compliance matrix.

        Returns a dict ready to update the MatrixCell model.
        """
        if not relevant_chunks:
            return self._missing_cell(criterion_type, is_mandatory, is_l1)

        bid_text = self._format_bid_text(relevant_chunks)

        if criterion_type == CriterionType.hard_binary:
            result = self._evaluate_hard_binary(criterion_text, threshold, bid_text)
        else:
            result = self._evaluate_soft_qualitative(criterion_text, threshold, bid_text)

        # L1 escalation: always escalate borderline L1 cases to officer
        if is_l1 and result["confidence"] < 0.85 and result["verdict"] != "fail":
            result["escalated_for_l1"] = True
            if result["flag_type"] == "none":
                result["flag_type"] = "ambiguous_language"
                result["flag_detail"] = (
                    f"This bidder is L1 (lowest bid). Borderline cases for L1 "
                    f"always require your review regardless of confidence level. "
                    f"Original confidence: {result['confidence']:.0%}"
                )
        else:
            result["escalated_for_l1"] = False

        return result

    def detect_price_anomalies(self, bidders: list[dict]) -> list[dict]:
        """
        Detect statistical anomalies in bid prices.
        Returns list of anomaly dicts per bidder.
        """
        if len(bidders) < 2:
            return []

        prices = [b["bid_amount"] for b in bidders if b.get("bid_amount")]
        if not prices:
            return []

        import statistics
        median_price = statistics.median(prices)
        mean_price = statistics.mean(prices)

        anomalies = []
        for bidder in bidders:
            amount = bidder.get("bid_amount")
            if not amount:
                continue
            deviation = (amount - median_price) / median_price
            if abs(deviation) > 0.3:  # >30% from median
                direction = "below" if deviation < 0 else "above"
                anomalies.append({
                    "bidder_id": bidder["id"],
                    "bidder_name": bidder["name"],
                    "description": (
                        f"{bidder['name']} bid is {abs(deviation):.0%} {direction} the field median. "
                        f"This is flagged for your awareness — not a disqualification."
                    ),
                    "statistical_note": (
                        f"Bid: ₹{amount:,.2f} Cr | Median: ₹{median_price:,.2f} Cr | "
                        f"Deviation: {deviation:+.0%}"
                    ),
                    "flag_type": FlagType.anomaly,
                })

        return anomalies

    def _evaluate_hard_binary(
        self, criterion_text: str, threshold: Optional[str], bid_text: str
    ) -> dict:
        prompt = f"""CRITERION: {criterion_text}
THRESHOLD: {threshold or "As stated in criterion"}

BIDDER DOCUMENT TEXT:
{bid_text}"""

        try:
            result = llm_service.complete_json(HARD_BINARY_SYSTEM, prompt)
            return self._normalise_result(result)
        except Exception as e:
            logger.error("Hard binary evaluation failed", error=str(e))
            return self._error_cell()

    def _evaluate_soft_qualitative(
        self, criterion_text: str, threshold: Optional[str], bid_text: str
    ) -> dict:
        prompt = f"""CRITERION: {criterion_text}
THRESHOLD / GUIDANCE: {threshold or "Use professional judgment"}

BIDDER DOCUMENT TEXT:
{bid_text}"""

        try:
            result = llm_service.complete_json(SOFT_QUALITATIVE_SYSTEM, prompt)
            # Soft qualitative always flagged if not clearly pass
            result = self._normalise_result(result)
            if result["confidence"] < 0.85 and result["flag_type"] == "none":
                result["flag_type"] = FlagType.ambiguous_language
                result["flag_detail"] = result.get("flag_detail") or (
                    "Soft qualitative criterion — requires your review. "
                    f"Confidence: {result['confidence']:.0%}"
                )
            return result
        except Exception as e:
            logger.error("Soft qualitative evaluation failed", error=str(e))
            return self._error_cell()

    def _missing_cell(self, criterion_type: str, is_mandatory: bool, is_l1: bool) -> dict:
        """Bidder did not address this criterion."""
        flag = FlagType.disqualifying if is_mandatory else FlagType.ambiguous_language
        return {
            "ai_verdict": AIVerdict.missing,
            "confidence_score": 1.0,
            "ai_reasoning": (
                "No relevant text found in the bid document for this criterion. "
                "Missing ≠ automatically disqualified — the officer must determine "
                "whether the criterion was addressed elsewhere or is truly absent."
            ),
            "extracted_claim": None,
            "source_text_snippet": None,
            "flag_type": flag,
            "flag_detail": "Criterion not addressed in bid document. Please verify manually.",
            "escalated_for_l1": is_l1,
        }

    def _error_cell(self) -> dict:
        return {
            "ai_verdict": AIVerdict.ambiguous,
            "confidence_score": 0.0,
            "ai_reasoning": "Evaluation failed due to a processing error. Manual review required.",
            "extracted_claim": None,
            "source_text_snippet": None,
            "flag_type": FlagType.ambiguous_language,
            "flag_detail": "Processing error — manual review required.",
            "escalated_for_l1": False,
        }

    def _normalise_result(self, result: dict) -> dict:
        """Normalise LLM output to expected schema."""
        verdict_map = {
            "pass": AIVerdict.pass_,
            "fail": AIVerdict.fail,
            "ambiguous": AIVerdict.ambiguous,
            "missing": AIVerdict.missing,
        }
        flag_map = {
            "none": FlagType.none,
            "disqualifying": FlagType.disqualifying,
            "needs_verification": FlagType.needs_verification,
            "ambiguous_language": FlagType.ambiguous_language,
            "anomaly": FlagType.anomaly,
        }

        return {
            "ai_verdict": verdict_map.get(result.get("verdict", "ambiguous"), AIVerdict.ambiguous),
            "confidence_score": float(result.get("confidence", 0.5)),
            "ai_reasoning": result.get("reasoning", ""),
            "extracted_claim": result.get("extracted_claim"),
            "alternative_reading": result.get("alternative_reading"),
            "source_text_snippet": result.get("extracted_claim"),
            "flag_type": flag_map.get(result.get("flag_type", "none"), FlagType.none),
            "flag_detail": result.get("flag_detail"),
        }

    def _format_bid_text(self, chunks: list[dict]) -> str:
        parts = []
        for chunk in chunks[:10]:  # limit context
            parts.append(
                f"[Page {chunk['page']} | {chunk['section']}]\n{chunk['text']}"
            )
        return "\n\n".join(parts)


evaluation_engine = EvaluationEngine()