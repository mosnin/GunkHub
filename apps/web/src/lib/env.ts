export const env = {
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '',
  NEXT_PUBLIC_CONVEX_URL: process.env.NEXT_PUBLIC_CONVEX_URL ?? '',
}

// Validate at startup
if (typeof window !== 'undefined') {
  if (!env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) throw new Error('Missing NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY')
  if (!env.NEXT_PUBLIC_CONVEX_URL) throw new Error('Missing NEXT_PUBLIC_CONVEX_URL')
}
