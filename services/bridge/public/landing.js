// Public product introduction. Keep capabilities aligned with the product model;
// the examples are suggestions, not live agent runs or customer testimonials.
const source = "https://github.com/Mat-Tom-Son/work-fold";
const examples = [
  { name: "Home projects", folder: "Kitchen refresh", request: "Compare these two estimates. What should I clarify before choosing?", result: "A decision brief beside your quotes, with the differences and open questions." },
  { name: "Writing", folder: "Field notes", request: "Turn these notes into a first draft. Keep my voice and flag anything that needs a source.", result: "A draft you can edit in your usual tools, with the conversation ready for the next revision." },
  { name: "Research", folder: "Supplier research", request: "Read these reports and make a comparison. Show me where each claim comes from.", result: "A comparison saved with your source material, ready for you to review." },
];

export function renderLanding(app) {
  app.innerHTML = `<div class="landing-shell">
    <a class="landing-skip" href="#landing-main">Skip to content</a>
    <header class="landing-top">
      <a class="landing-brand" href="/" aria-label="work-fold home"><img src="/brand-mark.png" width="32" height="32" alt="" /><span>Made for your Mac.</span></a>
      <nav aria-label="Main navigation"><a href="#how-it-works">How it works</a><a href="${source}">GitHub <span aria-hidden="true">↗</span></a></nav>
    </header>
    <main id="landing-main" tabindex="-1">
      <section class="landing-hero" aria-labelledby="landing-title">
        <div class="landing-hero-copy">
          <h1 id="landing-title">work-fold</h1>
          <p class="landing-promise">An AI agent for the folders you work in.</p>
          <p class="landing-intro">Bring your files, conversations, and project tools together.<br class="landing-wide-break" /> An open-source Mac app for getting real work done.</p>
          <div class="landing-download-row"><a class="landing-download" href="/download/macos">Download for Mac <span aria-hidden="true">↓</span></a><span>Apple silicon · Bring your model provider</span></div>
        </div>
        <figure class="landing-hero-shot">
          <a href="/screens/desktop-space.jpg" target="_blank" rel="noreferrer" aria-label="Open the full-size folder screenshot (new tab)"><img src="/screens/desktop-space.jpg" width="1440" height="900" fetchpriority="high" decoding="async" alt="Project files on the left; a worker comparing contractor estimates on the right." /></a>
          <figcaption>Your files. Your conversation. One place to work.</figcaption>
        </figure>
      </section>

      <section id="how-it-works" class="landing-section landing-workflow" aria-labelledby="workflow-title">
        <div class="landing-section-head" data-reveal><p class="landing-kicker">Start with what you have</p><h2 id="workflow-title">A folder. A conversation.<br />Something done.</h2></div>
        <ol class="landing-steps" data-reveal>
          <li><span>01</span><h3>Open a folder</h3><p>Use an existing project or start fresh. Nothing gets moved or converted.</p></li>
          <li><span>02</span><h3>Ask for what you need</h3><p>A worker can read, write, and work with files using the tools you give it.</p></li>
          <li><span>03</span><h3>Keep going</h3><p>Your files stay in the folder. Your conversations stay with the project. Pick up where you left off.</p></li>
        </ol>
        <div class="landing-example" data-reveal>
          <div class="landing-example-top"><p class="landing-kicker">A few ways to start</p><div class="landing-example-tabs" role="tablist" aria-label="Example projects">${examples.map((example, index) => `<button type="button" role="tab" id="example-tab-${index}" aria-controls="example-panel-${index}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">${example.name}</button>`).join("")}</div></div>
          ${examples.map((example, index) => `<div class="landing-example-panel" role="tabpanel" id="example-panel-${index}" aria-labelledby="example-tab-${index}" tabindex="0" ${index ? "hidden" : ""}><p class="landing-folder">${example.folder} <span>/</span></p><blockquote>“${example.request}”</blockquote><p class="landing-example-result">${example.result}</p></div>`).join("")}
        </div>
      </section>

      <section class="landing-fold-band" aria-labelledby="fold-title">
        <div class="landing-section landing-fold">
          <div data-reveal><p class="landing-kicker">work-fold agent</p><h2 id="fold-title">Many folders.<br />One place to ask.</h2><p class="landing-body">Each folder can have workers. The work-fold agent helps you manage them.</p><p class="landing-body">Ask what needs attention, send work to the right folder, or coordinate the next step between projects. Open it in the app or from your Mac’s menu bar.</p><p class="landing-prompt">“What’s ready, what’s waiting, and what should we do next?”</p></div>
          <figure class="landing-fold-shot" data-reveal><img src="/screens/fold-popover.jpg" width="400" height="560" loading="lazy" decoding="async" alt="The work-fold agent in the Mac menu bar, reporting progress across two folders." /></figure>
        </div>
      </section>

      <section class="landing-section landing-grow" aria-labelledby="grow-title">
        <div data-reveal><p class="landing-kicker">Go further when you need to</p><h2 id="grow-title">Make the folder<br />fit the work.</h2><p class="landing-body">Start with Chat. Ask a worker to help set up the rest.</p></div>
        <div class="landing-capabilities" data-reveal>
          <details open><summary>Build a tool for your project <span>Apps</span></summary><p>Ask for a quote tracker, a review queue, or a small dashboard. Review the app and its access, then use it from the folder’s sidebar.</p></details>
          <details><summary>Give your work another look <span>Checks</span></summary><p>Choose files and explain what to check. Review quoted findings, then ask a worker to help with a correction. Model reviews can miss things; you make the call.</p></details>
          <details><summary>Connect the next steps <span>Automations</span></summary><p>Ask for an automation across folders, on a schedule or when selected files change. Your awake Mac runs its enabled steps.</p></details>
        </div>
      </section>

      <section class="landing-web-band" aria-labelledby="web-title"><div class="landing-section landing-web">
        <figure class="landing-phone-shot" data-reveal><img src="/screens/web-phone.png" width="375" height="812" loading="lazy" decoding="async" alt="A work-fold agent conversation in a phone browser, with its message composer." /></figure>
        <div data-reveal><p class="landing-kicker">Optional web access · Private alpha</p><h2 id="web-title">Step away.<br />Stay in the conversation.</h2><p class="landing-body">Continue talking to the work-fold agent from a paired browser while your Mac is online. The work still happens on your computer.</p><p class="landing-body">Browser access is optional. You don’t need a work-fold account to use the desktop app.</p></div>
      </div></section>

      <section class="landing-section landing-start" aria-labelledby="start-title">
        <div data-reveal><p class="landing-kicker">A few things to know</p><h2 id="start-title">Your files stay yours.</h2></div>
        <dl class="landing-facts" data-reveal>
          <div><dt>Ordinary folders</dt><dd>Keep using Finder, your editor, backup, and sync tools. You can still use your files without work-fold.</dd></div>
          <div><dt>Your model provider</dt><dd>Connect a provider in Settings → Agents. Content used by workers goes to that provider, and usage may cost money.</dd></div>
          <div><dt>Open source, still growing</dt><dd>Available for Apple silicon Macs. The project is actively evolving; feedback and contributions help shape what comes next.</dd></div>
        </dl>
      </section>
    </main>

    <footer class="landing-footer">
      <div class="landing-footer-inner"><div><p class="landing-kicker">Make yourself at home</p><h2>Bring a folder.<br />See what you can do.</h2><a class="landing-download" href="/download/macos">Download for Mac <span aria-hidden="true">↓</span></a></div><div class="landing-contribute"><h3>Help build work-fold.</h3><p>An independent project looking for people to build and maintain it together. Small, thoughtful contributions are welcome.</p><a href="${source}/blob/main/CONTRIBUTING.md">Start contributing <span aria-hidden="true">↗</span></a></div></div>
      <div class="landing-colophon"><span>work-fold / Open source. Local first.</span><nav aria-label="Project links"><a href="${source}">GitHub</a><a href="${source}/tree/main/docs">Docs</a><a href="${source}/blob/main/PRIVACY.md">Privacy</a><a href="${source}/blob/main/LICENSE">MIT License</a></nav></div>
    </footer>
  </div>`;

  const tabs = [...app.querySelectorAll('[role="tab"]')];
  const panels = [...app.querySelectorAll('[role="tabpanel"]')];
  function selectExample(index) {
    tabs.forEach((tab, i) => { tab.setAttribute("aria-selected", String(i === index)); tab.tabIndex = i === index ? 0 : -1; panels[i].hidden = i !== index; });
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => selectExample(index));
    tab.addEventListener("keydown", (event) => {
      const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
      if (next === null) return;
      event.preventDefault(); selectExample(next); tabs[next].focus();
    });
  });

  const shell = app.querySelector(".landing-shell");
  if (!shell || matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;
  const reveals = [...app.querySelectorAll("[data-reveal]")];
  shell.classList.add("motion-ready");
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("is-visible"); observer.unobserve(entry.target);
    }
  }, { rootMargin: "0px 0px -24px", threshold: 0.05 });
  for (const element of reveals) observer.observe(element);
}
