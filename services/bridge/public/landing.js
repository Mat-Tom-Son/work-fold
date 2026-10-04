// Public product introduction. Every screen is a real Worker run in a
// demonstration work-folder, normalized to one window size; each caption
// quotes the request that produced it. Keep claims to what the screens show.
const source = "https://github.com/Mat-Tom-Son/work-fold";
const chromeExtension = "https://chromewebstore.google.com/detail/work-fold/ophmjbphcjmjcpcdpmfehbldiomkepgk";
const macDownload = "/download/macos";
// Replace with the Windows installer URL once it is supplied.
const windowsDownload = "/download/windows";

const work = [
  {
    id: "research", label: "Research", screen: "research", retina: false,
    ask: "Research how to start a monthly repair café at a community center.",
    result: "A sourced brief, saved next to the pages it read.",
    alt: "The Research — repair café work-folder: a sources folder beside research-brief.md, open to a table of the public sources the Worker consulted.",
  },
  {
    id: "orders", label: "Purchase orders", short: "Orders", screen: "orders", retina: false,
    ask: "Check every quantity and price. Create separate numbered purchase orders…",
    result: "Two orders checked to $1,102 before tax and shipping. Vendor emails drafted, not sent.",
    alt: "The Purchasing — autumn workshop work-folder: two purchase orders and two email drafts in the sidebar, and order-register.md showing a $1,102.00 goods subtotal with both orders marked Draft — not sent.",
  },
  {
    id: "writing", label: "Writing", screen: "writing", retina: true,
    ask: "Turn field-notes.md into a warm, concrete 400–500 word newsletter story…",
    result: "A 422-word draft, saved next to the notes it came from.",
    alt: "The Writing — neighborhood letter work-folder: field notes, a writing brief, and editorial notes in the sidebar, with newsletter-draft.md open.",
  },
  {
    id: "files", label: "Files", screen: "files", retina: true,
    ask: "Organize the loose files in inbox/ using project-notes.md.",
    result: "Eight files sorted into folders. Nothing deleted, every move logged.",
    alt: "The Files — studio cleanup work-folder: files sorted into archive, purchases, workshop planning, and writing folders, with organization-log.md open to a before-and-after table.",
  },
];

const inbox = {
  id: "inbox", screen: "inbox", retina: true,
  ask: "Build a small sidebar email organizer for this work-folder…",
  result: "A working inbox with categories, message tabs, and choices that stay saved.",
  alt: "A Studio inbox app built by a Worker, open in the work-fold sidebar: categories such as Needs reply and Purchasing, a message list, and one message open in its own tab with category and Mark not done controls.",
};

// The four supplied icons, verbatim, as one sprite so each id appears once.
const sprite = `<svg class="landing-sprite" aria-hidden="true" focusable="false">
  <symbol id="landing-icon-apple" viewBox="0 0 1024 1024"><path fill="currentColor" d="M747.4 535.7c-.4-68.2 30.5-119.6 92.9-157.5c-34.9-50-87.7-77.5-157.3-82.8c-65.9-5.2-138 38.4-164.4 38.4c-27.9 0-91.7-36.6-141.9-36.6C273.1 298.8 163 379.8 163 544.6c0 48.7 8.9 99 26.7 150.8c23.8 68.2 109.6 235.3 199.1 232.6c46.8-1.1 79.9-33.2 140.8-33.2c59.1 0 89.7 33.2 141.9 33.2c90.3-1.3 167.9-153.2 190.5-221.6c-121.1-57.1-114.6-167.2-114.6-170.7m-105.1-305c50.7-60.2 46.1-115 44.6-134.7c-44.8 2.6-96.6 30.5-126.1 64.8c-32.5 36.8-51.6 82.3-47.5 133.6c48.4 3.7 92.6-21.2 129-63.7" /></symbol>
  <symbol id="landing-icon-windows" viewBox="0 0 12 12"><path fill="currentColor" d="M6 6h5V1H6Zm-6 6h5V7H0Zm0-6h5V1H0Zm6 6h5V7H6Zm0 0" /></symbol>
  <symbol id="landing-icon-chrome" viewBox="0 0 1024 1024"><path fill="currentColor" d="M371.8 512c0 77.5 62.7 140.2 140.2 140.2S652.2 589.5 652.2 512S589.5 371.8 512 371.8S371.8 434.4 371.8 512M900 362.4l-234.3 12.1c63.6 74.3 64.6 181.5 11.1 263.7l-188 289.2c78 4.2 158.4-12.9 231.2-55.2c180-104 253-322.1 180-509.8M320.3 591.9L163.8 284.1A415.35 415.35 0 0 0 96 512c0 208 152.3 380.3 351.4 410.8l106.9-209.4c-96.6 18.2-189.9-34.8-234-121.5m218.5-285.5l344.4 18.1C848 254.7 792.6 194 719.8 151.7C653.9 113.6 581.5 95.5 510.5 96c-122.5.5-242.2 55.2-322.1 154.5l128.2 196.9c32-91.9 124.8-146.7 222.2-141" /></symbol>
  <symbol id="landing-icon-github" viewBox="0 0 24 24"><g fill="none"><g clip-path="url(#landing-icon-github-clip)"><path fill="currentColor" fill-rule="evenodd" d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385c.6.105.825-.255.825-.57c0-.285-.015-1.23-.015-2.235c-3.015.555-3.795-.735-4.035-1.41c-.135-.345-.72-1.41-1.23-1.695c-.42-.225-1.02-.78-.015-.795c.945-.015 1.62.87 1.845 1.23c1.08 1.815 2.805 1.305 3.495.99c.105-.78.42-1.305.765-1.605c-2.67-.3-5.46-1.335-5.46-5.925c0-1.305.465-2.385 1.23-3.225c-.12-.3-.54-1.53.12-3.18c0 0 1.005-.315 3.3 1.23c.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23c.66 1.65.24 2.88.12 3.18c.765.84 1.23 1.905 1.23 3.225c0 4.605-2.805 5.625-5.475 5.925c.435.375.81 1.095.81 2.22c0 1.605-.015 2.895-.015 3.3c0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12" clip-rule="evenodd" /></g><defs><clipPath id="landing-icon-github-clip"><path fill="#fff" d="M0 0h24v24H0z" /></clipPath></defs></g></symbol>
</svg>`;

const icon = (name) => `<svg class="landing-icon landing-icon-${name}" aria-hidden="true" focusable="false"><use href="#landing-icon-${name}" /></svg>`;
const expandIcon = `<svg class="landing-icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M12 3.5h4.5V8M8 16.5H3.5V12M16.5 3.5 11 9M3.5 16.5 9 11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>`;
const arrowIcon = `<svg class="landing-icon landing-arrow" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M4 10h11.5M11 5.5l4.5 4.5-4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>`;
const closeIcon = `<svg class="landing-icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M5 5l10 10M15 5 5 15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>`;

const screenSrc = (item, width) => `/screens/work-${item.screen}-${width}.webp`;
const sizes = "(min-width: 1296px) 1200px, calc(100vw - 32px)";

function shot(item, { eager = false } = {}) {
  const srcset = item.retina ? ` srcset="${screenSrc(item, 1440)} 1440w, ${screenSrc(item, 2880)} 2880w" sizes="${sizes}"` : "";
  return `<div class="landing-frame">
    <img src="${screenSrc(item, 1440)}"${srcset} width="1440" height="862" alt="${item.alt}" decoding="async" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} data-zoom="${item.id}" />
    ${item.id === "inbox" ? '<span class="landing-ring" aria-hidden="true"></span>' : ""}
  </div>`;
}

function caption(item) {
  return `<div class="landing-caption">
    <p class="landing-ask"><span class="landing-sr">Request: </span>“${item.ask}”</p>
    ${arrowIcon}
    <p class="landing-result"><span class="landing-sr">Result: </span>${item.result}</p>
    <button class="landing-zoom-button" type="button" data-zoom="${item.id}" aria-label="View the ${item.label ? item.label.toLowerCase() : "inbox app"} screen full size">${expandIcon}</button>
  </div>`;
}

const downloads = `<div class="landing-downloads">
  <a class="landing-download" href="${macDownload}">${icon("apple")}<span>Download for Mac</span></a>
  <a class="landing-download" href="${windowsDownload}">${icon("windows")}<span>Download for Windows</span></a>
</div>`;

const note = `<p class="landing-note"><span>Use your own model provider</span><span>Mac app for Apple silicon</span></p>`;

export function renderLanding(app) {
  app.innerHTML = `<div class="landing-shell">
    ${sprite}
    <a class="landing-skip" href="#landing-main">Skip to content</a>
    <header class="landing-top">
      <a class="landing-brand" href="/" aria-label="work-fold home"><img src="/brand-lockup-black.png" width="502" height="192" alt="" /></a>
      <nav class="landing-links" aria-label="Main navigation">
        <a href="${chromeExtension}">${icon("chrome")}<span>Chrome extension</span></a>
        <a href="${source}">${icon("github")}<span>GitHub</span></a>
      </nav>
    </header>

    <main id="landing-main" tabindex="-1">
      <section class="landing-hero" aria-labelledby="landing-title">
        <h1 id="landing-title">An AI Worker for every folder.</h1>
        <p class="landing-lede"><span>Ask for research, a draft, or the app you need.</span> <span>The work is saved right in your folder.</span></p>
        ${downloads}
        ${note}
      </section>

      <section class="landing-work" aria-label="Work done by Workers">
        <div class="landing-tabs" role="tablist" aria-label="Examples">${work.map((item, index) => `<button type="button" role="tab" id="work-tab-${item.id}" aria-controls="work-panel-${item.id}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}"><span class="landing-dot landing-dot-${item.id}" aria-hidden="true"></span>${item.short ? `<span class="landing-tab-long">${item.label}</span><span class="landing-tab-short" aria-hidden="true">${item.short}</span>` : item.label}</button>`).join("")}</div>
        <div class="landing-stage">${work.map((item, index) => `<div class="landing-panel" role="tabpanel" id="work-panel-${item.id}" aria-labelledby="work-tab-${item.id}" ${index ? "hidden" : ""}>${shot(item, { eager: index === 0 })}${caption(item)}</div>`).join("")}</div>
      </section>

      <section class="landing-apps" aria-labelledby="apps-title">
        <div class="landing-apps-inner">
          <h2 id="apps-title">Need an app? Ask for one.</h2>
          <p class="landing-lede"><span>A Worker built this inbox organizer from one request.</span> <span>It runs inside work-fold, in the sidebar.</span></p>
          <div class="landing-apps-shot">${shot(inbox)}${caption(inbox)}</div>
        </div>
      </section>

      <section class="landing-end" aria-labelledby="end-title">
        <h2 id="end-title">Start with a folder you already have.</h2>
        ${downloads}
        ${note}
      </section>
    </main>

    <footer class="landing-footer">
      <p>work-fold is open source under the MIT License.</p>
      <nav aria-label="Project links">
        <a href="${source}">GitHub</a>
        <a href="${chromeExtension}">Chrome extension</a>
        <a href="${source}/tree/main/docs">Docs</a>
        <a href="${source}/blob/main/PRIVACY.md">Privacy</a>
        <a href="${source}/blob/main/CONTRIBUTING.md">Contribute</a>
      </nav>
    </footer>

    <dialog class="landing-zoom" aria-label="Full-size screen">
      <button class="landing-zoom-close" type="button" aria-label="Close">${closeIcon}</button>
      <div class="landing-zoom-scroll"><img alt="" width="1440" height="862" /></div>
    </dialog>
  </div>`;

  const shell = app.querySelector(".landing-shell");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reducedMotion) shell.classList.add("motion-ok");

  const tabs = [...app.querySelectorAll('[role="tab"]')];
  const panels = tabs.map((tab) => app.querySelector(`#${tab.getAttribute("aria-controls")}`));
  function selectExample(index) {
    tabs.forEach((tab, i) => {
      const selected = i === index;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      panels[i].hidden = !selected;
    });
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => selectExample(index));
    tab.addEventListener("keydown", (event) => {
      const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
      if (next === null) return;
      event.preventDefault(); selectExample(next); tabs[next].focus();
    });
  });

  const dialog = app.querySelector(".landing-zoom");
  const zoomImage = dialog.querySelector("img");
  const scroller = dialog.querySelector(".landing-zoom-scroll");
  const items = Object.fromEntries([...work, inbox].map((item) => [item.id, item]));
  function openZoom(id) {
    const item = items[id];
    zoomImage.src = screenSrc(item, item.retina ? 2880 : 1440);
    zoomImage.alt = item.alt;
    if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
    // On a narrow screen, start at the Worker's output in the right panel.
    scroller.scrollLeft = scroller.scrollWidth > scroller.clientWidth ? scroller.scrollWidth * 0.38 : 0;
  }
  function closeZoom() {
    if (typeof dialog.close === "function") dialog.close(); else dialog.removeAttribute("open");
  }
  for (const trigger of app.querySelectorAll("[data-zoom]")) trigger.addEventListener("click", () => openZoom(trigger.dataset.zoom));
  dialog.querySelector(".landing-zoom-close").addEventListener("click", closeZoom);
  dialog.addEventListener("click", (event) => { if (event.target === dialog || event.target === scroller) closeZoom(); });
}
