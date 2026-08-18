import { describe, it, expect } from "vitest";
import { sweepTargets } from "../src/schedules/deskmate-sweep.js";

const routes = {
  C0A: { deskmate: "devops", watch: { digest: true, post: true } },   // sweeps
  C0B: { deskmate: "growth_hacker", watch: { digest: true } },        // digest but no post → skipped
  C0C: { deskmate: "product_analyst", watch: { reply: true } },       // no digest
  C0D: { deskmate: "devops" },                                        // not watched
};

describe("sweepTargets", () => {
  it("selects only channels with BOTH digest and post enabled", () => {
    expect(sweepTargets(routes as any).map((t) => t.channelId)).toEqual(["C0A"]);
  });
  it("carries the routed deskmate on each target", () => {
    expect(sweepTargets(routes as any)).toEqual([{ channelId: "C0A", deskmate: "devops" }]);
  });
});

it("resolves a name-keyed channel to its declared Slack id", () => {
  const named = { "ask-devops": { deskmate: "devops", id: "C0XYZ", watch: { digest: true, post: true } } };
  expect(sweepTargets(named as any)).toEqual([{ channelId: "C0XYZ", deskmate: "devops" }]);
});
