import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { v4 as uuidv4 } from "uuid";
import { ok, clientError, serverError, log } from "../lib/http";
import { getPresignedPut, getPresignedGet } from "../lib/s3-presign";

const PUT_EXPIRES_SECONDS = 5 * 60;
const GET_EXPIRES_SECONDS = 60 * 60;
const MAX_PDF_BYTES = 25 * 1024 * 1024;

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = event.requestContext?.requestId ?? "unknown";
  const claims = (event.requestContext as { authorizer?: { claims?: { sub?: string } } })?.authorizer?.claims;
  const userId = claims?.sub;

  if (!userId) return clientError(401, "unauthorized", "missing user identity");

  let body: { filename?: string; contentLength?: number };
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return clientError(400, "invalid_body", "request body is not valid JSON");
  }

  const filename = (body.filename ?? "").trim();
  if (!filename || !filename.toLowerCase().endsWith(".pdf")) {
    return clientError(400, "invalid_filename", "filename must end with .pdf");
  }

  if (typeof body.contentLength === "number" && body.contentLength > MAX_PDF_BYTES) {
    return clientError(413, "too_large", `PDF must be ≤ ${MAX_PDF_BYTES} bytes`);
  }

  const paperId = `upload-${uuidv4()}`;
  const s3Key = `uploads/${userId}/${paperId}.pdf`;
  const internalUrl = `internal:${s3Key}`;

  try {
    const [uploadUrl, viewUrl] = await Promise.all([
      getPresignedPut(s3Key, "application/pdf", PUT_EXPIRES_SECONDS),
      getPresignedGet(s3Key, GET_EXPIRES_SECONDS),
    ]);

    log("get_upload_url", { requestId, userId, paperId, s3Key });
    return ok(
      {
        paperId,
        s3Key,
        uploadUrl,
        viewUrl,
        internalUrl,
        contentType: "application/pdf",
        maxBytes: MAX_PDF_BYTES,
      },
      { "Cache-Control": "no-store" },
    );
  } catch (err) {
    log("get_upload_url_failed", { requestId, message: (err as Error).message });
    return serverError(500, "internal_error", "could not create upload URL");
  }
}
