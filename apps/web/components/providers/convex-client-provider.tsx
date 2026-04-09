"use client";

import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { useAuth } from "@clerk/nextjs";
import { getConvexUrl } from "@/lib/convex";

const convexClient = new ConvexReactClient(getConvexUrl());

// Type bridge: Clerk v5 UseAuth is runtime-compatible with convex/react-clerk's UseAuth
// but has a minor structural type mismatch (sessionClaims field). Cast to avoid the error.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const clerkUseAuth = useAuth as any;

export function ConvexClientProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ConvexProviderWithClerk client={convexClient} useAuth={clerkUseAuth}>
      {children}
    </ConvexProviderWithClerk>
  );
}
