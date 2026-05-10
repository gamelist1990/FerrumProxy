import { Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';
import { ServiceManager } from './services.js';

export class AuthManager {
  private serviceManager: ServiceManager;
  private sessions: Map<string, { username: string; expires: number }> = new Map();
  private loginFailures: Map<string, { count: number; firstFailureAt: number; blockedUntil?: number }> = new Map();
  private sessionDuration = 24 * 60 * 60 * 1000;
  private readonly loginFailureWindow = 10 * 60 * 1000;
  private readonly loginFailureThreshold = 5;
  private readonly loginLockoutDuration = 15 * 60 * 1000;

  constructor(serviceManager: ServiceManager) {
    this.serviceManager = serviceManager;
  }

  generateSessionToken(): string {
    return randomBytes(32).toString('base64url');
  }

  createSession(username: string): string {
    const token = this.generateSessionToken();
    this.sessions.set(token, {
      username,
      expires: Date.now() + this.sessionDuration,
    });
    return token;
  }

  validateSession(token: string): boolean {
    const session = this.sessions.get(token);
    if (!session) return false;

    if (Date.now() > session.expires) {
      this.sessions.delete(token);
      return false;
    }

    return true;
  }

  deleteSession(token: string): void {
    this.sessions.delete(token);
  }

  normalizeUsername(username: string): string {
    return username.trim().toLowerCase();
  }

  canAttemptLogin(username: string): { allowed: boolean; retryAfterMs?: number } {
    const key = this.normalizeUsername(username);
    const now = Date.now();
    const state = this.loginFailures.get(key);

    if (!state) {
      return { allowed: true };
    }

    if (state.blockedUntil && state.blockedUntil > now) {
      return { allowed: false, retryAfterMs: state.blockedUntil - now };
    }

    if (now - state.firstFailureAt > this.loginFailureWindow) {
      this.loginFailures.delete(key);
      return { allowed: true };
    }

    return { allowed: true };
  }

  registerFailedLogin(username: string): { blocked: boolean; retryAfterMs?: number } {
    const key = this.normalizeUsername(username);
    const now = Date.now();
    const current = this.loginFailures.get(key);

    if (!current || now - current.firstFailureAt > this.loginFailureWindow) {
      this.loginFailures.set(key, { count: 1, firstFailureAt: now });
      return { blocked: false };
    }

    const nextCount = current.count + 1;
    if (nextCount >= this.loginFailureThreshold) {
      const blockedUntil = now + this.loginLockoutDuration;
      this.loginFailures.set(key, {
        count: nextCount,
        firstFailureAt: current.firstFailureAt,
        blockedUntil,
      });
      return { blocked: true, retryAfterMs: this.loginLockoutDuration };
    }

    this.loginFailures.set(key, {
      count: nextCount,
      firstFailureAt: current.firstFailureAt,
    });
    return { blocked: false };
  }

  clearFailedLogins(username: string): void {
    this.loginFailures.delete(this.normalizeUsername(username));
  }

  sessionTokenFromRequest(req: Request): string | undefined {
    const token = req.cookies?.session || req.headers['x-session-token'];
    return typeof token === 'string' ? token : undefined;
  }

  private bearerTokenFromRequest(req: Request): string | undefined {
    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
      return undefined;
    }
    const token = auth.slice('Bearer '.length).trim();
    return token ? token : undefined;
  }

  private isManagerTokenAllowed(req: Request): boolean {
    const token = this.bearerTokenFromRequest(req);
    if (!token) {
      return false;
    }

    if (req.path === '/api/instances') {
      return this.serviceManager
        .getAll()
        .some((instance) => instance.managerToken === token);
    }

    const match = req.path.match(/^\/api\/instances\/([^/]+)\/public-metadata$/);
    if (match) {
      const instance = this.serviceManager.getById(match[1]);
      return !!instance?.managerToken && instance.managerToken === token;
    }

    return false;
  }

  strictAuthMiddleware() {
    return async (req: Request, res: Response, next: NextFunction) => {
      if (!this.serviceManager.hasAuth()) {
        return res.status(403).json({
          error: 'Authentication must be configured before issuing shared relay tokens',
          requireAuth: true,
        });
      }

      const token = this.sessionTokenFromRequest(req);
      if (!token || !this.validateSession(token)) {
        return res.status(401).json({ error: 'Unauthorized', requireAuth: true });
      }

      next();
    };
  }

  authMiddleware() {
    return async (req: Request, res: Response, next: NextFunction) => {

      if (
        req.path === '/api/auth/login' ||
        req.path === '/api/auth/status' ||
        /^\/api\/instances\/[^/]+\/manager\//.test(req.path) ||
        !req.path.startsWith('/api/')
      ) {
        return next();
      }


      if (!this.serviceManager.hasAuth()) {
        return next();
      }

      if (this.isManagerTokenAllowed(req)) {
        return next();
      }


      const token = this.sessionTokenFromRequest(req);

      if (!token || !this.validateSession(token)) {
        return res.status(401).json({ error: 'Unauthorized', requireAuth: true });
      }

      next();
    };
  }
}
