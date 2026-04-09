import { SignUp } from "@clerk/nextjs";

export default function SignUpPage() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-gray-900">Agent Flight Recorder</h1>
          <p className="mt-2 text-sm text-gray-600">
            Create an account to start recording agent executions
          </p>
        </div>
        <div className="flex justify-center">
          <SignUp
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
