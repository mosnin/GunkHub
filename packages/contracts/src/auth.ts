export interface AuthContext {
  readonly userId: string;       // Clerk user ID
  readonly orgId: string;        // Clerk org ID (= AFR org tenancy scope)
  readonly orgRole: string;      // "org:admin" | "org:member" etc from Clerk
  readonly sessionId: string;
}

export interface OrgMembership {
  readonly orgId: string;
  readonly userId: string;
  readonly role: "owner" | "admin" | "member";
}
