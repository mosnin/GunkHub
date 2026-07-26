/**
 * TargetVersionPicker — choose which version(s) to analyse.
 *
 * A plain `<form method="get">`. No `'use client'`, no state, no JavaScript.
 * That is a choice, not a limitation:
 *
 *   - submitting navigates to `?baseline=…&target=…`, so every analysis has a
 *     STABLE, SHAREABLE URL. CLAUDE.md asks for exactly that, and an onChange
 *     handler driving client state would produce a view nobody can link to.
 *   - native `<select>` + submit is fully keyboard-operable and screen-reader
 *     correct with no ARIA work, and keeps this off the client bundle.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FLEET FORM ASKS FOR TWO VERSIONS
 * ---------------------------------------------------------------------------
 *
 * The engine's fleet scan is keyed on a (baseline, target) PAIR rather than on
 * an agent, because every speculative finding is a property of that pair and is
 * identical across all its runs — which is what makes the cheap tier possible.
 * The baseline also selects WHICH runs are scanned: the recorded history of the
 * version you are replacing. Hiding that behind "latest" would silently change
 * the population being analysed whenever a new version was created.
 *
 * Versions WITHOUT a config snapshot are still listed and are labelled as such.
 * Hiding them would be worse: an operator looking for a version they just
 * created would conclude it does not exist, rather than learning it cannot be
 * analysed and why. Selecting one lands on the unanalysable state, which
 * explains the remedy.
 */

import type { AgentVersion } from '@agent-flight-recorder/contracts'

interface VersionSelectProps {
  id: string
  name: string
  label: string
  hint: string
  versions: readonly AgentVersion[]
  selectedId?: string | undefined
}

function optionLabel(v: AgentVersion): string {
  const analysable = v.configSnapshot !== undefined && Object.keys(v.configSnapshot).length > 0
  return analysable ? v.version : `${v.version} — no config snapshot`
}

function VersionSelect({ id, name, label, hint, versions, selectedId }: VersionSelectProps) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-mono uppercase text-pewter">
        {label}
      </label>
      <select
        id={id}
        name={name}
        defaultValue={selectedId ?? ''}
        aria-describedby={`${id}-hint`}
        className="rounded-[4px] bg-graphite-deep border border-graphite-light text-cloud text-sm font-mono px-2 py-1.5 min-w-[220px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-glow"
      >
        <option value="" disabled>
          Select a version…
        </option>
        {versions.map((v) => (
          <option key={v.id} value={v.id}>
            {optionLabel(v)}
          </option>
        ))}
      </select>
      <span id={`${id}-hint`} className="text-xs text-pewter">
        {hint}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Fleet: baseline + target
// ---------------------------------------------------------------------------

interface FleetVersionPickerProps {
  versions: readonly AgentVersion[]
  baselineId?: string | undefined
  targetId?: string | undefined
  action: string
}

export function FleetVersionPicker({
  versions,
  baselineId,
  targetId,
  action,
}: FleetVersionPickerProps) {
  return (
    <form method="get" action={action} className="flex items-start gap-4 flex-wrap">
      <VersionSelect
        id="baseline-version"
        name="baseline"
        label="Baseline version"
        hint="Whose recorded runs to check."
        versions={versions}
        selectedId={baselineId}
      />
      <VersionSelect
        id="target-version"
        name="target"
        label="Target version"
        hint="The version you are considering shipping."
        versions={versions}
        selectedId={targetId}
      />
      <button
        type="submit"
        className="mt-[22px] rounded-full bg-whiteout hover:bg-cloud text-graphite-deep text-sm font-medium px-[18px] py-1.5 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-glow"
      >
        Analyse
      </button>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Single run: target only
// ---------------------------------------------------------------------------
//
// A run already knows the version it executed under, so the baseline is a fact
// rather than a choice. Offering it as a control would invite an operator to
// analyse a run against a baseline it never ran on, which is not a question
// recorded history can answer.

interface RunVersionPickerProps {
  versions: readonly AgentVersion[]
  targetId?: string | undefined
  action: string
}

export function RunVersionPicker({ versions, targetId, action }: RunVersionPickerProps) {
  return (
    <form method="get" action={action} className="flex items-start gap-4 flex-wrap">
      <VersionSelect
        id="target-version"
        name="target"
        label="Target version"
        hint="Checked against this run's recorded history."
        versions={versions}
        selectedId={targetId}
      />
      <button
        type="submit"
        className="mt-[22px] rounded-full bg-whiteout hover:bg-cloud text-graphite-deep text-sm font-medium px-[18px] py-1.5 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-glow"
      >
        Analyse
      </button>
    </form>
  )
}
