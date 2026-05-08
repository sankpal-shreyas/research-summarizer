import type { Paper, Summary, KnowledgeGraph } from "./types";
import { getToken } from "./auth";
import { mockPapers } from "@/data/mock-papers";
import { mockSummaries } from "@/data/mock-summaries";

/**
 * Dual-mode API client with graceful fallback.
 *
 * - If NEXT_PUBLIC_API_URL is set → tries the real API Gateway first.
 * - If the real call fails (endpoint not deployed yet) → falls back to mocks.
 * - If NEXT_PUBLIC_API_URL is not set → uses mocks directly.
 *
 * This means mock data shows until the actual Lambda handlers are deployed.
 * No frontend code changes needed when backend endpoints come online.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";
const USE_REAL = !!API_URL;
const MOCK_DELAY = 400;

// ─── Internals ──────────────────────────────────────────────────────

function delay<T>(value: T, ms = MOCK_DELAY): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: token } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let parsed: { error?: string; message?: string } = {};
    try { parsed = JSON.parse(text); } catch {}
    throw new ApiError(res.status, parsed.error ?? "api_error", parsed.message ?? text ?? res.statusText);
  }
  return res.json();
}

// ─── Search ─────────────────────────────────────────────────────────

export async function searchPapers(query: string): Promise<Paper[]> {
  const q = query.trim().toLowerCase();
  if (!q) return delay([]);

  if (USE_REAL) {
    try {
      return await apiFetch<Paper[]>(`search?q=${encodeURIComponent(query)}`);
    } catch {
      // endpoint not deployed yet — fall back to mocks
    }
  }
  return delay(
    mockPapers.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.abstract.toLowerCase().includes(q) ||
        p.authors.some((a) => a.toLowerCase().includes(q)),
    ),
  );
}

// ─── Summaries ──────────────────────────────────────────────────────

export async function listSummaries(): Promise<Summary[]> {
  if (USE_REAL) {
    try {
      return await apiFetch<Summary[]>("summaries");
    } catch {
      // endpoint not deployed yet — fall back to mocks
    }
  }
  return delay(mockSummaries);
}

export async function getSummary(id: string): Promise<Summary | null> {
  if (USE_REAL) {
    try {
      return await apiFetch<Summary>(`summaries/${id}`);
    } catch {
      // fall back to mocks
    }
  }
  return delay(mockSummaries.find((s) => s.id === id) ?? null);
}

export type SubmitResult = {
  jobId: string;
  deduped?: boolean;
  quotaRemaining?: number;
};

export async function submitSummary(paper: Paper): Promise<SubmitResult> {
  if (USE_REAL) {
    return apiFetch<SubmitResult>("summarize", {
      method: "POST",
      body: JSON.stringify({ paper }),
    });
  }
  return delay({ jobId: `mock-${Date.now()}-${paper.id}`, deduped: false, quotaRemaining: 10 });
}

// ─── Health check (Phase 1 verification) ────────────────────────────

export async function healthCheck(): Promise<{
  status: string;
  userId?: string;
}> {
  if (USE_REAL) return apiFetch("health");
  return delay({ status: "ok (mock)", userId: "mock-user-id" });
}

// ─── Quota ──────────────────────────────────────────────────────────

export async function getQuota(): Promise<{ quotaRemaining: number }> {
  if (USE_REAL) {
    try {
      return await apiFetch<{ quotaRemaining: number }>("quota");
    } catch {
      return { quotaRemaining: 10 };
    }
  }
  return delay({ quotaRemaining: 10 });
}

// ─── Related papers ─────────────────────────────────────────────────

export type RelatedPaper = {
  id: string;
  paper: Paper;
  score: number;
  keywords: string[];
};

export async function getRelated(jobId: string): Promise<RelatedPaper[]> {
  if (USE_REAL) {
    try {
      const res = await apiFetch<{ related: RelatedPaper[] }>(`summaries/${jobId}/related`);
      return res.related;
    } catch {
      return [];
    }
  }
  return delay([]);
}

// ─── Knowledge graph ────────────────────────────────────────────────

export async function getGraph(
  jobId: string,
  options: { force?: boolean } = {},
): Promise<{ graph: KnowledgeGraph; generated: boolean }> {
  if (USE_REAL) {
    const qs = options.force ? "?force=1" : "";
    return apiFetch<{ graph: KnowledgeGraph; generated: boolean }>(`summaries/${jobId}/graph${qs}`);
  }
  return delay({ graph: { nodes: [], edges: [] }, generated: false });
}

// ─── Chat (Talk to PDF / RAG) ───────────────────────────────────────

export type ChatCitation = {
  index: number;
  chunkIndex: number;
  snippet: string;
  score: number;
};

export type ChatResponse = {
  answer: string;
  citations: ChatCitation[];
};

export async function askPaper(jobId: string, question: string): Promise<ChatResponse> {
  if (USE_REAL) {
    return apiFetch<ChatResponse>("chat", {
      method: "POST",
      body: JSON.stringify({ jobId, question }),
    });
  }
  return delay({
    answer: "(mock) The paper proposes the Transformer architecture, which uses self-attention to model sequence dependencies without recurrence or convolutions [1].",
    citations: [
      { index: 1, chunkIndex: 0, snippet: "We propose a new simple network architecture, the Transformer, based solely on attention mechanisms…", score: 0.91 },
    ],
  });
}

// ─── Upload (user-supplied PDF) ─────────────────────────────────────

export type UploadResult = {
  paper: Paper;
  viewUrl: string;
};

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

type UploadUrlResponse = {
  paperId: string;
  s3Key: string;
  uploadUrl: string;
  viewUrl: string;
  internalUrl: string;
  contentType: string;
  maxBytes: number;
};

export async function uploadPaper(file: File, title: string): Promise<UploadResult> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new ApiError(413, "too_large", `PDF must be ≤ ${MAX_UPLOAD_BYTES} bytes`);
  }
  if (file.type && file.type !== "application/pdf") {
    throw new ApiError(400, "invalid_type", "file must be a PDF");
  }

  const cleanTitle = title.trim() || file.name.replace(/\.pdf$/i, "");

  if (USE_REAL) {
    const presign = await apiFetch<UploadUrlResponse>("upload-url", {
      method: "POST",
      body: JSON.stringify({ filename: file.name, contentLength: file.size }),
    });

    const putRes = await fetch(presign.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/pdf" },
      body: file,
    });
    if (!putRes.ok) {
      throw new ApiError(putRes.status, "upload_failed", `S3 PUT returned ${putRes.status}`);
    }

    const paper: Paper = {
      id: presign.paperId,
      title: cleanTitle,
      authors: [],
      abstract: "",
      year: new Date().getFullYear(),
      pdfUrl: presign.internalUrl,
    };
    return { paper, viewUrl: presign.viewUrl };
  }

  const paper: Paper = {
    id: `upload-mock-${Date.now()}`,
    title: cleanTitle,
    authors: [],
    abstract: "",
    year: new Date().getFullYear(),
    pdfUrl: "internal:mock",
  };
  return delay({ paper, viewUrl: URL.createObjectURL(file) });
}

// ─── Expose mode for debugging ──────────────────────────────────────

export const apiMode: "real" | "mock" = USE_REAL ? "real" : "mock";
