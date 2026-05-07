"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api, Bidder, EvaluationSummaryItem, Tender, User } from "@/lib/api";

type ToastMessage = { id: number; type: "success" | "error"; text: string };
type LoadState = "idle" | "loading" | "success" | "error";

const NAVY = "#1B2B5E";
const BG = "#F8FAFC";

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  criteria_confirmed: "bg-blue-100 text-blue-700",
  evaluation_active: "bg-amber-100 text-amber-700",
  awaiting_approval: "bg-blue-100 text-blue-700",
  closed: "bg-green-100 text-green-700",
};

function toStatusDisplay(status: string | undefined) {
  if (!status) return "Draft";
  return status.replaceAll("_", " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function sortOrder(item: EvaluationSummaryItem): number {
  if (item.overall_status === "qualified") return 0;
  if (item.overall_status === "needs_review") return 1;
  if (item.overall_status === "disqualified") return 2;
  return 3;
}

function splitBidderDisplay(name: string, companyFromApi?: string | null) {
  const open = name.indexOf(" (");
  if (open >= 0 && name.endsWith(")")) {
    return {
      displayName: name.slice(0, open),
      company: companyFromApi || name.slice(open + 2, -1),
    };
  }
  return { displayName: name, company: companyFromApi ?? "" };
}

export default function EvaluationSummaryPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const router = useRouter();

  const [officer, setOfficer] = useState<User | null>(null);
  const [tender, setTender] = useState<Tender | null>(null);
  const [summaryItems, setSummaryItems] = useState<EvaluationSummaryItem[]>([]);
  const [biddersById, setBiddersById] = useState<Record<string, Bidder>>({});

  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [generatedAt] = useState(() => new Date());

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
      setLoadState("loading");
      const token = localStorage.getItem("token");
      if (!token) {
        router.replace("/login");
        return;
      }
      const [userData, tenderData, summaryData, biddersList] = await Promise.all([
        api.auth.me(),
        api.tenders.get(id),
        api.evaluation.getSummary(id),
        api.bidders.list(id),
      ]);
      setOfficer(userData);
      setTender(tenderData);
      setSummaryItems(summaryData.summary ?? []);
      const bm: Record<string, Bidder> = {};
      biddersList.forEach((b) => {
        bm[b.id] = b;
      });
      setBiddersById(bm);
      setLoadState("success");
    } catch (e: unknown) {
      const status = (e as { response?: { status?: number } })?.response?.status;
      if (status === 401) {
        router.replace("/login");
        return;
      }
      setLoadState("error");
      addToast("error", "Could not load evaluation summary.");
    }
  }, [id, router]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const sortedSummary = useMemo(() => {
    return [...summaryItems].sort((a, b) => {
      const da = sortOrder(a);
      const db = sortOrder(b);
      if (da !== db) return da - db;
      return a.bidder_name.localeCompare(b.bidder_name);
    });
  }, [summaryItems]);

  const stats = useMemo(() => {
    const total = summaryItems.length;
    let likelyPass = 0;
    let likelyFail = 0;
    let awaiting = 0;
    summaryItems.forEach((s) => {
      if (s.overall_status === "qualified") likelyPass += 1;
      else if (s.overall_status === "disqualified") likelyFail += 1;
      else if (s.overall_status === "needs_review" || s.amber > 0) awaiting += 1;
    });
    return { total, likelyPass, likelyFail, awaiting };
  }, [summaryItems]);

  const qualifiedCount = useMemo(
    () => summaryItems.filter((s) => s.overall_status === "qualified").length,
    [summaryItems]
  );

  const reviewFlaggedCount = useMemo(
    () => summaryItems.filter((s) => s.amber > 0 || s.overall_status === "needs_review").length,
    [summaryItems]
  );

  const amberCellsRemain =
    (tender?.cells_needing_review ?? 0) > 0 ||
    summaryItems.some((s) => s.amber > 0 || s.overall_status === "needs_review");

  const evalNotStarted =
    tender && (tender.status === "draft" || tender.status === "criteria_confirmed");

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

  const recommendationText = () => {
    if (amberCellsRemain) {
      return "Complete officer review queue before finalising";
    }
    return "Proceed to generate final report";
  };

  if (loadState === "loading") {
    return (
      <main className="min-h-screen px-6 pt-24" style={{ backgroundColor: BG }}>
        <header className="fixed inset-x-0 top-0 z-40 border-b border-[#E5E7EB] bg-white shadow-sm">
          <div className="mx-auto flex max-w-5xl animate-pulse items-center justify-between px-6 py-3">
            <div className="h-4 w-32 rounded bg-slate-200" />
            <div className="h-4 w-48 rounded bg-slate-200" />
            <div className="h-10 w-24 rounded bg-slate-200" />
          </div>
        </header>
        <div className="mx-auto max-w-5xl space-y-4">
          <div className="h-28 animate-pulse rounded-xl bg-slate-200" />
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {[1, 2, 3, 4].map((k) => (
              <div key={k} className="h-24 animate-pulse rounded-xl bg-slate-200" />
            ))}
          </div>
          <div className="h-40 animate-pulse rounded-xl bg-slate-200" />
          <div className="h-40 animate-pulse rounded-xl bg-slate-200" />
        </div>
      </main>
    );
  }

  if (loadState === "error" || !officer || !tender) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6" style={{ backgroundColor: BG }}>
        <div className="max-w-md rounded-xl border border-red-200 bg-red-50 p-6 text-center text-red-800">
          Unable to load this summary.
          <button type="button" onClick={() => void loadAll()} className="mt-4 block w-full rounded-lg border border-red-300 py-2 text-sm font-medium">
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
          <h1 className="hidden flex-1 text-center text-sm font-bold tracking-wide sm:block" style={{ color: NAVY }}>
            Evaluation Summary
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
        <div className="mx-auto max-w-5xl px-6 pb-2 sm:hidden">
          <p className="text-center text-sm font-bold" style={{ color: NAVY }}>
            Evaluation Summary
          </p>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-6 pb-16 pt-28">
        {evalNotStarted ? (
          <div className="rounded-xl border border-gray-200 bg-white p-10 text-center shadow-sm">
            <svg viewBox="0 0 64 64" className="mx-auto h-14 w-14 text-slate-400" fill="none" aria-hidden>
              <path d="M12 20h40v36H12z" stroke="currentColor" strokeWidth="2" />
              <path d="M20 12h24v8H20z" stroke="currentColor" strokeWidth="2" />
            </svg>
            <h2 className="mt-4 text-xl font-semibold text-[#1B2B5E]">Evaluation not started yet</h2>
            <p className="mt-2 text-sm text-gray-600">Run the evaluation from the tender workspace when you are ready.</p>
            <Link
              href={`/dashboard/${id}`}
              className="mt-6 inline-flex rounded-xl px-6 py-3 text-sm font-semibold text-white"
              style={{ backgroundColor: NAVY }}
            >
              Back to tender
            </Link>
          </div>
        ) : (
          <>
            <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
              <h2 className="text-2xl font-bold text-[#1B2B5E]">{tender.title}</h2>
              <p className="mt-1 font-mono text-sm text-gray-600">{tender.tender_number}</p>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <span className="text-sm text-gray-700">{tender.department}</span>
                <span
                  className={`rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_BADGE[tender.status] ?? "bg-gray-100 text-gray-700"}`}
                >
                  {toStatusDisplay(tender.status)}
                </span>
              </div>
              <p className="mt-4 text-sm text-gray-500">
                Summary generated at:{" "}
                {generatedAt.toLocaleString("en-GB", {
                  day: "2-digit",
                  month: "short",
                  year: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </p>
            </section>

            <section className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
              <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Total Bidders</p>
                <p className="mt-2 text-3xl font-bold text-[#1B2B5E]">{stats.total}</p>
              </div>
              <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Likely Pass</p>
                <p className="mt-2 text-3xl font-bold text-green-700">{stats.likelyPass}</p>
                <p className="mt-1 text-[11px] text-gray-500">No mandatory red cells</p>
              </div>
              <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Likely Fail</p>
                <p className="mt-2 text-3xl font-bold text-red-700">{stats.likelyFail}</p>
                <p className="mt-1 text-[11px] text-gray-500">Has mandatory red cells</p>
              </div>
              <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Awaiting Review</p>
                <p className="mt-2 text-3xl font-bold text-amber-600">{stats.awaiting}</p>
                <p className="mt-1 text-[11px] text-gray-500">Has amber cells</p>
              </div>
            </section>

            <section className="mt-8 space-y-4">
              {sortedSummary.map((row) => {
                const bidder = biddersById[row.bidder_id];
                const { displayName, company } = splitBidderDisplay(row.bidder_name, bidder?.company);
                const email = bidder?.email?.trim();
                const totalCells = row.green + row.amber + row.red;
                const gPct = totalCells ? (row.green / totalCells) * 100 : 0;
                const aPct = totalCells ? (row.amber / totalCells) * 100 : 0;
                const rPct = totalCells ? (row.red / totalCells) * 100 : 0;

                let rightBadge: { text: string; className: string };
                if (row.overall_status === "disqualified") {
                  rightBadge = { text: "LIKELY FAIL", className: "bg-red-100 text-red-800 ring-2 ring-red-200" };
                } else if (row.overall_status === "needs_review" || row.amber > 0) {
                  rightBadge = { text: "REVIEW REQUIRED", className: "bg-amber-100 text-amber-900 ring-2 ring-amber-200" };
                } else if (row.overall_status === "qualified") {
                  rightBadge = { text: "LIKELY PASS", className: "bg-green-100 text-green-800 ring-2 ring-green-200" };
                } else {
                  rightBadge = { text: "PENDING", className: "bg-slate-100 text-slate-700 ring-2 ring-slate-200" };
                }

                return (
                  <div key={row.bidder_id} className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                    <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
                      <div className="min-w-0 flex-1">
                        <p className="text-lg font-bold text-gray-900">{displayName}</p>
                        <p className="text-sm text-gray-500">{company || "—"}</p>
                        {email ? <p className="mt-1 text-sm text-gray-600">{email}</p> : null}
                      </div>

                      <div className="flex flex-wrap gap-2 lg:justify-center">
                        <span className="inline-flex min-w-[9rem] items-center justify-center rounded-full bg-green-100 px-3 py-2 text-sm font-bold text-green-800">
                          🟢 {row.green} criteria passed
                        </span>
                        <span className="inline-flex min-w-[9rem] items-center justify-center rounded-full bg-amber-100 px-3 py-2 text-sm font-bold text-amber-900">
                          🟡 {row.amber} flagged for review
                        </span>
                        <span className="inline-flex min-w-[9rem] items-center justify-center rounded-full bg-red-100 px-3 py-2 text-sm font-bold text-red-800">
                          🔴 {row.red} criteria failed
                        </span>
                      </div>

                      <div className="flex lg:w-56 lg:justify-end">
                        <span className={`inline-flex rounded-full px-4 py-2 text-center text-sm font-bold ${rightBadge.className}`}>
                          {rightBadge.text}
                        </span>
                      </div>
                    </div>

                    <div className="mt-5 border-t border-gray-100 pt-4">
                      <div className="flex h-2 w-full overflow-hidden rounded-full bg-slate-100">
                        <div className="h-full bg-green-500" style={{ width: `${gPct}%` }} />
                        <div className="h-full bg-amber-400" style={{ width: `${aPct}%` }} />
                        <div className="h-full bg-red-500" style={{ width: `${rPct}%` }} />
                      </div>
                      <Link href={`/dashboard/${id}?tab=matrix`} className="mt-3 inline-block text-sm font-medium text-[#3B82F6] hover:underline">
                        View in Matrix
                      </Link>
                    </div>
                  </div>
                );
              })}
            </section>

            <section className="mt-10 rounded-xl border border-gray-200 bg-white p-6 shadow-sm" style={{ borderLeftWidth: 4, borderLeftColor: NAVY }}>
              <h3 className="text-lg font-semibold text-[#1B2B5E]">Evaluation Overview</h3>
              <ul className="mt-4 space-y-2 text-sm text-gray-700">
                <li>
                  <strong>{qualifiedCount}</strong> of <strong>{stats.total}</strong> bidders meet all mandatory criteria (likely pass — you make the final call).
                </li>
                <li>
                  <strong>{reviewFlaggedCount}</strong> bidder{reviewFlaggedCount === 1 ? " has" : "s have"} been flagged for officer review (AI flagged; not final).
                </li>
                <li className="pt-2 font-medium text-[#1B2B5E]">
                  Recommended next step: {recommendationText()}
                </li>
              </ul>
              <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                <Link
                  href={`/dashboard/${id}/review`}
                  className="inline-flex flex-1 items-center justify-center rounded-xl border border-gray-200 px-5 py-3 text-center text-sm font-semibold text-[#1B2B5E] hover:bg-slate-50"
                >
                  Open Review Queue
                </Link>
                <button
                  type="button"
                  onClick={() => void exportPdf()}
                  className="inline-flex flex-1 items-center justify-center rounded-xl px-5 py-3 text-sm font-semibold text-white"
                  style={{ backgroundColor: NAVY }}
                >
                  Export PDF Report
                </button>
              </div>
            </section>
          </>
        )}
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
