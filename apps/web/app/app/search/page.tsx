"use client";

import { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { searchPapers, submitSummary, ApiError } from "@/lib/api";
import type { Paper } from "@/lib/types";
import { useToast } from "@/app/components/Toaster";
import { SearchHistory } from "@/app/components/SearchHistory";
import { UploadPaperCard } from "@/app/components/UploadPaperCard";
import { addSearch } from "@/lib/searchHistory";

function SearchInner() {
  const router = useRouter();
  const params = useSearchParams();
  const initialQuery = params.get("q") ?? "";
  const toast = useToast();

  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<Paper[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<{ paper: Paper; viewUrl: string } | null>(null);

  useEffect(() => {
    if (initialQuery) {
      setLoading(true);
      addSearch(initialQuery);
      searchPapers(initialQuery).then((r) => {
        setResults(r);
        setLoading(false);
      });
    }
  }, [initialQuery]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (q) router.push(`/app/search?q=${encodeURIComponent(q)}`);
  }

  function pickHistory(q: string) {
    setQuery(q);
    router.push(`/app/search?q=${encodeURIComponent(q)}`);
  }

  async function handleSummarize(paper: Paper) {
    setSubmitting(paper.id);
    try {
      const result = await submitSummary(paper);
      if (result.deduped) {
        toast.success("Already summarized — opening the cached result.");
      } else {
        toast.info(`Job submitted${result.quotaRemaining !== undefined ? ` — ${result.quotaRemaining} summaries left this period.` : "."}`);
      }
      router.push("/app");
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        toast.warning("You're out of summary quota for now.");
      } else {
        toast.error(`Could not submit: ${(err as Error).message}`);
      }
      setSubmitting(null);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="text-3xl font-bold tracking-tight">Search papers</h1>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
        Search across arXiv, Semantic Scholar, and Crossref. Click Summarize to send any paper through the pipeline.
      </p>

      <form onSubmit={handleSubmit} className="mt-6 flex gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. transformer models in healthcare"
          className="flex-1 rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm shadow-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        />
        <button
          type="submit"
          className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200"
        >
          Search
        </button>
      </form>

      <UploadPaperCard onUploaded={(paper, viewUrl) => setUploaded({ paper, viewUrl })} />

      {uploaded ? (
        <div className="mt-6">
          <p className="text-xs text-slate-500 dark:text-slate-400">Uploaded paper</p>
          <ul className="mt-3">
            <PaperResultCard
              paper={uploaded.paper}
              submitting={submitting === uploaded.paper.id}
              onSummarize={() => handleSummarize(uploaded.paper)}
              pdfHref={uploaded.viewUrl}
            />
          </ul>
        </div>
      ) : null}

      {/* Results */}
      <div className="mt-8">
        {loading ? (
          <div className="space-y-4">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-28 animate-pulse rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
              />
            ))}
          </div>
        ) : results === null ? (
          <>
            <SearchPromptState />
            <SearchHistory onPick={pickHistory} className="mt-6" />
          </>
        ) : results.length === 0 ? (
          <NoResultsState q={initialQuery} />
        ) : (
          <>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {results.length} result{results.length === 1 ? "" : "s"} for &ldquo;{initialQuery}&rdquo;
            </p>
            <ul className="mt-3 space-y-4">
              {results.map((p) => (
                <PaperResultCard
                  key={p.id}
                  paper={p}
                  submitting={submitting === p.id}
                  onSummarize={() => handleSummarize(p)}
                />
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function PaperResultCard({
  paper,
  submitting,
  onSummarize,
  pdfHref,
}: {
  paper: Paper;
  submitting: boolean;
  onSummarize: () => void;
  pdfHref?: string;
}) {
  // Prefer an explicit override (e.g. pre-signed GET for an uploaded paper).
  // Fall back to paper.pdfUrl, but only if it's a real URL — `internal:` keys
  // are pipeline-only references, not browser-resolvable.
  const href =
    pdfHref ?? (paper.pdfUrl && !paper.pdfUrl.startsWith("internal:") ? paper.pdfUrl : undefined);
  return (
    <li className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-50">{paper.title}</h3>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {paper.authors.slice(0, 4).join(", ")}
            {paper.authors.length > 4 ? ` +${paper.authors.length - 4}` : ""}
            {paper.venue ? ` · ${paper.venue} ${paper.year}` : ` · ${paper.year}`}
            {paper.arxivId ? ` · arXiv:${paper.arxivId}` : ""}
          </p>
          <p className="mt-3 line-clamp-3 text-sm text-slate-600 dark:text-slate-300">{paper.abstract}</p>
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          <button
            onClick={onSummarize}
            disabled={submitting}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-700 disabled:opacity-60 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200"
          >
            {submitting ? "Submitting…" : "Summarize"}
          </button>
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
            >
              PDF
            </a>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function SearchPromptState() {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center dark:border-slate-700 dark:bg-slate-900">
      <h3 className="text-sm font-semibold">Enter a search term</h3>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        Try &ldquo;transformer&rdquo;, &ldquo;language model&rdquo;, or &ldquo;retrieval augmented&rdquo;.
      </p>
    </div>
  );
}

function NoResultsState({ q }: { q: string }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center dark:border-slate-700 dark:bg-slate-900">
      <h3 className="text-sm font-semibold">No results for &ldquo;{q}&rdquo;</h3>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        Try a different query.
      </p>
    </div>
  );
}

export default function SearchPage() {
  return (
    <Suspense fallback={null}>
      <SearchInner />
    </Suspense>
  );
}
