import { z } from "zod";

export interface ApiErrorPayload {
  error: {
    code: string;
    details?: unknown;
    message: string;
    retryable: boolean;
  };
}

export class ApiError extends Error {
  readonly code: string;
  readonly details: unknown;
  readonly retryable: boolean;
  readonly statusCode: number;

  constructor(
    code: string,
    message: string,
    statusCode = 500,
    retryable = false,
    details?: unknown
  ) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "ApiError";
    this.retryable = retryable;
    this.statusCode = statusCode;
  }
}

export const toApiError = (error: unknown): ApiError => {
  if (error instanceof ApiError) {
    return error;
  }
  if (error instanceof z.ZodError) {
    return new ApiError(
      "validation-error",
      "Request or persisted data did not match the expected schema.",
      400,
      true,
      error.flatten()
    );
  }
  if (error instanceof Error) {
    return new ApiError("internal-error", error.message, 500, true);
  }
  return new ApiError("internal-error", String(error), 500, true);
};
