"""
Object storage service.
Wraps MinIO / S3-compatible storage for document upload/download.
In production, points to NIC Cloud / MeitY-empanelled S3.
"""
import io
import uuid
from pathlib import Path
import structlog
from minio import Minio
from minio.error import S3Error

from app.config import settings

logger = structlog.get_logger()


class StorageService:
    def __init__(self):
        self.client = Minio(
            settings.S3_ENDPOINT.replace("http://", "").replace("https://", ""),
            access_key=settings.S3_ACCESS_KEY,
            secret_key=settings.S3_SECRET_KEY,
            secure=settings.S3_ENDPOINT.startswith("https://"),
        )
        self.bucket = settings.S3_BUCKET
        self._ensure_bucket()

    def _ensure_bucket(self):
        try:
            if not self.client.bucket_exists(self.bucket):
                self.client.make_bucket(self.bucket, location=settings.S3_REGION)
                logger.info("Storage bucket created", bucket=self.bucket)
        except S3Error as e:
            logger.error("Could not ensure bucket", error=str(e))

    def upload(self, file_bytes: bytes, filename: str, folder: str = "documents") -> str:
        """
        Upload a file and return the storage path (used as storage_url).
        """
        ext = Path(filename).suffix
        object_name = f"{folder}/{uuid.uuid4()}{ext}"

        self.client.put_object(
            self.bucket,
            object_name,
            io.BytesIO(file_bytes),
            length=len(file_bytes),
            content_type=self._content_type(ext),
        )
        return object_name

    def download(self, storage_url: str) -> bytes:
        """Download a file by its storage_url (object name)."""
        response = self.client.get_object(self.bucket, storage_url)
        try:
            return response.read()
        finally:
            response.close()
            response.release_conn()

    def get_presigned_url(self, storage_url: str, expires_seconds: int = 3600) -> str:
        """Generate a time-limited presigned URL for frontend download."""
        from datetime import timedelta
        return self.client.presigned_get_object(
            self.bucket,
            storage_url,
            expires=timedelta(seconds=expires_seconds),
        )

    def delete(self, storage_url: str):
        """Delete an object."""
        self.client.remove_object(self.bucket, storage_url)

    @staticmethod
    def _content_type(ext: str) -> str:
        return {
            ".pdf": "application/pdf",
            ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ".doc": "application/msword",
        }.get(ext.lower(), "application/octet-stream")


storage_service = StorageService()