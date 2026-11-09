import { defineAgent } from "eve";

export default defineAgent({
  description:
    "DevOps/SRE deskmate. Monitors logs and errors, triages incidents, explains likely " +
    "causes, and PROPOSES (never auto-applies) remediations. Delegate here for anything " +
    "about errors, incidents, deploys, latency, or system health.",
  // Each deskmate can run its own model. Defaults to the front desk's model.
  model: "anthropic/claude-sonnet-5.5",
});
