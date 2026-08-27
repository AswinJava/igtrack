import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AppError, AppErrorCode, type AppErrorCode as Code } from "@igtrack/core";

const STATUS_BY_CODE: Record<Code, number> = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  CONFLICT: 409,
  CAPABILITY_UNAVAILABLE: 503,
  PROVIDER_ERROR: 502,
  DATABASE_ERROR: 500,
  JOB_ERROR: 500,
  INTERNAL_ERROR: 500,
};

export function respondError(err: unknown): NextResponse {
  if (err instanceof ZodError) {
    return NextResponse.json(
      {
        error: {
          code: AppErrorCode.VALIDATION_ERROR,
          message: "Validation failed",
          details: err.flatten().fieldErrors,
        },
      },
      { status: 400 },
    );
  }
  if (err instanceof AppError) {
    const exposeDetails =
      process.env.NODE_ENV !== "production" && err.details !== undefined;
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          ...(exposeDetails ? { details: err.details } : {}),
        },
      },
      { status: STATUS_BY_CODE[err.code] },
    );
  }
  // Unknown failures are logged server-side; clients never see stack traces.
  console.error("[api] unhandled error:", err);
  return NextResponse.json(
    { error: { code: AppErrorCode.INTERNAL_ERROR, message: "Internal server error" } },
    { status: 500 },
  );
}

export function respondOk<T extends object>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

export function jsonOk<T extends object>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: NO_STORE });
}
