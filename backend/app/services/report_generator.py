"""
Audit report generator.
Produces a structured PDF report for the tender file.
Format mirrors CVC-accepted tender evaluation reports.
"""
import io
from datetime import datetime
from typing import List, Optional
from xml.sax.saxutils import escape
import pytz

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.colors import HexColor, black, white
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Table, TableStyle,
    Spacer, HRFlowable, PageBreak,
)
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT

IST = pytz.timezone("Asia/Kolkata")

# Colour palette
DARK_NAVY = HexColor("#1B2A4A")
MID_BLUE = HexColor("#185FA5")
LIGHT_BLUE = HexColor("#E6F1FB")
GREEN = HexColor("#3B6D11")
LIGHT_GREEN = HexColor("#EAF3DE")
RED = HexColor("#A32D2D")
LIGHT_RED = HexColor("#FCEBEB")
AMBER = HexColor("#854F0B")
LIGHT_AMBER = HexColor("#FAEEDA")
LIGHT_GREY = HexColor("#F1EFE8")
MID_GREY = HexColor("#888780")


def fmt_enum(val):
    if val is None:
        return "—"
    s = str(val)
    if "." in s:
        s = s.split(".")[-1]
    return s.replace("_", " ").title()


class AuditReportGenerator:
    """
    Generates the official evaluation report PDF.
    This document is appended to the tender file and submitted to CVC.
    """

    def generate(self, tender_data: dict) -> bytes:
        """
        Generate the full audit report as PDF bytes.

        tender_data structure:
        {
            "tender": {...},
            "officer": {...},
            "criteria": [...],
            "bidders": [...],
            "matrix": [[cell, ...], ...],  # criteria × bidders
            "decision_log": [...],
            "generated_at": datetime,
        }
        """
        buffer = io.BytesIO()
        doc = SimpleDocTemplate(
            buffer,
            pagesize=A4,
            leftMargin=2 * cm,
            rightMargin=2 * cm,
            topMargin=2.5 * cm,
            bottomMargin=2.5 * cm,
        )

        styles = self._build_styles()
        story = []

        # ── Cover page ──
        story.extend(self._cover_page(tender_data, styles))
        story.append(PageBreak())

        # ── Section 1: Tender details ──
        story.extend(self._tender_details_section(tender_data, styles))
        story.append(Spacer(1, 0.5 * cm))

        # ── Section 2: Evaluation summary ──
        story.extend(self._summary_section(tender_data, styles))
        story.append(PageBreak())

        # ── Section 3: Criteria list (officer-confirmed) ──
        story.extend(self._criteria_section(tender_data, styles))
        story.append(PageBreak())

        # ── Section 4: Compliance matrix ──
        story.extend(self._matrix_section(tender_data, styles))
        story.append(PageBreak())

        # ── Section 5: Decision log ──
        story.extend(self._decision_log_section(tender_data, styles))
        story.append(PageBreak())

        # ── Section 6: Officer certification ──
        story.extend(self._certification_section(tender_data, styles))

        doc.build(story, onFirstPage=self._header_footer, onLaterPages=self._header_footer)
        return buffer.getvalue()

    def _cover_page(self, data: dict, styles: dict) -> list:
        tender = data["tender"]
        officer = data["officer"]
        story = []

        story.append(Spacer(1, 2 * cm))
        story.append(Paragraph("GOVERNMENT OF INDIA", styles["dept_label"]))
        story.append(Paragraph(tender.get("department", ""), styles["dept_name"]))
        story.append(Spacer(1, 1 * cm))
        story.append(HRFlowable(width="100%", thickness=2, color=DARK_NAVY))
        story.append(Spacer(1, 0.5 * cm))
        story.append(Paragraph("TENDER EVALUATION REPORT", styles["report_title"]))
        story.append(Paragraph("(Prepared with AI-assisted evaluation — TenderMind AI)", styles["report_subtitle"]))
        story.append(Spacer(1, 1 * cm))
        story.append(HRFlowable(width="100%", thickness=1, color=MID_GREY))
        story.append(Spacer(1, 0.5 * cm))

        cover_data = [
            ["Tender Title", tender.get("title", "")],
            ["Tender Number", tender.get("tender_number", "")],
            ["Tender Type", tender.get("tender_type", "")],
            ["Evaluation Officer", officer.get("name", "")],
            ["Designation", officer.get("designation", "")],
            ["Report Generated", data.get("generated_at", datetime.now(IST)).strftime("%d %B %Y, %H:%M IST")],
        ]
        t = Table(cover_data, colWidths=[5 * cm, 12 * cm])
        t.setStyle(TableStyle([
            ("FONT", (0, 0), (-1, -1), "Helvetica", 10),
            ("FONT", (0, 0), (0, -1), "Helvetica-Bold", 10),
            ("TEXTCOLOR", (0, 0), (0, -1), DARK_NAVY),
            ("ROWBACKGROUNDS", (0, 0), (-1, -1), [white, LIGHT_GREY]),
            ("GRID", (0, 0), (-1, -1), 0.25, MID_GREY),
            ("TOPPADDING", (0, 0), (-1, -1), 6),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ]))
        story.append(t)
        story.append(Spacer(1, 1.5 * cm))
        story.append(Paragraph(
            "This report constitutes the official evaluation record for the above tender. "
            "Every finding has been reviewed and confirmed by the signing officer. "
            "AI-generated evaluations marked as such in the Decision Log.",
            styles["disclaimer"],
        ))
        return story

    def _tender_details_section(self, data: dict, styles: dict) -> list:
        story = [Paragraph("1. Tender Details", styles["section_heading"])]
        tender = data["tender"]
        bidders = data.get("bidders", [])
        story.append(Paragraph(f"Number of bidders: {len(bidders)}", styles["body"]))
        story.append(Paragraph(f"Number of evaluation criteria: {len(data.get('criteria', []))}", styles["body"]))
        return story

    def _summary_section(self, data: dict, styles: dict) -> list:
        story = [Paragraph("2. Evaluation Summary", styles["section_heading"])]
        bidders = data.get("bidders", [])
        criteria = data.get("criteria", [])
        matrix = data.get("matrix", {}) or {}
        mandatory_by_criterion_id = {
            str(c.get("id")): bool(c.get("is_mandatory"))
            for c in criteria
        }
        has_any_bid_amount = any(b.get("bid_amount") not in (None, "") for b in bidders)
        has_any_rank = any(b.get("rank") not in (None, "") for b in bidders)
        show_pricing_columns = has_any_bid_amount or has_any_rank

        if show_pricing_columns:
            summary_data = [["Bidder", "Bid Amount", "Rank", "Status"]]
            col_widths = [7 * cm, 3.5 * cm, 2 * cm, 4.5 * cm]
        else:
            summary_data = [["Bidder", "Status"]]
            col_widths = [12 * cm, 5 * cm]
        summary_cell_style = ParagraphStyle(
            "summary_cell",
            parent=styles["body"],
            fontName="Helvetica",
            fontSize=9,
            leading=11,
            wordWrap="CJK",
        )
        for b in sorted(bidders, key=lambda x: x.get("rank") or 99):
            bidder_id = str(b.get("id"))
            bidder_cells = []
            for key, cell in matrix.items():
                if not isinstance(cell, dict):
                    continue
                try:
                    criterion_id, cell_bidder_id = str(key).split("_", 1)
                except ValueError:
                    continue
                if cell_bidder_id != bidder_id:
                    continue
                bidder_cells.append((criterion_id, cell))

            has_mandatory_fail = any(
                mandatory_by_criterion_id.get(criterion_id, False)
                and str(
                    cell.get("officer_verdict") or cell.get("ai_verdict") or ""
                ).lower() in {"red", "fail", "disqualifying"}
                for criterion_id, cell in bidder_cells
            )

            if has_mandatory_fail:
                status = "Fail"
            else:
                status = "Pass"
            bid_amount_value = (
                f"₹{b['bid_amount']:,.2f}" if b.get("bid_amount") is not None else "Not entered"
            )
            rank_value = f"L{b['rank']}" if b.get("rank") is not None else "Not assigned"
            if show_pricing_columns:
                summary_data.append([
                    Paragraph(str(b.get("name", "—")), summary_cell_style),
                    Paragraph(bid_amount_value, summary_cell_style),
                    Paragraph(rank_value, summary_cell_style),
                    Paragraph(status, summary_cell_style),
                ])
            else:
                summary_data.append([
                    Paragraph(str(b.get("name", "—")), summary_cell_style),
                    Paragraph(status, summary_cell_style),
                ])

        t = Table(summary_data, colWidths=col_widths)
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), DARK_NAVY),
            ("TEXTCOLOR", (0, 0), (-1, 0), white),
            ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 9),
            ("FONT", (0, 1), (-1, -1), "Helvetica", 9),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [white, LIGHT_GREY]),
            ("GRID", (0, 0), (-1, -1), 0.25, MID_GREY),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ]))
        story.append(t)
        return story

    def _criteria_section(self, data: dict, styles: dict) -> list:
        story = [Paragraph("3. Evaluation Criteria (Officer-Confirmed)", styles["section_heading"])]
        story.append(Paragraph(
            "The following criteria were extracted from the tender document, cross-referenced "
            "with GFR/CVC standing rules, and confirmed by the evaluation officer before evaluation began.",
            styles["body"],
        ))
        story.append(Spacer(1, 0.3 * cm))

        crit_data = [["#", "Criterion", "Type", "Source", "Threshold", "Mandatory"]]
        cell_style = ParagraphStyle(
            "criteria_cell",
            parent=styles["body"],
            fontName="Helvetica",
            fontSize=7.5,
            leading=9,
            wordWrap="CJK",
        )
        for i, c in enumerate(data.get("criteria", []), 1):
            crit_data.append([
                Paragraph(str(i), cell_style),
                Paragraph((c.get("criterion_text") or "—"), cell_style),
                Paragraph(fmt_enum(c.get("criterion_type")), cell_style),
                Paragraph(fmt_enum(c.get("source")), cell_style),
                Paragraph((c.get("threshold") or "—"), cell_style),
                Paragraph("Yes" if c.get("is_mandatory") else "No", cell_style),
            ])

        t = Table(crit_data, colWidths=[0.8 * cm, 6.3 * cm, 2.2 * cm, 1.7 * cm, 3.0 * cm, 2.0 * cm])
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), MID_BLUE),
            ("TEXTCOLOR", (0, 0), (-1, 0), white),
            ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 8),
            ("FONT", (0, 1), (-1, -1), "Helvetica", 7.5),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [white, LIGHT_BLUE]),
            ("GRID", (0, 0), (-1, -1), 0.25, MID_GREY),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("LEFTPADDING", (0, 0), (-1, -1), 5),
            ("RIGHTPADDING", (0, 0), (-1, -1), 5),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ]))
        story.append(t)
        return story

    def _matrix_section(self, data: dict, styles: dict) -> list:
        story = [Paragraph("4. Compliance Matrix", styles["section_heading"])]
        story.append(Paragraph("✓ = Pass  ✗ = Fail  ? = Ambiguous  – = Not addressed", styles["legend"]))
        story.append(Spacer(1, 0.3 * cm))

        criteria = data.get("criteria", [])
        bidders = data.get("bidders", [])
        matrix = data.get("matrix", {})

        if not criteria or not bidders:
            story.append(Paragraph("No matrix data available.", styles["body"]))
            return story

        # Table width must match the SimpleDocTemplate frame (A4 − left/right margins).
        usable_pt = A4[0] - 4 * cm
        n_bidders = len(bidders)
        min_bidder_pt = 1.25 * cm
        max_crit_pt = usable_pt - n_bidders * min_bidder_pt
        criterion_pt = max(4.2 * cm, min(8.5 * cm, max_crit_pt))
        bidder_pt = (usable_pt - criterion_pt) / n_bidders
        if bidder_pt < min_bidder_pt:
            bidder_pt = min_bidder_pt
            criterion_pt = usable_pt - n_bidders * bidder_pt
        col_widths = [criterion_pt] + [bidder_pt] * n_bidders

        matrix_crit_style = ParagraphStyle(
            "matrix_crit",
            parent=styles["body"],
            fontName="Helvetica",
            fontSize=7,
            leading=8.5,
            alignment=TA_LEFT,
            wordWrap="CJK",
        )
        matrix_sym_style = ParagraphStyle(
            "matrix_sym",
            parent=styles["body"],
            fontName="Helvetica",
            fontSize=7.5,
            leading=9,
            alignment=TA_CENTER,
            wordWrap="CJK",
        )
        hdr_crit = ParagraphStyle(
            "matrix_hdr_crit",
            fontName="Helvetica-Bold",
            fontSize=7,
            leading=8,
            textColor=white,
            alignment=TA_LEFT,
        )
        hdr_bid = ParagraphStyle(
            "matrix_hdr_bid",
            fontName="Helvetica-Bold",
            fontSize=7,
            leading=8,
            textColor=white,
            alignment=TA_CENTER,
            wordWrap="CJK",
        )

        header = [Paragraph("Criterion", hdr_crit)] + [
            Paragraph(escape(str(b.get("name") or "—")), hdr_bid) for b in bidders
        ]
        matrix_data = [header]

        verdict_symbols = {"pass": "✓", "fail": "✗", "ambiguous": "?", "missing": "–", None: "—"}

        for c in criteria:
            crit_text = escape(str(c.get("criterion_text") or "—"))
            row = [Paragraph(crit_text, matrix_crit_style)]
            for b in bidders:
                cell = matrix.get(f"{c['id']}_{b['id']}")
                raw_verdict = None
                if cell and isinstance(cell, dict):
                    raw_verdict = cell.get("ai_verdict")
                    if hasattr(raw_verdict, "value"):
                        raw_verdict = raw_verdict.value
                symbol = verdict_symbols.get(raw_verdict, "—")
                if cell and isinstance(cell, dict) and cell.get("officer_verdict"):
                    symbol = f"[{symbol}]"
                row.append(Paragraph(escape(symbol), matrix_sym_style))
            matrix_data.append(row)

        t = Table(matrix_data, colWidths=col_widths, repeatRows=1)
        style_cmds = [
            ("BACKGROUND", (0, 0), (-1, 0), MID_BLUE),
            ("TEXTCOLOR", (0, 0), (-1, 0), white),
            ("GRID", (0, 0), (-1, -1), 0.25, MID_GREY),
            ("ALIGN", (1, 0), (-1, -1), "CENTER"),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("LEFTPADDING", (0, 0), (-1, -1), 4),
            ("RIGHTPADDING", (0, 0), (-1, -1), 4),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [white, LIGHT_GREY]),
        ]
        t.setStyle(TableStyle(style_cmds))
        story.append(t)
        story.append(Paragraph("[x] = Officer reviewed and confirmed", styles["legend"]))
        return story

    def _decision_log_section(self, data: dict, styles: dict) -> list:
        story = [Paragraph("5. Decision Log", styles["section_heading"])]
        story.append(Paragraph(
            "Immutable record of all actions taken during evaluation. "
            "Every entry is timestamped in IST and attributed to either the AI system or the evaluation officer.",
            styles["body"],
        ))
        story.append(Spacer(1, 0.3 * cm))

        log_data = [["Timestamp (IST)", "Actor", "Action", "Summary"]]
        log_cell_style = ParagraphStyle(
            "log_cell",
            parent=styles["body"],
            fontName="Helvetica",
            fontSize=8,
            leading=10,
            wordWrap="CJK",
        )
        for entry in data.get("decision_log", []):
            ts = entry.get("timestamp")
            if isinstance(ts, datetime):
                ts_str = ts.strftime("%d-%m-%Y %H:%M")
            else:
                ts_str = str(ts)
            log_data.append([
                Paragraph(ts_str, log_cell_style),
                Paragraph(str(entry.get("actor_name") or entry.get("actor_ai_version") or "System"), log_cell_style),
                Paragraph(str(entry.get("action_type", "")), log_cell_style),
                Paragraph(str(entry.get("summary") or ""), log_cell_style),
            ])

        t = Table(log_data, colWidths=[3.2 * cm, 2.8 * cm, 3.4 * cm, 7.2 * cm])
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), DARK_NAVY),
            ("TEXTCOLOR", (0, 0), (-1, 0), white),
            ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 8),
            ("FONT", (0, 1), (-1, -1), "Helvetica", 8),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [white, LIGHT_GREY]),
            ("GRID", (0, 0), (-1, -1), 0.25, MID_GREY),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("LEFTPADDING", (0, 0), (-1, -1), 5),
            ("RIGHTPADDING", (0, 0), (-1, -1), 5),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ]))
        story.append(t)
        return story

    def _certification_section(self, data: dict, styles: dict) -> list:
        officer = data.get("officer", {})
        tender = data.get("tender", {})
        story = [Paragraph("6. Officer Certification", styles["section_heading"])]
        story.append(Paragraph(
            f"I, {officer.get('name', '_______________')}, {officer.get('designation', '')}, "
            f"hereby certify that the evaluation of bids received against Tender No. "
            f"{tender.get('tender_number', '')} has been carried out in accordance with "
            "the prescribed procedure and the criteria specified in the tender document. "
            "The AI-assisted evaluation has been reviewed and I take full responsibility "
            "for all decisions recorded in this report.",
            styles["body"],
        ))
        story.append(Spacer(1, 2 * cm))
        story.append(Paragraph("Signature: _______________________________", styles["body"]))
        story.append(Spacer(1, 0.3 * cm))
        story.append(Paragraph(f"Name: {officer.get('name', '')}", styles["body"]))
        story.append(Paragraph(f"Designation: {officer.get('designation', '')}", styles["body"]))
        story.append(Paragraph(f"Department: {officer.get('department', '')}", styles["body"]))
        story.append(Paragraph(f"Date: {datetime.now(IST).strftime('%d %B %Y')}", styles["body"]))
        story.append(Spacer(1, 1 * cm))
        story.append(Paragraph("(Space for Digital Signature Certificate — DSC compatible)", styles["disclaimer"]))
        return story

    def _header_footer(self, canvas, doc):
        canvas.saveState()
        # Header
        canvas.setFillColor(DARK_NAVY)
        canvas.rect(0, A4[1] - 1.5 * cm, A4[0], 1.5 * cm, fill=1, stroke=0)
        canvas.setFillColor(white)
        canvas.setFont("Helvetica-Bold", 9)
        canvas.drawString(2 * cm, A4[1] - 1 * cm, "TenderMind AI — Evaluation Report")
        canvas.setFont("Helvetica", 8)
        canvas.drawRightString(A4[0] - 2 * cm, A4[1] - 1 * cm, "CONFIDENTIAL — For official use only")
        # Footer
        canvas.setFillColor(DARK_NAVY)
        canvas.setFont("Helvetica", 8)
        canvas.drawString(2 * cm, 1 * cm, f"Page {doc.page}")
        canvas.drawRightString(A4[0] - 2 * cm, 1 * cm, "Generated by TenderMind AI · Data within department boundary")
        canvas.restoreState()

    def _build_styles(self) -> dict:
        base = getSampleStyleSheet()
        return {
            "dept_label": ParagraphStyle("dept_label", fontSize=10, textColor=MID_GREY, alignment=TA_CENTER, spaceAfter=4),
            "dept_name": ParagraphStyle("dept_name", fontSize=16, textColor=DARK_NAVY, fontName="Helvetica-Bold", alignment=TA_CENTER, spaceAfter=6),
            "report_title": ParagraphStyle("report_title", fontSize=20, textColor=DARK_NAVY, fontName="Helvetica-Bold", alignment=TA_CENTER, spaceAfter=4),
            "report_subtitle": ParagraphStyle("report_subtitle", fontSize=10, textColor=MID_GREY, alignment=TA_CENTER, spaceAfter=12),
            "section_heading": ParagraphStyle("section_heading", fontSize=12, textColor=DARK_NAVY, fontName="Helvetica-Bold", spaceBefore=12, spaceAfter=6, borderPad=4),
            "body": ParagraphStyle("body", fontSize=9, textColor=black, leading=14, spaceAfter=4),
            "legend": ParagraphStyle("legend", fontSize=8, textColor=MID_GREY, spaceAfter=4),
            "disclaimer": ParagraphStyle("disclaimer", fontSize=8, textColor=MID_GREY, leading=12),
        }


report_generator = AuditReportGenerator()