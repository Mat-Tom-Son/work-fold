// The unauthenticated landing page at https://www.work-fold.com. Rendered
// by app.js when the request carries no personal address.
//
// It explains the shipped product with real screenshots. Every claim here
// must stay aligned with README.md and docs/product-model.md.

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
      <div class="hero-copy" data-reveal>
        <h1>Every folder,<br />its own Assistant.</h1>
        <p>work-fold gives an ordinary folder a focused Assistant, its own context, and a durable record of the work. Your files stay files.</p>
        <div class="hero-actions">
          <a class="primary-download" href="/download/macos">Download for macOS</a>
          <span>Apple silicon</span>
        </div>
      </div>
      <figure class="shot hero-shot">
        <img src="/screens/desktop-space.png" width="1440" height="900" decoding="async" alt="A work-fold Space with ordinary project files on the left and its Assistant comparing two estimates in a Chat on the right." />
      </figure>
    </section>

    <section class="landing-section space-section">
      <div class="section-heading" data-reveal>
        <p class="section-kicker">Spaces</p>
        <h2>The work stays where it belongs.</h2>
      </div>
      <dl class="plain-lines" data-reveal>
        <div><dt>Ordinary files</dt><dd>Open the same folder in Finder, Git, backup, or sync tools. No proprietary container.</dd></div>
        <div><dt>Focused context</dt><dd>Each Space has its own Assistant, model, instructions, Chats, Skills, Extensions, and apps.</dd></div>
        <div><dt>A durable record</dt><dd>The Space identity and append-only Chat logs travel beside the work when the folder moves.</dd></div>
      </dl>
    </section>

    <section class="landing-section fold-section">
      <figure class="shot fold-shot" data-reveal>
        <img src="/screens/fold-popover.png" width="400" height="560" loading="lazy" decoding="async" alt="The populated work-fold menu-bar window summarizing progress across two Spaces, with model and reasoning controls in the composer." />
      </figure>
      <div class="section-copy" data-reveal>
        <p class="section-kicker">The fold</p>
        <h2>One Assistant above every Space.</h2>
        <p>Ask what changed, find what needs attention, or hand the next step to the right Space. The fold keeps the overview without blending every conversation together.</p>
        <p>It is always close: in the app, from the Mac menu bar, and on your private web address.</p>
      </div>
    </section>

    <section class="landing-section movement-section">
      <div class="section-heading" data-reveal>
        <p class="section-kicker">Work that keeps moving</p>
        <h2>Do it now. Pick it up later.</h2>
        <p>Agents can build, verify, publish, and return to work on a schedule. The important actions remain visible and receipted.</p>
      </div>
      <dl class="system-lines" data-reveal>
        <div><dt>Checks</dt><dd>Verify the exact files you choose.</dd></div>
        <div><dt>Routings</dt><dd>Start timed or event-driven work across Spaces.</dd></div>
        <div><dt>Apps</dt><dd>Build useful interfaces inside a Space with narrow grants.</dd></div>
        <div><dt>Pages</dt><dd>Share one designated file from your desktop, then revoke it at once.</dd></div>
      </dl>
      <p class="authority-note" data-reveal><strong>You set the authority.</strong> Review consequential actions one at a time, or let newly admitted work run immediately. Approved browsers inherit the same choice.</p>
    </section>

    <section class="landing-section web-section">
      <div class="section-heading" data-reveal>
        <p class="section-kicker">Private alpha</p>
        <h2>Your fold, wherever you are.</h2>
        <p>Continue the same management conversation from a browser while your Mac is online. Approve each browser once on the desktop.</p>
      </div>
      <div class="web-stage" data-reveal>
        <figure class="shot web-desktop-shot">
          <img src="/screens/web-chat.png" width="1280" height="720" loading="lazy" decoding="async" alt="The work-fold web client showing the fold conversation and saved Chats in a desktop browser." />
        </figure>
        <figure class="shot web-phone-shot">
          <img src="/screens/web-phone.png" width="375" height="812" loading="lazy" decoding="async" alt="The same fold conversation and composer in a phone browser." />
        </figure>
      </div>
      <p class="web-note" data-reveal>Your Mac remains the execution endpoint. Messages and attachments cross the relay inside signed encrypted envelopes.</p>
    </section>

    <section class="landing-section boundary-section">
      <div class="section-heading" data-reveal>
        <p class="section-kicker">Local first</p>
        <h2>The folder is the handoff.</h2>
      </div>
      <dl class="boundary-lines" data-reveal>
        <div>
          <dt>Travels with the Space</dt>
          <dd>Files, stable identity, Chat logs, and project-owned Pi configuration when the folder has it.</dd>
        </div>
        <div>
          <dt>Stays on each computer</dt>
          <dd>Credentials, model choices, Space instructions, trust settings, History restore points, sessions, and app preferences.</dd>
        </div>
      </dl>
    </section>

    <footer class="landing-foot">
      <div class="foot-copy">
        <h2>Put an Assistant where the work lives.</h2>
        <p>Open source. Available now for Apple silicon Macs.</p>
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
