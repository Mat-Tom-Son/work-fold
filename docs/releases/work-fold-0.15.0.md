# work-fold 0.15.0

November 5, 2026

This release adds pages: things you make for other people, which can collect
entries and stay online when your computer is off. It replaces the old way of
sharing a single file.

- Ask your Worker to make a page, such as an RSVP form, a sign-up sheet, a
  poll, or an announcement. A page is a folder holding its files and a
  `page.json` that says what it collects and who can see it.
- Open a page from Files to try it in Preview, viewing as a visitor, as
  yourself, or as a new visitor. Entries made while trying it are test entries:
  they stay on this computer and are never published.
- The Data view shows a page's entries with search, filters, editing, deletes
  you can restore, and Export as Spreadsheet. A page that saves nothing has no
  Data view.
- **Publish** puts a page online at `pages.work-fold.com` and gives you its
  link. **Publish Changes** updates it at the same link and keeps its entries;
  **Unpublish** takes it offline and keeps them too. Publishing needs Web
  Access, your work-fold.com address.
- Entries visitors make come back into the page's folder as `data.sqlite`
  whenever work-fold is running. Signed in at your work-fold.com address, you
  can see entries, export them, and unpublish even with your computer off.
- Settings → Published lists every published page.
- New `work-fold pages` commands: `validate`, `publish`, `unpublish`, and
  `list`.
- Share a Page, Share at Your Address, Settings → Shared Pages, and the web
  client's Shared pages popup are gone, and links shared that way no longer
  open.

Published pages and their entries are stored on work-fold's page service,
which can read them so it can serve the page and check each entry; see
[Privacy](../../PRIVACY.md).

Mac releases and automatic updates are available through the
[work-fold Mac release feed](https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases).
