import { Request, Response, NextFunction } from 'express';
import { ServiceManager } from './services.js';

export class AuthManager {
  private serviceManager: ServiceManager;
  private sessions: Map<string, { username: string; expires: number }> = new Map();
  private sessionDuration = 24 * 60 * 60 * 1000;

  constructor(serviceManager: ServiceManager) {
    this.serviceManager = serviceManager;
  }

  generateSessionToken(): string {
    return Math.random().toString(36).substring(2) + Date.now().toString(36);
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

  authMiddleware() {
    return async (req: Request, res: Response, next: NextFunction) => {

      if (req.path === '/api/auth/login' || req.path === '/api/auth/status' || !req.path.startsWith('/api/')) {
        return next();
      }


      if (!this.serviceManager.hasAuth()) {
        return next();
      }


      const token = req.cookies?.session || req.headers['x-session-token'];

      if (!token || !this.validateSession(token as string)) {
        return res.status(401).json({ error: 'Unauthorized', requireAuth: true });
      }

      next();
    };
  }
}
