// The unauthenticated landing page at https://www.work-fold.com. Rendered
// by app.js when the request carries no personal address.

export function renderLanding(app) {
  app.innerHTML = `<main class="landing-shell">
    <header class="auth-top">
      <span class="brand" role="img" aria-label="work-fold"><img class="brand-lockup brand-lockup-black" src="/brand-lockup-black.png" alt="" /><img class="brand-lockup brand-lockup-white" src="/brand-lockup-white.png" alt="" /></span>
      <nav class="landing-actions" aria-label="Download and source">
        <a class="header-download" href="/download/macos">Download for macOS</a>
        <a class="github-link" href="https://github.com/Mat-Tom-Son/work-fold" target="_blank" rel="noreferrer" aria-label="View work-fold on GitHub" title="View work-fold on GitHub">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .8a11.4 11.4 0 0 0-3.6 22.2c.6.1.8-.2.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.6-.3-5.4-1.3-5.4-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.4 5.7.4.4.8 1.1.8 2.2v3.3c0 .4.2.7.8.6A11.4 11.4 0 0 0 12 .8Z" /></svg>
        </a>
      </nav>
    </header>
    <section class="landing-hero">
      <div class="landing-copy">
        <p class="eyebrow">Folders first</p>
        <h1>Work with your desktop folders.</h1>
        <p>work-fold gives ordinary folders an Assistant, a running history, and simple Spaces—without turning your files into a proprietary workspace.</p>
        <div class="landing-cta"><a class="header-download" href="/download/macos">Download for macOS</a></div>
      </div>
      <div class="landing-vignette" aria-hidden="true">
        <div class="vig-app">
          <div class="vig-titlebar"><i></i><i></i><i></i></div>
          <div class="vig-body">
            <div class="vig-rail"><i></i><i class="vig-rail-active"></i><i></i><i></i></div>
            <div class="vig-tree">
              <i class="w72"></i><i class="w52 in"></i><i class="w62 in"></i><i class="w44"></i><i class="w58 in"></i><i class="w34 in"></i><i class="w48"></i>
            </div>
            <div class="vig-chat">
              <span class="vig-bubble user w56"></span>
              <span class="vig-bubble w82"></span>
              <span class="vig-bubble w64"></span>
              <div class="vig-composer"><i></i><b></b></div>
            </div>
          </div>
        </div>
        <div class="vig-popover">
          <div class="vig-pop-head"><i class="w40"></i></div>
          <span class="vig-line w74"></span>
          <span class="vig-line w52"></span>
          <div class="vig-pop-composer"><i></i><b></b></div>
        </div>
        <div class="vig-phone">
          <i class="vig-phone-notch"></i>
          <span class="vig-bubble w78"></span>
          <span class="vig-bubble user w50"></span>
          <span class="vig-line w64"></span>
          <div class="vig-phone-tabs"><i></i><i></i><i></i></div>
        </div>
      </div>
    </section>
    <section class="landing-details" aria-label="How work-fold works">
      <section><span>01</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5h6l1.8 2h9.2v9H3.5Z" /></svg><div><h2>Keep folders ordinary</h2><p>Create a Space or register an existing folder. Your files stay visible in Finder and usable by the tools you already have.</p></div></section>
      <section><span>02</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h16v11h-9l-4 3.5v-3.5H4Z" /></svg><div><h2>Work with an Assistant</h2><p>Chat in the context you choose, keep a running local log, and move between Spaces without hiding where anything lives.</p></div></section>
      <section><span>03</span><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.7 2.8 2.7 14.2 0 17-2.7-2.8-2.7-14.2 0-17Z" /></svg><div><h2>Your fold on the web</h2><p>One private address opens the same conversation your menu bar does, while your desktop is online.</p></div></section>
    </section>
    <footer class="landing-foot" aria-hidden="true"><img src="/brand-mark.png" alt="" /></footer>
  </main>`;
}
