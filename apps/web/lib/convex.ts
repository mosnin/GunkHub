/**
 * Returns the validated Convex URL from the environment.
 * Throws an error at startup if the env var is missing so issues
 * surface immediately rather than at request time.
 */
export function getConvexUrl(): string {
  const url = process.env["NEXT_PUBLIC_CONVEX_URL"];
  if (!url) {
    throw new Error(
      "Missing environment variable: NEXT_PUBLIC_CONVEX_URL\n" +
        "Set it in .env.local or your deployment environment."
    );
  }
  return url;
}
