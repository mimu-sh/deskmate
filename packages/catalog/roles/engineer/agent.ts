import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Software-engineer deskmate. Clones a GitHub repo into an isolated sandbox, makes a " +
    "focused change on a new branch, runs the repo's tests, and opens a pull request for " +
    "human review. NEVER pushes to the default branch and NEVER merges. Delegate here to fix " +
    "a bug, apply a scoped feature, bump a dependency, or make a well-defined code change in a repo.",
  // Each deskmate can run its own model. Defaults to the front desk's model.
  model: "anthropic/claude-sonnet-5.5",
});
