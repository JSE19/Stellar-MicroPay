import { Request, Response, NextFunction } from "express";

export declare class AppError extends Error {
  status: number;
  code: string;
  details: any;
  constructor(status: number, message: string, code?: string, details?: any);
}

export declare function errorHandler(
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
): void;

export declare function notFoundHandler(
  req: Request,
  res: Response,
  next: NextFunction
): void;

export declare function resolveRequestId(req: Request, res?: Response): string;

export declare const STATUS_TO_CODE: Record<number, string>;
