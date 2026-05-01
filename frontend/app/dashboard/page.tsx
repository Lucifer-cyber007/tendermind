"use client";

import { useRouter } from "next/navigation";
import { AxiosError } from "axios";
import { Building2, Users } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";

import { TenderDetailView } from "@/app/dashboard/[id]/page";
import { api, apiClient, Tender, User } from "@/lib/api";

type StatusTab = "all" | "draft" | "active" | "evaluating" | "closed";

const statusTabLabels: Record<StatusTab, string> = {
  all: "All",
  draft: "Draft",
  active: "Active",
  evaluating: "Evaluating",
  closed: "Closed",
};

const statusStyles: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  criteria_confirmed: "bg-blue-100 text-blue-700",
  evaluation_active: "bg-amber-100 text-amber-700",
  awaiting_approval: "bg-purple-100 text-purple-700",
  closed: "bg-emerald-100 text-emerald-700",
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

function matchesStatusFilter(status: string, filter: StatusTab): boolean {
  if (filter === "all") return true;
  if (filter === "draft") return status === "draft";
  if (filter === "active") return status === "criteria_confirmed" || status === "awaiting_approval";
  if (filter === "evaluating") return status === "evaluation_active";
  if (filter === "closed") return status === "closed";
  return true;
}

function prettyStatus(status: string): string {
  return status.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export default function DashboardPage() {
  const router = useRouter();
  const [officer, setOfficer] = useState<User | null>(null);
  const [tenders, setTenders] = useState<Tender[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<StatusTab>("all");
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState("");
  const [toast, setToast] = useState("");

  const [showModal, setShowModal] = useState(false);
  const [selectedTenderId, setSelectedTenderId] = useState<string | null>(null);
  const [openMenuTenderId, setOpenMenuTenderId] = useState<string | null>(null);
  const [deleteTargetTender, setDeleteTargetTender] = useState<Tender | null>(null);
  const [deletingTender, setDeletingTender] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [title, setTitle] = useState("");
  const [tenderNumber, setTenderNumber] = useState("");
  const [department, setDepartment] = useState("");
  const [description, setDescription] = useState("");

  const loadDashboardData = async (showSkeleton = true) => {
    try {
      if (showSkeleton) {
        setLoading(true);
      }
      setFetchError("");
      const token = localStorage.getItem("token");
      if (!token) {
        router.replace("/login");
        return;
      }
      const [userData, tenderData] = await Promise.all([api.auth.me(), api.tenders.list()]);
      setOfficer(userData);
      setTenders(tenderData);
    } catch (error) {
      console.error("Dashboard load failed", error);
      const axiosError = error as AxiosError;
      if (axiosError.response?.status === 401) {
        router.replace("/login");
        return;
      }
      setFetchError("Failed to load tenders. Please refresh.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadDashboardData();
  }, []);

  const filteredTenders = useMemo(() => {
    const term = search.trim().toLowerCase();
    return tenders.filter((tender) => {
      const searchable = `${tender.title} ${tender.tender_number}`.toLowerCase();
      const matchesSearch = term.length === 0 || searchable.includes(term);
      const matchesStatus = matchesStatusFilter(tender.status, filter);
      return matchesSearch && matchesStatus;
    });
  }, [tenders, search, filter]);

  const stats = useMemo(() => {
    const total = tenders.length;
    const active = tenders.filter(
      (t) => t.status === "criteria_confirmed" || t.status === "awaiting_approval"
    ).length;
    const evaluating = tenders.filter((t) => t.status === "evaluation_active").length;
    const closed = tenders.filter((t) => t.status === "closed").length;
    return { total, active, evaluating, closed };
  }, [tenders]);

  const signOut = () => {
    localStorage.removeItem("token");
    router.push("/login");
  };

  const createTender = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreateError("");
    setCreating(true);
    try {
      await api.tenders.create({
        title: title.trim(),
        tender_number: tenderNumber.trim(),
        department: department.trim(),
        notes: description.trim() || undefined,
      });
      await loadDashboardData(false);
      setToast("Tender created successfully");
      setShowModal(false);
      setTitle("");
      setTenderNumber("");
      setDepartment("");
      setDescription("");
    } catch (error) {
      console.error("Create tender failed", error);
      setCreateError("Could not create tender. Please verify details and retry.");
    } finally {
      setCreating(false);
    }
  };

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 2500);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const confirmDeleteTender = async () => {
    if (!deleteTargetTender) return;
    try {
      setDeletingTender(true);
      await apiClient.delete(`/tenders/${deleteTargetTender.id}`);
      setTenders((prev) => prev.filter((tender) => tender.id !== deleteTargetTender.id));
      setDeleteTargetTender(null);
      setOpenMenuTenderId(null);
      setToast("Tender deleted");
    } catch (error) {
      console.error("Delete tender failed", error);
      setToast("Could not delete tender");
    } finally {
      setDeletingTender(false);
    }
  };

  if (loading) {
    return (
      <main className="min-h-screen bg-[#F8FAFC] p-8 pt-28">
        <div className="mx-auto max-w-7xl animate-pulse space-y-4">
          <div className="h-10 w-64 rounded bg-slate-200" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[1, 2, 3, 4].map((item) => (
              <div key={item} className="h-24 rounded-xl bg-slate-200" />
            ))}
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {[1, 2, 3, 4, 5, 6].map((item) => (
              <div key={item} className="h-40 rounded-xl bg-slate-200" />
            ))}
          </div>
        </div>
      </main>
    );
  }

  if (selectedTenderId) {
    return (
      <TenderDetailView
        tenderId={selectedTenderId}
        embedded
        onBackToList={() => setSelectedTenderId(null)}
      />
    );
  }

  return (
    <main className="min-h-screen bg-[#F8FAFC]">
      <header className="fixed inset-x-0 top-0 z-40 border-b border-[#E5E7EB] bg-white shadow-sm">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-4">
          <div>
            <p className="text-lg font-bold tracking-wide text-[#1B2B5E]">TenderMind</p>
            <p className="text-xs text-gray-500">Procurement Evaluation System</p>
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

      <div className="mx-auto max-w-7xl px-6 pb-10 pt-28">
        {toast ? (
          <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">
            {toast}
          </div>
        ) : null}

        <section className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { label: "Total", value: stats.total },
            { label: "Active", value: stats.active },
            { label: "Evaluating", value: stats.evaluating },
            { label: "Closed", value: stats.closed },
          ].map((item) => (
            <div key={item.label} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
              <p className="text-sm text-gray-500">{item.label}</p>
              <p className="mt-2 text-2xl font-semibold text-[#1B2B5E]">{item.value}</p>
            </div>
          ))}
        </section>

        <section className="mb-6 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by title or tender number"
              className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-[#3B82F6] focus:ring-4 focus:ring-blue-100 md:max-w-md"
            />

            <button
              onClick={() => setShowModal(true)}
              className="rounded-lg bg-[#1B2B5E] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#16264f]"
            >
              New Tender
            </button>
          </div>

          <div className="mt-4 flex flex-wrap gap-2 border-b border-gray-100 pb-1">
            {(Object.keys(statusTabLabels) as StatusTab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setFilter(tab)}
                className={`rounded-none border-b-2 px-3 py-1.5 text-sm font-medium ${
                  filter === tab
                    ? "border-[#1B2B5E] text-[#1B2B5E]"
                    : "border-transparent text-gray-500 hover:text-gray-700"
                }`}
              >
                {statusTabLabels[tab]}
              </button>
            ))}
          </div>
        </section>

        {fetchError ? (
          <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {fetchError}
          </div>
        ) : null}

        {filteredTenders.length === 0 ? (
          <section className="rounded-xl border border-dashed border-gray-300 bg-white px-6 py-14 text-center">
            <svg className="mx-auto mb-5 h-20 w-20 text-slate-300" viewBox="0 0 120 120" fill="none">
              <rect x="20" y="30" width="58" height="72" rx="6" stroke="currentColor" strokeWidth="4" />
              <rect x="42" y="18" width="58" height="72" rx="6" stroke="currentColor" strokeWidth="4" />
              <line x1="54" y1="40" x2="86" y2="40" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
              <line x1="54" y1="54" x2="86" y2="54" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
              <line x1="54" y1="68" x2="78" y2="68" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
            </svg>
            <h3 className="text-xl font-semibold text-gray-900">No tenders yet</h3>
            <p className="mt-2 text-sm text-gray-500">
              Create your first tender to begin the evaluation process
            </p>
            <button
              onClick={() => setShowModal(true)}
              className="mt-5 rounded-lg bg-[#1B2B5E] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#16264f]"
            >
              Create New Tender
            </button>
          </section>
        ) : (
          <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {filteredTenders.map((tender) => (
              <button
                key={tender.id}
                type="button"
                onClick={() => setSelectedTenderId(tender.id)}
                className="rounded-xl border border-gray-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-1 hover:shadow-md"
              >
                <div className="mb-4 flex items-start justify-between gap-3">
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                      statusStyles[tender.status] ?? "bg-slate-100 text-slate-700"
                    }`}
                  >
                    {prettyStatus(tender.status)}
                  </span>
                  <div className="relative">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        setOpenMenuTenderId((prev) => (prev === tender.id ? null : tender.id));
                      }}
                      className="rounded-md px-2 py-1 text-lg leading-none text-gray-500 hover:bg-gray-100 hover:text-gray-700"
                      aria-label="More options"
                    >
                      ⋯
                    </button>
                    {openMenuTenderId === tender.id ? (
                      <div className="absolute right-0 z-10 mt-1 min-w-36 rounded-md border border-gray-200 bg-white p-1 shadow-lg">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setDeleteTargetTender(tender);
                            setOpenMenuTenderId(null);
                          }}
                          className="w-full rounded px-2 py-1.5 text-left text-sm text-red-600 hover:bg-red-50"
                        >
                          Delete Tender
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
                <h3 className="truncate text-lg font-semibold text-gray-900">{tender.title}</h3>
                <p className="mt-2 font-mono text-sm text-gray-500">{tender.tender_number}</p>
                <p className="mt-3 flex items-center gap-2 text-sm text-gray-600">
                  <Building2 size={14} />
                  {tender.department}
                </p>
                <div className="mt-3 flex items-center gap-2 text-sm text-gray-600">
                  <Users size={14} />
                  <span>{tender.bidder_count ?? 0} bidders</span>
                </div>
                <div className="mt-4 text-xs text-gray-500">
                  {new Date(tender.created_at).toLocaleDateString("en-GB", {
                    day: "2-digit",
                    month: "short",
                    year: "numeric",
                  })}
                </div>
              </button>
            ))}
          </section>
        )}
      </div>

      {showModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-xl border border-gray-200 bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-start justify-between">
              <h2 className="text-xl font-semibold">Create New Tender</h2>
              <button onClick={() => setShowModal(false)} className="text-gray-500 hover:text-gray-800">
                ✕
              </button>
            </div>

            <form className="space-y-4" onSubmit={createTender}>
              <div>
                <label className="mb-1.5 block text-sm font-medium">Title</label>
                <input
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-[#3B82F6] focus:ring-4 focus:ring-blue-100"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium">Tender number</label>
                <input
                  required
                  value={tenderNumber}
                  onChange={(e) => setTenderNumber(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 font-mono text-sm outline-none focus:border-[#3B82F6] focus:ring-4 focus:ring-blue-100"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium">Department</label>
                <select
                  required
                  value={department}
                  onChange={(e) => setDepartment(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-[#3B82F6] focus:ring-4 focus:ring-blue-100"
                >
                  <option value="">Select department</option>
                  {DEPARTMENTS.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium">Description (optional)</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-[#3B82F6] focus:ring-4 focus:ring-blue-100"
                />
              </div>

              {createError ? (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {createError}
                </div>
              ) : null}

              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="rounded-lg bg-[#1B2B5E] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#16264f] disabled:opacity-70"
                >
                  {creating ? "Creating..." : "Create Tender"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {deleteTargetTender ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-gray-900">Delete this tender? This cannot be undone.</h2>
            <div className="mt-5 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setDeleteTargetTender(null)}
                disabled={deletingTender}
                className="rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-slate-50 disabled:opacity-70"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmDeleteTender()}
                disabled={deletingTender}
                className="rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-70"
              >
                {deletingTender ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
