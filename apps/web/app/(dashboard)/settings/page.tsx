import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export default function SettingsPage() {
  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Settings</h1>
        <p className="mt-1 text-sm text-gray-600">
          Manage your organization settings and API access
        </p>
      </div>

      {/* API Keys section */}
      <Card>
        <CardHeader className="p-4">
          <CardTitle>API Keys</CardTitle>
          <CardDescription>
            Use these keys to authenticate API requests from your agents.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-4 pb-4 space-y-3">
          <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-700">Default Key</span>
              <span className="text-xs text-gray-400">Created —</span>
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs text-gray-600 font-mono bg-white border border-gray-200 px-3 py-2 rounded">
                afr_••••••••••••••••••••••••••••••
              </code>
              <button
                className="px-3 py-2 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded hover:bg-gray-50 transition-colors"
                disabled
              >
                Copy
              </button>
            </div>
          </div>
          <button
            className="px-3 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors disabled:opacity-50"
            disabled
          >
            Generate new key
          </button>
          <p className="text-xs text-gray-400">
            API key management coming soon. Keys will be scoped per organization.
          </p>
        </CardContent>
      </Card>

      {/* Organization section */}
      <Card>
        <CardHeader className="p-4">
          <CardTitle>Organization</CardTitle>
          <CardDescription>
            Update your organization name and settings.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-4 pb-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Organization Name
            </label>
            <input
              type="text"
              placeholder="Your Organization"
              disabled
              className="w-full text-sm border border-gray-200 rounded px-3 py-2 text-gray-700 placeholder-gray-400 bg-gray-50"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Slug
            </label>
            <input
              type="text"
              placeholder="your-org"
              disabled
              className="w-full text-sm border border-gray-200 rounded px-3 py-2 text-gray-700 placeholder-gray-400 bg-gray-50 font-mono"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Plan
            </label>
            <div className="flex items-center gap-2">
              <span className="px-2 py-1 text-xs font-medium text-blue-700 bg-blue-50 rounded">
                Free
              </span>
              <a href="#" className="text-xs text-blue-600 hover:underline">
                Upgrade to Pro
              </a>
            </div>
          </div>
          <p className="text-xs text-gray-400">
            Organization settings are managed via Clerk. Visit your Clerk dashboard to update.
          </p>
        </CardContent>
      </Card>

      {/* Members section */}
      <Card>
        <CardHeader className="p-4">
          <CardTitle>Members</CardTitle>
          <CardDescription>
            Manage who has access to your organization.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-4 pb-4 space-y-3">
          <div className="divide-y divide-gray-100">
            {/* Stub member row */}
            <div className="flex items-center justify-between py-3">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center">
                  <span className="text-xs font-medium text-gray-600">?</span>
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-900">You</p>
                  <p className="text-xs text-gray-400">your@email.com</p>
                </div>
              </div>
              <span className="px-2 py-1 text-xs font-medium text-gray-600 bg-gray-100 rounded capitalize">
                owner
              </span>
            </div>
          </div>
          <button
            className="px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-md hover:bg-gray-50 transition-colors disabled:opacity-50"
            disabled
          >
            Invite member
          </button>
          <p className="text-xs text-gray-400">
            Member management coming soon. Use Clerk dashboard to invite team members.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
