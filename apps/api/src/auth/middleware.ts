import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, findUserById, toAuthUser } from './service.js';
import type { AuthUser } from '@pe/shared';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * Requires a valid bearer token. Re-reads the user so a deactivated
 * account loses access immediately rather than at token expiry.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;

  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'unauthorized', message: 'Missing bearer token' });
    return;
  }

  try {
    const payload = verifyAccessToken(header.slice(7));
    const userId = Number(payload.sub);

    if (!Number.isInteger(userId)) {
      res.status(401).json({ error: 'unauthorized', message: 'Invalid token subject' });
      return;
    }

    const row = await findUserById(userId);

    if (!row || !row.IsActive) {
      res.status(401).json({ error: 'unauthorized', message: 'Account is inactive' });
      return;
    }

    req.user = toAuthUser(row);
    next();
  } catch {
    res.status(401).json({ error: 'unauthorized', message: 'Invalid or expired token' });
  }
}

/** Restricts a route to the given roles. Use after requireAuth. */
export function requireRole(...roles: AuthUser['role'][]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'unauthorized', message: 'Not authenticated' });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: 'forbidden', message: 'Insufficient permissions' });
      return;
    }
    next();
  };
}
