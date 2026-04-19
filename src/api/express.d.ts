declare global {
  namespace Express {
    interface Request {
      workspaceId: string;
      userId: string;
      /**
       * Raw request body captured by the express.json() verify callback
       * in server.ts. Webhook handlers that must re-hash the exact bytes
       * Stripe / Postmark / etc. signed read from here instead of
       * re-serializing req.body, which would break signature checks.
       */
      rawBody?: Buffer;
      /** Workspace name decoded from a daemon JWT token. */
      workspaceName?: string;
      /** Per-workspace SQLite connection pool injected by auth middleware. */
      dbPool?: import('../db/workspace-db-pool.js').WorkspaceDbPool;
    }
  }
}
export {};
