"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api, AmberMatrixResponse, Criterion, MatrixCell, User } from "@/lib/api";

type ToastMessage = { id: number; type: "success" | "error"; text: string };
type LoadState = "idle" | "loading" | "success" | "error";
type CriterionKind = "mandatory" | "preferential" | "disqualifying";

const NAVY = "#1B2B5E";
const BG = "#F8FAFC";

const CRITERION_BADGE: Record<CriterionKind, string> = {
  mandatory: "bg-red-100 text-red-700",
  preferential: "bg-blue-100 text-blue-700",
  disqualifying: "bg-gray-900 text-white",
};

function criterionTypeLabel(criterion: Criterion): CriterionKind {
  if (criterion.criterion_type === "hard_binary" && criterion.is_mandatory) return "mandatory";
  if (criterion.criterion_type === "soft_qualitative") return "preferential";
  if (criterion.criterion_type === "documentary" && criterion.is_mandatory) return "disqualifying";
  return criterion.is_mandatory ? "mandatory" : "preferential";
}

function isPendingOfficerReview(cell: MatrixCell): boolean {
  const v = cell.officer_verdict;
  if (v == null || v === "") return true;
  if (v === "qualifying" || v === "disqualifying") return false;
  return true;
}

type AmberRow = AmberMatrixResponse["amber_cells"][number];

export default function OfficerReviewQueuePage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const router = useRouter();

  const [officer, setOfficer] = useState<User | null>(null);
  const [headerLoad, setHeaderLoad] = useState<LoadState>("loading");

  const [amberLoad, setAmberLoad] = useState<LoadState>("idle");
  const [amberPayload, setAmberPayload] = useState<AmberMatrixResponse | null>(null);

  const [criteriaById, setCriteriaById] = useState<Record<string, Criterion>>({});

  const [cardIndex, setCardIndex] = useState(0);
  const [verdict, setVerdict] = useState<"green" | "red" | "">("");
  const [officerNote, setOfficerNote] = useState("");
  const [noteError, setNoteError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const toastIdRef = useRef(0);

  const addToast = (type: ToastMessage["type"], text: string) => {
    toastIdRef.current += 1;
    const nid = toastIdRef.current;
    setToasts((prev) => [...prev, { id: nid, type, text }]);
    window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== nid)), 3200);
  };

  const signOut = () => {
    localStorage.removeItem("token");
    router.push("/login");
  };

  const loadAll = useCallback(async () => {
    if (!id) return;
    try {
      setHeaderLoad("loading");
      const token = localStorage.getItem("token");
      if (!token) {
        router.replace("/login");
        return;
      }
      const [userData, amberData, criteriaList] = await Promise.all([
        api.auth.me(),
        api.evaluation.getAmber(id),
        api.criteria.list(id),
      ]);
      setOfficer(userData);
      setAmberPayload(amberData);
      const map: Record<string, Criterion> = {};
      criteriaList.forEach((c) => {
        map[c.id] = c;
      });
      setCriteriaById(map);
      setHeaderLoad("success");
      setAmberLoad("success");
    } catch (e: unknown) {
      const status = (e as { response?: { status?: number } })?.response?.status;
      if (status === 401) {
        router.replace("/login");
        return;
      }
      setHeaderLoad("error");
      setAmberLoad("error");
      addToast("error", "Could not load review queue.");
    }
  }, [id, router]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const pendingCells = useMemo(() => {
    if (!amberPayload) return [];
    return amberPayload.amber_cells.filter(isPendingOfficerReview);
  }, [amberPayload]);

  const totalFlagged = amberPayload?.amber_cells.length ?? 0;

  const currentCell: AmberRow | undefined = pendingCells[cardIndex];

  useEffect(() => {
    setCardIndex((i) => {
      if (pendingCells.length === 0) return 0;
      return Math.min(i, pendingCells.length - 1);
    });
  }, [pendingCells.length]);

  useEffect(() => {
    setVerdict("");
    setOfficerNote("");
    setNoteError("");
  }, [cardIndex, currentCell?.cell_id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (pendingCells.length <= 1) return;
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setCardIndex((i) => Math.max(0, i - 1));
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        setCardIndex((i) => Math.min(pendingCells.length - 1, i + 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pendingCells.length]);

  const progressTotal = totalFlagged;
  const progressDone = Math.max(0, totalFlagged - pendingCells.length);
  const allDone = amberLoad === "success" && totalFlagged > 0 && pendingCells.length === 0;
  const noAmberEver = amberLoad === "success" && amberPayload && totalFlagged === 0;

  const criterionKindForCell = (cell: AmberRow): CriterionKind => {
    const c = criteriaById[cell.criterion_id];
    if (!c) return "mandatory";
    return criterionTypeLabel(c);
  };

  const confidencePct = (cell: AmberRow) =>
    cell.confidence_score != null ? Math.round(Math.min(1, Math.max(0, cell.confidence_score)) * 100) : null;

  const reasoningText = (cell: AmberRow) => {
    const parts = [cell.flag_detail, cell.extracted_claim].filter(Boolean);
    return parts.join("\n\n").trim() || "The AI identified uncertainty here — review the evidence and record your decision.";
  };

  const noteValid = officerNote.trim().length >= 10;
  const canSubmit = verdict !== "" && !submitting;

  const recordDecision = async () => {
    if (!currentCell) return;
    if (!verdict) return;
    if (!noteValid) {
      setNoteError("Enter at least 10 characters explaining your rationale.");
      return;
    }
    setNoteError("");
    try {
      setSubmitting(true);
      const officerVerdict = verdict === "green" ? "qualifying" : "disqualifying";
      await api.evaluation.decide(id, currentCell.cell_id, officerVerdict, officerNote.trim());
      addToast("success", "Decision recorded.");
      await loadAll();
      setVerdict("");
      setOfficerNote("");
    } catch {
      addToast("error", "Could not record decision. Try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const exportPdf = async () => {
    try {
      const token = localStorage.getItem("token");
      const baseUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
      const response = await fetch(`${baseUrl}/api/v1/reports/${id}/report`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error("fail");
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `tender-report-${id}.pdf`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      addToast("success", "PDF downloaded.");
    } catch {
      addToast("error", "Could not download PDF.");
    }
  };

  if (headerLoad === "loading") {
    return (
      <main className="min-h-screen px-6 pt-24" style={{ backgroundColor: BG }}>
        <div className="mx-auto max-w-3xl animate-pulse space-y-4">
          <div className="h-10 rounded bg-slate-200" />
          <div className="h-4 w-2/3 rounded bg-slate-200" />
          <div className="h-48 rounded bg-slate-200" />
        </div>
      </main>
    );
  }

  if (headerLoad === "error" || !officer) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6" style={{ backgroundColor: BG }}>
        <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-red-800">
          Unable to load session.
          <button type="button" onClick={() => void loadAll()} className="ml-3 text-sm underline">
            Retry
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen" style={{ backgroundColor: BG }}>
      <header className="fixed inset-x-0 top-0 z-40 border-b border-[#E5E7EB] bg-white shadow-sm">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-6 py-3">
          <Link href={`/dashboard/${id}`} className="shrink-0 text-sm font-medium hover:underline" style={{ color: NAVY }}>
            ← Back to Tender
          </Link>
          <h1 className="hidden text-center text-sm font-bold tracking-wide sm:block sm:flex-1" style={{ color: NAVY }}>
            Officer Review Queue
          </h1>
          <div className="flex shrink-0 items-center gap-3">
            <div className="text-right text-xs sm:text-sm">
              <p className="font-semibold text-gray-900">{officer.name}</p>
              <p className="text-gray-500">
                {officer.designation ?? "Officer"} · {officer.department ?? "—"}
              </p>
            </div>
            <button
              type="button"
              onClick={signOut}
              className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 sm:text-sm"
            >
              Sign Out
            </button>
          </div>
        </div>
        <div className="mx-auto max-w-5xl px-6 pb-3 sm:hidden">
          <p className="text-center text-sm font-bold" style={{ color: NAVY }}>
            Officer Review Queue
          </p>
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-6 pb-16 pt-28">
        {!noAmberEver && !allDone && amberLoad === "success" ? (
          <div className="mb-6">
            <div className="mb-2 flex items-center justify-between text-sm text-gray-600">
              <span>
                {progressDone} of {progressTotal} decisions made
              </span>
              {progressDone === progressTotal && progressTotal > 0 ? (
                <span className="font-medium text-green-700">Queue complete</span>
              ) : null}
            </div>
            <div className="h-3 w-full overflow-hidden rounded-full bg-slate-200">
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{
                  width: `${progressTotal ? Math.min(100, (progressDone / progressTotal) * 100) : 0}%`,
                  backgroundColor: NAVY,
                }}
              />
            </div>
          </div>
        ) : null}

        {amberLoad === "loading" ? (
          <div className="space-y-4">
            <div className="h-40 animate-pulse rounded-xl bg-slate-200" />
            <div className="h-40 animate-pulse rounded-xl bg-slate-200" />
          </div>
        ) : null}

        {amberLoad === "error" ? (
          <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-red-800">
            Failed to load amber cells.
            <button type="button" className="ml-2 underline" onClick={() => void loadAll()}>
              Retry
            </button>
          </div>
        ) : null}

        {noAmberEver ? (
          <div className="rounded-xl border border-gray-200 bg-white p-10 text-center shadow-sm">
            <svg viewBox="0 0 64 64" className="mx-auto h-16 w-16 text-green-600" fill="none" aria-hidden>
              <circle cx="32" cy="32" r="30" stroke="currentColor" strokeWidth="2" />
              <path
                d="M18 34l8 8 20-22"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <h2 className="mt-4 text-xl font-semibold" style={{ color: NAVY }}>
              No items flagged for review
            </h2>
            <p className="mt-2 text-gray-600">All criteria were evaluated with high confidence</p>
            <Link
              href={`/dashboard/${id}?tab=matrix`}
              className="mt-8 inline-flex rounded-xl px-6 py-3 text-sm font-semibold text-white"
              style={{ backgroundColor: NAVY }}
            >
              View Evaluation Matrix
            </Link>
          </div>
        ) : null}

        {allDone ? (
          <div className="rounded-xl border border-gray-200 bg-white p-10 text-center shadow-sm">
            <svg viewBox="0 0 64 64" className="mx-auto h-20 w-20 text-green-600" fill="none" aria-hidden>
              <circle cx="32" cy="32" r="28" stroke="currentColor" strokeWidth="2" />
              <path
                d="M18 34l10 10 18-20"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <h2 className="mt-4 text-2xl font-bold" style={{ color: NAVY }}>
              Review Complete
            </h2>
            <p className="mt-2 text-gray-600">
              You have reviewed all {progressTotal} flagged item{progressTotal === 1 ? "" : "s"}
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
              <Link
                href={`/dashboard/${id}?tab=matrix`}
                className="inline-flex flex-1 justify-center rounded-xl border border-gray-200 px-5 py-3 text-sm font-semibold text-[#1B2B5E] hover:bg-gray-50 sm:flex-none"
              >
                View Full Matrix
              </Link>
              <button
                type="button"
                onClick={() => void exportPdf()}
                className="inline-flex flex-1 justify-center rounded-xl px-5 py-3 text-sm font-semibold text-white sm:flex-none"
                style={{ backgroundColor: NAVY }}
              >
                Export Report
              </button>
            </div>
          </div>
        ) : null}

        {!noAmberEver && !allDone && currentCell && amberLoad === "success" ? (
          <article className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <span
                className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide ${CRITERION_BADGE[criterionKindForCell(currentCell)]}`}
              >
                {criterionKindForCell(currentCell)}
              </span>
              <span className="text-sm text-gray-500">
                Item {cardIndex + 1} of {pendingCells.length}
              </span>
            </div>

            <p className="mt-4 text-base font-bold leading-relaxed" style={{ color: NAVY }}>
              {currentCell.criterion_text}
            </p>

            <div className="mt-4 text-sm">
              <span className="text-gray-600">Bidder:</span>{" "}
              <span className="font-bold text-gray-900">{currentCell.bidder_name}</span>
            </div>

            <div className="mt-6 rounded-xl bg-slate-100 p-4">
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-gray-500">AI Assessment</p>
              <p className="mt-2 font-medium text-amber-700">Flagged for review</p>
              <div className="mt-3">
                <div className="mb-1 h-2 w-full overflow-hidden rounded-full bg-white">
                  <div
                    className="h-full rounded-full bg-amber-400 transition-all"
                    style={{ width: `${confidencePct(currentCell) ?? 50}%` }}
                  />
                </div>
                <p className="text-sm text-gray-700">
                  {confidencePct(currentCell) != null
                    ? `${confidencePct(currentCell)}% confidence — too uncertain to auto-decide`
                    : "Confidence unavailable — manual review required"}
                </p>
              </div>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-gray-800">{reasoningText(currentCell)}</p>
            </div>

            <div className="mt-4 rounded-lg bg-slate-200/80 p-4 font-mono text-xs text-gray-800">
              <p className="mb-2 text-[10px] font-sans font-semibold uppercase tracking-wide text-gray-600">
                Evidence found in bid document
              </p>
              {currentCell.source_text_snippet && currentCell.source_text_snippet.trim() !== "" ? (
                <p className="whitespace-pre-wrap">{currentCell.source_text_snippet}</p>
              ) : (
                <p className="italic text-gray-500">Not found</p>
              )}
            </div>

            <div className="mt-8 border-t border-gray-100 pt-6">
              <h3 className="text-lg font-semibold" style={{ color: NAVY }}>
                Your Decision
              </h3>
              <p className="mt-1 text-sm text-gray-500">This decision will be recorded in the audit trail</p>

              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setVerdict("green")}
                  className={`rounded-xl px-4 py-4 text-center text-sm font-semibold text-white ${
                    verdict === "green" ? "ring-2 ring-offset-2 ring-green-600" : ""
                  }`}
                  style={{ backgroundColor: verdict === "green" ? "#15803d" : "#22c55e" }}
                >
                  ✓ Qualify this bidder
                </button>
                <button
                  type="button"
                  onClick={() => setVerdict("red")}
                  className={`rounded-xl px-4 py-4 text-center text-sm font-semibold text-white ${
                    verdict === "red" ? "ring-2 ring-offset-2 ring-red-700" : ""
                  }`}
                  style={{ backgroundColor: verdict === "red" ? "#b91c1c" : "#ef4444" }}
                >
                  ✗ Disqualify this bidder
                </button>
              </div>

              <textarea
                value={officerNote}
                onChange={(e) => {
                  setOfficerNote(e.target.value);
                  if (noteError) setNoteError("");
                }}
                rows={4}
                placeholder="Enter your rationale for this decision (required)"
                className={`mt-4 w-full rounded-xl border px-3 py-3 text-sm ${
                  noteError ? "border-red-500 ring-1 ring-red-200" : "border-gray-200"
                }`}
              />
              {noteError ? <p className="mt-1 text-sm text-red-600">{noteError}</p> : null}

              <button
                type="button"
                disabled={!canSubmit}
                onClick={() => void recordDecision()}
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                style={{ backgroundColor: NAVY }}
              >
                {submitting ? (
                  <>
                    <svg className="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      />
                    </svg>
                    Recording…
                  </>
                ) : (
                  "Record Decision →"
                )}
              </button>
            </div>

            {pendingCells.length > 1 ? (
              <div className="mt-8 flex flex-wrap items-center justify-between gap-4 border-t border-gray-100 pt-6">
                <button
                  type="button"
                  onClick={() => setCardIndex((i) => Math.max(0, i - 1))}
                  disabled={cardIndex === 0}
                  className="text-sm font-medium text-[#3B82F6] disabled:opacity-40"
                >
                  ← Previous
                </button>
                <span className="text-sm text-gray-600">
                  {cardIndex + 1} / {pendingCells.length}
                </span>
                <button
                  type="button"
                  onClick={() => setCardIndex((i) => Math.min(pendingCells.length - 1, i + 1))}
                  disabled={cardIndex >= pendingCells.length - 1}
                  className="text-sm font-medium text-[#3B82F6] disabled:opacity-40"
                >
                  Next →
                </button>
              </div>
            ) : null}
          </article>
        ) : null}
      </div>

      <div className="fixed right-4 top-24 z-[60] flex w-full max-w-sm flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`rounded-lg border px-3 py-2 text-sm shadow ${
              toast.type === "success" ? "border-green-200 bg-green-50 text-green-800" : "border-red-200 bg-red-50 text-red-800"
            }`}
          >
            {toast.text}
          </div>
        ))}
      </div>
    </main>
  );
}
