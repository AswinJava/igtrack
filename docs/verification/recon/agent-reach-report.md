# Agent Reach — reconnaissance report

Target: `C:\Users\aswin\Agent-Reach` @ `df539ff1ace314a812b087b9079ce9cb33d6b06c` (2026-10-08, "fix: discover all skill roots, add verified channel fallbacks").
Date: 2026-10-16. Method: read source + docs; ran `agent-reach doctor` and `agent-reach doctor --json` (CLI was on PATH). Repo NOT modified. README/SKILL are Chinese; quotes below are translated and marked.

## 1. Identity

- License MIT: `LICENSE:1` ("MIT License", © 2025 Agent Eyes).
- Version 1.5.0: `pyproject.toml:3`, `agent_reach/__init__.py:4`. Python ≥3.10 (`pyproject.toml:7`), hatchling; console entry `agent-reach = agent_reach.cli:main` (`pyproject.toml:53`); argparse CLI (`agent_reach/cli.py:68-257`).
- Layout: `agent_reach/{cli,core,doctor,probe,config,cookie_extract,transcribe}.py`; `agent_reach/channels/*.py` (16 channels registered in `channels/__init__.py:27-44`); `agent_reach/backends/opencli.py`; `agent_reach/skill/SKILL.md` + `skill/references/*.md`; also an MCP server module (`integrations/mcp_server.py`, not exercised).
- Self-description mismatch: `llms.txt:3` says "15 platforms", `skill/SKILL.md:13` says 16; doctor reports 16 channels.
- Core claim (README, zh): picks/installs/health-checks "the most stable access method for you; backends rotate, you don't care" (`README.md:8-9`). Source-verified: it is an installer/router/doctor, not a data layer — "agents call the upstream tools directly — no wrapper layer needed" (`agent_reach/core.py:1-7`).

## 2. Channel architecture

- `Channel` ABC (`channels/base.py:29-70`): `name`, ordered `backends` (backends[0] preferred), `tier` (0 zero-config, 1 free key/login, 2 complex setup), `can_handle(url)`, `check(config) -> (status, message)`; `check()` must set `active_backend` (`None` = unavailable). Config/env `<channel>_backend` reorders candidates; unknown overrides are ignored so they "can never hide working backends" (`base.py:45-59`).
- Doctor collects checks (`doctor.py:16-45`); statuses ok/warn/off/error; a broken channel degrades to `error` without killing the report (`doctor.py:27-32`); rows are `{status,name,message,tier,backends,active_backend}` (`doctor.py:37-44`). JSON mode `cli.py:140-142`.
- Routing is skill-level, not code-level: `SKILL.md:51-62` routes intent → reference doc; `SKILL.md:32-36` instructs agents to run `agent-reach doctor --json` first and then call the upstream CLI named by `active_backend`. Agent Reach itself never fetches platform data (`core.py:1-7`).
- OpenCLI = external npm package `@jackwener/opencli` (`backends/opencli.py:28`): "drives the user's real Chrome via a browser-bridge extension + local daemon, reusing existing login sessions — zero per-platform configuration, desktop-only (no headless)" (`opencli.py:4-6`). Extension store URL/id `opencli.py:29-32`; daemon loopback status `http://127.0.0.1:19825/status` (`opencli.py:50`).
- Per-channel evidence (source-verified):
  - Instagram: `channels/instagram.py:7-13` (`site="instagram"`, domains `instagram.com/instagr.am`, usage `opencli instagram search/profile/user/explore -f yaml`).
  - X: `channels/twitter.py:34-38`, backends `["twitter-cli","OpenCLI","bird CLI (legacy)"]`, tier 1.
  - Reddit: `channels/reddit.py:30-34`, backends `["OpenCLI","rdt-cli"]`, tier 1; docstring `reddit.py:2-9`: "there is NO zero-config path… anonymous .json blocked (403)… official API closed self-service registration 2025-11".
  - YouTube: `channels/youtube.py:39-43`, backends `["yt-dlp"]`, tier 0.
  - Web (generic): `channels/web.py:34-46`, backends `["Jina Reader"]`, tier 0, `can_handle → True` for any URL; `read()` fetches `https://r.jina.ai/<url>` (`web.py:48-67`) — a third-party reader proxy returning page text.
  - Others: github `channels/github.py:96-99`; v2ex `v2ex.py:141-144`; rss `rss.py:8-11`; exa_search `exa_search.py:10-14` (remote MCP `mcp.exa.ai`, `exa_search.py:25`); xiaohongshu `xiaohongshu.py:161-164`; bilibili `bilibili.py:36-39`; linkedin `linkedin.py:24-27`; boss `boss.py:254-257` (CDP-controlled real Chrome, tier 2); xueqiu `xueqiu.py:115-118` (login cookie); xiaoyuzhou `xiaoyuzhou.py:13-16` (Groq Whisper).

## 3. Instagram channel specifically

- Thin `OpenCLISiteChannel`: `backends=["OpenCLI"]`, tier 1 (`channels/_opencli_site.py:21-22`). `check()` only proves OpenCLI installed + a live extension connection, then returns **warn**: "bridge connected, but login state and actual commands not verified in real time; Doctor does not run platform commands, so not marked available" (`_opencli_site.py:41-47`).
- Data path per `skill/references/social.md:300-334`: `opencli instagram search|profile|user|explore|saved -f yaml`; "requires Chrome open with the OpenCLI extension, and logged in to instagram.com" (`social.md:321`). `search` is user search only, not post keyword search (`social.md:306`).
- README table (zh) lists Instagram's "works out of the box" column as empty — nothing before configuration; unlock = desktop OpenCLI reusing Chrome login (`README.md:117`).
- 429 workaround (`social.md:323-334`): `profile/user/whoami` hit Instagram's `web_profile_info` endpoint and "necessarily 429 when anonymous or at high frequency"; documented fallback is `opencli browser ig open <profile URL>` + `opencli browser ig extract` — page rendering through the logged-in browser explicitly to route around the endpoint throttle ("failure = stop, do not retry" applies to the 429 itself).
- Upstream agents are told NOT to fall back to instaloader ("historically unstable cookies/401/429", `social.md:302`).
- Auth-free part: none claimed. Without a logged-in Chrome + extension the channel stays warn and no command is documented as working; doctor deliberately never promotes it to ok.

## 4. Output / evidence discipline

- No shared result envelope. After routing, agents invoke upstream CLIs directly (`core.py:3-7`); result shape, fields and timestamps are whatever the upstream tool emits (skill recommends `-f yaml` / `--json`, `social.md:146`). Nothing in this repo records source URL, raw hash, or capture time alongside a result.
- The only structured artifact Agent Reach owns is the doctor report (`doctor.py:37-44`), JSON via `doctor --json` (`cli.py:140-142`).
- Failures are messages on ok/warn/off/error rows; "installed/configured but not live-verified" is always `warn`, never `ok` (`twitter.py:120-125`, `exa_search.py:32-35`, `_opencli_site.py:41-46`).
- Probe contract: `probe_command()` is "for SIDE-EFFECT-FREE health probes only" (`probe.py:56-60`) and distinguishes missing / broken (126/127 or exec failure) / timeout / error (`probe.py:4-10`, `84-120`). Doctor refuses to run `opencli doctor` (auto-starts daemon, `opencli.py:9-10`) and refuses `twitter status` / `rdt status` because upstream auto-reads/refreshes browser cookies (`twitter.py:84-89`, `reddit.py:91-93,106-108`).
- Caching/freshness: none — no cache layer exists (repo-wide grep: no cache code). `SKILL.md:34-36` states doctor is a point-in-time snapshot ("某一时刻的快照") and may be stale. Only TTL heuristic: `rdt-cli` credential older than 7 days flagged (`reddit.py:25,125-132`).
- Secrets: doctor scrubs credentials from URLs in messages (`doctor.py:33-36`); `configure --stdin` avoids argv exposure (`cli.py:115-120`); Twitter/XHS cookie handling is deliberately Cookie-Editor-manual only (`cookie_extract.py:65-68`, `twitter.py:100-108`).

## 5. Live `agent-reach doctor` (read-only, run on this machine)

`agent-reach --version` → `Agent Reach v1.5.0`. `agent-reach doctor` output, verbatim (console wraps long lines):

```
Agent Reach 状态
========================================
图例：✅ 可用  [!] 已装但需配置/登录  [X] 未安装

✅ 装好即用：
  [!]  GitHub 仓库和代码 — gh CLI 可执行，且检测到显式认证配置；Doctor 
不执行会写 device-id 的 `gh auth status`，因此未实时验证，未标记为可用。
  ✅ YouTube 视频和字幕 — 可提取视频信息和字幕，可转写音频（groq/openai）
  ✅ V2EX 节点、主题与回复 — 公开 API 
可用（热门主题、节点浏览、主题详情、用户信息）
  ✅ RSS/Atom 订阅源 — 可读取 RSS/Atom 源
  [!]  全网语义搜索 — Exa 已写入 mcporter 配置，但 Doctor 
未启动远端服务做连通验证，不能仅凭配置宣称可用。
  ✅ 任意网页 — 通过 Jina Reader 读取任意网页（curl https://r.jina.ai/URL）

可选渠道（已安装）：
  ✅ B站视频、字幕和搜索 — bili-cli 
可用（搜索/热门/排行/视频详情/音频，无需登录；字幕需 OpenCLI。上游 2026-03 
起停更） （当前后端：bili-cli）
  ✅ 小宇宙播客转文字 — 完整可用（播客下载 + Whisper 转录） 
（当前后端：groq-whisper）
  ✅ 雪球股票行情与社区动态 — 公开 API 可用（行情、搜索、热帖、热股）

状态：7/16 个渠道可用
还有 7 个可选渠道可以解锁（Twitter/X 推文、Reddit 帖子和评论、Facebook 
帖子、主页和群组、Instagram 用户、主页和指定用户帖子、小红书笔记、LinkedIn 
职业社交、Boss直聘 职位搜索与 JD），告诉你的 Agent「帮我装 XXX」即可
```

Result: 7/16 ok (YouTube, V2EX, RSS, web, bilibili via `bili-cli`, xiaoyuzhou, xueqiu). `warn`: github, twitter, exa_search (configured, not live-verified). Reddit/Facebook/Instagram/Xiaohongshu: OpenCLI extension files detected but extension not connected. `off`: boss (CDP port unreachable). This matches the prior "7/16" lead; note the gated social channels are gated on a live Chrome+extension+login, not merely cookies.

## 6. What IGTrack should learn / must not copy

Learn (all point the same direction IGTrack already walks):
1. Claim only what was verified: `active_backend=None` + "not live-verified" is the availability-layer equivalent of UNAVAILABLE+reason (`_opencli_site.py:41-46`, `twitter.py:120-125`).
2. Tiering that admits absence: Reddit's docstring records "NO zero-config path exists" (`reddit.py:2-9`) instead of silently failing — a registry entry should be able to say "no lawful route exists" the same way.
3. Probe beyond presence: missing / broken / timeout / error (`probe.py:4-10`) maps to IGTrack's "capability absent" vs "call failed" vs "genuinely empty".
4. Two-phase backend selection: gather all findings, prefer a verified-ok backend over a half-configured one (`twitter.py:43-71`) — provider fallback without lying about health.
5. Side-effect-free doctor: no daemon starts, no cookie reads during status (`probe.py:56-60`, `opencli.py:9-13`) — same discipline as IGTrack's "doctor prints presence, never values", applied one step further.

Must NOT copy:
1. OpenCLI browser-session reuse and `opencli browser ig extract` fallbacks — automated use of the operator's logged-in Instagram session is exactly the session-cookie/headless-scraping line IGTrack refuses (AGENTS.md invariant 3; FOUNDING §14). The IG 429 workaround (`social.md:323-334`) is that line used to route around a platform's own throttle.
2. Cookie extraction/import: `cookie_extract.py` (Chrome/Firefox/Edge/Brave/Opera), `TWITTER_AUTH_TOKEN`/`CT0`, `rdt` `reddit_session` (`reddit.py:138-151`) — no session cookies in IGTrack, even hand-exported.
3. Jina Reader as generic web channel (`web.py:48-67`): proxying target content through a third party violates IGTrack's no-proxy-re-serving stance and is unavailable-when-CAPTCHA anyway (`web.py:15-31`).
4. Retry/fallback chains that route around platform controls (twitter search chain `social.md:128-133`; FB DOM workarounds `social.md:286-298`) — a platform refusal is structural, not an obstacle.
5. "Agents call upstream tools directly" (`core.py:1-7`): no evidence ledger, observation ids, observed-vs-captured time, or raw/normalized hashes — results are untraceable after the call.
6. Hosted/metered search (Exa via remote MCP, `exa_search.py:25`) and Boss CDP-controlled Chrome (`boss.py:254-257`) — paid dependency and browser automation by another name.

Bottom line: Agent Reach is a competent installer/router/doctor with a genuinely aligned honesty culture at the availability layer (probe-real, admit-absent, never promote unverified), but its answer to gated platforms is browser automation and cookie reuse — precisely the route IGTrack is built to refuse.
