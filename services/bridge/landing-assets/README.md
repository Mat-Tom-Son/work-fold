# Landing assets

The October 9 revision uses real Worker results captured in the public Mac
release **0.4.50**, in an isolated demo profile. Every person, merchant, job
and application in the new fixtures is fictional. The original purchase-order
example reuses its saved October 3 Worker run. No messages or applications were
sent and no Downloads inputs were deleted.

[manifest.json](manifest.json) records the requests, source hashes, completed
turns, verified outcomes, native capture version and screenshot hashes.
[banner-prompts.json](banner-prompts.json) contains the prompts used with the
built-in image-generation tool. The five final WebP headers live in `banners/`;
the four new generated originals are kept alongside them.

The published screenshots live in [public/screens](../public/screens). All five
desktop captures are 1440 × 862 at 1x and 2880 × 1724 at 2x. They are native
window captures, including the tracker's real sandboxed app views. Image
processing only flattens transparency, resizes and encodes WebP. The existing
Chrome, Numbers and bridge-client captures remain in use.

Each directory under `fixtures/` has the starting files in `inputs/`, the
request in `request.txt`, and the finished deliverables in `results/`. The
Worker built the tracker; local review corrected filter matching and focus.
Status, next step and notes were verified to persist in the native app host.

## Rebuild after a desktop release

1. Use the latest installed public release, with separate desktop state and Pi
   resources as described in [Development](../../../docs/development.md).
   Connect the model provider in that isolated app. Keep its state outside the
   fixture directories.
2. Run `node services/bridge/landing-assets/stage-fixtures.mjs` with Node 24.
   It copies only the starting files into a new ignored directory and writes
   the exact requests with the repository path resolved.
3. Register those folders through the isolated app's `work-folders register` CLI,
   then use `chat send --work-folder <id> --new --message-file <request>` for each.
   Pin `WORKFOLD_CLI_STATE_DIR`, `WORKFOLD_STATE_DIR` and
   `WORKFOLD_DESKTOP_STATE_DIR` to the same isolated profile. Follow each
   returned task through `chat status` / `chat result`.
4. Verify results against starting hashes. The receipt total is $1,063.79,
   with two missing dates; all 31 Downloads inputs, including duplicates,
   must survive unchanged across six folders. Résumé claims must come only
   from the original, and both source documents must remain unchanged.
5. Apply the saved headers and matching appearance, open the result files,
   and capture the actual native 1440 × 862 window on a Retina display. Open
   the tracker and an application detail tab before its native capture.
   Check version, dimensions and the app rail button bounds before exporting.
6. Export 1x and 2x WebP siblings into `public/screens/`, update the manifest,
   and run `npm --prefix services/bridge test`. Check desktop, phone, tablet,
   short landscape and reduced motion in a real browser.

The appearance matches the page: Receipts `#5c7c2e` / `receipt`, Purchase
Orders `#953ea3` / `receipt`, Job search `#41618f` / `person-briefcase`,
Downloads `#af6400` / `archive`, and Job tracker `#287868` / `briefcase`.
The tracker rail button in this release is 44 × 44 at (7, 198), below the
32-pixel native title bar; the highlight's full-capture center is (29, 220).

Desktop and Pi profiles, credentials, portable identity records and runtime
scratch files are excluded from this bundle.
