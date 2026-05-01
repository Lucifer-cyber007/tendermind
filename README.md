# TenderMind AI
### AI-Assisted Government Procurement Evaluation System

> Built for [AI for Bharat] | Team: Aditya Sharma | CRPF Procurement Cell

---

## The Problem

A CRPF procurement officer today spends 2–3 days manually checking 
40 criteria × 15 bidders in a compliance matrix. One mistake becomes 
a vigilance case. TenderMind does the mechanical checking and flags 
only the genuinely hard calls for her review.

**Her signature. Her decision. Her accountability — but with 90% of 
the grunt work already done and a complete audit trail protecting her.**

---

## What It Does

1. Officer uploads tender document (PDF)
2. AI (Groq llama-3.3-70b) extracts all evaluation criteria automatically
3. Officer confirms/edits criteria — stays in control
4. Bidders' documents uploaded — AI reads all of them
5. AI evaluates every criterion × every bidder = full compliance matrix
6. Green = pass, Red = fail, Amber = officer must decide
7. Officer reviews only the hard calls with full AI evidence
8. Complete audit trail PDF generated — protects officer from vigilance cases

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 16, TypeScript, Tailwind CSS |
| Backend | FastAPI, Python, SQLAlchemy |
| Database | PostgreSQL 16 + pgvector |
| AI/LLM | Groq API (llama-3.3-70b-versatile) |
| Queue | Celery + Redis |
| Storage | MinIO (S3-compatible) |
| PDF | ReportLab |
| Deploy | Docker Compose |

---

## Architecture
Officer Browser
↓
Next.js Frontend (port 3000)
↓
FastAPI Backend (port 8000)
↓
┌─────────────────────────────┐
│  PostgreSQL  │  Redis  │  MinIO  │
└─────────────────────────────┘
↓
Celery Workers
↓
Groq API (LLM)

---

## Key Features

- **Three-tier criterion classification** — Mandatory / Preferential / Disqualifying
- **Confidence scoring** — AI shows uncertainty, never hides it
- **Amber cell review** — Officer decides genuinely hard calls
- **Immutable audit trail** — Every decision logged with timestamp
- **PDF report** — Officer certification + DSC compatible
- **Air-gap capable** — Can run with local LLM (Ollama) if needed
- **NIC cloud ready** — Standard Docker deployment

---

## Demo Flow

1. Register as Procurement Officer (CRPF)
2. Create tender → Upload tender PDF
3. AI extracts criteria in ~60 seconds
4. Add bidders → Upload bid documents
5. Confirm criteria → Start Evaluation
6. Review amber cells → Submit decisions
7. Export PDF report

---

## Setup

```bash
# Prerequisites: Docker Desktop, Node.js 18+

# Clone
git clone https://github.com/Lucifer-cyber007/tendermind
cd tendermind

# Start backend services
docker-compose up -d

# Start frontend
cd frontend
npm install
npm run dev

# Visit http://localhost:3000
```

---

## Environment Variables

Copy `backend/.env.example` to `backend/.env` and fill in:
- `GROQ_API_KEY` — Get free at console.groq.com
- `SECRET_KEY` — Any random 64-char string
- MinIO and PostgreSQL credentials (defaults work for local)

---

## Hackathon Evaluation Mapping

| Criteria | Weight | How We Address It |
|----------|--------|-------------------|
| Problem Relevance | 20% | Real CRPF officer pain, vigilance case angle |
| Technical Implementation | 25% | Three-tier classification, confidence scoring, L1 detection |
| Government Deployability | 25% | NIC cloud, air-gap capable, DSC compatible |
| Demo Quality | 15% | End-to-end flow, real documents, AI uncertainty visible |
| Scalability | 15% | Criteria library compounds, ₹15L crore market, GeM path |

---

## Market Context

- Indian government procurement: **₹15 lakh crore annually**
- Central Armed Police Forces: 7 forces, thousands of tenders/year
- Current process: Manual Excel matrix, 2-3 days per tender
- TenderMind target: 30 minutes per tender, zero missed criteria

---

*Built with care for the procurement officers who protect India's borders.*
