"""
Criteria library service.
Uses pgvector to store and semantically search historical criteria.
Every closed tender feeds back into the library.
New tenders are matched against it to detect deviations.
"""
from typing import List, Optional
from uuid import UUID
import structlog
import anthropic

from app.config import settings

logger = structlog.get_logger()

EMBEDDING_MODEL = "voyage-3"  # Anthropic's embedding model


class CriteriaLibraryService:
    """
    Manages the organisation-level criteria library.
    Uses pgvector for semantic similarity search.
    """

    def __init__(self):
        if not settings.use_local_llm:
            self._client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)

    def get_embedding(self, text: str) -> List[float]:
        """Get a text embedding for semantic search."""
        if settings.use_local_llm:
            return self._ollama_embedding(text)
        return self._anthropic_embedding(text)

    def _anthropic_embedding(self, text: str) -> List[float]:
        """Get embedding via Anthropic's voyage model."""
        # Note: Use the anthropic client's embedding endpoint
        import httpx
        response = httpx.post(
            "https://api.anthropic.com/v1/embeddings",
            headers={
                "x-api-key": settings.ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": EMBEDDING_MODEL,
                "input": text[:8000],  # max input length
            },
            timeout=30.0,
        )
        response.raise_for_status()
        return response.json()["embeddings"][0]["embedding"]

    def _ollama_embedding(self, text: str) -> List[float]:
        """Get embedding via Ollama (air-gapped fallback)."""
        import httpx
        response = httpx.post(
            f"{settings.OLLAMA_BASE_URL}/api/embeddings",
            json={"model": "nomic-embed-text", "prompt": text},
            timeout=30.0,
        )
        response.raise_for_status()
        return response.json()["embedding"]

    async def find_similar_templates(
        self,
        db,
        criterion_text: str,
        limit: int = 5,
        threshold: float = 0.8,
    ) -> List[dict]:
        """
        Find semantically similar criteria from the library.
        Used to detect deviations from precedent.
        """
        from app.models import CriterionTemplate
        from sqlalchemy import text

        try:
            embedding = self.get_embedding(criterion_text)
            embedding_str = "[" + ",".join(str(x) for x in embedding) + "]"

            # pgvector cosine similarity query
            result = await db.execute(
                text("""
                    SELECT id, text, criterion_type, source, typical_threshold,
                           seen_in_tender_count,
                           1 - (embedding <=> :embedding::vector) as similarity
                    FROM criterion_templates
                    WHERE 1 - (embedding <=> :embedding::vector) > :threshold
                    ORDER BY embedding <=> :embedding::vector
                    LIMIT :limit
                """),
                {
                    "embedding": embedding_str,
                    "threshold": threshold,
                    "limit": limit,
                },
            )
            rows = result.fetchall()
            return [dict(row._mapping) for row in rows]
        except Exception as e:
            logger.warning("Similarity search failed", error=str(e))
            return []

    async def upsert_template(
        self,
        db,
        criterion_text: str,
        criterion_type: str,
        source: str,
        typical_threshold: Optional[str] = None,
        department: Optional[str] = None,
    ) -> None:
        """
        Add or update a criterion in the library after a tender closes.
        Increments seen_in_tender_count for existing matches.
        """
        from app.models import CriterionTemplate
        from sqlalchemy import text

        embedding = self.get_embedding(criterion_text)
        embedding_str = "[" + ",".join(str(x) for x in embedding) + "]"

        # Check if a very similar template already exists
        similar = await self.find_similar_templates(db, criterion_text, limit=1, threshold=0.95)

        if similar:
            # Increment count on existing
            template_id = similar[0]["id"]
            await db.execute(
                text("UPDATE criterion_templates SET seen_in_tender_count = seen_in_tender_count + 1, updated_at = NOW() WHERE id = :id"),
                {"id": template_id},
            )
        else:
            # Insert new template
            template = CriterionTemplate(
                text=criterion_text,
                criterion_type=criterion_type,
                source=source,
                typical_threshold=typical_threshold,
                department=department,
                embedding=embedding,
            )
            db.add(template)

        await db.commit()
        logger.info("Criteria library updated", text_preview=criterion_text[:80])


criteria_library = CriteriaLibraryService()x``