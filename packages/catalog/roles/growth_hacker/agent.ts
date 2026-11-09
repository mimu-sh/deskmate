import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Growth-hacker deskmate. Reads acquisition and activation funnels, finds the leakiest " +
    "step, and proposes experiments. Delegate here for growth, acquisition, conversion, " +
    "funnels, activation, or experiment ideas.",
  // Each deskmate can run its own model. Defaults to the front desk's model.
  model: "anthropic/claude-sonnet-5.5",
});
