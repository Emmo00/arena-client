import { NextResponse } from "next/server";
import { logger } from "./logger";

/** Log a successful API request/operation with its duration in ms. Error paths
 * are logged by `handleApiError`. */
export function logOk(
  scope: string,
  msg: string,
  startedAt: number,
  fields?: Record<string, unknown>
): void {
  logger.info(scope, `${msg} (${Date.now() - startedAt}ms)`, fields);
}

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (msg: string) => new ApiError(400, "BAD_REQUEST", msg);
export const unauthorized = (msg = "Unauthorized") =>
  new ApiError(401, "UNAUTHORIZED", msg);
export const forbidden = (msg: string) => new ApiError(403, "FORBIDDEN", msg);
export const notFound = (msg: string) => new ApiError(404, "NOT_FOUND", msg);
export const conflict = (msg: string) => new ApiError(409, "CONFLICT", msg);
export const gone = (msg: string) => new ApiError(410, "GONE", msg);

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export function handleApiError(e: unknown) {
  if (e instanceof ApiError) {
    logger.warn(
      "api",
      `request rejected`,
      undefined,
      { status: e.status, code: e.code, message: e.message }
    );
    return NextResponse.json(
      { error: { code: e.code, message: e.message } },
      { status: e.status }
    );
  }
  logger.error("api", "unhandled API error", e);
  return NextResponse.json(
    { error: { code: "INTERNAL", message: "Internal server error" } },
    { status: 500 }
  );
}
