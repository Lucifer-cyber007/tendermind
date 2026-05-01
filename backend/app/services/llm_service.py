"""Groq-backed LLM service for extraction and evaluation."""

import json
from typing import Any

import structlog
from groq import AsyncGroq

from app.config import settings

logger = structlog.get_logger()
_groq_client = AsyncGroq(api_key=settings.GROQ_API_KEY)


def _strip_markdown_fences(content: str) -> str:
    text = content.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if len(lines) >= 3:
            text = "\n".join(lines[1:-1]).strip()
    return text


def _safe_parse_json(content: str) -> Any:
    try:
        return json.loads(_strip_markdown_fences(content))
    except Exception as exc:
        logger.error("Failed to parse Groq JSON response", error=str(exc), raw_preview=content[:300])
        return None


async def extract_criteria_from_document(document_text: str) -> list[dict]:
    """
    Sends document text to Groq. Returns list of criterion dicts.
    Each dict: { "description": str, "type": "mandatory"|"preferential"|"disqualifying", "source": str }
    """
    try:
        prompt = (
            "You are a government procurement expert. Extract ALL evaluation criteria from this tender document.\n"
            "For each criterion identify: description (exact requirement), "
            "type (mandatory=must have, disqualifying=instant fail, preferential=nice to have), "
            "source (quote the exact clause or sentence it came from, max 200 chars).\n"
            "Return ONLY valid JSON array, no markdown, no explanation."
        )

        response = await _groq_client.chat.completions.create(
            model=settings.GROQ_MODEL,
            temperature=0.1,
            max_tokens=3000,
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": document_text[:25000]},
            ],
        )
        content = response.choices[0].message.content or "[]"
        parsed = _safe_parse_json(content)
        if not isinstance(parsed, list):
            return []

        cleaned: list[dict] = []
        for item in parsed[:50]:
            if not isinstance(item, dict):
                continue
            description = str(item.get("description", "")).strip()
            criterion_type = str(item.get("type", "")).strip().lower()
            source = str(item.get("source", "")).strip()
            if not description:
                continue
            if criterion_type not in {"mandatory", "preferential", "disqualifying"}:
                criterion_type = "mandatory"
            cleaned.append(
                {
                    "description": description,
                    "type": criterion_type,
                    "source": source[:200],
                }
            )
        return cleaned
    except Exception as exc:
        logger.error("extract_criteria_from_document failed", error=str(exc))
        return []


async def evaluate_cell(criterion: dict, bidder_document_text: str, bidder_name: str) -> dict:
    """
    Evaluates one matrix cell.
    Returns: { verdict, confidence, reasoning, evidence }.
    """
    safe_default = {
        "verdict": "amber",
        "confidence": 0.5,
        "reasoning": "Could not complete automated evaluation. Officer review required.",
        "evidence": "Not found",
    }
    try:
        criterion_description = str(criterion.get("description", "")).strip()
        criterion_type = str(criterion.get("type", "mandatory")).strip().lower()
        excerpt = bidder_document_text[:3000] if bidder_document_text else ""

        prompt = (
            "You are a government procurement compliance checker.\n"
            f"Criterion: {criterion_description} (Type: {criterion_type})\n"
            f"Bidder: {bidder_name}\n"
            f"Bid document excerpt: {excerpt}\n"
            "Does this bid comply with the criterion?\n"
            "- green: clearly complies, evidence found\n"
            "- amber: unclear, missing info, or partially complies - needs officer review\n"
            "- red: clearly does not comply\n"
            "Return ONLY valid JSON with keys: verdict, confidence (0.0-1.0), "
            "reasoning (max 200 chars), evidence (exact quote from bid doc, max 300 chars, or \"Not found\").\n"
            "For mandatory criteria: if confidence < 0.75, return amber not green.\n"
            "For disqualifying criteria: if any doubt, return red."
        )

        response = await _groq_client.chat.completions.create(
            model=settings.GROQ_MODEL,
            temperature=0.0,
            max_tokens=900,
            messages=[
                {"role": "system", "content": "You must output strict JSON only."},
                {"role": "user", "content": prompt},
            ],
        )
        content = response.choices[0].message.content or "{}"
        parsed = _safe_parse_json(content)
        if not isinstance(parsed, dict):
            return safe_default

        verdict = str(parsed.get("verdict", "amber")).lower()
        if verdict not in {"green", "amber", "red"}:
            verdict = "amber"

        confidence = float(parsed.get("confidence", 0.5))
        confidence = min(max(confidence, 0.0), 1.0)

        if criterion_type == "mandatory" and verdict == "green" and confidence < 0.75:
            verdict = "amber"
        if criterion_type == "disqualifying" and verdict == "amber":
            verdict = "red"

        reasoning = str(parsed.get("reasoning", safe_default["reasoning"]))[:200]
        evidence = str(parsed.get("evidence", "Not found"))[:300]
        return {
            "verdict": verdict,
            "confidence": confidence,
            "reasoning": reasoning,
            "evidence": evidence if evidence else "Not found",
        }
    except Exception as exc:
        logger.error("evaluate_cell failed", error=str(exc), bidder_name=bidder_name)
        return safe_default


async def health_check() -> bool:
    """Returns True if Groq API responds to a simple test request."""
    try:
        response = await _groq_client.chat.completions.create(
            model=settings.GROQ_MODEL,
            temperature=0.0,
            max_tokens=10,
            messages=[
                {"role": "system", "content": "Return OK"},
                {"role": "user", "content": "health check"},
            ],
        )
        content = (response.choices[0].message.content or "").strip().lower()
        return bool(content)
    except Exception as exc:
        logger.error("Groq health_check failed", error=str(exc))
        return False