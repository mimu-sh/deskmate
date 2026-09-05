# Changelog

## [0.6.3](https://github.com/mimu-sh/deskmate/compare/cli-v0.6.2...cli-v0.6.3) (2026-09-05)


### Bug Fixes

* tell deskmates what today is ([#42](https://github.com/mimu-sh/deskmate/issues/42)) ([92310de](https://github.com/mimu-sh/deskmate/commit/92310de07a256a68b544d36ad191982333916fcb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @deskmate/core bumped to 0.5.1

## [0.6.2](https://github.com/mimu-sh/deskmate/compare/cli-v0.6.1...cli-v0.6.2) (2026-09-05)


### Bug Fixes

* **doctor:** stop reporting Vercel sensitive vars as unset ([#40](https://github.com/mimu-sh/deskmate/issues/40)) ([84a9f99](https://github.com/mimu-sh/deskmate/commit/84a9f994cb307008354002cbaeb5f68c87adf9ea))

## [0.6.1](https://github.com/mimu-sh/deskmate/compare/cli-v0.6.0...cli-v0.6.1) (2026-09-04)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @deskmate/core bumped to 0.5.0

## [0.6.0](https://github.com/mama-sh/deskmate/compare/cli-v0.5.0...cli-v0.6.0) (2026-08-18)


### Features

* proactive jobs (scheduled + webhook-triggered) ([#34](https://github.com/mama-sh/deskmate/issues/34)) ([cb8e324](https://github.com/mama-sh/deskmate/commit/cb8e324ce8a92fc42356f405c851628bab992a29))

## [0.5.0](https://github.com/mama-sh/deskmate/compare/cli-v0.4.0...cli-v0.5.0) (2026-07-06)


### Features

* **cli:** deploy provisions coding/channel sandbox templates before --prebuilt ([#24](https://github.com/mama-sh/deskmate/issues/24)) ([4f7a9d8](https://github.com/mama-sh/deskmate/commit/4f7a9d84d91ffbdb14b5c6c0704ce73f76163774))

## [0.4.0](https://github.com/mama-sh/deskmate/compare/cli-v0.3.0...cli-v0.4.0) (2026-07-06)


### Features

* agentic coding for deskmates (clone → change → PR) ([#23](https://github.com/mama-sh/deskmate/issues/23)) ([7ddc23a](https://github.com/mama-sh/deskmate/commit/7ddc23aa333f1e8bbf880a3e07757be254f13aaa))
* **cli:** connection doctor + deploy/scaffolding hardening ([#21](https://github.com/mama-sh/deskmate/issues/21)) ([9bc9452](https://github.com/mama-sh/deskmate/commit/9bc9452cafdfacc270524a408d1a0f184c1c8336))

## [0.3.0](https://github.com/mama-sh/deskmate/compare/cli-v0.2.0...cli-v0.3.0) (2026-07-05)


### Features

* **cli:** app-scoped OAuth (Vercel Connect) MCP connections ([#20](https://github.com/mama-sh/deskmate/issues/20)) ([73a2573](https://github.com/mama-sh/deskmate/commit/73a25730769700afcf55653e870c8a20c7d5ada3))
* cross-thread long-term memory for deskmates ([#17](https://github.com/mama-sh/deskmate/issues/17)) ([db4ff2c](https://github.com/mama-sh/deskmate/commit/db4ff2c92ade674cd7d8768ae94f61d16569eac0))

## [0.2.0](https://github.com/mama-sh/deskmate/compare/cli-v0.1.0...cli-v0.2.0) (2026-07-04)


### Features

* **cli:** add deskmate dev orchestrator ([7dbd670](https://github.com/mama-sh/deskmate/commit/7dbd670f4b89837f663d4ec461f6ed729e935647))
* **cli:** add quiet option to syncCommand ([9d63fd9](https://github.com/mama-sh/deskmate/commit/9d63fd9fa34ec89d97a8732d0db174ae5ed39dd3))
* **cli:** deskmate deploy — fix eve #channel trace gap on Vercel ([a09c562](https://github.com/mama-sh/deskmate/commit/a09c56241bdb39457f62598cdfbb00e7dc54ad15))
* **cli:** deskmate deploy — fix eve #channel trace gap on Vercel ([0db00a9](https://github.com/mama-sh/deskmate/commit/0db00a9d1ee0ce5dec48cf8460d4d996fecf25cf))
* **cli:** deskmate dev — local testing loop for your config ([149767c](https://github.com/mama-sh/deskmate/commit/149767cf0880d80d432bdd3b1b5f5241028181fb))
* **cli:** resolve the consumer's eve binary ([616699b](https://github.com/mama-sh/deskmate/commit/616699b95fe47ee3fc9433cf85b0a51c05c77af8))
* **cli:** wire up the deskmate dev command ([7f0a56f](https://github.com/mama-sh/deskmate/commit/7f0a56fae6ddd6c8a333497279bf5ca91e4ea7db))


### Bug Fixes

* **cli:** address deploy review (spawn errors, signal exits, build flags) ([41b263c](https://github.com/mama-sh/deskmate/commit/41b263c2edd310d6adcdca15c256ebc469b195bf))
* **cli:** guard deskmate dev against a missing roles dir ([899a364](https://github.com/mama-sh/deskmate/commit/899a364778b4ad099ceaaafead2f6cc7490a6833))
* **cli:** live-reload deskmate.config.ts edits in deskmate dev ([1177c57](https://github.com/mama-sh/deskmate/commit/1177c57d66a27526c857bd601cbc0741aaf00848))
* **cli:** serialize deskmate dev re-syncs and harden the roles watcher ([4e0f5f9](https://github.com/mama-sh/deskmate/commit/4e0f5f9a288296374b75dd03ed2bbd676825d385))

## 0.1.0 (2026-07-04)


### Features

* **cli,catalog:** seed deskmate voice from the role manifest ([3e50aca](https://github.com/mama-sh/deskmate/commit/3e50acacb0ff7b09f06ac0176d1a97f9858d48ee))
* **cli:** generate the sweep schedule when a channel opts into digest ([b8a6e9f](https://github.com/mama-sh/deskmate/commit/b8a6e9ffd7f3fb1f1b98de7d5bc501134f133d43))
* **cli:** sync serializes the channel watch block ([1ab62c6](https://github.com/mama-sh/deskmate/commit/1ab62c6c4139df95d3696924b1e9f468dcdeb3b1))
* **core:** front-desk follow-up continuity + human voice note ([29f3f8f](https://github.com/mama-sh/deskmate/commit/29f3f8f0911a14fc1a0adb39cfa21d07853aa56b))
* deskmate voice + iteration-loop upgrade ([c2eb4d7](https://github.com/mama-sh/deskmate/commit/c2eb4d738e27e9517d80b44045e59261759f0ad3))
* proactive channel watching (opt-in two-tier watcher + scheduled sweep) ([a9743cb](https://github.com/mama-sh/deskmate/commit/a9743cb4d488408e0631bd2777b35e35d07fb901))
* **starter:** example deskmate voices + anti-slop guard; dedupe house-style header ([07e9ba1](https://github.com/mama-sh/deskmate/commit/07e9ba13c7dbfd56472ae8417599f466f35ce5ea))
* **sync:** compose house-style + voice into deskmate instructions ([e35960f](https://github.com/mama-sh/deskmate/commit/e35960f245292aca9d7e7a7c810e3f7d4c8cae75))


### Bug Fixes

* **core,cli:** address Codex/Copilot review on the proactive watcher ([a5c59b6](https://github.com/mama-sh/deskmate/commit/a5c59b6b182eb8e7539d6125085552ee85dbf257))
* **core,cli:** sweep respects watch.post; delimit untrusted watcher text; DRY sweep cron ([09abb31](https://github.com/mama-sh/deskmate/commit/09abb3162fccb2d6bea3ddca8b6711b6391fb4a8))
