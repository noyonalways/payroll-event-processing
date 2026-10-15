/**
 * Structured error body produced by the API's global `HttpExceptionFilter` for
 * every non-2xx response, and parsed by the UI's `ApiError` — one shape both
 * deployables agree on (design D2: the error-body shape lives in `shared`
 * because the UI re-defined it once and that copy drifted).
 */
export interface ErrorResponseBody {
  /** HTTP status code, echoed into the body. */
  statusCode: number;
  /** Human message, or the validation pipe's list of per-field messages. */
  message: string | string[];
  /** The error class (the exception name). */
  error: string;
  /** ISO-8601 timestamp of the failure. */
  timestamp: string;
  /** Request path the failure occurred on. */
  path: string;
}
