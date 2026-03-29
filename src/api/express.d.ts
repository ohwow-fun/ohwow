declare global {
  namespace Express {
    interface Request {
      workspaceId: string;
      userId: string;
    }
  }
}
export {};
