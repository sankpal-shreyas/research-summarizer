"use client";

import { useRef, useState } from "react";
import { uploadPaper, MAX_UPLOAD_BYTES, ApiError } from "@/lib/api";
import type { Paper } from "@/lib/types";
import { useToast } from "@/app/components/Toaster";

type Props = {
  onUploaded: (paper: Paper, viewUrl: string) => void;
};

export function UploadPaperCard({ onUploaded }: Props) {
  const toast = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);

  function pick(f: File | undefined | null) {
    if (!f) return;
    if (f.type && f.type !== "application/pdf") {
      toast.error("Only PDF files are supported.");
      return;
    }
    if (f.size > MAX_UPLOAD_BYTES) {
      toast.error(`PDF is too large (${formatSize(f.size)}). Max ${formatSize(MAX_UPLOAD_BYTES)}.`);
      return;
    }
    setFile(f);
    setTitle((prev) => prev || f.name.replace(/\.pdf$/i, ""));
  }

  function clear() {
    setFile(null);
    setTitle("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleUpload() {
    if (!file) return;
    setUploading(true);
    try {
      const { paper, viewUrl } = await uploadPaper(file, title);
      toast.success("Uploaded — ready to summarize.");
      onUploaded(paper, viewUrl);
      clear();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      toast.error(`Upload failed: ${msg}`);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="mt-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          pick(e.dataTransfer.files?.[0]);
        }}
        className={`rounded-xl border border-dashed p-6 transition ${
          dragOver
            ? "border-cyan-500 bg-cyan-50/40 dark:bg-cyan-500/10"
            : "border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900"
        }`}
      >
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
              Or upload your own PDF
            </h3>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Drop a research paper here, or click to choose. Up to {formatSize(MAX_UPLOAD_BYTES)}.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              onChange={(e) => pick(e.target.files?.[0])}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
            >
              Choose PDF
            </button>
          </div>
        </div>

        {file ? (
          <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-50">
                  {file.name}
                </p>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  {formatSize(file.size)}
                </p>
              </div>
              <button
                type="button"
                onClick={clear}
                disabled={uploading}
                className="text-xs text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline disabled:opacity-50 dark:text-slate-400 dark:hover:text-slate-200"
              >
                Remove
              </button>
            </div>

            <label className="mt-3 block text-xs font-medium text-slate-600 dark:text-slate-300">
              Title
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Paper title"
              disabled={uploading}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />

            <div className="mt-3 flex justify-end">
              <button
                type="button"
                onClick={handleUpload}
                disabled={uploading || !title.trim()}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-700 disabled:opacity-60 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200"
              >
                {uploading ? "Uploading…" : "Upload"}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
