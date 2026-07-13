export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(code: string, message: string, details?: unknown) {
  return new HttpError(400, code, message, details);
}

export function forbidden(code = "forbidden", message = "Access denied.") {
  return new HttpError(403, code, message);
}

export function notFound(code: string, message: string) {
  return new HttpError(404, code, message);
}

export function conflict(code: string, message: string, details?: unknown) {
  return new HttpError(409, code, message, details);
}
