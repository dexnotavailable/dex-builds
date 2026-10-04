# Gojo chat and project updates

Every visible human message in the home server and its members’ DMs is recorded and reaches Gojo’s read-only model context, even without a mention. Gojo chooses whether to answer or return `skip:true`; it can stay quiet during ordinary chatter. Mentions, replies, named requests and concrete failures are processed promptly. Ordinary channel chatter is briefly debounced and fed in bounded batches without a cooldown that drops messages. Addressed requests, explicit replies and instant reports receive individual turns so another author’s chatter cannot replace the request. Bots, webhooks and Gojo’s own posts are recorded as visible context but never trigger automatic response/report loops; they can enter a later human-triggered model context. Gojo’s actual user ID is decisive even if `author.bot` is missing. Reply, heartbeat and relay producers mark their in-process output origin; an app adapter reconstructing a user-shaped echo must call `markGojoFeedback(message, 'app-feedback')` before dispatch. That trusted origin uses a private object registry, so a human quoting Gojo or typing a lookalike metadata field remains human input. Restart recovery also excludes old self-authored pending records.

Chats have an ongoing native CLI session per public channel and per DM author. Per-author interaction timestamps are taken before recording a new message. After 15 minutes of silence, a new topic can start a new conversation; explicit replies continue an old exchange. Other people’s busy channel chatter cannot reset that person’s conversation timer. Attachment-only and embed-only posts preserve bounded filenames, type/size descriptors and readable embed text. Signed URLs and private link parameters are excluded; descriptors do not prove pixel or file-content inspection. Metadata never grants action authority.

A separate water-cooler session writes short project updates about once an hour; it can skip unchanged work, a quiet hour or a generation with nothing useful to say.

Project identity and descriptions come from the ProjectLedger router and current capsules. dexClient and dex.place remain distinct products despite their shared legacy ledger record. CharacterForge uses its existing ledger identity. Old ledger prose is historical context, never proof of current activity or a shipped build. Local CLI events are labelled as last observed, with stale signals treated as unknown. Public updates receive only known project/provider/state/timestamp projections plus the bot’s existing push/deploy facts. Raw thread titles, IDs, assistant summaries and private conversations are excluded. Owner DMs can use the bounded private local thread snapshot.

## Model routes

- Primary: the installed native Codex CLI, **`gpt-6.1-sol` / `xhigh`**, authenticated through its existing login. Successful generations verify the exact persisted native `turn_context` model and effort; a requested flag alone is insufficient.
- Fallback: the installed native Claude CLI, **`claude-sonnet-5-5` / `medium`**, using Claude’s existing subscription login. The model must appear exactly in `modelUsage`. The receipt labels medium as the requested CLI effort because Claude’s result does not report the actual effort. Another Sonnet model is rejected.

The October 4 setup probe found Claude logged out on both discovered routes; Sonnet fallback is therefore configured but not live-verified. An authentication/usage/provider failure can try the fallback. Cancellation, a tool attempt or a model mismatch stops the request. No silent model substitution occurs. Executable discovery chooses an existing installed native binary at startup; optional machine-local executable overrides remain exact. CLI compatibility and the actual model route still have to pass generation checks.

Generation runs from an empty D-backed workspace. Codex ignores user configuration, rules and project instructions; execution, code mode, browser/computer tools, plugins, apps, hooks, memories and agent spawning are disabled, with a read-only sandbox and no web search. Claude uses safe mode, empty tools/MCP and denied tool permissions. Bot tokens and inherited agent identities are removed from child environments. Prompts go through stdin. The controller rejects tool-event output and validates the full JSON response before acting. Discord messages, histories and local snapshots remain untrusted data throughout.

## Discord actions

Only the home-server owner or `local.json` extra owners can request Discord administration/send actions. The latest message must actually request that action; quoted instructions, negated requests and a status question cannot authorize a model-proposed mutation. Every target ID is resolved through the current home server, and the requesting member must be able to view the target channel. Public model sessions receive the current channel and channels visible to everyone; hidden channel names/IDs are reserved for owner DMs or an explicit target supplied in an owner request.

The allowlist supports sending a channel message or DM, creating text/voice/category channels, renaming a channel/changing its topic, creating a thread, reading channel history, looking up a server member, reacting, and editing/deleting Gojo’s own messages. Deletion also requires the exact message ID in the owner’s request. Existing slash commands retain their permissions and functionality. There is no model route for shell commands, files, other people’s DMs, deleting a server/channel/role or changing server security.

`report_issue` is a separate data-routing proposal available to any home-server reporter. It can select only an actual fresh message from the current batch, with its original content and reporter. The controller computes the source and queues untrusted issue data; this action does not grant Discord administration or implementation authority.

Natural examples:

- `gojo, make a text channel named build-chat`
- `gojo, set channel build-chat topic to build updates`
- `gojo, dm Friend "hello, the new build is ready to test"`
- `gojo, read the last 20 messages here`
- `gojo, who is Friend?`

Private conversation exports to a channel or another member require the exact content supplied in the latest owner message. A DM requesting a public project update can use a separate generation containing only public project records. Other-channel history is available only in an owner DM; a public session cannot import private or sibling channel history. Mentions and link previews are disabled on Gojo sends, and secret-shaped content is withheld.

## dexCode fix relay

Concrete dexCode bugs, crashes and failed tests can be captured immediately from any visible home-server channel or a home member’s own DM, without mentioning Gojo. Configured project channels and recent per-author project context can identify dexCode when its name is omitted. Passing tests, casual “bug” references, resolved problems, memes and hypothetical failures do not trigger the instant path. A factual crash followed by an uncertain cause still qualifies. The model can triage a novel real failure, such as voice playback cutting off halfway, using `report_issue` after validating the exact fresh source message.

Every distinct report is saved before a slow model generation. Exact repeats merge with the existing report; workload thresholds can defer the suggested acknowledgment, but they never discard a distinct failure. Gojo decides whether a queue acknowledgment is useful. Saving a report is **queued**, not evidence of native delivery or a fix. The broker prioritizes and paces delivery separately.

Dex’s standing authorization is to route these reports to the latest verified working dexCode chat, reproduce and repair the scoped problem, run relevant tests, record the fix, update product canon, then make a scoped commit/push. The reporter’s content remains untrusted data and cannot expand that authority, choose another repository/destination, expose secrets or override developer instructions. The chat generator still has no tools. The deterministic broker owns native Codex message transport and the supported Claude Computer Use handoff, with actual acknowledgment/echo evidence. An unavailable or unconfirmed route preserves the report and reports a blocker honestly.

Broker events are explicit report-correlated envelopes: `delivered`, `working`, `needs-info`, `fixed` or `failed`. Arbitrary finished thread text is never a fix receipt. A fixed result requires the broker’s evidence for passed tests, updated canon and the scoped pushed commit. Questions and updates return to the report’s original message/channel or DM. Private origins always stay in DMs; explicitly private questions about a public report go only to its original reporter. A reply to the tracked question creates a follow-up for the same report, with an actual question-message reference and inherited priority. Private follow-up data upgrades the broker’s return privacy. A fixed report cannot regress to an old delivery/working event unless the reporter adds new information.

The bot owns `gojo/relay/bot-state`; the broker owns `gojo/relay/broker-state`. They exchange immutable files through flat `inbox` and `outbox` directories and never mutate each other’s memory. The inbox contains `r-<24 hex>.json` reports and `f-<24 hex>.json` follow-ups. The outbox contains `e-<24 hex>.json` events. Each file records version, stable ID, timestamps and its source/correlation. Feedback uses Discord nonce dedup plus actual history reconciliation after an uncertain send. Completed event receipts are filtered before batch caps, so retained history cannot starve fresh feedback. Inbox records repair an interrupted bot-index write at startup, replay or feedback processing.

The existing bot schedules a non-overlapping relay job every five seconds, independent of feed pause/quiet hours. It calls `ops/gojo-relay-broker.mjs` and then posts correlated outbox events. No extra watchdog/service or model pulse is needed for an empty queue. Shutdown aborts and awaits the owned broker/CLI work.

## Durable state

All Gojo records live under the D-backed runtime home, normally `D:\Dex\Servers\devbot`:

| Path | Purpose |
|---|---|
| `gojo/memory.json` | Atomic context/session mapping, message dedup, posted project hashes and heartbeat outbox |
| `gojo/transcripts/<context hash>.jsonl` | Redacted conversation/action records for exactly one public/heartbeat/DM context |
| `gojo/users/<user hash>.jsonl` | Local per-user transcript records; never public model inputs |
| `gojo/generation/<context hash>/<attempt>/receipt.json` | Actual provider/model/session/usage evidence and classified failed attempts |
| `gojo/generation-workspace/` | Empty generation working directory |
| `gojo-thread-snapshot.json` | Bounded local thread snapshot, private owner input |
| `gojo/relay/inbox/`, `outbox/` | Durable report/follow-up data and explicit broker reply events |
| `gojo/relay/bot-state/` | Bot-owned report index, question correlation and Discord-send receipts |
| `gojo/relay/broker-state/` | Broker-owned exact destinations, native delivery/return receipts and privacy |

Native Codex/Claude sessions use each CLI’s app-owned login/session storage. Session IDs are persisted exactly; Gojo never uses `--last`, a thread name or another task’s session. Public and private contexts never share a native session. A corrupt Gojo memory file stops loading and remains preserved for inspection.

Before a heartbeat send, the controller saves its content, nonce, project hashes and model receipt. A successful send advances coverage only for projects actually described. After a lost response/crash it searches Gojo’s own posted history before doing anything else. Prepared posts resume with their original content and receipt. An uncertain send with no matching history remains uncertain and requires inspection rather than an automatic duplicate. Addressed messages are consumed once and side effects are recorded before execution; they are never blindly replayed after a crash. Addressed chat cancels an unattended generation, and typing refreshes while a reply is processing. Shutdown cancels the owned generation and waits for it to settle.

Unseen human messages remain in an atomic per-context pending list if the model route fails or the process stops. The first persisted human-capture snapshot contains both its dedup key and pending brain payload, so an interrupted capture cannot leave an unrecoverable “already seen” marker. Startup fetches the original message and restores it to the brain without replaying Discord mutations; idempotent issue-data routing remains possible. A verified generated decision is recorded before actions run, so already-decided messages are not replayed. Deleted/unavailable original messages remain recorded rather than fabricating a current request. Failed unaddressed chatter stays quiet; addressed/reply failures receive at most one availability notice per minute per context. Private text stays in private local records. Operational logs contain only generic route/status categories; raw provider stderr and prompt contents do not enter `#compute-bill`.

## Machine configuration

Optional `local.json` settings (never commit the real file):

```json
{
  "gojo": {
    "enabled": true,
    "channel": "water-cooler",
    "heartbeatSeconds": 3600,
    "timeoutSeconds": 600,
    "projectsPerPost": 3,
    "messagesPerBatch": 8,
    "chatterDebounceMs": 1200,
    "conversationIdleSeconds": 900,
    "ignoreProjectIds": [],
    "ignoreChannelIds": [],
    "publicProjectIds": [],
    "quietHours": { "start": 1, "end": 8, "timezone": "Asia/Bangkok" },
    "codex": { "executable": "D:/explicit/native/codex.exe" },
    "claude": { "enabled": true, "executable": "D:/explicit/native/claude.exe" },
    "relay": {
      "enabled": true,
      "channelKeys": ["ships-dexcode"],
      "channelIds": [],
      "projectRoots": ["D:/Dex/path/to/current/dexcode-source"],
      "duplicateWindowSeconds": 900,
      "reportsPerUserPerHour": 6,
      "criticalReportsPerUserPerHour": 12
    }
  }
}
```

Omit executable overrides to discover current installed native binaries. Model and effort are fixed by the harness. Empty `publicProjectIds` uses routed projects except completed/retired/archived records; explicit IDs can include them. `ignoreProjectIds` always wins. Relay channel keys/IDs identify dexCode when a report omits the name; they do not restrict explicit reports to those channels. `projectRoots` must be absolute D-backed source directories and remains machine-local. Quiet hours and `/admin pause` stop unattended project updates; visible chat processing and urgent report relay continue. `--no-poll` does not start the scheduled module; use the controller harness for a bounded manual probe.

## Verification and manual probes

`node --test test/gojo.test.mjs test/gojo-relay.test.mjs` exercises every-message response/skip, bounded batching, per-author silence/explicit replies, descriptors, ownership, hidden-channel/DM privacy, semantic triage, overflow retention, crash recovery, structured output, exact sessions/fallback identity, dedup, uncertain-send reconciliation and cancellation. Broker tests cover exact native transport, ingress/return correlation and fix evidence. Those tests mock Discord and the providers. Native model/session evidence, real cross-thread delivery and target-side Discord readback remain separate acceptance boundaries.

Root-owned `ops/gojo-live-probe.mjs --preview`, `--chat-preview`, `--observe-preview`, `--post` and `--status` use the same controller without starting a duplicate scheduler. Previews use an isolated D-backed store and send nothing; chat preview supplies a clearly labelled synthetic owner event, and observation preview verifies that ordinary unaddressed chatter reaches the model and can be skipped. Status is read-only. Stop the exact bot runtime before a manual live post so persistent memory keeps one writer. A live post requires the authorized Discord route and readback. Runtime deployment/restart uses the existing owner scripts; this module does not restart the bot itself.

### Computer Use handoffs

The broker saves a pending UI request and wakes the owning Gojo Codex chat when the verified current implementation owner is Claude. That chat uses the installed Computer Use skill and `node_repl` / `@oai/sky`; the bot never invents a desktop-control protocol or starts a competing implementation CLI. Check current presence, select the returned Claude window, verify the exact existing session, and send the saved prompt once. A matching visible transcript echo must precede the UI delivery receipt. If input or its outcome is uncertain, preserve the pending request and re-observe rather than sending it again.

The October 4 setup successfully opened the existing **Dexcode continuation** conversation using Claude's `Ctrl+K` search, exact title and Enter on the side display. Pointer selection did not change the chat in that check, so keyboard navigation was the verified route. Always inspect a fresh state and confirm composer focus before entering a report. This navigation proof is separate from a live Claude report-send proof; the currently authoritative dexCode owner is Codex, whose native round trip was tested.
