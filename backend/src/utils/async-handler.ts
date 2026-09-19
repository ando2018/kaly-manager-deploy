import { NextFunction, Request, Response } from 'express';

/** Express 4 doesn't catch rejected promises from async handlers — wrap them so errors reach the error middleware instead of hanging the request. */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}
