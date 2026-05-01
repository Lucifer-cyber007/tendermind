import axios, { AxiosError } from "axios";

type UUID = string;

export interface AuthTokenResponse {
  access_token: string;
  token_type: "bearer" | string;
}

export interface User {
  id: UUID;
  name: string;
  designation?: string | null;
  department?: string | null;
  email: string;
}

export interface TenderCreateInput {
  title: string;
  tender_number: string;
  department: string;
  tender_type?: string;
  notes?: string;
}

export interface Tender {
  id: UUID;
  title: string;
  tender_number: string;
  department: string;
  tender_type?: string | null;
  status: string;
  created_at: string;
  criteria_confirmed_at?: string | null;
  notes?: string | null;
  bidder_count?: number;
  criteria_count?: number;
  cells_needing_review?: number;
}

export interface Bidder {
  id: UUID;
  name: string;
  company?: string | null;
  email?: string | null;
  bid_amount?: number | null;
  rank?: number | null;
  is_l1: boolean;
  parse_status: string;
}

export interface Criterion {
  id: UUID;
  criterion_text: string;
  criterion_type: string;
  source: string;
  source_page?: number | null;
  source_section?: string | null;
  threshold?: string | null;
  exception_clause?: string | null;
  is_mandatory: boolean;
  confirmed_by_officer: boolean;
  officer_edit?: string | null;
  confirmation_timestamp?: string | null;
  display_order: number;
}

export interface MatrixCell {
  cell_id: UUID;
  criterion_id: UUID;
  criterion_text: string;
  ai_verdict?: string | null;
  confidence_score?: number | null;
  flag_type?: string | null;
  flag_detail?: string | null;
  extracted_claim?: string | null;
  source_page?: number | null;
  source_text_snippet?: string | null;
  officer_verdict?: string | null;
  officer_note?: string | null;
}

export interface MatrixByBidder {
  bidder_id: UUID;
  bidder_name: string;
  rank?: number | null;
  is_l1: boolean;
  cells: MatrixCell[];
}

export interface MatrixResponse {
  tender_id: UUID;
  bidders: MatrixByBidder[];
}

export interface AmberMatrixResponse {
  tender_id: UUID;
  amber_cells: Array<
    MatrixCell & {
      bidder_id: UUID;
      bidder_name: string;
      rank?: number | null;
    }
  >;
}

export interface EvaluationSummaryItem {
  bidder_id: UUID;
  bidder_name: string;
  rank?: number | null;
  is_l1: boolean;
  green: number;
  amber: number;
  red: number;
  overall_status: string;
}

export interface EvaluationSummaryResponse {
  tender_id: UUID;
  summary: EvaluationSummaryItem[];
}

export interface DecisionLogEntry {
  timestamp: string;
  actor_type: string;
  actor_ai_version?: string | null;
  action_type: string;
  summary?: string | null;
  before_state?: unknown;
  after_state?: unknown;
}

export interface DecisionLogResponse {
  tender_id: UUID;
  decision_log: DecisionLogEntry[];
}

export function handleUnauthorized(): void {
  if (typeof window !== "undefined") {
    localStorage.removeItem("token");
    window.location.href = "/login";
  }
}

const baseURL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000") + "/api/v1";

const api = axios.create({ baseURL });

api.interceptors.request.use((config) => {
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    if (error.response?.status === 401) {
      handleUnauthorized();
    }
    return Promise.reject(error);
  }
);

export const apiClient = api;

const apiService = {
  auth: {
    register: async (
      fullName: string,
      email: string,
      password: string,
      designation?: string,
      department?: string
    ): Promise<User> => {
      const { data } = await api.post<User>("/auth/register", {
        name: fullName,
        full_name: fullName,
        email,
        password,
        designation,
        department,
      });
      return data;
    },
    login: async (email: string, password: string): Promise<AuthTokenResponse> => {
      const { data } = await api.post<AuthTokenResponse>("/auth/login", {
        email,
        password,
      });
      return data;
    },
    me: async (): Promise<User> => {
      const { data } = await api.get<User>("/auth/me");
      return data;
    },
  },
  tenders: {
    list: async (): Promise<Tender[]> => {
      const { data } = await api.get<Tender[]>("/tenders/");
      return data;
    },
    create: async (payload: TenderCreateInput): Promise<Tender> => {
      const { data } = await api.post<Tender>("/tenders/", payload);
      return data;
    },
    get: async (id: string): Promise<Tender> => {
      const { data } = await api.get<Tender>(`/tenders/${id}`);
      return data;
    },
    uploadDocument: async (id: string, file: File): Promise<{ document_id: string; status: string }> => {
      const formData = new FormData();
      formData.append("file", file);
      const { data } = await api.post<{ document_id: string; status: string }>(
        `/tenders/${id}/document`,
        formData,
        { headers: { "Content-Type": "multipart/form-data" } }
      );
      return data;
    },
    startEvaluation: async (id: string): Promise<{ status: string }> => {
      const { data } = await api.post<{ status: string }>(`/tenders/${id}/start-evaluation`);
      return data;
    },
    close: async (id: string): Promise<{ status: string }> => {
      const { data } = await api.post<{ status: string }>(`/tenders/${id}/close`);
      return data;
    },
  },
  bidders: {
    list: async (tenderId: string): Promise<Bidder[]> => {
      const { data } = await api.get<Bidder[]>(`/bidders/${tenderId}/bidders`);
      return data;
    },
    create: async (
      tenderId: string,
      payload: { name: string; company?: string; email?: string; bid_amount?: number }
    ): Promise<Bidder> => {
      const { data } = await api.post<Bidder>(`/bidders/${tenderId}/bidders`, {
        name: payload.name,
        company: payload.company,
        email: payload.email,
        bid_amount: payload.bid_amount,
      });
      return data;
    },
    uploadDocument: async (
      tenderId: string,
      bidderId: string,
      file: File
    ): Promise<{ document_id: string; status: string }> => {
      const formData = new FormData();
      formData.append("file", file);
      const { data } = await api.post<{ document_id: string; status: string }>(
        `/bidders/${tenderId}/bidders/${bidderId}/document`,
        formData,
        { headers: { "Content-Type": "multipart/form-data" } }
      );
      return data;
    },
  },
  criteria: {
    list: async (tenderId: string): Promise<Criterion[]> => {
      const { data } = await api.get<Criterion[]>(`/criteria/${tenderId}/criteria`);
      return data;
    },
    confirmAll: async (tenderId: string): Promise<{ status: string; criteria_count: number }> => {
      const { data } = await api.post<{ status: string; criteria_count: number }>(
        `/criteria/${tenderId}/criteria/confirm-all`
      );
      return data;
    },
    confirm: async (
      tenderId: string,
      criterionId: string,
      officerEdit?: string
    ): Promise<{ status: string; criterion_id: string }> => {
      const { data } = await api.put<{ status: string; criterion_id: string }>(
        `/criteria/${tenderId}/criteria/${criterionId}/confirm`,
        { officer_edit: officerEdit }
      );
      return data;
    },
  },
  evaluation: {
    getMatrix: async (tenderId: string): Promise<MatrixResponse> => {
      const { data } = await api.get<MatrixResponse>(`/evaluation/${tenderId}/matrix`);
      return data;
    },
    getAmber: async (tenderId: string): Promise<AmberMatrixResponse> => {
      const { data } = await api.get<AmberMatrixResponse>(`/evaluation/${tenderId}/matrix/amber`);
      return data;
    },
    decide: async (
      tenderId: string,
      cellId: string,
      verdict: string,
      note?: string
    ): Promise<{ status: string; cell_id: string }> => {
      const { data } = await api.put<{ status: string; cell_id: string }>(
        `/evaluation/${tenderId}/matrix/${cellId}/decide`,
        {
          officer_verdict: verdict,
          officer_note: note,
        }
      );
      return data;
    },
    getSummary: async (tenderId: string): Promise<EvaluationSummaryResponse> => {
      const { data } = await api.get<EvaluationSummaryResponse>(`/evaluation/${tenderId}/summary`);
      return data;
    },
  },
  reports: {
    getDecisionLog: async (tenderId: string): Promise<DecisionLogResponse> => {
      const { data } = await api.get<DecisionLogResponse>(`/reports/${tenderId}/decision-log`);
      return data;
    },
  },
};

export { apiService as api };
export default apiService;
