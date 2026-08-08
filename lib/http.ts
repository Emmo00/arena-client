import { NextResponse } from "next/server";

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
    return NextResponse.json(
      { error: { code: e.code, message: e.message } },
      { status: e.status }
    );
  }
  console.error("Unhandled API error:", e);
  return NextResponse.json(
    { error: { code: "INTERNAL", message: "Internal server error" } },
    { status: 500 }
  );
}
