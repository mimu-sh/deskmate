import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Product-analyst deskmate. Turns usage data into a short narrative: what changed, " +
    "why it might have, what to look at next. Delegate here for product metrics, usage, " +
    "funnels, activation, retention.",
  // Each deskmate can run its own model. Defaults to the front desk's model;
  // change this line for a cheaper or stronger model per deskmate.
  model: "anthropic/claude-sonnet-5.5",
});
