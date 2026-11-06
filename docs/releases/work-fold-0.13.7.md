# work-fold 0.13.7

OpenAI account details now use the data returned by live sign-ins, with separate
handling for direct ChatGPT-plan access and Codex subscription access.

- Direct OpenAI sign-in validates and retains account identity, so the email
  remains available when UserInfo returns only a subject. Existing direct
  connections saved without identity show **Reconnect to load email**.
- Settings → AI Models now offers **OpenAI (Codex subscription)** as a distinct
  connection. Sign in there to see the selected workspace, plan, provider usage
  windows, percentages used and reset times. Connecting it preserves a working
  model selection; **Save Model** remains the explicit model change.
- Codex usage refreshes every minute while its details are open and on window
  focus. Zero usage stays visible. Window lengths and reset timestamps come
  from the provider, and account-wide reset credits are distinguished from
  resets applicable to the selected workspace. This display never redeems one.
- Failed lookups say that details are unavailable. An email, user id, API
  organization, client id or default workspace never substitutes for the
  connected workspace.
- Native identity verification keeps a rotated replacement refresh credential
  even if an optional identity check subsequently fails. Installation and
  packaged-byte checks enforce the reviewed Pi auth fix.

Validation includes real isolated direct and native Pi Codex sign-ins, live
account/usage reads through the application reader, and the actual Settings
component rendered with the captured application response. Private captures and
diagnostic tools remain outside the source repository. Adversarial review,
authentication/rotation and workspace-binding regressions, TypeScript checks,
the full test suite and desktop preparation cover the corrected implementation.
