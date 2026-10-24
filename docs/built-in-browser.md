# Built-in browser

> **Status:** Accepted 2026-10-23 (owner decision), built for
> [0.13.0](releases/work-fold-0.13.0.md). The Mac feed records publication.
> `desktop/src/built-in-browser.ts`, `src/shared/browser*.ts`,
> `src/local/agent/browser-tools.ts`, the renderer's browser tab, and their
> suites are the implementation authority.

work-fold has a browser of its own. A **browser tab** sits in the tab strip
beside Chats and files, shows any ordinary website, and is shared with the
Workers: they can read and use the tabs the person has open, and the pages
they open appear in the same strip.

## Tabs

- The globe button beside **New Chat** opens a new browser tab, as does **New
  browser tab** in the command palette. A link that opens a new tab, and a
  Worker's page, become browser tabs too.
- A browser tab belongs to no work-folder (owner decision, 2026-10-23). Every
  work-folder's tab strip shows it; selecting it keeps the work-folder that is
  open; switching work-folders still restores that work-folder's most recent
  tab; removing a work-folder never closes a browser tab. Grouping by
  work-folder puts browser tabs in one **Browser** group. This is the one
  exception to work-folder-bound tabs.
- Browser tabs otherwise work like every tab: drag to reorder, Cmd/Ctrl+W to
  close, Ctrl+Tab and Cmd/Ctrl+1–9 to move between them, and they come back
  after a restart with their address and title. A restored page loads when
  its tab is next shown or a Worker uses it.
- Cmd/Ctrl+Shift+T, or **Reopen closed tab** in the command palette, brings
  back the browser tab closed last; the window remembers the last 25.
- Right-clicking a browser tab offers Reload, Duplicate, Copy Address, Open in
  Your Web Browser, Mute Tab, Print…, Save as PDF…, Close Tab, Close Other
  Browser Tabs, and Reopen Closed Tab. A muted tab shows a crossed-out
  speaker; one playing sound shows a speaker.
- The toolbar has Back, Forward, Reload (Stop while loading), the address bar,
  Find in page, and Open in your web browser.
- The site button at the start of the address bar shows the connection: a
  lock for https, an information mark for this computer's servers and files,
  and a warning with **Not secure** for plain http anywhere else. It opens the
  site's information: the connection in words and what the site was allowed
  or blocked. A zoom level other than 100% shows at the end of the address
  bar; clicking it resets the zoom.
- Hovering a link shows its address at the page's bottom-left, as in Chrome,
  or at the bottom-right when the pointer is in that corner. The bubble stays
  in the window between links, so moving across a page of links only changes
  its text. The address bar takes a full
  address, a bare host (`example.com`, opened over https), this computer's
  servers (`localhost:3000`, `127.0.0.1:5173`, over http), an absolute file
  path, or words to search for with Google.
- As someone types, a list under the address bar offers what Enter will do
  (go to the address, or search for the words) and then matching pages from
  history; arrow keys and Enter, or a click, choose one. Every word typed has
  to appear in a page's address or title; an address that starts with the
  text comes first, then pages visited often and lately.
- History keeps every web page the browser's tabs reach, Workers' visits
  included, in machine-local app data. A new tab lists the most recent pages,
  with **Clear browsing history**.
- A link in a Chat to a server on this computer (`http://localhost:5173`),
  such as the dev server a Worker started, opens as a browser tab. Other links
  still open in the default browser.
- With the page focused: Cmd/Ctrl+L goes to the address bar, Cmd/Ctrl+F finds
  in the page, Cmd/Ctrl+R reloads (with Shift, past the cache), Cmd/Ctrl+[ and
  ] go back and forward, Cmd/Ctrl+=, - and 0 zoom the page, Cmd/Ctrl+P prints,
  and Cmd/Ctrl+Shift+T reopens a closed tab. The app's own tab keys keep
  working.
- Right-clicking offers opening a link in a new tab or in your web browser,
  copying links and images, spelling suggestions and **Add to Dictionary** on
  a misspelled word, the usual editing actions, Back, Forward, Reload, Print…,
  Save as PDF…, and Inspect. On macOS the suggestions come from the system
  spell checker when Electron has none, which it often does there
  (electron/electron#24455).
- **Print…** uses the system print dialog. **Save as PDF…** asks where to save
  (the Downloads folder, named after the page, by default) and then offers
  **Show in Finder** like a download.
- A site opens a new tab or window only within five seconds of a press in the
  page, by the person or a Worker, and one press opens one, as in Chrome. Otherwise a bar above the page says **Pop-up
  blocked** with the address it wanted, **Always allow on this site**, **Open
  it**, and a close button. The allowance is remembered and listed with the
  site's other decisions. These rules also apply inside a sign-in pop-up
  window. Its blocked requests appear in the original tab, naming the site
  that asked; **Always allow** grants that site, even when it differs from
  the original tab's site.
- A sized pop-up such as "Sign in with…" opens as its own small window that
  keeps its link to the page that opened it, which sign-in flows rely on.
  Mail links open the mail app; other non-web addresses are refused.
- Downloads go to the Downloads folder and never replace a file there, even
  when two with the same name arrive at once; a message offers **Show in
  Finder**.
- A site that wants the camera, microphone, location, notifications, MIDI
  devices, the clipboard, window placement, or activity status asks first: a
  bar above the page says what it wants, with **Block** and **Allow**. A tab
  waiting for an answer carries a dot, and a Worker using that tab is told the
  person has to answer. The answer is remembered for that site; the site
  button in the address bar lists what a site was allowed or blocked, and
  **Ask again** forgets one. A pop-up window asks with a dialog instead.
- On macOS the camera and microphone also need the system's own permission:
  the first time a site is allowed one, macOS asks once for work-fold, and if
  it is turned off the bar says so with **Open System Settings**. Screen
  sharing uses the macOS picker (macOS 15 and later), where the person chooses
  what to share.
- Full screen, copying from the page, pointer and keyboard lock, saving to a
  file the person picked, and protected media need no question, as in Chrome.
  USB, serial, HID, and Bluetooth devices stay unavailable.

## Profile and sign-ins

One persistent Chromium profile serves every browser tab and every
work-folder. It lives in work-fold's machine-local app data, apart from Chrome,
from the app's own window, and from every work-folder; cookies are encrypted
with the operating system's keychain like the rest of the app's Chromium data.
Signing in to a site in one tab signs every tab in.

The browser identifies itself the way Claude's own browser does: Chromium's
user agent with the app's name (`work-fold/<version>`) and without Electron's
token. Several Electron browsers measured that Google's sign-in refuses an
embedded browser that poses as plain Chrome and accepts one that names itself,
so the browser does not pose. Sites see Chromium's brand hints and no
automation flag. On 2026-10-23 a real Google account signed in this way on
macOS, through the password and phone-code steps.

Passkeys saved in Apple Passwords, 1Password, or a phone do not work yet. On
macOS an app may use them for any website only with Apple's managed
`com.apple.developer.web-browser.public-key-credential` entitlement, which
Chrome and Firefox hold; Electron also has no passkey sheet of its own, so a
passkey request waits until the site offers another way (Google: **Try another
way**).

## Workers

Every Worker and the work-fold agent in the desktop app carry the browser
tools, registered beside the background job tools. They are part of the app,
not one of the five included tools, so the Skills & Extensions strip is
unchanged and there is nothing to set up. A development API without Electron
has no browser and no browser tools.

| Tool | What it does |
|---|---|
| `browser_tabs` | Lists the open tabs, their addresses and titles, and which one the person is looking at. |
| `browser_open` | Opens an address in a new tab and waits for it to load. The tab opens behind the person's work unless `show` is true. |
| `browser_navigate` | Loads an address in a tab, or goes back, forward, or reloads. |
| `browser_read` | Reads a tab: its `structure` (the default), its visible `text`, or its `console` (messages and failed requests). `find` keeps matching lines; long pages come in 50,000-character parts. |
| `browser_screenshot` | A picture of the visible page, one element, or the whole page (up to 8,000 pixels tall), in page pixels. |
| `browser_click`, `browser_type`, `browser_press`, `browser_scroll` | Act in the page by element ref or viewport coordinates. Click supports left, right, middle, double, and modifier keys. Typing replaces a field or chooses a list option. Press can focus a ref and send keys together. Scroll accepts a ref alone to bring it into view, a ref plus direction to scroll inside a panel, or coordinates to aim the wheel. |
| `browser_hover` | Moves the pointer over a ref or viewport coordinates to reveal a hover menu or tooltip. |
| `browser_drag` | Drags between two refs or viewport points: sliders, custom handles, and native HTML drag-and-drop. Both ends must already be visible in the viewport. Stop releases the button and cancels an unfinished native drag. |
| `browser_upload` | Attaches up to 100 existing local files by absolute path to a file input ref, without a native chooser. Multiple files require a multiple-file input; an empty list clears it. Folder inputs are unsupported. Attaching may immediately upload to the site, so the tool teaches the agent to use only the files and destination authorized by the task. |
| `browser_downloads` | Lists a tab's latest 50 downloads from this app launch, with ids, source URLs, filenames, byte counts, states, and completed local paths. Optionally waits up to 60 seconds for transfers already in progress. The host retains the most recent 200 finished/active records, never dropping an active transfer. |
| `browser_evaluate` | Runs JavaScript in the page and returns the result. |
| `browser_wait` | Waits for text to appear, or for loading to finish. |
| `browser_close` | Closes a tab this Chat opened. The person's tabs, and tabs another Chat opened, stay open. |

- A page's structure is the accessibility tree Chromium already keeps,
  written as indented lines. Every element a Worker can use carries a ref such
  as `e42`, valid until the page changes, so one read can serve several
  actions.
- Each action says whether it led to a new page, and a tab that did not load
  says why.
- A tool without a `tab` uses the tab this Chat last used, else the one the
  person is looking at.
- While a Worker uses a page, its tab carries a pulsing dot and the toolbar a
  **Worker** chip naming the Chat. The chip opens that Chat, and its Stop
  button stops the Chat's turn. For the work-fold agent the chip opens its
  panel. The mark stays three seconds after the last step, so a run of steps
  reads as one. When several Chats use a page, the chip names the most recent
  Chat with an active step; finishing its step restores another active Chat
  rather than leaving Stop pointed at a Chat that finished.
- Workers act through the Chrome DevTools Protocol on Electron's own debugger:
  mouse and keyboard input arrive as real presses. While a Worker uses a page
  in the background, focus emulation lets it render and take input as if it
  were in front; the debugger lets go after two quiet minutes.
- Clicks, hovering, dragging, file attachment, typing, keys, scrolling, and navigation on one page take turns, so
  two Chats using the same page never type into each other's fields. A script
  run does not take a turn because it may wait on page events or navigation;
  scripts can change the page, so agents are taught to prefer the queued tools
  for input. Download observation and waiting likewise leave that queue free.
- The tool instructions teach the same observation loop for every Chat: read
  the page, act on observed refs, and check the resulting page or screenshot
  before claiming success. An unchanged page calls for inspecting an overlay,
  disabled control, or stale ref rather than repeating the same action.
  Page text and downloaded content are untrusted data, not instructions or
  authorization. Download paths become usable evidence only after completion;
  the normal file tools read the saved bytes.
- The tools follow [Receipts, not gates](receipts-not-gates.md): an action runs
  when called. Stop before or during an action sends no further input (a
  button already pressed is still released, so the page is never left
  mid-click); Stop also interrupts a wait or a load, but an effect a page
  already received is not undone.

## Boundaries

- Pages run sandboxed with context isolation, without Node, a preload, or
  webview tags, so a page never reaches the app's desktop bridge. The main
  window's trust checks are unchanged; a page is never a trusted renderer.
- A page shows as a native view over its tab's placeholder, through the same
  placement, occlusion, and zoom rules as app views; a menu or dialog over
  the tab hides the page while it is open.
- Pages keep running in the background, and on macOS after the window
  closes. Quitting closes them without closing their tabs.
- Nothing from the browser enters a work-folder unless a Worker writes it
  there or the person moves a download in. What a Worker reads from a page
  reaches the model provider like any other tool result.

## Verification

`npm run desktop:browser:smoke`, part of `npm run desktop:prepare`, drives the
real host in Electron against pages served from a loopback server: opening
with no window, structure and refs, trusted clicks and typing, lists, waiting,
scripts, the console, three kinds of screenshot, scrolling, new-tab links,
downloads, back and forward, restored tabs, window placement and occlusion,
a site's question answered, remembered, forgotten, blocked, and dropped on
navigation, history suggestions and clearing, a pop-up blocked and then
opened or allowed (including requests from a sign-in window on another site),
mute and zoom, the Worker mark and overlapping Chats, the link bubble, and
quitting without closing tabs. `tests/built-in-browser.test.ts`
covers the address bar, the connection labels, the link bubble's text, the
user agent, the structure format, keys, the tools, site decisions, history,
local server addresses and links, reopening tabs, and saving browser tabs.
The tab and page right-click menus, printing, and saving a PDF use native
dialogs and are checked by hand. A complete Google sign-in needs a real
account and is checked by hand: the 2026-10-23 check reached the account page.

## Next

- Saved passkeys through the macOS system sheet, once Apple grants the browser
  passkey entitlement (requested by the developer account holder), and Touch
  ID passkeys created in work-fold through Electron's `app.configureWebAuthn`,
  which needs a provisioning profile in the signed build.
