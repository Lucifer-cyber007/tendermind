import io
import logging
import pdfplumber

logger = logging.getLogger(__name__)

async def extract_text_from_pdf(file_bytes: bytes) -> str:
    """
    Try pdfplumber first for text-based PDFs.
    If text extraction yields less than 100 chars per page on average,
    fall back to OCR using tesseract.
    """
    text = ""
    num_pages = 0
    
    try:
        with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
            num_pages = len(pdf.pages)
            for page in pdf.pages:
                page_text = page.extract_text() or ""
                text += page_text + "\n"
    except Exception as e:
        logger.error(f"pdfplumber failed: {e}")
        text = ""
        num_pages = 1

    avg_chars = len(text.strip()) / max(num_pages, 1)
    
    if avg_chars < 100:
        logger.info(f"Text extraction weak ({avg_chars:.0f} chars/page). Switching to OCR.")
        text = _ocr_pdf(file_bytes)
    else:
        logger.info(f"Text extraction successful ({avg_chars:.0f} chars/page).")
    
    return text


def _ocr_pdf(file_bytes: bytes) -> str:
    """
    Convert PDF pages to images and run Tesseract OCR.
    """
    try:
        from pdf2image import convert_from_bytes
        import pytesseract
        
        logger.info("Starting OCR on scanned PDF...")
        
        images = convert_from_bytes(
            file_bytes,
            dpi=150,
            fmt='jpeg'
        )
        
        text = ""
        for i, image in enumerate(images):
            logger.info(f"OCR processing page {i+1}/{len(images)}")
            page_text = pytesseract.image_to_string(
                image,
                lang='eng',
                config='--psm 6'
            )
            text += f"\n--- Page {i+1} ---\n"
            text += page_text
        
        logger.info(f"OCR complete. Extracted {len(text)} characters.")
        return text
        
    except Exception as e:
        logger.error(f"OCR failed: {e}")
        return ""
