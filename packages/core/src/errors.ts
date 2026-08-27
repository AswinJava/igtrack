export const AppErrorCode = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  CONFLICT: "CONFLICT",
  CAPABILITY_UNAVAILABLE: "CAPABILITY_UNAVAILABLE",
  PROVIDER_ERROR: "PROVIDER_ERROR",
  DATABASE_ERROR: "DATABASE_ERROR",
  JOB_ERROR: "JOB_ERROR",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type AppErrorCode =
  (typeof AppErrorCode)[keyof typeof AppErrorCode];

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly details?: Record<string, unknown> | undefined;

  constructor(
    code: AppErrorCode,
    message: string,
    options: { details?: Record<string, unknown> | undefined; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : {});
    this.name = "AppError";
    this.code = code;
    this.details = options.details;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
