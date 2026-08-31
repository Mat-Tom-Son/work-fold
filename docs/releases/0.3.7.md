# work-fold 0.3.7

August 31, 2026

work-fold 0.3.7 makes Assistant setup more flexible, gives the fold an explicit
full-authority mode, and makes remote conversations feel like live chats rather
than delayed status pages.

## Assistant models by working context

- Each Space can now keep its own provider and model selection, while the fold
  above all Spaces has a separate model choice for management and web requests.
- Provider credentials remain shared on the computer, so choosing a different
  model does not duplicate secrets or require reconnecting the same account.
- OpenRouter setup can refresh its live catalog from Settings. The refreshed
  list is limited to text models that advertise tool support, keeps the last
  good result for offline use, and never writes the API key into the cache.
- The Assistant Settings page is leaner and makes the selected scope, saved
  connection, model, refresh state, and automatic saving explicit.

## Authority you choose

- Settings → The fold now offers **Reviewed** and **Unrestricted** authority.
  Reviewed keeps runnable-code, standing-power, and irreversible-destruction
  acts on the existing staged decision path.
- Unrestricted still stages and pins every sensitive act, then immediately
  consumes it through the same effect-time checks and execution adapters. Each
  automatic decision is recorded with surface `unrestricted`.
- Approved browsers inherit the desktop's authority mode but cannot change it.
  Only local Settings can select root authority, and changing modes does not
  erase the decision or execution record.

## Your fold on the web

- A running management reply now streams bounded response text to the approved
  browser alongside its current activity. The durable desktop transcript
  replaces the transient projection when the turn settles.
- Stop now replaces Send inside the composer while a turn is running, on both
  desktop and phone layouts, instead of appearing in the page header.
- Live progress continues to use signed, application-encrypted operation
  envelopes. The hosted relay remains content-blind and stores no transcript.

## Chat polish

- A user message's timestamp and Copy control now sit below its accent bubble.
- Assistant timestamps and Copy controls align to the left directly beneath
  the response instead of drifting to the far edge of the conversation.

## Safety and compatibility

- OpenRouter catalog reads are bounded and normalize untrusted provider data
  before caching or presenting it.
- Remote live text is capped at 256 KB per watch. If a response exceeds that
  transient limit, the browser says the remainder will appear on completion;
  the saved transcript remains authoritative.
- Unrestricted authority does not create a new act lane or expose authority
  selection to the CLI, management Assistant, or approved browser.
- This is an in-place work-fold update. It does not read, migrate, or modify
  legacy Workspace application state or `.workspace/` metadata.

## Current limitations

- macOS is the only active CI packaging and public distribution lane. Windows
  workflows and release gates remain disabled.
- The macOS updater publishes Apple-silicon (`arm64`) artifacts only.
- Provider subscriptions work only where Pi exposes a compatible OAuth or
  provider-login flow; an ordinary ChatGPT subscription is not an OpenAI API
  balance and does not act as one.

## Verification

- Node 24 TypeScript checks, the complete 992-test suite with one intentional
  skip, the bridge integration suite, and the high-severity dependency audit.
- Real-browser review of the web bridge at desktop and phone widths plus the
  desktop Chat fixture in light mode.
- Desktop preparation, Electron preload and restricted-app sandbox smoke tests,
  and the guarded macOS signing, notarization, packaging, updater, checksum,
  and remote-digest release lanes.
