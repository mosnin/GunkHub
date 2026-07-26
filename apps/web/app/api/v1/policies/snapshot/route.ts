import { type NextRequest, NextResponse } from 'next/server'

import { fieldsInvalidArgument, parseFieldsParam } from '../../_lib/fieldsParam'

import { mapApiErrorV1, v1InvalidArgument, v1UnauthorizedNoKey } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { apiV1Envelope } from '@/lib/apiV1Envelope'
import { hashApiKey } from '@/lib/convexServer'
import { apiGetPolicySnapshot } from '@/lib/services/api_v1_policies'

// ---------------------------------------------------------------------------
// GET /api/v1/policies/snapshot — "which prohibitions govern me?", asked BEFORE
// acting.
//
// x-api-key auth, org-scoped. Wraps convex/policy_gate.ts `sdkCheckPolicy`,
// which resolves the key, takes its org FROM the key, and narrows within it.
// Powers `FlightReader.getPolicySnapshot` and the SDK's in-process preflight.
//
// A LISTING OF DEFINITIONS, NOT OF ANSWERS — unlike the budget snapshot, which
// carries evaluated states. Deliberate, and it is what makes the preflight
// affordable: a prohibition is decidable IN THE CLIENT from the definition and
// the proposed act, so the SDK asks once per shelf life and answers locally for
// free thereafter. Only spend needs the server, because only the server can sum
// it.
//
// AND THE LIMIT, STATED RATHER THAN IMPLIED: this answer is ADVISORY. Nothing
// here prevents anything. A caller that ignores it produces a run this system
// records in full, and the recording is the point.
//
// SCOPE NOTE: `sdkCheckPolicy` resolves the key through the same read path the
// budget gate uses. This is a PRE-WRITE check, semantically part of the write
// path the key already holds — requiring `read` would deny every key scoped
// exactly `["ingest:write"]`, which is the overwhelmingly common SDK key.
//
// ---------------------------------------------------------------------------
// A SUBJECT IS REQUIRED, AND `orgWide` MUST BE ASKED FOR BY NAME
// ---------------------------------------------------------------------------
//
// Omitting every id would be read as "everything that governs me", which
// silently CHANGES MEANING the day somebody adds an org-wide policy — and it
// changes it in the direction that under-reports. The SDK raises before it sends
// (`getPolicySnapshot` throws `RangeError`); this route refuses on arrival so a
// hand-rolled client gets the same answer. The refusal is emitted BEFORE the key
// is resolved, so a malformed request cannot be used to probe whether a key is
// valid.
// ---------------------------------------------------------------------------
export const GET = withApiHandler(
  '/api/v1/policies/snapshot',
  async (req: NextRequest, ctx) => {
    const sp = req.nextUrl.searchParams
    const projectId = sp.get('projectId')
    const agentId = sp.get('agentId')
    const environment = sp.get('environment')
    const runId = sp.get('runId')
    const orgWide = sp.get('orgWide')

    const named = [projectId, agentId, environment, runId].filter(
      (value) => value !== null && value !== '',
    )

    // Parameter validation FIRST, before the key is touched. That ordering is
    // what keeps a malformed request from being an existence oracle: every
    // response below is identical whether the key is valid, invalid or absent.
    if (named.length === 0 && orgWide !== 'true') {
      return v1InvalidArgument(
        'name a subject: one or more of projectId, agentId, environment, runId — or pass orgWide=true to ask ' +
          'about the org explicitly. There is deliberately no implicit default: a preflight whose subject is ' +
          'implicit silently changes meaning the day somebody adds an org-wide policy, and it changes it in the ' +
          'direction that under-reports what forbids you.',
        ctx.requestId,
      )
    }
    if (orgWide !== null && orgWide !== 'true') {
      return v1InvalidArgument(
        'orgWide, when supplied, must be exactly "true". It is an explicit opt-in and never a default, so it is ' +
          'not coerced from other values.',
        ctx.requestId,
      )
    }

    // ---------------------------------------------------------------------
    // `fields` IS REFUSED ON THIS ROUTE.
    //
    // Same ruling as the budget snapshot, and the reason transfers exactly. A
    // listing is not a document, it is an ANSWER, and the fields a projection
    // would strip are the ones that decide what the answer means:
    //
    //   `listingTruncated` is the difference between "these are all the rules"
    //     and "these are some of the rules". Strip it and contracts refuses the
    //     body — safe, but useless.
    //   `policies[].rule` IS THE PROHIBITION. Strip it and the SDK is holding a
    //     listing that forbids nothing, which is the answer `no_listed_policy_
    //     forbids_this_act` is built out of. That is the permissive direction,
    //     and it is reachable in one query parameter.
    //   `subject` is what proves the answer is about the subject that was asked
    //     about.
    //
    // Shape is still validated with the shared helper before the refusal, so a
    // malformed `fields` gets the same message here as everywhere else.
    // ---------------------------------------------------------------------
    const fields = parseFieldsParam(sp)
    if (!fields.ok) {
      return fieldsInvalidArgument(fields.message, ctx.requestId)
    }
    if (fields.fields !== undefined) {
      return v1InvalidArgument(
        'fields projection is not supported on this route. Every field of a policy listing is required by the ' +
          'client-side preflight that reads it — a projected listing is refused as malformed, and a listing that ' +
          'lost its rules would answer "nothing forbids this act". Omit the fields parameter.',
        ctx.requestId,
      )
    }

    const apiKey = req.headers.get('x-api-key')
    if (!apiKey) {
      return v1UnauthorizedNoKey(ctx.requestId)
    }

    // The subject echoed back on the snapshot is the one the CALLER asked for,
    // not the one the backend resolved. The SDK compares it against its own
    // parameters and refuses a listing whose subject differs, which is how a
    // deployment that ignored a narrowing id is caught — a well-formed answer to
    // a question nobody asked is, here, "some other agent's prohibitions"
    // applied to this one.
    const subjectEcho: Record<string, unknown> = {
      ...(projectId !== null && projectId !== '' && { projectId }),
      ...(agentId !== null && agentId !== '' && { agentId }),
      ...(environment !== null && environment !== '' && { environment }),
      ...(runId !== null && runId !== '' && { runId }),
      ...(orgWide === 'true' && { orgWide: true }),
    }

    try {
      const result = await apiGetPolicySnapshot(
        hashApiKey(apiKey),
        {
          ...(projectId !== null && projectId !== '' && { projectId }),
          ...(agentId !== null && agentId !== '' && { agentId }),
          ...(environment !== null && environment !== '' && { environment }),
          ...(runId !== null && runId !== '' && { runId }),
        },
        subjectEcho,
      )
      return NextResponse.json(apiV1Envelope(result, ctx.requestId))
    } catch (err) {
      const mapped = mapApiErrorV1(err, ctx.requestId)
      if (mapped) return mapped
      throw err
    }
  },
  // Same ingest-key rate class as the budget snapshot and the other v1 reads.
  // Deliberately NOT tighter: a preflight a caller cannot afford to ask is a
  // check that gets commented out the first time somebody profiles the loop.
  { rateLimit: { key: 'apiKey', limitPerMin: 300 } },
)
