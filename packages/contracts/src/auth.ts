export interface AuthContext {
  userId: string;
  orgId: string;
  orgRole: "admin" | "member" | "viewer";
  sessionId: string;
}

/** Utility type that merges an arbitrary type T with an auth context. */
export type WithAuthContext<T> = T & { auth: AuthContext };
