import { auth } from '@clerk/nextjs/server'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { Reveal, RevealGroup, RevealItem } from '@/components/ui/Motion'

// Neon landing (see /design.md): Blackout ground, generative data-stream backdrop,
// Inter display type with tight tracking, Whiteout pill CTAs, GeistMono terminal
// mock, and a bento feature grid on layered near-black surfaces.

function Logo() {
  return (
    <div className="flex items-center gap-2">
      <div className="w-6 h-6 rounded-[4px] bg-neon-glow flex items-center justify-center">
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <circle cx="7" cy="7" r="2.5" fill="#000" />
          <path d="M7 1v2M7 11v2M1 7h2M11 7h2" stroke="#000" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </div>
      <span className="text-sm font-medium tracking-tight text-whiteout">Agent Flight Recorder</span>
    </div>
  )
}

function TerminalMock() {
  return (
    <div className="neon-surface relative overflow-hidden font-mono text-sm leading-[1.65]">
      <div className="scanline" aria-hidden="true" />
      <div className="flex items-center gap-1.5 border-b border-graphite px-4 py-2.5">
        <span className="w-2.5 h-2.5 rounded-full bg-graphite-light" />
        <span className="w-2.5 h-2.5 rounded-full bg-graphite-light" />
        <span className="w-2.5 h-2.5 rounded-full bg-graphite-light" />
        <span className="ml-2 text-pewter text-xs">run_9f3c — replay</span>
      </div>
      <div className="p-4 space-y-1">
        <div className="text-ash">$ afr replay run_9f3c</div>
        <div className="text-cloud"><span className="text-neon-glow">RUN_STARTED</span> agent=support-triage v=1.4.0</div>
        <div className="text-cloud"><span className="text-neon-glow">LLM_REQUEST</span> model=claude-opus tokens=1,204</div>
        <div className="text-cloud"><span className="text-neon-glow">TOOL_CALL</span> search_docs("refund policy")</div>
        <div className="text-cloud"><span className="text-neon-glow">TOOL_RESULT</span> 3 matches · 412ms</div>
        <div className="text-ember"><span className="text-system-warning">RUN_FAILED</span> timeout after 30s · seq 41</div>
        <div className="text-ash">→ replay reconstructed 41 events · <span className="text-neon-glow">integrity ok</span></div>
      </div>
    </div>
  )
}

const FEATURES = [
  { k: 'Immutable event log', d: 'Every run is an append-only graph. Sequence-validated, never mutated — the record you can trust.' },
  { k: 'Replay & diff', d: 'Walk any run event-by-event. Diff two runs to see exactly what changed and where it broke.' },
  { k: 'Failure summaries', d: 'The terminal event, the error, the last tool call — surfaced instantly, no scrolling.' },
  { k: 'Tenant-isolated', d: 'Org-scoped from the schema up. Your runs never cross an organization boundary.' },
  { k: 'Durable SDK', d: 'Crash-safe ingestion. Terminal telemetry is retried, never dropped — even on process death.' },
  { k: 'Built for scale', d: 'Indexed hot paths, per-key rate limits, bounded queries. Ready for fleets of autonomous agents.' },
]

export default function RootPage() {
  const { userId } = auth()
  if (userId) redirect('/dashboard')

  return (
    <div className="min-h-screen bg-blackout text-whiteout">
      {/* Sticky header */}
      <header className="sticky top-0 z-40 border-b border-graphite-light/60 bg-blackout/80 backdrop-blur">
        <div className="mx-auto max-w-[1200px] px-6 h-14 flex items-center justify-between">
          <Logo />
          <nav className="flex items-center gap-2">
            <Link href="/sign-in" className="rounded-full border border-graphite-light px-[18px] py-2 text-sm text-whiteout hover:bg-graphite transition-colors">
              Log in
            </Link>
            <Link href="/sign-up" className="rounded-full bg-whiteout px-7 py-2 text-sm font-medium text-graphite-deep hover:bg-cloud transition-colors">
              Get started
            </Link>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="relative">
        <div className="data-stream-bg" aria-hidden="true" />
        <div className="relative mx-auto max-w-[1200px] px-6 pt-24 pb-20 text-center">
          <Reveal>
            <span className="inline-flex items-center gap-2 rounded-full border border-graphite-light px-3 py-1 font-mono text-xs uppercase tracking-wider text-ash">
              <span className="w-1.5 h-1.5 rounded-full bg-neon-glow animate-neon-pulse" /> Flight recorder for AI agents
            </span>
          </Reveal>
          <Reveal delay={0.06}>
            <h1 className="mx-auto mt-7 max-w-4xl text-[clamp(44px,8vw,80px)] font-medium leading-[1.02] tracking-[-0.03em] text-whiteout text-balance">
              Make agent failures explainable.
            </h1>
          </Reveal>
          <Reveal delay={0.12}>
            <p className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-ash">
              Record every agent run as an immutable event graph. Replay it, diff it, and understand exactly what happened — and why it broke.
            </p>
          </Reveal>
          <Reveal delay={0.18}>
            <div className="mt-9 flex items-center justify-center gap-3">
              <Link href="/sign-up" className="rounded-full bg-whiteout px-7 py-3 text-sm font-medium text-graphite-deep hover:bg-cloud transition-colors">
                Get started
              </Link>
              <Link href="/sign-in" className="rounded-full border border-graphite-light px-[18px] py-3 text-sm text-whiteout hover:bg-graphite transition-colors">
                Log in
              </Link>
            </div>
          </Reveal>
          <Reveal delay={0.26}>
            <div className="mx-auto mt-16 max-w-2xl text-left">
              <TerminalMock />
            </div>
          </Reveal>
        </div>
      </section>

      {/* Bento feature grid */}
      <section className="mx-auto max-w-[1200px] px-6 py-24">
        <Reveal>
          <h2 className="max-w-2xl text-[clamp(28px,4vw,48px)] font-medium leading-[1.1] tracking-[-0.02em] text-whiteout text-balance">
            Debuggability, by design.
          </h2>
          <p className="mt-4 max-w-xl text-base text-ash">
            When an agent misbehaves, open the trace and walk every event in sequence. Replay and diff are derived views — never the source of truth.
          </p>
        </Reveal>

        <RevealGroup className="mt-12 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => (
            <RevealItem
              key={f.k}
              className={[
                'neon-surface group relative overflow-hidden p-6 transition-colors hover:border-graphite-light',
                i === 0 ? 'lg:col-span-2' : '',
              ].join(' ')}
            >
              <div className="mb-3 flex items-center gap-2.5">
                {/* Sanctioned accent glow token — design.md "Glow" (status dots only) */}
                <span className="w-1.5 h-1.5 rounded-full bg-neon-glow shadow-[var(--shadow-glow)]" />
                <h3 className="text-[15px] font-medium text-whiteout">{f.k}</h3>
              </div>
              <p className="text-sm leading-relaxed text-ash">{f.d}</p>
              <div className="pointer-events-none absolute -right-6 -bottom-8 font-mono text-[64px] leading-none text-graphite/60 select-none">
                {String(i + 1).padStart(2, '0')}
              </div>
            </RevealItem>
          ))}
        </RevealGroup>
      </section>

      {/* CTA band */}
      <section className="border-t border-graphite-light/60">
        <div className="mx-auto max-w-[1200px] px-6 py-24 text-center">
          <Reveal>
            <h2 className="mx-auto max-w-2xl text-[clamp(28px,4vw,48px)] font-medium leading-[1.1] tracking-[-0.02em] text-whiteout text-balance">
              Ship agents you can actually debug.
            </h2>
            <div className="mt-8 flex items-center justify-center gap-3">
              <Link href="/sign-up" className="rounded-full bg-whiteout px-7 py-3 text-sm font-medium text-graphite-deep hover:bg-cloud transition-colors">
                Get started
              </Link>
              <Link href="/sign-in" className="rounded-full border border-graphite-light px-[18px] py-3 text-sm text-whiteout hover:bg-graphite transition-colors">
                Log in
              </Link>
            </div>
            <p className="mt-6 font-mono text-xs text-pewter">
              By continuing, you agree to our Terms of Service and Privacy Policy.
            </p>
          </Reveal>
        </div>
      </section>
    </div>
  )
}
