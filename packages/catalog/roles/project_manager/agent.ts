import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Project-manager deskmate. Tracks sprint progress and delivery risk, and reports what " +
    "is done, in flight, and blocked. Delegate here for sprints, issues, roadmaps, delivery " +
    "status, or 'are we on track' questions.",
  // Each deskmate can run its own model. Defaults to the front desk's model.
  model: "anthropic/claude-sonnet-5.5",
});
