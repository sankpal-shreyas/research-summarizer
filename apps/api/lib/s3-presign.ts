import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const PDF_BUCKET = process.env.PDF_BUCKET!;

const s3 = new S3Client({ region: REGION });

export async function getPresignedPut(
  key: string,
  contentType: string,
  expiresInSeconds: number,
): Promise<string> {
  const cmd = new PutObjectCommand({
    Bucket: PDF_BUCKET,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(s3, cmd, { expiresIn: expiresInSeconds });
}

export async function getPresignedGet(
  key: string,
  expiresInSeconds: number,
): Promise<string> {
  const cmd = new GetObjectCommand({
    Bucket: PDF_BUCKET,
    Key: key,
  });
  return getSignedUrl(s3, cmd, { expiresIn: expiresInSeconds });
}
