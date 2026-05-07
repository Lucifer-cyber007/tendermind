"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { ChangeEvent, DragEvent, FormEvent, Suspense, useEffect, useMemo, useRef, useState } from "react";

import { api, apiClient, Bidder, Criterion, DecisionLogResponse, MatrixByBidder, MatrixCell, MatrixResponse, Tender, User } from "@/lib/api";

type TabKey = "overview" | "upload" | "bidders" | "criteria" | "matrix" | "report";
type LoadState = "idle" | "loading" | "success" | "error";
type DocStatus = "pending" | "processing" | "done" | "failed" | "not_uploaded";

interface ToastMessage {
  id: number;
  type: "success" | "error";
  text: string;
}

interface BidderDocState {
  status: DocStatus;
  pageCount?: number;
  error?: string;
  fileName?: string;
}

interface MatrixRow {
  criterionId: string;
  criterionText: string;
  cellsByBidder: Record<string, MatrixCell | null>;
}

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "upload", label: "Upload Document" },
  { key: "bidders", label: "Bidders" },
  { key: "criteria", label: "Criteria" },
  { key: "matrix", label: "Evaluation Matrix" },
  { key: "report", label: "Report" },
];

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  criteria_confirmed: "bg-blue-100 text-blue-700",
  evaluation_active: "bg-amber-100 text-amber-700",
  awaiting_approval: "bg-blue-100 text-blue-700",
  closed: "bg-green-100 text-green-700",
};

const CRITERION_TYPE_STYLE: Record<string, string> = {
  mandatory: "bg-red-100 text-red-700",
  preferential: "bg-blue-100 text-blue-700",
  disqualifying: "bg-gray-900 text-white",
};

const DEPARTMENTS = [
  "CRPF",
  "BSF",
  "CISF",
  "ITBP",
  "SSB",
  "NSG",
  "Assam Rifles",
  "Coast Guard",
  "MHA",
  "MoD",
  "Other",
];

function toStatusDisplay(status: string | undefined) {
  if (!status) return "Draft";
  return status.replaceAll("_", " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function normalizeDocStatus(raw?: string): DocStatus {
  if (!raw) return "not_uploaded";
  if (raw === "pending") return "pending";
  if (raw === "processing") return "processing";
  if (raw === "completed" || raw === "done") return "done";
  if (raw === "failed") return "failed";
  return "pending";
}

function criterionTypeLabel(criterion: Criterion) {
  if (criterion.criterion_type === "hard_binary" && criterion.is_mandatory) return "mandatory";
  if (criterion.criterion_type === "soft_qualitative") return "preferential";
  if (criterion.criterion_type === "documentary" && criterion.is_mandatory) return "disqualifying";
  return criterion.is_mandatory ? "mandatory" : "preferential";
}

function criterionTypeToBackend(value: "mandatory" | "preferential" | "disqualifying") {
  if (value === "preferential") return "soft_qualitative";
  if (value === "disqualifying") return "documentary";
  return "hard_binary";
}

function decisionTone(verdict?: string | null) {
  if (verdict === "red" || verdict === "fail" || verdict === "disqualifying") return "text-red-700";
  if (verdict === "amber" || verdict === "ambiguous" || verdict === "missing" || verdict === "deferred") return "text-amber-700";
  if (verdict === "green" || verdict === "pass" || verdict === "qualifying") return "text-green-700";
  return "text-gray-500";
}

function verdictSymbol(verdict?: string | null) {
  if (verdict === "green" || verdict === "pass" || verdict === "qualifying") return "✓";
  if (verdict === "red" || verdict === "fail" || verdict === "disqualifying") return "✗";
  if (verdict === "amber" || verdict === "ambiguous" || verdict === "missing" || verdict === "deferred") return "?";
  return "•";
}

function SimpleIcon({
  path,
  className,
}: {
  path: string;
  className?: string;
}) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className ?? "h-4 w-4"} stroke="currentColor" strokeWidth="2">
      <path d={path} />
    </svg>
  );
}

interface TenderDetailViewProps {
  tenderId?: string;
  embedded?: boolean;
  onBackToList?: () => void;
}

export function TenderDetailView({ tenderId, embedded = false, onBackToList }: TenderDetailViewProps) {
  const params = useParams<{ id: string }>();
  const id = tenderId ?? params?.id ?? "";
  const router = useRouter();
  const searchParams = useSearchParams();

  const [activeTab, setActiveTab] = useState<TabKey>("overview");

  const [officer, setOfficer] = useState<User | null>(null);
  const [tender, setTender] = useState<Tender | null>(null);
  const [tenderLoad, setTenderLoad] = useState<LoadState>("loading");
  const [tenderNotFound, setTenderNotFound] = useState(false);

  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const toastIdRef = useRef(0);

  const [criteriaLoad, setCriteriaLoad] = useState<LoadState>("idle");
  const [criteria, setCriteria] = useState<Criterion[]>([]);

  const [biddersLoad, setBiddersLoad] = useState<LoadState>("idle");
  const [bidders, setBidders] = useState<Bidder[]>([]);
  const [bidderDocs, setBidderDocs] = useState<Record<string, BidderDocState>>({});

  const [matrixLoad, setMatrixLoad] = useState<LoadState>("idle");
  const [matrixData, setMatrixData] = useState<MatrixResponse | null>(null);

  const [reportLoad, setReportLoad] = useState<LoadState>("idle");
  const [decisionLog, setDecisionLog] = useState<DecisionLogResponse["decision_log"]>([]);

  const [tenderDocStatus, setTenderDocStatus] = useState<{
    status: DocStatus;
    pageCount?: number;
    error?: string;
  }>({ status: "not_uploaded" });
  const [selectedTenderFile, setSelectedTenderFile] = useState<File | null>(null);
  const [uploadingTenderDoc, setUploadingTenderDoc] = useState(false);

  const [bidderFormCollapsed, setBidderFormCollapsed] = useState(false);
  const [bidderName, setBidderName] = useState("");
  const [bidderCompany, setBidderCompany] = useState("");
  const [bidderEmail, setBidderEmail] = useState("");
  const [creatingBidder, setCreatingBidder] = useState(false);

  const [manualCriterionOpen, setManualCriterionOpen] = useState(false);
  const [manualDescription, setManualDescription] = useState("");
  const [manualType, setManualType] = useState<"mandatory" | "preferential" | "disqualifying">("mandatory");
  const [manualSource, setManualSource] = useState("");
  const [creatingCriterion, setCreatingCriterion] = useState(false);

  const [editingCriterionId, setEditingCriterionId] = useState<string | null>(null);
  const [editingCriterionText, setEditingCriterionText] = useState("");
  const [editingCriterionType, setEditingCriterionType] = useState<"mandatory" | "preferential" | "disqualifying">(
    "mandatory"
  );

  const [startingEvaluation, setStartingEvaluation] = useState(false);
  const [matrixPolling, setMatrixPolling] = useState(false);

  const [selectedAmberCell, setSelectedAmberCell] = useState<{
    cell: MatrixCell;
    bidderName: string;
    criterionText: string;
  } | null>(null);
  const [officerDecision, setOfficerDecision] = useState<"green" | "red" | "">("");
  const [officerNote, setOfficerNote] = useState("");
  const [decisionSubmitting, setDecisionSubmitting] = useState(false);
  const [decisionValidation, setDecisionValidation] = useState("");

  const [downloadingReport, setDownloadingReport] = useState(false);
  const [, setError] = useState("");

  const addToast = (type: ToastMessage["type"], text: string) => {
    toastIdRef.current += 1;
    const idValue = toastIdRef.current;
    setToasts((prev) => [...prev, { id: idValue, type, text }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== idValue));
    }, 3000);
  };

  const signOut = () => {
    localStorage.removeItem("token");
    router.push("/login");
  };

  const loadHeaderData = async () => {
    try {
      setTenderLoad("loading");
      const token = localStorage.getItem("token");
      if (!token) {
        router.replace("/login");
        return;
      }
      const [userData, tenderData] = await Promise.all([api.auth.me(), api.tenders.get(id)]);
      setOfficer(userData);
      setTender(tenderData);
      setTenderLoad("success");
      setTenderNotFound(false);
    } catch (error: any) {
      const status = error?.response?.status;
      if (status === 401) {
        router.replace("/login");
        return;
      }
      if (status === 404) {
        setTenderNotFound(true);
        setTenderLoad("success");
        return;
      }
      setTenderLoad("error");
    }
  };

  const loadCriteria = async () => {
    try {
      setCriteriaLoad("loading");
      const data = await api.criteria.list(id);
      setCriteria(data);
      setCriteriaLoad("success");
    } catch {
      setCriteriaLoad("error");
    }
  };

  const loadBidders = async () => {
    try {
      setBiddersLoad("loading");
      const data = await api.bidders.list(id);
      setBidders(data);
      setBiddersLoad("success");
    } catch {
      setBiddersLoad("error");
    }
  };

  const loadMatrix = async () => {
    try {
      setMatrixLoad("loading");
      const data = await api.evaluation.getMatrix(id);
      setMatrixData(data);
      setMatrixLoad("success");
    } catch {
      setMatrixLoad("error");
    }
  };

  const loadDecisionLog = async () => {
    try {
      setReportLoad("loading");
      const data = await api.reports.getDecisionLog(id);
      setDecisionLog(data.decision_log ?? []);
      setReportLoad("success");
    } catch {
      setReportLoad("error");
    }
  };

  const loadTenderDocumentStatus = async () => {
    try {
      const { data } = await apiClient.get(`/tenders/${id}/document/status`);
      setTenderDocStatus({
        status: normalizeDocStatus(String(data?.status ?? "")),
        pageCount: data?.page_count ?? undefined,
        error: data?.error ?? undefined,
      });
    } catch (error: any) {
      if (error?.response?.status === 404) {
        setTenderDocStatus({ status: "not_uploaded" });
      } else {
        setTenderDocStatus((prev) => ({ ...prev, status: "failed", error: "Could not fetch status" }));
      }
    }
  };

  const loadBidderDocStatus = async (bidderId: string) => {
    try {
      const { data } = await apiClient.get(`/bidders/${id}/bidders/${bidderId}/document/status`);
      setBidderDocs((prev) => ({
        ...prev,
        [bidderId]: {
          ...prev[bidderId],
          status: normalizeDocStatus(String(data?.status ?? "")),
          pageCount: data?.page_count ?? undefined,
          error: data?.error ?? undefined,
        },
      }));
    } catch (error: any) {
      if (error?.response?.status === 404) {
        setBidderDocs((prev) => ({ ...prev, [bidderId]: { status: "not_uploaded" } }));
      } else {
        setBidderDocs((prev) => ({
          ...prev,
          [bidderId]: {
            status: "failed",
            error: "Status unavailable",
          },
        }));
      }
    }
  };

  useEffect(() => {
    if (!id) return;
    void loadHeaderData();
  }, [id]);

  useEffect(() => {
    const tab = searchParams.get("tab");
    if (!tab) return;
    const key = tab as TabKey;
    if (TABS.some((t) => t.key === key)) {
      setActiveTab(key);
    }
  }, [searchParams]);

  useEffect(() => {
    if (tenderLoad !== "success" || tenderNotFound) return;
    if (activeTab === "overview" || activeTab === "criteria") {
      void loadCriteria();
    }
    if (activeTab === "overview" || activeTab === "bidders") {
      void loadBidders();
    }
    if (activeTab === "upload" || activeTab === "overview") {
      void loadTenderDocumentStatus();
    }
    if (activeTab === "matrix") {
      void loadMatrix();
    }
    if (activeTab === "report") {
      void loadDecisionLog();
    }
  }, [activeTab, tenderLoad, tenderNotFound]);

  useEffect(() => {
    if (activeTab !== "upload") return;
    if (!["pending", "processing"].includes(tenderDocStatus.status)) return;
    const interval = window.setInterval(() => {
      void loadTenderDocumentStatus();
    }, 3000);
    return () => window.clearInterval(interval);
  }, [activeTab, tenderDocStatus.status]);

  useEffect(() => {
    if (activeTab !== "bidders" || bidders.length === 0) return;
    bidders.forEach((bidder) => {
      if (!bidderDocs[bidder.id]) {
        void loadBidderDocStatus(bidder.id);
      }
    });
  }, [activeTab, bidders]);

  useEffect(() => {
    if (activeTab !== "bidders") return;
    const hasProcessing = Object.values(bidderDocs).some(
      (state) => state.status === "pending" || state.status === "processing"
    );
    if (!hasProcessing) return;
    const interval = window.setInterval(() => {
      bidders.forEach((bidder) => {
        void loadBidderDocStatus(bidder.id);
      });
    }, 3000);
    return () => window.clearInterval(interval);
  }, [activeTab, bidderDocs, bidders]);

  useEffect(() => {
    if (activeTab !== "matrix" || !matrixPolling) return;
    const interval = window.setInterval(async () => {
      const data = await api.evaluation.getMatrix(id);
      setMatrixData(data);
      const hasCells = data.bidders.some((bidder) => bidder.cells.length > 0);
      if (hasCells) {
        setMatrixPolling(false);
      }
    }, 5000);
    return () => window.clearInterval(interval);
  }, [activeTab, matrixPolling, id]);

  const criteriaConfirmedCount = useMemo(
    () => criteria.filter((criterion) => criterion.confirmed_by_officer).length,
    [criteria]
  );
  const matrixCompletionPercent = useMemo(() => {
    if (criteria.length === 0) return 0;
    return Math.round((criteriaConfirmedCount / criteria.length) * 100);
  }, [criteria.length, criteriaConfirmedCount]);

  const matrixRows: MatrixRow[] = useMemo(() => {
    if (!matrixData) return [];
    const rowsMap = new Map<string, MatrixRow>();
    matrixData.bidders.forEach((bidder) => {
      bidder.cells.forEach((cell) => {
        if (!rowsMap.has(cell.criterion_id)) {
          rowsMap.set(cell.criterion_id, {
            criterionId: cell.criterion_id,
            criterionText: cell.criterion_text,
            cellsByBidder: {},
          });
        }
        rowsMap.get(cell.criterion_id)!.cellsByBidder[bidder.bidder_id] = cell;
      });
    });
    const rows = Array.from(rowsMap.values());
    rows.sort((a, b) => a.criterionText.localeCompare(b.criterionText));
    return rows;
  }, [matrixData]);

  const reportSummary = useMemo(() => {
    let qualified = 0;
    let disqualified = 0;
    decisionLog.forEach((entry) => {
      const verdict = String((entry.after_state as any)?.officer_verdict ?? "").toLowerCase();
      if (verdict === "qualifying") qualified += 1;
      if (verdict === "disqualifying") disqualified += 1;
    });
    return {
      total: decisionLog.length,
      qualified,
      disqualified,
    };
  }, [decisionLog]);

  const nextStepGuidance = useMemo(() => {
    if (!tender) return "";
    if (tender.status === "closed") return "This tender is closed. View the final report.";
    if (tender.status === "evaluation_active") return "AI has identified matrix findings. Review flagged cells.";
    if (tender.status === "awaiting_approval") return "Awaiting your review of flagged cells before closure.";
    if (tender.status === "criteria_confirmed") return "Run evaluation matrix to identify bidder compliance findings.";
    if (tender.status === "draft") {
      if (tenderDocStatus.status === "not_uploaded") return "Upload the tender document to begin.";
      if (tenderDocStatus.status === "pending" || tenderDocStatus.status === "processing") {
        return "Document is being processed...";
      }
      if (criteria.length > 0 && criteriaConfirmedCount < criteria.length) {
        return "Review and confirm extracted criteria.";
      }
    }
    return "Continue reviewing criteria and bidder documents.";
  }, [tender, tenderDocStatus.status, criteria.length, criteriaConfirmedCount]);

  const uploadTenderDocument = async () => {
    if (!selectedTenderFile) {
      addToast("error", "Select a PDF file before upload.");
      return;
    }
    if (selectedTenderFile.type !== "application/pdf") {
      addToast("error", "Only PDF files are accepted.");
      return;
    }
    try {
      setUploadingTenderDoc(true);
      await api.tenders.uploadDocument(id, selectedTenderFile);
      setTenderDocStatus({ status: "pending" });
      addToast("success", "Document uploaded. AI processing has started.");
      setSelectedTenderFile(null);
      await loadTenderDocumentStatus();
    } catch {
      addToast("error", "Upload failed. Please try again.");
    } finally {
      setUploadingTenderDoc(false);
    }
  };

  const createBidder = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!bidderName.trim() || !bidderCompany.trim()) {
      addToast("error", "Name and company are required.");
      return;
    }
    try {
      setCreatingBidder(true);
      await api.bidders.create(id, {
        name: bidderName.trim(),
        company: bidderCompany.trim(),
        email: bidderEmail.trim() || undefined,
      });
      setBidderName("");
      setBidderCompany("");
      setBidderEmail("");
      await loadBidders();
      addToast("success", "Bidder added.");
    } catch {
      addToast("error", "Could not add bidder.");
    } finally {
      setCreatingBidder(false);
    }
  };

  const onBidderDocSelect = async (bidderId: string, event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      await api.bidders.uploadDocument(id, bidderId, file);
      setBidderDocs((prev) => ({
        ...prev,
        [bidderId]: {
          status: "pending",
          fileName: file.name,
        },
      }));
      addToast("success", "Bidder document uploaded.");
    } catch {
      addToast("error", "Could not upload bidder document.");
    }
  };

  const deleteBidder = async (bidderId: string) => {
    const ok = window.confirm("Remove this bidder?");
    if (!ok) return;
    try {
      await apiClient.delete(`/bidders/${id}/bidders/${bidderId}`);
      await loadBidders();
      addToast("success", "Bidder removed.");
    } catch {
      addToast("error", "Could not remove bidder.");
    }
  };

  const confirmAllCriteria = async () => {
    try {
      await api.criteria.confirmAll(id);
      await loadCriteria();
      await loadHeaderData();
      addToast("success", "All criteria confirmed.");
    } catch {
      addToast("error", "Could not confirm all criteria.");
    }
  };

  const confirmCriterion = async (criterionId: string) => {
    try {
      await api.criteria.confirm(id, criterionId);
      await loadCriteria();
      addToast("success", "Criterion confirmed.");
    } catch {
      addToast("error", "Could not confirm criterion.");
    }
  };

  const startEditCriterion = (criterion: Criterion) => {
    setEditingCriterionId(criterion.id);
    setEditingCriterionText(criterion.criterion_text);
    setEditingCriterionType(criterionTypeLabel(criterion) as "mandatory" | "preferential" | "disqualifying");
  };

  const saveCriterionEdit = async (criterionId: string) => {
    try {
      await apiClient.put(`/criteria/${id}/criteria/${criterionId}`, {
        criterion_text: editingCriterionText,
        is_mandatory: editingCriterionType !== "preferential",
      });
      setEditingCriterionId(null);
      await loadCriteria();
      addToast("success", "Criterion updated.");
    } catch {
      addToast("error", "Could not update criterion.");
    }
  };

  const deleteCriterion = async (criterionId: string) => {
    const ok = window.confirm("Delete this criterion?");
    if (!ok) return;
    try {
      await apiClient.delete(`/criteria/${id}/criteria/${criterionId}`);
      await loadCriteria();
      addToast("success", "Criterion deleted.");
    } catch {
      addToast("error", "Could not delete criterion.");
    }
  };

  const addManualCriterion = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!manualDescription.trim()) {
      addToast("error", "Description is required.");
      return;
    }
    try {
      setCreatingCriterion(true);
      await apiClient.post(`/criteria/${id}/criteria`, {
        criterion_text: manualDescription.trim(),
        criterion_type: criterionTypeToBackend(manualType),
        threshold: manualSource.trim() || undefined,
        is_mandatory: manualType !== "preferential",
      });
      setManualDescription("");
      setManualSource("");
      setManualType("mandatory");
      setManualCriterionOpen(false);
      await loadCriteria();
      addToast("success", "Manual criterion added.");
    } catch {
      addToast("error", "Could not add criterion.");
    } finally {
      setCreatingCriterion(false);
    }
  };

  const startEvaluation = async () => {
    try {
      setStartingEvaluation(true);
      await api.tenders.startEvaluation(id);
      addToast("success", "Evaluation started. AI is identifying findings.");
      setMatrixPolling(true);
      await loadMatrix();
      await loadHeaderData();
    } catch (err: unknown) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ||
        "Could not start evaluation.";
      addToast("error", detail);
    } finally {
      setStartingEvaluation(false);
    }
  };

  const submitOfficerDecision = async () => {
    if (!selectedAmberCell) return;
    if (!officerDecision || !officerNote.trim()) {
      setDecisionValidation("Decision rationale is required.");
      return;
    }
    try {
      setDecisionSubmitting(true);
      setDecisionValidation("");
      await apiClient.put(`/evaluation/${id}/matrix/${selectedAmberCell.cell.cell_id}/decide`, {
        officer_verdict: officerDecision === "green" ? "qualifying" : "disqualifying",
        officer_note: officerNote.trim(),
      });
      addToast("success", "Your decision has been recorded.");
      setSelectedAmberCell(null);
      setOfficerDecision("");
      setOfficerNote("");
      await loadMatrix();
      await loadDecisionLog();
    } catch {
      setDecisionValidation("Could not submit your decision.");
    } finally {
      setDecisionSubmitting(false);
    }
  };

  const handleExportPDF = async () => {
    try {
      setDownloadingReport(true);
      const token = localStorage.getItem("token");
      const baseUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
      const response = await fetch(`${baseUrl}/api/v1/reports/${id}/report`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (!response.ok) throw new Error("Export failed");
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `tender-report-${id}.pdf`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      addToast("success", "PDF report downloaded.");
    } catch (err) {
      console.error("PDF export error:", err);
      setError("Could not export PDF report.");
      addToast("error", "Could not export PDF report.");
    } finally {
      setDownloadingReport(false);
    }
  };

  const onTenderDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    setSelectedTenderFile(file);
  };

  const openAmberCell = (bidder: MatrixByBidder, cell: MatrixCell) => {
    if (!(cell.ai_verdict === "ambiguous" || cell.ai_verdict === "missing" || cell.flag_type !== "none")) return;
    setSelectedAmberCell({
      bidderName: bidder.bidder_name,
      criterionText: cell.criterion_text,
      cell,
    });
    setOfficerDecision("");
    setOfficerNote("");
    setDecisionValidation("");
  };

  if (tenderLoad === "loading") {
    return (
      <main className="min-h-screen bg-[#F8FAFC] px-6 pt-24">
        <div className="mx-auto max-w-7xl animate-pulse space-y-4">
          <div className="h-10 w-1/2 rounded bg-slate-200" />
          <div className="h-20 rounded bg-slate-200" />
          <div className="h-12 rounded bg-slate-200" />
          <div className="h-64 rounded bg-slate-200" />
        </div>
      </main>
    );
  }

  if (tenderNotFound) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#F8FAFC] p-6">
        <div className="rounded-xl border border-gray-200 bg-white p-8 text-center shadow-sm">
          <h1 className="text-2xl font-semibold text-[#1B2B5E]">Tender not found</h1>
          <Link href="/dashboard" className="mt-4 inline-block text-sm font-medium text-[#3B82F6] hover:underline">
            Back to Dashboard
          </Link>
        </div>
      </main>
    );
  }

  if (tenderLoad === "error" || !tender) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#F8FAFC] p-6">
        <div className="rounded-xl border border-red-200 bg-red-50 p-8 text-center text-red-700">
          Failed to load tender details.
          <button
            onClick={() => void loadHeaderData()}
            className="ml-3 rounded-lg border border-red-200 bg-white px-3 py-1 text-sm"
          >
            Retry
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#F8FAFC]">
      <header className="fixed inset-x-0 top-0 z-40 border-b border-[#E5E7EB] bg-white shadow-sm">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-4">
            {embedded ? (
              <button onClick={onBackToList} className="text-sm font-medium text-[#1B2B5E] hover:underline">
                ← Back to Tenders
              </button>
            ) : (
              <Link href="/dashboard" className="text-sm font-medium text-[#1B2B5E] hover:underline">
                ← Back to Dashboard
              </Link>
            )}
            <div>
              <p className="text-lg font-bold tracking-wide text-[#1B2B5E]">TenderMind</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <p className="text-sm font-semibold text-gray-900">{officer?.name ?? "Officer"}</p>
              <p className="text-xs text-gray-500">
                {officer?.designation ?? "Designation"} · {officer?.department ?? "Department"}
              </p>
            </div>
            <button
              onClick={signOut}
              className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Sign Out
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-6 pb-10 pt-24">
        <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h1 className="text-3xl font-bold text-[#1B2B5E]">{tender.title}</h1>
          <p className="mt-1 font-mono text-sm text-gray-500">{tender.tender_number}</p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <span className="text-sm text-gray-700">{tender.department}</span>
            <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_BADGE[tender.status] ?? "bg-gray-100 text-gray-700"}`}>
              {toStatusDisplay(tender.status)}
            </span>
          </div>
          {tender.notes ? <p className="mt-3 text-sm text-gray-600">{tender.notes}</p> : null}
        </section>

        <section className="sticky top-[60px] z-30 mt-4 border-b border-gray-200 bg-[#F8FAFC]">
          <div className="flex flex-wrap gap-5">
            {TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`border-b-2 pb-2 pt-2 text-sm font-medium ${
                  activeTab === tab.key
                    ? "border-[#1B2B5E] text-[#1B2B5E]"
                    : "border-transparent text-gray-500 hover:text-gray-700"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </section>

        <section className="mt-5">
          {activeTab === "overview" ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <div className="rounded-xl border border-gray-200 bg-white p-4">
                  <p className="text-sm text-gray-500">Created date</p>
                  <p className="mt-2 font-medium text-gray-900">
                    {new Date(tender.created_at).toLocaleDateString("en-GB", {
                      day: "2-digit",
                      month: "short",
                      year: "numeric",
                    })}
                  </p>
                </div>
                <div className="rounded-xl border border-gray-200 bg-white p-4">
                  <p className="text-sm text-gray-500">Status</p>
                  <p className="mt-2 font-medium text-gray-900">{toStatusDisplay(tender.status)}</p>
                </div>
                <div className="rounded-xl border border-gray-200 bg-white p-4">
                  <p className="text-sm text-gray-500">Description</p>
                  <p className="mt-2 font-medium text-gray-900">{tender.notes || "No description added"}</p>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <div className="rounded-xl border border-gray-200 bg-white p-4">
                  <p className="text-sm text-gray-500">Criteria count</p>
                  <p className="mt-2 text-2xl font-semibold text-[#1B2B5E]">{criteria.length}</p>
                </div>
                <div className="rounded-xl border border-gray-200 bg-white p-4">
                  <p className="text-sm text-gray-500">Bidder count</p>
                  <p className="mt-2 text-2xl font-semibold text-[#1B2B5E]">{bidders.length}</p>
                </div>
                <div className="rounded-xl border border-gray-200 bg-white p-4">
                  <p className="text-sm text-gray-500">Matrix completion</p>
                  <p className="mt-2 text-2xl font-semibold text-[#1B2B5E]">{matrixCompletionPercent}%</p>
                </div>
              </div>

              <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
                <p className="text-sm font-semibold text-[#1B2B5E]">Next step guidance</p>
                <div className="mt-2 space-y-2 text-sm text-blue-900">
                  {tender.status === "evaluation_active" ? (
                    <p>
                      AI has identified matrix findings. Open the{" "}
                      <Link href={`/dashboard/${id}/review`} className="font-semibold text-[#3B82F6] underline">
                        Officer Review Queue
                      </Link>{" "}
                      or view the{" "}
                      <Link href={`/dashboard/${id}/summary`} className="font-semibold text-[#3B82F6] underline">
                        Evaluation Summary
                      </Link>
                      .
                    </p>
                  ) : null}
                  {tender.status === "awaiting_approval" ? (
                    <p>
                      Complete outstanding checks in the{" "}
                      <Link href={`/dashboard/${id}/review`} className="font-semibold text-[#3B82F6] underline">
                        Officer Review Queue
                      </Link>
                      , then review the{" "}
                      <Link href={`/dashboard/${id}/summary`} className="font-semibold text-[#3B82F6] underline">
                        Evaluation Summary
                      </Link>
                      .
                    </p>
                  ) : null}
                  {tender.status === "criteria_confirmed" ? (
                    <p>
                      Run evaluation from the{" "}
                      <button
                        type="button"
                        onClick={() => setActiveTab("matrix")}
                        className="font-semibold text-[#3B82F6] underline"
                      >
                        Evaluation Matrix
                      </button>{" "}
                      tab, then use the{" "}
                      <Link href={`/dashboard/${id}/summary`} className="font-semibold text-[#3B82F6] underline">
                        Evaluation Summary
                      </Link>{" "}
                      when results are ready.
                    </p>
                  ) : null}
                  {!["evaluation_active", "awaiting_approval", "criteria_confirmed"].includes(tender.status) ? (
                    <p>{nextStepGuidance}</p>
                  ) : null}
                </div>
              </div>
              {tender.status !== "draft" ? (
                <div className="mt-4 flex flex-row flex-wrap gap-3">
                  <Link
                    href={`/dashboard/${id}/summary`}
                    className="inline-flex items-center justify-center rounded-lg bg-[#1B2B5E] px-4 py-2 text-sm font-medium text-white hover:bg-[#16264f]"
                  >
                    View Evaluation Summary
                  </Link>
                  <Link
                    href={`/dashboard/${id}/review`}
                    className="inline-flex items-center justify-center rounded-lg bg-[#1B2B5E] px-4 py-2 text-sm font-medium text-white hover:bg-[#16264f]"
                  >
                    Officer Review Queue
                  </Link>
                </div>
              ) : null}
            </div>
          ) : null}

          {activeTab === "upload" ? (
            <div className="space-y-4">
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={onTenderDrop}
                className="rounded-xl border-2 border-dashed border-gray-300 bg-white p-10 text-center"
              >
                <svg viewBox="0 0 64 64" className="mx-auto h-14 w-14 text-gray-400" fill="none">
                  <path d="M16 52h32a6 6 0 0 0 6-6V22l-12-12H16a6 6 0 0 0-6 6v30a6 6 0 0 0 6 6Z" stroke="currentColor" strokeWidth="2" />
                  <path d="M42 10v12h12" stroke="currentColor" strokeWidth="2" />
                  <path d="M32 42V26m0 0-6 6m6-6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <p className="mt-4 text-sm text-gray-700">Drag and drop tender PDF here, or click to browse</p>
                <input
                  type="file"
                  accept="application/pdf"
                  onChange={(e) => setSelectedTenderFile(e.target.files?.[0] ?? null)}
                  className="mx-auto mt-4 block text-sm"
                />
                {selectedTenderFile ? (
                  <p className="mt-3 text-sm text-gray-600">
                    {selectedTenderFile.name} · {(selectedTenderFile.size / 1024).toFixed(1)} KB
                  </p>
                ) : null}
                <button
                  onClick={uploadTenderDocument}
                  disabled={uploadingTenderDoc}
                  className="mt-5 rounded-lg bg-[#1B2B5E] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#16264f] disabled:opacity-70"
                >
                  {uploadingTenderDoc ? "Uploading..." : "Upload Document"}
                </button>
              </div>

              <div className="rounded-xl border border-gray-200 bg-white p-4">
                {tenderDocStatus.status === "pending" ? (
                  <p className="text-sm text-gray-600">⏳ Waiting to process...</p>
                ) : null}
                {tenderDocStatus.status === "processing" ? (
                  <p className="text-sm text-blue-700">
                    🔄 Extracting criteria with AI... this may take a minute
                  </p>
                ) : null}
                {tenderDocStatus.status === "done" ? (
                  <p className="text-sm text-green-700">
                    ✅ Document processed successfully.
                    {criteria.length > 0 ? ` ${criteria.length} criteria identified.` : ""}
                  </p>
                ) : null}
                {tenderDocStatus.status === "failed" ? (
                  <p className="text-sm text-red-700">
                    ❌ Processing failed. Please try uploading again.
                    {tenderDocStatus.error ? ` (${tenderDocStatus.error})` : ""}
                  </p>
                ) : null}
                {tenderDocStatus.status === "not_uploaded" ? (
                  <p className="text-sm text-gray-600">No tender document uploaded yet.</p>
                ) : null}
              </div>
            </div>
          ) : null}

          {activeTab === "bidders" ? (
            <div className="space-y-4">
              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <button
                  onClick={() => setBidderFormCollapsed((prev) => !prev)}
                  className="text-sm font-medium text-[#1B2B5E]"
                >
                  {bidderFormCollapsed ? "Show Add Bidder Form" : "Hide Add Bidder Form"}
                </button>
                {!bidderFormCollapsed ? (
                  <form onSubmit={createBidder} className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
                    <input
                      value={bidderName}
                      onChange={(e) => setBidderName(e.target.value)}
                      placeholder="Name"
                      className="rounded-lg border border-gray-200 px-3 py-2.5 text-sm"
                      required
                    />
                    <input
                      value={bidderCompany}
                      onChange={(e) => setBidderCompany(e.target.value)}
                      placeholder="Company"
                      className="rounded-lg border border-gray-200 px-3 py-2.5 text-sm"
                      required
                    />
                    <input
                      value={bidderEmail}
                      onChange={(e) => setBidderEmail(e.target.value)}
                      placeholder="Email (optional)"
                      className="rounded-lg border border-gray-200 px-3 py-2.5 text-sm"
                    />
                    <div className="md:col-span-3">
                      <button
                        type="submit"
                        disabled={creatingBidder}
                        className="rounded-lg bg-[#1B2B5E] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#16264f] disabled:opacity-70"
                      >
                        {creatingBidder ? "Adding..." : "Add Bidder"}
                      </button>
                    </div>
                  </form>
                ) : null}
              </div>

              {biddersLoad === "loading" ? (
                <div className="animate-pulse rounded-xl border border-gray-200 bg-white p-8 text-sm text-gray-400">
                  Loading bidders...
                </div>
              ) : null}
              {biddersLoad === "error" ? (
                <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                  Failed to load bidders.
                  <button onClick={() => void loadBidders()} className="ml-3 underline">
                    Retry
                  </button>
                </div>
              ) : null}
              {biddersLoad === "success" && bidders.length === 0 ? (
                <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
                  No bidders added yet
                </div>
              ) : null}

              {biddersLoad === "success" && bidders.length > 0 ? (
                <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
                  <table className="min-w-full text-left text-sm">
                    <thead className="bg-gray-50 text-gray-600">
                      <tr>
                        <th className="px-4 py-3">Name</th>
                        <th className="px-4 py-3">Company</th>
                        <th className="px-4 py-3">Email</th>
                        <th className="px-4 py-3">Document</th>
                        <th className="px-4 py-3">Status</th>
                        <th className="px-4 py-3">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bidders.map((bidder) => {
                        const state = bidderDocs[bidder.id] ?? { status: "not_uploaded" as DocStatus };
                        const [legacyName, legacyCompanyFromName] = bidder.name.split(" (");
                        const company =
                          bidder.company ||
                          (legacyCompanyFromName ? legacyCompanyFromName.replace(")", "") : "—");
                        const displayName = bidder.company ? bidder.name : legacyName;
                        return (
                          <tr key={bidder.id} className="border-t border-gray-100">
                            <td className="px-4 py-3">{displayName}</td>
                            <td className="px-4 py-3 text-gray-600">{company}</td>
                            <td className="px-4 py-3 text-gray-600">{bidder.email || "—"}</td>
                            <td className="px-4 py-3">
                              {state.status === "not_uploaded" ? (
                                <label className="cursor-pointer text-[#3B82F6] hover:underline">
                                  Upload
                                  <input
                                    type="file"
                                    accept="application/pdf"
                                    className="hidden"
                                    onChange={(event) => void onBidderDocSelect(bidder.id, event)}
                                  />
                                </label>
                              ) : (
                                <span className="text-gray-600">{state.fileName || "Uploaded"}</span>
                              )}
                            </td>
                            <td className="px-4 py-3">
                              <span
                                className={`rounded-full px-2 py-1 text-xs font-medium ${
                                  state.status === "done"
                                    ? "bg-green-100 text-green-700"
                                    : state.status === "failed"
                                    ? "bg-red-100 text-red-700"
                                    : state.status === "processing"
                                    ? "bg-blue-100 text-blue-700"
                                    : "bg-gray-100 text-gray-600"
                                }`}
                              >
                                {state.status}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              <button onClick={() => void deleteBidder(bidder.id)} className="text-red-600 hover:underline">
                                Delete
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          ) : null}

          {activeTab === "criteria" ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white p-4">
                <p className="text-sm text-gray-700">
                  {criteriaConfirmedCount} of {criteria.length} criteria confirmed
                </p>
                <button
                  onClick={confirmAllCriteria}
                  disabled={criteria.length === 0}
                  className="rounded-lg bg-[#1B2B5E] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#16264f] disabled:opacity-60"
                >
                  Confirm All
                </button>
              </div>

              {criteriaLoad === "loading" ? (
                <div className="animate-pulse rounded-xl border border-gray-200 bg-white p-8 text-sm text-gray-400">
                  Loading criteria...
                </div>
              ) : null}
              {criteriaLoad === "error" ? (
                <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                  Failed to load criteria.
                  <button onClick={() => void loadCriteria()} className="ml-3 underline">
                    Retry
                  </button>
                </div>
              ) : null}

              {criteriaLoad === "success" && criteria.length === 0 ? (
                <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
                  Upload and process the tender document first to extract criteria automatically
                </div>
              ) : null}

              {criteriaLoad === "success" && criteria.length > 0 ? (
                <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
                  <table className="min-w-full text-left text-sm">
                    <thead className="bg-gray-50 text-gray-600">
                      <tr>
                        <th className="w-10 px-4 py-3">#</th>
                        <th className="min-w-[300px] px-4 py-3">Criterion</th>
                        <th className="min-w-[120px] px-4 py-3">Type</th>
                        <th className="min-w-[100px] px-4 py-3">Source</th>
                        <th className="min-w-[100px] px-4 py-3">Threshold</th>
                        <th className="min-w-[120px] whitespace-nowrap px-4 py-3">Mandatory</th>
                        <th className="px-4 py-3">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {criteria.map((criterion, index) => {
                        const typeLabel = criterionTypeLabel(criterion) as "mandatory" | "preferential" | "disqualifying";
                        const isEditing = editingCriterionId === criterion.id;
                        return (
                          <tr key={criterion.id} className="border-t border-gray-100 align-top">
                            <td className="px-4 py-3 text-gray-500">{index + 1}</td>
                            <td className="min-w-[300px] px-4 py-3">
                              {isEditing ? (
                                <textarea
                                  value={editingCriterionText}
                                  onChange={(e) => setEditingCriterionText(e.target.value)}
                                  rows={3}
                                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                                />
                              ) : (
                                <span className="block truncate text-gray-900" title={criterion.criterion_text}>
                                  {criterion.criterion_text}
                                </span>
                              )}
                            </td>
                            <td className="min-w-[120px] px-4 py-3">
                              {isEditing ? (
                                <select
                                  value={editingCriterionType}
                                  onChange={(e) =>
                                    setEditingCriterionType(e.target.value as "mandatory" | "preferential" | "disqualifying")
                                  }
                                  className="rounded-lg border border-gray-200 px-3 py-2 text-sm"
                                >
                                  <option value="mandatory">mandatory</option>
                                  <option value="preferential">preferential</option>
                                  <option value="disqualifying">disqualifying</option>
                                </select>
                              ) : (
                                <span className={`whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ${CRITERION_TYPE_STYLE[typeLabel]}`}>
                                  {typeLabel}
                                </span>
                              )}
                            </td>
                            <td className="min-w-[100px] px-4 py-3 text-gray-600">
                              {criterion.source_section || criterion.source || "—"}
                            </td>
                            <td className="min-w-[100px] px-4 py-3 text-gray-600">{criterion.threshold || "—"}</td>
                            <td className="min-w-[120px] whitespace-nowrap px-4 py-3">
                              {criterion.is_mandatory ? (
                                <span className="text-green-700">Yes</span>
                              ) : (
                                <span className="text-gray-500">No</span>
                              )}
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex flex-wrap gap-2">
                                {!criterion.confirmed_by_officer ? (
                                  <button
                                    onClick={() => void confirmCriterion(criterion.id)}
                                    className="rounded-lg border border-green-200 bg-green-50 px-3 py-1.5 text-xs font-medium text-green-700"
                                  >
                                    Confirm
                                  </button>
                                ) : null}
                                {isEditing ? (
                                  <>
                                    <button
                                      onClick={() => void saveCriterionEdit(criterion.id)}
                                      className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700"
                                    >
                                      Save
                                    </button>
                                    <button
                                      onClick={() => setEditingCriterionId(null)}
                                      className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-600"
                                    >
                                      Cancel
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    onClick={() => startEditCriterion(criterion)}
                                    className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-700"
                                  >
                                    Edit
                                  </button>
                                )}
                                <button
                                  onClick={() => void deleteCriterion(criterion.id)}
                                  className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700"
                                >
                                  Delete
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : null}

              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <button onClick={() => setManualCriterionOpen((prev) => !prev)} className="text-sm font-medium text-[#1B2B5E]">
                  {manualCriterionOpen ? "Hide Manual Criterion Form" : "Add Manual Criterion"}
                </button>
                {manualCriterionOpen ? (
                  <form onSubmit={addManualCriterion} className="mt-4 space-y-3">
                    <textarea
                      value={manualDescription}
                      onChange={(e) => setManualDescription(e.target.value)}
                      rows={3}
                      placeholder="Criterion description"
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                    />
                    <select
                      value={manualType}
                      onChange={(e) => setManualType(e.target.value as "mandatory" | "preferential" | "disqualifying")}
                      className="rounded-lg border border-gray-200 px-3 py-2 text-sm"
                    >
                      <option value="mandatory">mandatory</option>
                      <option value="preferential">preferential</option>
                      <option value="disqualifying">disqualifying</option>
                    </select>
                    <input
                      value={manualSource}
                      onChange={(e) => setManualSource(e.target.value)}
                      placeholder="Source text (optional)"
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                    />
                    <button
                      type="submit"
                      disabled={creatingCriterion}
                      className="rounded-lg bg-[#1B2B5E] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#16264f] disabled:opacity-70"
                    >
                      {creatingCriterion ? "Adding..." : "Add Criterion"}
                    </button>
                  </form>
                ) : null}
              </div>
            </div>
          ) : null}

          {activeTab === "matrix" ? (
            <div className="space-y-4">
              {matrixLoad === "loading" ? (
                <div className="animate-pulse rounded-xl border border-gray-200 bg-white p-8 text-sm text-gray-400">
                  Loading matrix...
                </div>
              ) : null}
              {matrixLoad === "error" ? (
                <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                  Failed to load matrix.
                  <button onClick={() => void loadMatrix()} className="ml-3 underline">
                    Retry
                  </button>
                </div>
              ) : null}

              {matrixLoad === "success" && (!matrixData || matrixData.bidders.length === 0 || matrixRows.length === 0) ? (
                <div className="rounded-xl border border-gray-200 bg-white p-8 text-center">
                  <p className="text-sm text-gray-600">No matrix cells available yet.</p>
                  <button
                    onClick={startEvaluation}
                    disabled={startingEvaluation}
                    className="mt-4 rounded-lg bg-[#1B2B5E] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#16264f] disabled:opacity-70"
                  >
                    {startingEvaluation ? "Starting..." : "Start Evaluation"}
                  </button>
                </div>
              ) : null}

              {matrixLoad === "success" && matrixData && matrixRows.length > 0 ? (
                <>
                  <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
                    <table className="min-w-full text-left text-sm">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-3">Criterion</th>
                          {matrixData.bidders.map((bidder) => (
                            <th key={bidder.bidder_id} className="px-4 py-3">
                              {bidder.bidder_name}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {matrixRows.map((row) => (
                          <tr key={row.criterionId} className="border-t border-gray-100">
                            <td className="px-4 py-3 text-gray-700">{row.criterionText.slice(0, 40)}</td>
                            {matrixData.bidders.map((bidder) => {
                              const cell = row.cellsByBidder[bidder.bidder_id];
                              const verdict = cell?.ai_verdict?.toString().toLowerCase() ?? "";
                              const cls =
                                verdict === "pass"
                                  ? "bg-green-50 text-green-700"
                                  : verdict === "fail"
                                  ? "bg-red-50 text-red-700"
                                  : verdict
                                  ? "bg-amber-50 text-amber-700"
                                  : "bg-gray-50 text-gray-400";
                              const clickable =
                                !!cell &&
                                (verdict === "ambiguous" || verdict === "missing" || (cell.flag_type && cell.flag_type !== "none"));
                              return (
                                <td key={bidder.bidder_id} className="px-4 py-3">
                                  <button
                                    disabled={!clickable}
                                    onClick={() => cell && openAmberCell(bidder, cell)}
                                    className={`w-full rounded-lg px-2 py-2 text-center ${cls} ${
                                      clickable ? "cursor-pointer hover:ring-2 hover:ring-amber-200" : "cursor-default"
                                    }`}
                                  >
                                    <div className="text-lg font-semibold">{verdictSymbol(verdict)}</div>
                                    <div className="text-[11px]">
                                      {cell?.confidence_score != null ? `${Math.round(cell.confidence_score * 100)}%` : "—"}
                                    </div>
                                  </button>
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex flex-row flex-wrap gap-3">
                    <Link
                      href={`/dashboard/${id}/summary`}
                      className="inline-flex items-center justify-center rounded-lg bg-[#1B2B5E] px-4 py-2 text-sm font-medium text-white hover:bg-[#16264f]"
                    >
                      View Evaluation Summary
                    </Link>
                    <Link
                      href={`/dashboard/${id}/review`}
                      className="inline-flex items-center justify-center rounded-lg bg-[#1B2B5E] px-4 py-2 text-sm font-medium text-white hover:bg-[#16264f]"
                    >
                      Officer Review Queue
                    </Link>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}

          {activeTab === "report" ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white p-4">
                <div className="flex flex-wrap gap-4 text-sm">
                  <span>Total decisions: <strong>{reportSummary.total}</strong></span>
                  <span className="text-green-700">Qualified: <strong>{reportSummary.qualified}</strong></span>
                  <span className="text-red-700">Disqualified: <strong>{reportSummary.disqualified}</strong></span>
                </div>
                <button
                  onClick={handleExportPDF}
                  disabled={downloadingReport}
                  className="rounded-lg bg-[#1B2B5E] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#16264f] disabled:opacity-70"
                >
                  {downloadingReport ? "Exporting..." : "Export PDF Report"}
                </button>
              </div>

              {reportLoad === "loading" ? (
                <div className="animate-pulse rounded-xl border border-gray-200 bg-white p-8 text-sm text-gray-400">
                  Loading decision log...
                </div>
              ) : null}
              {reportLoad === "error" ? (
                <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                  Failed to load decision log.
                  <button onClick={() => void loadDecisionLog()} className="ml-3 underline">
                    Retry
                  </button>
                </div>
              ) : null}

              {reportLoad === "success" && decisionLog.length === 0 ? (
                <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
                  No officer decisions recorded yet. Complete the evaluation matrix first.
                </div>
              ) : null}

              {reportLoad === "success" && decisionLog.length > 0 ? (
                <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
                  <table className="min-w-full text-left text-sm">
                    <thead className="bg-gray-50 text-gray-600">
                      <tr>
                        <th className="px-4 py-3">Criterion</th>
                        <th className="px-4 py-3">Bidder</th>
                        <th className="px-4 py-3">AI Verdict</th>
                        <th className="px-4 py-3">Officer Decision</th>
                        <th className="px-4 py-3">Note</th>
                        <th className="px-4 py-3">Decided At</th>
                      </tr>
                    </thead>
                    <tbody>
                      {decisionLog.map((entry, index) => {
                        const after = (entry.after_state as any) || {};
                        const aiVerdict = String(after.ai_verdict || "").toLowerCase();
                        const officerVerdict = String(after.officer_verdict || "").toLowerCase();
                        return (
                          <tr key={`${entry.timestamp}-${index}`} className="border-t border-gray-100">
                            <td className="px-4 py-3 text-gray-700">{String(after.criterion_text || "—")}</td>
                            <td className="px-4 py-3 text-gray-700">{String(after.bidder_name || "—")}</td>
                            <td className={`px-4 py-3 ${decisionTone(aiVerdict)}`}>{aiVerdict || "—"}</td>
                            <td className={`px-4 py-3 ${decisionTone(officerVerdict)}`}>{officerVerdict || "—"}</td>
                            <td className="px-4 py-3 text-gray-700">{String(after.officer_note || entry.summary || "—")}</td>
                            <td className="px-4 py-3 text-gray-500">
                              {entry.timestamp
                                ? new Date(entry.timestamp).toLocaleString("en-GB", {
                                    day: "2-digit",
                                    month: "short",
                                    year: "numeric",
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })
                                : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>

      {selectedAmberCell ? (
        <aside className="fixed inset-y-0 right-0 z-50 w-full max-w-[400px] overflow-y-auto border-l border-gray-200 bg-white p-5 shadow-xl">
          <div className="mb-4 flex items-start justify-between">
            <h3 className="text-lg font-semibold text-[#1B2B5E]">Awaiting your review</h3>
            <button onClick={() => setSelectedAmberCell(null)} className="text-gray-500 hover:text-gray-800">
              ✕
            </button>
          </div>
          <div className="space-y-3 text-sm">
            <div>
              <p className="text-xs uppercase tracking-wide text-gray-500">Criterion</p>
              <p className="mt-1 text-gray-900">{selectedAmberCell.criterionText}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-gray-500">Bidder</p>
              <p className="mt-1 text-gray-900">{selectedAmberCell.bidderName}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-gray-500">AI finding</p>
              <p className={`mt-1 font-medium ${decisionTone(selectedAmberCell.cell.ai_verdict?.toString())}`}>
                {selectedAmberCell.cell.ai_verdict || "amber"} ·{" "}
                {selectedAmberCell.cell.confidence_score != null
                  ? `${Math.round(selectedAmberCell.cell.confidence_score * 100)}% confidence`
                  : "confidence unavailable"}
              </p>
              <div className="mt-2 h-2 rounded-full bg-gray-100">
                <div
                  className="h-2 rounded-full bg-amber-400"
                  style={{ width: `${Math.round((selectedAmberCell.cell.confidence_score ?? 0.5) * 100)}%` }}
                />
              </div>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-gray-500">Reasoning</p>
              <p className="mt-1 text-gray-700">{selectedAmberCell.cell.flag_detail || selectedAmberCell.cell.extracted_claim || "AI flagged this for your review."}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-gray-500">Evidence</p>
              <pre className="mt-1 whitespace-pre-wrap rounded-lg bg-gray-100 p-3 text-xs text-gray-700">
                {selectedAmberCell.cell.source_text_snippet || "Not found"}
              </pre>
            </div>
          </div>

          <div className="mt-6 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
            AI flagged this for your review. Final decision is yours.
          </div>

          <div className="mt-6">
            <h4 className="text-sm font-semibold text-[#1B2B5E]">Your Decision</h4>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => setOfficerDecision("green")}
                className={`rounded-lg px-3 py-2 text-sm font-medium ${
                  officerDecision === "green"
                    ? "bg-green-600 text-white"
                    : "border border-green-200 bg-green-50 text-green-700"
                }`}
              >
                Qualify ✓
              </button>
              <button
                onClick={() => setOfficerDecision("red")}
                className={`rounded-lg px-3 py-2 text-sm font-medium ${
                  officerDecision === "red" ? "bg-red-600 text-white" : "border border-red-200 bg-red-50 text-red-700"
                }`}
              >
                Disqualify ✗
              </button>
            </div>

            <textarea
              value={officerNote}
              onChange={(e) => setOfficerNote(e.target.value)}
              rows={4}
              placeholder="Decision rationale (required)"
              className="mt-3 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
            />
            {decisionValidation ? <p className="mt-2 text-xs text-red-700">{decisionValidation}</p> : null}
            <button
              onClick={submitOfficerDecision}
              disabled={decisionSubmitting}
              className="mt-3 rounded-lg bg-[#1B2B5E] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#16264f] disabled:opacity-70"
            >
              {decisionSubmitting ? "Submitting..." : "Submit Decision"}
            </button>
          </div>
        </aside>
      ) : null}

      <div className="fixed right-4 top-20 z-[60] flex w-full max-w-sm flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`rounded-lg border px-3 py-2 text-sm shadow ${
              toast.type === "success"
                ? "border-green-200 bg-green-50 text-green-700"
                : "border-red-200 bg-red-50 text-red-700"
            }`}
          >
            {toast.text}
          </div>
        ))}
      </div>
    </main>
  );
}

function TenderDetailFallback() {
  return (
    <main className="min-h-screen bg-[#F8FAFC] px-6 pt-24">
      <div className="mx-auto max-w-7xl animate-pulse space-y-4">
        <div className="h-10 w-1/2 rounded bg-slate-200" />
        <div className="h-20 rounded bg-slate-200" />
        <div className="h-12 rounded bg-slate-200" />
        <div className="h-64 rounded bg-slate-200" />
      </div>
    </main>
  );
}

export default function TenderDetailPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <Suspense fallback={<TenderDetailFallback />}>
      <TenderDetailView tenderId={id} />
    </Suspense>
  );
}
