export default {
  providers: [
    {
      // Set CLERK_JWT_ISSUER_DOMAIN in .env.local
      // Format: https://<your-clerk-domain>
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN as string,
      applicationID: "convex",
    },
  ],
};
