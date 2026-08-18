// Public API of @deskmate/core.
//
// The engine is parameterized by the roster: consumers pass their own roster
// data into these helpers; core never imports a generated registry.
//
export type { Roster, DeskmateIdentity } from "./roster.js";

export { defineTeam, type TeamConfig, type DeskmateConfig, type ConnectionConfig, type CodingSetting } from "./config.js";

export { defineDeskmate } from "./deskmate.js";

export {
  deskmateSlackIdentity,
  deskmateRoster,
  chunkMarkdown,
  type SlackSenderIdentity,
} from "./deskmate-identity.js";

export {
  resolveRoute,
  resolveWatch,
  watchDisabled,
  resolveChannelTarget,
  isSlackChannelId,
  DEFAULT_REACTION_PALETTE,
  type ChannelRoute,
  type ResolvedRoute,
  type ChannelWatch,
  type EffectiveWatch,
} from "./channel-routes.js";

export { nextConveneDecision, maxTurns, type ConveneState } from "./convene.js";

export { createDeskmateSweep, sweepTargets, DEFAULT_SWEEP_CRON, type SweepTarget } from "./schedules/deskmate-sweep.js";
