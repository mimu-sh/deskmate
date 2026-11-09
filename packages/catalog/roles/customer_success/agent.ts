import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Customer-success deskmate. Watches account health, churn risk, and renewals, and " +
    "flags accounts that need attention. Delegate here for customer health, support load, " +
    "churn, retention, or renewal questions.",
  // Each deskmate can run its own model. Defaults to the front desk's model.
  model: "anthropic/claude-sonnet-5.5",
});
