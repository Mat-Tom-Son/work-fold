// The unauthenticated landing page at https://www.work-fold.com. Rendered
// by app.js when the request carries no personal address.
//
// It explains the product with real screenshots of the shipped app. Every
// claim here has to hold in README.md's "What it supports" and
// docs/product-model.md — nothing aspirational, no slogans.

const githubMark = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .8a11.4 11.4 0 0 0-3.6 22.2c.6.1.8-.2.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.6-.3-5.4-1.3-5.4-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.4 5.7.4.4.8 1.1.8 2.2v3.3c0 .4.2.7.8.6A11.4 11.4 0 0 0 12 .8Z" /></svg>`;

const githubLink = `<a class="github-link" href="https://github.com/Mat-Tom-Son/work-fold" target="_blank" rel="noreferrer" aria-label="View work-fold on GitHub" title="View work-fold on GitHub">${githubMark}</a>`;

export function renderLanding(app) {
  app.innerHTML = `<main class="landing-shell">
    <header class="auth-top">
      <span class="brand" role="img" aria-label="work-fold"><img class="brand-lockup brand-lockup-black" src="/brand-lockup-black.png" alt="" /><img class="brand-lockup brand-lockup-white" src="/brand-lockup-white.png" alt="" /></span>
      <nav class="landing-actions" aria-label="Download and source">
        <a class="header-download" href="/download/macos">Download for macOS</a>
        ${githubLink}
      </nav>
    </header>

    <section class="landing-block landing-intro">
      <h1>work-fold</h1>
      <p>work-fold is a Mac app that gives an ordinary folder an Assistant. Create a Space and work-fold makes the folder for it, or point work-fold at a folder you already have. The files stay where they are.</p>
    </section>

    <section class="landing-block">
      <div class="block-text">
        <h2>The main window</h2>
        <p>The left side lists the files in that Space's folder — the same files Finder shows. The Chat on the right runs the Assistant in that folder, using the files you attach as its context. History records a restore point around file changes and Assistant turns, so you can put the folder back the way it was.</p>
      </div>
      <figure class="shot shot-desktop">
        <img src="/screens/desktop-space.png" width="2880" height="1800" decoding="async" alt="The work-fold main window with a Space open: the folder's files listed on the left, a Chat with the Assistant on the right." />
      </figure>
    </section>

    <section class="landing-block landing-split">
      <div class="block-text">
        <h2>The fold in the menu bar</h2>
        <p>The fold is one conversation that sits above all your Spaces, open from the menu bar even after the last window closes. Drop files, folders, or links on it, add an instruction, and it files them into the right Space with a restore point where they land.</p>
      </div>
      <figure class="shot shot-popover">
        <img src="/screens/fold-popover.png" width="800" height="1120" loading="lazy" decoding="async" alt="The work-fold menu-bar popover: a drop zone for files, folders, and links above the message box, with the What’s new strip at the bottom." />
      </figure>
    </section>

    <section class="landing-block">
      <div class="block-text">
        <div class="block-head"><h2>Your fold on the web</h2><span class="tag">Private alpha</span></div>
        <p>One private address opens the same conversation your menu bar does, while your desktop is online — with your saved chats, the decisions waiting on you, and your files beside it. You choose that address — <code>yourname.work-fold.com</code> — and its password in Settings, then approve each new browser once by matching a six-digit code on your Mac. Messages and attachments cross the relay inside encrypted envelopes, and your Spaces stay on the Mac, which does the work.</p>
      </div>
      <div class="shot-pair">
        <figure class="shot shot-web">
          <img src="/screens/web-chat.png" width="2560" height="1600" loading="lazy" decoding="async" alt="The work-fold web client in a desktop browser: the fold's conversation beside its list of saved chats." />
        </figure>
        <figure class="shot shot-phone">
          <img src="/screens/web-phone.png" width="750" height="1624" loading="lazy" decoding="async" alt="The same conversation in a phone browser, with the menu button and composer." />
        </figure>
      </div>
    </section>

    <section class="landing-block">
      <div class="block-text">
        <h2>What stays on your computer</h2>
      </div>
      <dl class="facts">
        <div>
          <dt>Spaces</dt>
          <dd>A Space is one ordinary folder. Registering a folder you already have never moves, copies, or renames anything in it, and those files stay open to your other apps, your backups, and your sync tools.</dd>
        </div>
        <div>
          <dt>History</dt>
          <dd>Restore points live in work-fold's own application storage, not in your folder. What sits beside your files is a hidden <code>.work-fold/</code> folder holding the Space's identity and its Chats.</dd>
        </div>
        <div>
          <dt>Library</dt>
          <dd>The Library is a personal collection of files worth reusing. Nothing in it reaches a Space until you copy it in, and that copy is independent of the original.</dd>
        </div>
        <div>
          <dt>Web access</dt>
          <dd>The web address is optional and stays off until you set one.</dd>
        </div>
      </dl>
    </section>

    <footer class="landing-foot">
      <div class="landing-actions">
        <a class="header-download" href="/download/macos">Download for macOS</a>
        ${githubLink}
      </div>
      <img class="foot-mark" src="/brand-mark.png" alt="" />
    </footer>
  </main>`;
}
