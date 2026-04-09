// Convex auth configuration — tells Convex which JWT issuers to trust.
// The domain must match the Clerk issuer URL for your application.
// Set CLERK_JWT_ISSUER_DOMAIN in your environment (e.g. https://your-app.clerk.accounts.dev).
// See .env.example for setup instructions.

export default {
  providers: [
    {
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN,
      applicationID: "convex",
    },
  ],
};
