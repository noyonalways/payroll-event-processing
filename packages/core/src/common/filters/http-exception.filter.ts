import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
// Type-only import: the body shape is the single workspace copy in @repo/shared
// (design D2 — the UI's hand-written duplicate of it was deleted in task 9).
import { ErrorResponseBody } from '@repo/shared';

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const status = exception.getStatus ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const exceptionResponse = exception.getResponse();

    const message: string | string[] =
      typeof exceptionResponse === 'object' && 'message' in exceptionResponse
        ? ((exceptionResponse as Record<string, unknown>).message as string | string[])
        : exception.message;

    const errorBody: ErrorResponseBody = {
      statusCode: status,
      message,
      error: exception.name,
      timestamp: new Date().toISOString(),
      path: request.url,
    };

    this.logger.warn(`HTTP ${status} — ${request.method} ${request.url}: ${JSON.stringify(message)}`);

    response.status(status).json(errorBody);
  }
}
