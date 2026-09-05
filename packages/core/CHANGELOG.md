# Changelog

## [0.5.1](https://github.com/mimu-sh/deskmate/compare/core-v0.5.0...core-v0.5.1) (2026-09-05)


### Bug Fixes

* tell deskmates what today is ([#42](https://github.com/mimu-sh/deskmate/issues/42)) ([92310de](https://github.com/mimu-sh/deskmate/commit/92310de07a256a68b544d36ad191982333916fcb))

## [0.5.0](https://github.com/mimu-sh/deskmate/compare/core-v0.4.0...core-v0.5.0) (2026-09-04)


### ⚠ BREAKING CHANGES

* **deps:** eve 0.51 requires Node >= 24, and @deskmate/core now resolves eve ^0.51.1. Consumers pinned to eve 0.19 must upgrade with it, or pnpm installs two eve copies and the channels core builds run a different eve than `eve build`.

### Bug Fixes

* **slack:** give duration failures advice that can actually work ([#36](https://github.com/mimu-sh/deskmate/issues/36)) ([b6643eb](https://github.com/mimu-sh/deskmate/commit/b6643ebec43770358f0ea758c5c35a0daad989bc))


### Miscellaneous Chores

* **deps:** upgrade eve to 0.51.1 and migrate off ctx.receive ([#37](https://github.com/mimu-sh/deskmate/issues/37)) ([c4220a4](https://github.com/mimu-sh/deskmate/commit/c4220a4525377e021de0b77e01df647df0d7b6d3))

## [0.4.0](https://github.com/mama-sh/deskmate/compare/core-v0.3.2...core-v0.4.0) (2026-08-18)


### Features

* proactive jobs (scheduled + webhook-triggered) ([#34](https://github.com/mama-sh/deskmate/issues/34)) ([cb8e324](https://github.com/mama-sh/deskmate/commit/cb8e324ce8a92fc42356f405c851628bab992a29))

## [0.3.2](https://github.com/mama-sh/deskmate/compare/core-v0.3.1...core-v0.3.2) (2026-07-19)


### Bug Fixes

* **core:** hydrate Slack thread context on first [@mention](https://github.com/mention) into an existing thread ([#28](https://github.com/mama-sh/deskmate/issues/28)) ([4845e61](https://github.com/mama-sh/deskmate/commit/4845e6125ae2487306b5c3f16240946f31530fe1))

## [0.3.1](https://github.com/mama-sh/deskmate/compare/core-v0.3.0...core-v0.3.1) (2026-07-14)


### Bug Fixes

* **core:** follow up in Slack threads the bot joined without a re-[@mention](https://github.com/mention) ([#26](https://github.com/mama-sh/deskmate/issues/26)) ([5ec4c62](https://github.com/mama-sh/deskmate/commit/5ec4c62f613ba9ab777db0671a110bc1fd7bd5be))

## [0.3.0](https://github.com/mama-sh/deskmate/compare/core-v0.2.0...core-v0.3.0) (2026-07-06)


### Features

* agentic coding for deskmates (clone → change → PR) ([#23](https://github.com/mama-sh/deskmate/issues/23)) ([7ddc23a](https://github.com/mama-sh/deskmate/commit/7ddc23aa333f1e8bbf880a3e07757be254f13aaa))

## [0.2.0](https://github.com/mama-sh/deskmate/compare/core-v0.1.0...core-v0.2.0) (2026-07-05)


### Features

* **cli:** app-scoped OAuth (Vercel Connect) MCP connections ([#20](https://github.com/mama-sh/deskmate/issues/20)) ([73a2573](https://github.com/mama-sh/deskmate/commit/73a25730769700afcf55653e870c8a20c7d5ada3))
* cross-thread long-term memory for deskmates ([#17](https://github.com/mama-sh/deskmate/issues/17)) ([db4ff2c](https://github.com/mama-sh/deskmate/commit/db4ff2c92ade674cd7d8768ae94f61d16569eac0))

## 0.1.0 (2026-07-04)


### Features

* **core:** add optional per-deskmate voice field ([d774440](https://github.com/mama-sh/deskmate/commit/d774440119bcd48702a70f2c6434869bd9a3c75c))
* **core:** add optional watch block to ChannelRoute ([94e5e1e](https://github.com/mama-sh/deskmate/commit/94e5e1e1eab99379b5fd04f1eb7107fa5213b67f))
* **core:** add shared house-style voice + work block ([da394e7](https://github.com/mama-sh/deskmate/commit/da394e7889dad6c8296b5929eb5ef50dffc954d6))
* **core:** clampVerdict guardrail for the watch gate ([53a1e99](https://github.com/mama-sh/deskmate/commit/53a1e99ade2b4d7e186767a651950461bb6075da))
* **core:** classifyEvent LLM action selector (injectable, fails closed) ([d6296a5](https://github.com/mama-sh/deskmate/commit/d6296a5d6361ffe3b52c55f8a7fc0d4ede565bfe))
* **core:** createDeskmateSweep schedule factory ([4514b3f](https://github.com/mama-sh/deskmate/commit/4514b3f73a5df4f4878d87ad738f900bcb5451ea))
* **core:** front-desk follow-up continuity + human voice note ([29f3f8f](https://github.com/mama-sh/deskmate/commit/29f3f8f0911a14fc1a0adb39cfa21d07853aa56b))
* **core:** generalize the ambient channel into the two-tier watcher ([fe6a03a](https://github.com/mama-sh/deskmate/commit/fe6a03a68c9c86563def68117794b76245cdbe72))
* **core:** resolveWatch effective settings + env overrides ([d048169](https://github.com/mama-sh/deskmate/commit/d048169cb22e46bd008608ec7fb7c8bd1f377dae))
* **core:** Slack-derived reply-cooldown helpers ([82060c4](https://github.com/mama-sh/deskmate/commit/82060c4ffb191c97b4240475e0181dba5227294c))
* **core:** validate the channel watch block in defineTeam ([29847f2](https://github.com/mama-sh/deskmate/commit/29847f2aee22d8e7ab870b46f46dcb92e98c873d))
* deskmate voice + iteration-loop upgrade ([c2eb4d7](https://github.com/mama-sh/deskmate/commit/c2eb4d738e27e9517d80b44045e59261759f0ad3))
* proactive channel watching (opt-in two-tier watcher + scheduled sweep) ([a9743cb](https://github.com/mama-sh/deskmate/commit/a9743cb4d488408e0631bd2777b35e35d07fb901))
* **starter:** example deskmate voices + anti-slop guard; dedupe house-style header ([07e9ba1](https://github.com/mama-sh/deskmate/commit/07e9ba13c7dbfd56472ae8417599f466f35ce5ea))


### Bug Fixes

* **core,cli:** address Codex/Copilot review on the proactive watcher ([a5c59b6](https://github.com/mama-sh/deskmate/commit/a5c59b6b182eb8e7539d6125085552ee85dbf257))
* **core,cli:** sweep respects watch.post; delimit untrusted watcher text; DRY sweep cron ([09abb31](https://github.com/mama-sh/deskmate/commit/09abb3162fccb2d6bea3ddca8b6711b6391fb4a8))
* **core:** harden the watcher post cap + dispatch exhaustiveness ([798b329](https://github.com/mama-sh/deskmate/commit/798b329f1b612c587f6c3f66d47bdb307cf3ea15))
* **core:** remove em dashes from the house-style block ([6f92762](https://github.com/mama-sh/deskmate/commit/6f92762a43c61ea84f61f5b8d38ecbd5ba0b1947))
