// The unauthenticated landing page at https://www.work-fold.com. Rendered
// by app.js when the request carries no personal address.
//
// It explains the product with real screenshots of the shipped app. Every
// claim here has to hold in README.md's "What it supports" and
// docs/product-model.md — nothing aspirational.

const githubMark = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .8a11.4 11.4 0 0 0-3.6 22.2c.6.1.8-.2.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.6-.3-5.4-1.3-5.4-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.4 5.7.4.4.8 1.1.8 2.2v3.3c0 .4.2.7.8.6A11.4 11.4 0 0 0 12 .8Z" /></svg>`;

const githubLink = `<a class="github-link" href="https://github.com/Mat-Tom-Son/work-fold" target="_blank" rel="noreferrer" aria-label="View work-fold on GitHub" title="View work-fold on GitHub">${githubMark}</a>`;

export function renderLanding(app) {
  app.innerHTML = `<main class="landing-shell">
    <header class="auth-top landing-top">
      <span class="brand" role="img" aria-label="work-fold"><img class="brand-lockup brand-lockup-black" src="/brand-lockup-black.png" alt="" /><img class="brand-lockup brand-lockup-white" src="/brand-lockup-white.png" alt="" /></span>
      <nav class="landing-actions" aria-label="Source">
        ${githubLink}
      </nav>
    </header>

    <section class="landing-hero">
      <div class="hero-wrap">
        <div class="hero-copy" data-reveal>
          <h1>AI work you can hand off.</h1>
          <p>work-fold gives an ordinary folder its own Assistant and a portable record of the work. Your files stay files. The Space remembers.</p>
          <a class="primary-download" href="/download/macos">Download for macOS</a>
        </div>
        <figure class="shot hero-shot" data-reveal>
          <img src="/screens/desktop-space.png" width="1440" height="900" decoding="async" alt="The work-fold main window with a Space open: the folder's files listed on the left and its Assistant Chat on the right." />
        </figure>
      </div>
    </section>

    <section class="landing-section assistant-section">
      <div class="section-split">
        <div class="section-copy" data-reveal>
          <h2>Every Space keeps its own context.</h2>
          <p>Each Space is one ordinary folder with its own Assistant, model choice, instructions, Chats, and tools. The files remain open to Finder, Git, backup, and sync tools.</p>
          <p>The fold sits above your Spaces. It can inspect, organize, and delegate without blending one Space's conversation into another.</p>
        </div>
        <figure class="shot shot-popover" data-reveal>
          <img src="/screens/fold-popover.png" width="800" height="1120" loading="lazy" decoding="async" alt="The work-fold menu-bar popover showing the manager conversation above every Space, with model and reasoning controls in its composer." />
        </figure>
      </div>
    </section>

    <section class="landing-section orchestration-section">
      <div class="section-heading" data-reveal>
        <h2>Automation you can account for.</h2>
        <p>Agents can keep work moving without turning the system into an invisible loop.</p>
      </div>
      <dl class="system-lines" data-reveal>
        <div><dt>Checks</dt><dd>Reusable validations over the files you choose, with evidence that can be verified again.</dd></div>
        <div><dt>Routings</dt><dd>Timed or event-driven handoffs that start Space Chats, copy bounded files, and run Checks.</dd></div>
        <div><dt>Receipts</dt><dd>A durable trail for accepted actions, delegated work, and results.</dd></div>
        <div><dt>Space apps</dt><dd>Assistant-built interfaces in a separate sandbox, with each connection and power granted on its own.</dd></div>
      </dl>
      <p class="authority-note" data-reveal><strong>You set the authority.</strong> Reviewed mode holds consequential actions for a decision. Unrestricted mode runs newly admitted actions immediately. Approved browsers inherit the same choice.</p>
    </section>

    <section class="landing-section web-section">
      <div class="section-heading" data-reveal>
        <span class="section-label">Private alpha</span>
        <h2>Your fold on the web</h2>
        <p>One private address opens the same conversation your menu bar does, while your desktop is online — with your saved chats, the decisions waiting on you, and your files beside it. Approve each browser once on your Mac.</p>
      </div>
      <div class="shot-pair" data-reveal>
        <figure class="shot shot-web">
          <img src="/screens/web-chat.png" width="1280" height="800" loading="lazy" decoding="async" alt="The work-fold web client in a desktop browser: the fold's conversation beside its saved Chats." />
        </figure>
        <figure class="shot shot-phone">
          <img src="/screens/web-phone.png" width="375" height="812" loading="lazy" decoding="async" alt="The same fold conversation in a phone browser, with its menu and composer." />
        </figure>
      </div>
      <p class="web-note" data-reveal>Messages and attachments cross the relay inside signed encrypted envelopes. Your Spaces remain on the Mac, which stays the execution endpoint.</p>
    </section>

    <section class="landing-section portability-section">
      <div class="section-heading" data-reveal>
        <h2>The folder is the handoff.</h2>
        <p>Move it, sync it, put it in Git, or give it to someone else. work-fold keeps the portable record beside the work and leaves machine authority on the machine.</p>
      </div>
      <dl class="portability-lines" data-reveal>
        <div>
          <dt>Travels with the Space</dt>
          <dd>Ordinary files, a stable identity, append-only Chat logs, and project-owned Pi configuration when the folder has it.</dd>
        </div>
        <div>
          <dt>Stays on each computer</dt>
          <dd>Credentials, model choices, Space instructions, trust settings, History restore points, sessions, and app preferences.</dd>
        </div>
        <div>
          <dt>Moves only when you choose</dt>
          <dd>Library materials, outside files, capabilities, connections, and browser access remain explicit actions.</dd>
        </div>
      </dl>
    </section>

    <footer class="landing-foot">
      <div class="foot-copy">
        <h2>Keep the work. Keep the context.</h2>
        <p>Open source and available now for Apple silicon Macs.</p>
      </div>
      <div class="landing-actions">
        <a class="primary-download" href="/download/macos">Download for macOS</a>
        ${githubLink}
      </div>
      <img class="foot-mark" src="/brand-mark.png" alt="" />
    </footer>
  </main>`;

  const shell = app.querySelector(".landing-shell");
  const reveals = [...app.querySelectorAll("[data-reveal]")];
  if (!shell || matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) {
    for (const element of reveals) element.classList.add("is-visible");
    return;
  }

  shell.classList.add("motion-ready");
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    }
  }, { rootMargin: "0px 0px -8%", threshold: 0.08 });

  for (const element of reveals) observer.observe(element);
}
