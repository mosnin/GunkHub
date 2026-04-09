import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-gray-900">Agent Flight Recorder</h1>
          <p className="mt-2 text-sm text-gray-600">
            Sign in to inspect, replay, and compare agent runs
          </p>
        </div>
        <div className="flex justify-center">
          <SignIn
            appearance={{
              elements: {
                rootBox: "w-full",
                card: "shadow-sm border border-gray-200 rounded-lg",
              },
            }}
          />
        </div>
      </div>
    </div>
  );
}
