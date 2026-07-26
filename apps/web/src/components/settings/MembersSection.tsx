import Link from 'next/link'

import type { Membership, MembershipRole } from '@/lib/services/organizations'

import { Card } from '@/components/ui/Card'
import { CopyToClipboardButton } from '@/components/ui/CopyToClipboardButton'
import { EmptyState } from '@/components/ui/EmptyState'
import { truncateId } from '@/lib/utils'

interface MembersSectionProps {
  memberships: Membership[]
  loadError: string | null
  pendingDeletionAt: number | null
}

// Role badges use the same neutral/graphite palette as the rest of settings —
// role is informational, not a status to alarm on, so no destructive/warning
// tones (design.md: reserve those for genuine alert states).
const ROLE_STYLES: Record<MembershipRole, string> = {
  admin: 'bg-graphite-light text-whiteout border-graphite-light',
  member: 'bg-graphite text-cloud border-graphite-light',
  viewer: 'bg-graphite-deep text-pewter border-graphite',
}

function RoleBadge({ role }: { role: MembershipRole }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-[4px] text-xs font-mono font-medium border ${ROLE_STYLES[role]}`}
    >
      {role}
    </span>
  )
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export function MembersSection({ memberships, loadError, pendingDeletionAt }: MembersSectionProps) {
  return (
    <Card>
      <div className="px-5 py-4 border-b border-neutral-800">
        <h2 className="text-sm font-semibold text-neutral-200">Members</h2>
        <p className="mt-0.5 text-xs text-neutral-400">
          Everyone with access to this organization. Membership and role are synced from Clerk.
        </p>
      </div>

      <div className="px-5 py-4 flex flex-col gap-4">
        {pendingDeletionAt !== null && (
          <div
            role="alert"
            className="flex items-start gap-2 bg-destructive-900/40 border border-destructive-700/60 rounded-[4px] px-3 py-2.5"
          >
            <span
              className="w-1.5 h-1.5 rounded-full bg-destructive-500 shrink-0 mt-1 shadow-[var(--shadow-glow-warn)]"
              aria-hidden="true"
            />
            <p className="text-xs text-destructive-400 leading-relaxed">
              This organization was deleted in Clerk on{' '}
              <span className="font-mono">{formatDate(pendingDeletionAt)}</span>. The roster below
              may be stale — Clerk is no longer the source of new membership events for this org.
              Data erasure is pending operator action (ADR 001).
            </p>
          </div>
        )}

        {loadError ? (
          <p role="alert" className="text-destructive-400 text-sm">
            {loadError}
          </p>
        ) : memberships.length === 0 ? (
          <EmptyState
            title="No members found"
            description="This organization has no synced memberships yet. Membership rows are created by the Clerk organizationMembership webhook — invite someone to your Clerk organization to see them here."
          />
        ) : (
          <div className="overflow-x-auto rounded-md border border-neutral-800">
            <table className="w-full text-sm table-fixed">
              <thead>
                <tr className="border-b border-neutral-800 bg-neutral-900">
                  <th className="px-4 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider w-2/5">
                    User
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider w-1/5">
                    Role
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider w-2/5">
                    Joined
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-800 bg-neutral-950">
                {memberships.map((m) => (
                  <tr key={m.id}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <span
                          className="font-mono text-xs text-neutral-300 truncate"
                          title={m.clerkUserId}
                        >
                          {truncateId(m.clerkUserId, 16)}
                        </span>
                        <CopyToClipboardButton value={m.clerkUserId} label="Copy user ID" />
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <RoleBadge role={m.role} />
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-neutral-400">
                      {formatDate(m.joinedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-xs text-pewter leading-relaxed">
          Display name and email enrichment from Clerk profiles is a planned follow-up — today
          rows show the raw <span className="font-mono">clerkUserId</span>. Role changes and
          invitations happen in your{' '}
          <a
            href="https://dashboard.clerk.com"
            target="_blank"
            rel="noreferrer"
            className="text-neutral-300 underline underline-offset-2 hover:text-whiteout transition-colors duration-100"
          >
            Clerk dashboard
          </a>{' '}
          and sync here automatically via webhook — this page does not write roles directly, so
          authority always stays in one place. Role-change history is visible on the{' '}
          <Link href="/audit" className="text-neutral-300 underline underline-offset-2 hover:text-whiteout transition-colors duration-100">
            Audit
          </Link>{' '}
          page (admins only).
        </p>
      </div>
    </Card>
  )
}
