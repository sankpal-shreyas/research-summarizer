import { putBytes, getBytes, keys } from "../../lib/s3";
import { updateJobStatus } from "../../lib/ddb";
import { log } from "../../lib/http";
import type { PipelinePayload } from "../../lib/types";

const FETCH_TIMEOUT_MS = 25_000;
const MAX_PDF_BYTES = 25 * 1024 * 1024; // 25 MB cap — academic papers rarely exceed this

/**
 * Step 1 of the pipeline.
 * Downloads the paper's PDF from its source URL and writes it to S3.
 * Updates the DynamoDB job to "running" so the user sees status flip
 * from "pending".
 */
export async function handler(event: PipelinePayload): Promise<PipelinePayload> {
  log("fetch_pdf_start", { jobId: event.jobId, url: event.paper.pdfUrl });

  await updateJobStatus({ userId: event.userId, jobId: event.jobId, status: "running" });

  if (!event.paper.pdfUrl) {
    throw new Error("paper has no pdfUrl");
  }

  let bytes: Uint8Array;
  if (event.paper.pdfUrl.startsWith("internal:")) {
    // User-uploaded PDF already resident in S3 (uploaded via /upload-url).
    const sourceKey = event.paper.pdfUrl.slice("internal:".length);
    const buf = await getBytes(sourceKey);
    if (buf.length > MAX_PDF_BYTES) {
      throw new Error(`PDF too large: ${buf.length} bytes (cap ${MAX_PDF_BYTES})`);
    }
    bytes = new Uint8Array(buf);
  } else {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(event.paper.pdfUrl, {
        headers: { "User-Agent": "research-summarizer/1.0 (NYU class project)" },
        signal: ctrl.signal,
        redirect: "follow",
      });
      if (!res.ok) {
        throw new Error(`PDF source returned HTTP ${res.status}`);
      }
      const arr = new Uint8Array(await res.arrayBuffer());
      if (arr.length > MAX_PDF_BYTES) {
        throw new Error(`PDF too large: ${arr.length} bytes (cap ${MAX_PDF_BYTES})`);
      }
      bytes = arr;
    } finally {
      clearTimeout(timer);
    }
  }

  const pdfKey = keys.pdf(event.jobId);
  await putBytes(pdfKey, bytes, "application/pdf");

  log("fetch_pdf_done", { jobId: event.jobId, pdfKey, size: bytes.length });
  return { ...event, pdfKey };
}
