// Public product introduction. Saved Worker results are shown in the current
// desktop release; the bridge renders the saved demonstration conversation.
// Keep claims to what the screens show.
const source = "https://github.com/Mat-Tom-Son/work-fold";
const chromeExtension = "https://chromewebstore.google.com/detail/work-fold/ophmjbphcjmjcpcdpmfehbldiomkepgk";
const macDownload = "/download/macos";
const windowsDownload = "https://github.com/Mat-Tom-Son/work-fold/releases/download/windows-test-0.4.50/work-fold-Setup-0.4.50.exe";
const linuxDownload = "https://github.com/Mat-Tom-Son/work-fold/releases/tag/linux-test-0.4.52";

// Each workflow is a work-folder; its colors are the folder's own colors in the app.
const folders = [
  {
    id: "research", tab: "Research", screen: "research", retina: false,
    text: "Reads public sources and saves a cited brief beside them.",
    alt: "The Research — repair café work-folder: a sources folder beside research-brief.md, open to a table of the public sources the Worker consulted.",
  },
  {
    id: "orders", tab: "Purchase Orders", screen: "orders", retina: false,
    text: "Checks every price, prepares two purchase orders, and drafts the vendor emails. Nothing is sent.",
    alt: "The Purchasing — autumn workshop work-folder: two purchase orders and two email drafts in the sidebar, and order-register.md showing a $1,102.00 goods subtotal with both orders marked Draft — not sent.",
  },
  {
    id: "writing", tab: "Writing", screen: "writing", retina: true,
    text: "Turns rough field notes into a 422-word newsletter draft.",
    alt: "The Writing — neighborhood letter work-folder: field notes, a writing brief, and editorial notes in the sidebar, with newsletter-draft.md open.",
  },
  {
    id: "files", tab: "Files", screen: "files", retina: true,
    text: "Sorts eight loose files into folders and logs every move. Nothing is deleted.",
    alt: "The Files — studio cleanup work-folder: files sorted into archive, purchases, workshop planning, and writing folders, with organization-log.md open to a before-and-after table.",
  },
];

const inbox = {
  id: "inbox", tab: "Inbox app", screen: "inbox", retina: true,
  text: "Sorts mail into categories, opens each message in a tab, and remembers what you mark done.",
  alt: "A Studio inbox app built by a Worker, open in the work-fold sidebar: categories such as Needs reply and Purchasing, a message list, and one message open in its own tab with category and Mark not done controls.",
};

// Saved repair-café conversation rendered in the current bridge client.
const web = {
  chat: { src: "/screens/web-chat-desktop.webp", width: 876, height: 794, alt: "The work-fold web client in a desktop browser: a request to make the repair café a 9–12 morning event, and the work-fold agent's reply with the updated Saturday schedule." },
  plan: { src: "/screens/web-plan-desktop.webp", width: 876, height: 794, alt: "The work-fold web client showing workshop-plan.md, the plan the work-fold agent saved in the Community workshop work-folder." },
  phone: { src: "/screens/web-chat-phone.webp", width: 390, height: 844, alt: "The same conversation in the work-fold web client on a phone, showing the Saturday morning schedule." },
};

// Browser and computer use: one real supply-pricing run in the "Repair café —
// supplies" work-folder, 2026-10-04. The Worker read six public prices in
// Chrome and created the sheet; the Numbers sorting and bold were assisted
// by a person, after which the Worker checked Chrome and Numbers through its
// tools and saved. The copy claims only the checking and reviewing. The step
// trail is cropped above a later line that shows a local path.
const handoff = [
  {
    id: "chrome", place: "Chrome", width: 1280, height: 800,
    capture: { src: "/screens/apps-chrome-1280.webp", srcset: "/screens/apps-chrome-1280.webp 1280w, /screens/apps-chrome-2560.webp 2560w", full: "/screens/apps-chrome-2560.webp", alt: "Chrome with the work-fold extension pinned, open to Adafruit's public page for a 6-piece precision screwdriver set at $7.95, in the tab group of the Worker's session." },
  },
  {
    id: "steps", place: "work-fold", folder: "Repair café — supplies", width: 1560, height: 518,
    capture: { src: "/screens/apps-steps-1560.webp", full: "/screens/apps-workfold-2880.webp", alt: "The Worker's steps in the Repair café — supplies work-folder: Chrome Navigate and Chrome Snapshot confirm the $7.95 price, then Find Roots and Observe Ui check the Numbers document.", fullAlt: "The Worker's final reply in the Repair café — supplies work-folder: the research sheet it saved, the assisted Numbers file, and the three cheapest prices, all checked 2026-10-04." },
  },
  {
    id: "app", place: "Numbers", width: 1280, height: 800,
    capture: { src: "/screens/apps-numbers-1280.webp", srcset: "/screens/apps-numbers-1280.webp 1280w, /screens/apps-numbers-2560.webp 2560w", full: "/screens/apps-numbers-2560.webp", alt: "Numbers showing supply-prices: six public prices from Adafruit and iFixit, sorted by item and price, with the cheapest price for each item in bold." },
  },
];

function appWindow(item) {
  if (item.capture) {
    const { src, srcset, alt } = item.capture;
    const image = `<button class="landing-window-open" type="button" data-zoom="${item.id}" aria-label="View the ${item.place} screen full size"><img src="${src}"${srcset ? ` srcset="${srcset}" sizes="(min-width: 900px) 700px, calc(100vw - 32px)"` : ""} width="${item.width}" height="${item.height}" alt="${alt}" loading="lazy" decoding="async" /></button>`;
    return item.folder
      ? `<figure class="landing-window landing-window-${item.id}"><figcaption class="landing-window-tab"><span class="landing-dot" aria-hidden="true"></span>${item.folder}</figcaption><div class="landing-window-shot">${image}</div></figure>`
      : `<figure class="landing-window landing-window-${item.id}">${image}</figure>`;
  }
  return `<figure class="landing-window landing-window-${item.id} is-pending" data-capture-needed="${item.id}">
    <div class="landing-window-slot"><span>Real capture needed</span><strong>${item.place}</strong><p>${item.need}</p></div>
  </figure>`;
}

// The supplied icons, verbatim, as one sprite so each id appears once.
const sprite = `<svg class="landing-sprite" aria-hidden="true" focusable="false">
  <symbol id="landing-icon-apple" viewBox="0 0 1024 1024"><path fill="currentColor" d="M747.4 535.7c-.4-68.2 30.5-119.6 92.9-157.5c-34.9-50-87.7-77.5-157.3-82.8c-65.9-5.2-138 38.4-164.4 38.4c-27.9 0-91.7-36.6-141.9-36.6C273.1 298.8 163 379.8 163 544.6c0 48.7 8.9 99 26.7 150.8c23.8 68.2 109.6 235.3 199.1 232.6c46.8-1.1 79.9-33.2 140.8-33.2c59.1 0 89.7 33.2 141.9 33.2c90.3-1.3 167.9-153.2 190.5-221.6c-121.1-57.1-114.6-167.2-114.6-170.7m-105.1-305c50.7-60.2 46.1-115 44.6-134.7c-44.8 2.6-96.6 30.5-126.1 64.8c-32.5 36.8-51.6 82.3-47.5 133.6c48.4 3.7 92.6-21.2 129-63.7" /></symbol>
  <symbol id="landing-icon-windows" viewBox="0 0 12 12"><path fill="currentColor" d="M6 6h5V1H6Zm-6 6h5V7H0Zm0-6h5V1H0Zm6 6h5V7H6Zm0 0" /></symbol>
  <symbol id="landing-icon-linux" viewBox="0 0 24 24"><path fill="currentColor" fill-rule="evenodd" d="M8 6a4 4 0 0 1 8 0v1c0 1.214.502 2.267 1.166 3.354c.124.203.274.438.427.678c.207.325.42.66.588.944c.32.541.629 1.14.79 1.781a7 7 0 0 1 .192 1.358a2 2 0 0 0-1.93-.516l-.566.151l-.582-.336a2 2 0 0 0-2.996 1.613l-.238 3.965c-.021.345.022.684.121 1.003a7 7 0 0 1-.269.005h-.406q-.114 0-.226-.004c.22-.71.152-1.492-.214-2.167l-1.891-3.493a2 2 0 0 0-3.397-.195l-.385.55l-.33.058a5.4 5.4 0 0 1 .024-1.16c.037-.285.086-.567.152-.832c.254-1.018.739-1.83 1.125-2.477q.09-.147.169-.284C7.74 10.28 8 9.723 8 9zm3.597 1.664a1.5 1.5 0 0 0-1.035.114l-.822.41c.224.597.572 1.156.897 1.6c.176.24.341.441.47.588l.105-.059c.271-.154.642-.376 1.04-.646c.603-.412 1.224-.91 1.661-1.427z" clip-rule="evenodd" />
	<path fill="currentColor" d="M18.716 16.271a1 1 0 0 0-1.225-.707l-.966.259l-.94-.543a1 1 0 0 0-1.498.806l-.238 3.965a1.809 1.809 0 0 0 2.802 1.618l3.315-2.188a1 1 0 0 0-.051-1.7l-.94-.544zM4.97 17.936a1 1 0 0 1 .81-1.159l.985-.173l.623-.89a1 1 0 0 1 1.698.098l1.892 3.493a1.809 1.809 0 0 1-1.856 2.65l-3.93-.582a1 1 0 0 1-.672-1.563l.623-.89z" /></symbol>
  <symbol id="landing-icon-chrome" viewBox="0 0 1024 1024"><path fill="currentColor" d="M371.8 512c0 77.5 62.7 140.2 140.2 140.2S652.2 589.5 652.2 512S589.5 371.8 512 371.8S371.8 434.4 371.8 512M900 362.4l-234.3 12.1c63.6 74.3 64.6 181.5 11.1 263.7l-188 289.2c78 4.2 158.4-12.9 231.2-55.2c180-104 253-322.1 180-509.8M320.3 591.9L163.8 284.1A415.35 415.35 0 0 0 96 512c0 208 152.3 380.3 351.4 410.8l106.9-209.4c-96.6 18.2-189.9-34.8-234-121.5m218.5-285.5l344.4 18.1C848 254.7 792.6 194 719.8 151.7C653.9 113.6 581.5 95.5 510.5 96c-122.5.5-242.2 55.2-322.1 154.5l128.2 196.9c32-91.9 124.8-146.7 222.2-141" /></symbol>
  <symbol id="landing-icon-github" viewBox="0 0 24 24"><g fill="none"><g clip-path="url(#landing-icon-github-clip)"><path fill="currentColor" fill-rule="evenodd" d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385c.6.105.825-.255.825-.57c0-.285-.015-1.23-.015-2.235c-3.015.555-3.795-.735-4.035-1.41c-.135-.345-.72-1.41-1.23-1.695c-.42-.225-1.02-.78-.015-.795c.945-.015 1.62.87 1.845 1.23c1.08 1.815 2.805 1.305 3.495.99c.105-.78.42-1.305.765-1.605c-2.67-.3-5.46-1.335-5.46-5.925c0-1.305.465-2.385 1.23-3.225c-.12-.3-.54-1.53.12-3.18c0 0 1.005-.315 3.3 1.23c.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23c.66 1.65.24 2.88.12 3.18c.765.84 1.23 1.905 1.23 3.225c0 4.605-2.805 5.625-5.475 5.925c.435.375.81 1.095.81 2.22c0 1.605-.015 2.895-.015 3.3c0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12" clip-rule="evenodd" /></g><defs><clipPath id="landing-icon-github-clip"><path fill="#fff" d="M0 0h24v24H0z" /></clipPath></defs></g></symbol>
</svg>`;

const icon = (name) => `<svg class="landing-icon landing-icon-${name}" aria-hidden="true" focusable="false"><use href="#landing-icon-${name}" /></svg>`;
const expandIcon = `<svg class="landing-icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M12 3.5h4.5V8M8 16.5H3.5V12M16.5 3.5 11 9M3.5 16.5 9 11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>`;
const closeIcon = `<svg class="landing-icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M5 5l10 10M15 5 5 15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>`;

const screenSrc = (item, width) => `/screens/work-${item.screen}-${width}.webp`;
// Phones show a crop of each screen at 1440/830 of the frame width.
const sizes = "(max-width: 640px) calc((100vw - 48px) * 1.735), (min-width: 1260px) 1176px, calc(100vw - 48px)";

function folder(item, index, { eager = false } = {}) {
  const srcset = item.retina ? ` srcset="${screenSrc(item, 1440)} 1440w, ${screenSrc(item, 2880)} 2880w" sizes="${sizes}"` : "";
  return `<article class="landing-folder landing-folder-${item.id}" id="folder-${item.id}" data-index="${index}" aria-labelledby="folder-${item.id}-title">
    <div class="landing-folder-inner">
      <h3 class="landing-tab" id="folder-${item.id}-title"><span class="landing-dot" aria-hidden="true"></span>${item.tab}</h3>
      <div class="landing-folder-body">
        <div class="landing-folder-bar">
          <p>${item.text}</p>
          <button class="landing-zoom-button" type="button" data-zoom="${item.id}" aria-label="View the ${item.tab.toLowerCase()} screen full size">${expandIcon}</button>
        </div>
        <div class="landing-shot">
          <div class="landing-shot-media">
            <img src="${screenSrc(item, 1440)}"${srcset} width="1440" height="862" alt="${item.alt}" decoding="async" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} data-zoom="${item.id}" />
            ${item.id === "inbox" ? '<span class="landing-ring" aria-hidden="true"></span>' : ""}
          </div>
        </div>
      </div>
    </div>
  </article>`;
}

const downloads = `<div class="landing-download-group" role="group" aria-label="Download work-fold">
  <p class="landing-download-label">Download</p>
  <div class="landing-downloads">
    <a class="landing-download" href="${macDownload}" aria-label="Download for Mac">${icon("apple")}<span>Mac</span></a>
    <a class="landing-download" href="${windowsDownload}" aria-label="Download for Windows">${icon("windows")}<span>Windows</span></a>
    <a class="landing-download" href="${linuxDownload}" aria-label="Download for Linux">${icon("linux")}<span>Linux</span></a>
  </div>
</div>`;

const browser = (shot, kind) => `<figure class="landing-browser landing-browser-${kind}">
    <div class="landing-browser-bar" aria-hidden="true"><span></span><span></span><span></span><p>your-name.work-fold.com</p></div>
    <img src="${shot.src}" width="${shot.width}" height="${shot.height}" alt="${shot.alt}" loading="lazy" decoding="async" />
  </figure>`;
// Top to bottom, the same order as the hierarchy: you in a browser, the
// work-fold agent on your computer, and the work-folder where the plan is saved.
const devices = `<div class="landing-devices">
  <figure class="landing-phone"><img src="${web.phone.src}" width="${web.phone.width}" height="${web.phone.height}" alt="${web.phone.alt}" loading="lazy" decoding="async" /></figure>
  ${browser(web.chat, "chat")}
  ${browser(web.plan, "plan")}
</div>`;

const route = `<ol class="landing-route" aria-label="How web access connects">
  <li><span class="landing-route-node"><span class="landing-route-lead">Your </span>browser</span><span class="landing-route-note">anywhere</span></li>
  <li><span class="landing-route-node">work-fold agent</span><span class="landing-route-note">on your computer</span></li>
  <li><span class="landing-route-node">Workers</span><span class="landing-route-note">in your work-folders</span></li>
</ol>`;

export function renderLanding(app) {
  app.innerHTML = `<div class="landing-shell">
    ${sprite}
    <a class="landing-skip" href="#landing-main">Skip to content</a>
    <header class="landing-nav">
      <a class="landing-brand" href="/" aria-label="work-fold home"><img src="/brand-lockup-white.png" width="502" height="192" alt="" /></a>
      <nav class="landing-links" aria-label="Main navigation">
        <a href="${chromeExtension}">${icon("chrome")}<span>Chrome extension</span></a>
        <a href="${source}">${icon("github")}<span>GitHub</span></a>
        <a class="landing-nav-download" href="#download">Download</a>
      </nav>
    </header>

    <main id="landing-main" tabindex="-1">
      <section class="landing-stack" aria-labelledby="landing-title">
        <div class="landing-hero">
          <div class="landing-hero-copy">
            <h1 id="landing-title"><span>An AI Worker</span> <span>for every folder.</span></h1>
            <p class="landing-lede">work-fold is an AI agent harness for everyone. Workers use tools, work in your ordinary folders, and build the apps you need.</p>
            ${downloads}
          </div>
        </div>
        <h2 class="landing-sr">Work done by Workers</h2>
        ${folders.map((item, index) => folder(item, index, { eager: index === 0 })).join("")}
      </section>

      <section class="landing-chapter landing-hands" aria-labelledby="hands-title">
        <div class="landing-chapter-head">
          <h2 id="hands-title">Works with the apps you already use.</h2>
          <div>
            <p>Workers can check pages in Chrome and use apps on your Mac. Here, one priced repair-café supplies in Chrome, saved a sheet with your files, and reviewed it in Numbers.</p>
            <a class="landing-text-link" href="${chromeExtension}">${icon("chrome")}<span>Add work-fold to Chrome</span></a>
          </div>
        </div>
        <div class="landing-handoff">${handoff.map(appWindow).join("")}</div>
      </section>

      <section class="landing-chapter landing-app" aria-labelledby="app-title">
        <div class="landing-chapter-head">
          <h2 id="app-title">Need an app? Ask for one.</h2>
          <p>A Worker built this inbox organizer from one request. It runs inside work-fold, right in the sidebar.</p>
        </div>
        ${folder(inbox, folders.length)}
      </section>

      <section class="landing-chapter landing-web" aria-labelledby="web-title">
        <div class="landing-web-copy">
          <h2 id="web-title">Check in from anywhere.</h2>
          <p>Reach the work-fold agent from any browser while your desktop stays on and online. It can update your files and hand work to the Workers in your folders.</p>
          ${route}
        </div>
        ${devices}
      </section>

      <section class="landing-end" id="download" aria-labelledby="end-title" tabindex="-1">
        <div class="landing-end-main">
          <h2 id="end-title">Start with a folder you already have.</h2>
          ${downloads}
        </div>
        <ul class="landing-facts">
          <li><h3>Ordinary folders</h3><p>Your files stay where they are and open in any app.</p></li>
          <li><h3>Your model provider</h3><p>Connect the AI provider you choose in Settings.</p></li>
          <li><h3>Chrome and computer tools</h3><p>Add the <a href="${chromeExtension}">Chrome extension</a> so Workers can use your browser.</p></li>
          <li><h3>Open source</h3><p>MIT licensed. <a href="${source}">Read the code on GitHub</a>.</p></li>
        </ul>
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

  const dialog = app.querySelector(".landing-zoom");
  const zoomImage = dialog.querySelector("img");
  const scroller = dialog.querySelector(".landing-zoom-scroll");
  const items = Object.fromEntries([...folders, inbox, ...handoff].map((item) => [item.id, item]));
  function openZoom(id) {
    const item = items[id];
    zoomImage.src = item.capture ? item.capture.full ?? item.capture.src : screenSrc(item, item.retina ? 2880 : 1440);
    zoomImage.alt = item.capture ? item.capture.fullAlt ?? item.capture.alt : item.alt;
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

  if (!reducedMotion) followScroll(shell);
}

// Let the compositor track the hero on browsers with scroll timelines. The
// fallback uses the same measured endpoints; scrolling never remeasures the
// animated image or interleaves layout reads with transform writes.
function followScroll(shell) {
  const win = window;
  const root = shell.ownerDocument.documentElement;
  const hero = shell.querySelector(".landing-hero");
  const copy = shell.querySelector(".landing-hero-copy");
  const stack = [...shell.querySelectorAll(".landing-stack .landing-folder")];
  const app = shell.querySelector(".landing-app .landing-shot-media");
  const appFrame = app?.closest(".landing-shot");
  const devices = shell.querySelector(".landing-devices");
  const webSection = devices?.closest(".landing-web");
  const hands = shell.querySelector(".landing-handoff");
  const stacking = matchMedia("(min-width: 900px) and (min-height: 640px)");
  const mobileStacking = matchMedia("(max-width: 899px) and (min-height: 560px)");
  let mobileStack = false;
  const clamp = (value) => Math.min(1, Math.max(0, value));
  const nativeScroll = win.CSS?.supports("animation-timeline", "scroll(root block)")
    && win.CSS.supports("animation-range", "0px 1px");
  if (nativeScroll) shell.classList.add("css-scroll");
  let frame = 0;
  let geometry;
  let deviceCenters = null;
  let needsMeasure = true;
  function measure(first) {
    // Measure its place in document flow, even after the sticky stack has
    // settled. Only viewport/font changes require these layout reads.
    shell.classList.add("is-measuring");
    const natural = first.getBoundingClientRect();
    const box = copy.getBoundingClientRect();
    const heroBottom = hero.getBoundingClientRect().bottom + win.scrollY;
    const nav = shell.querySelector(".landing-nav").offsetHeight;
    shell.classList.remove("is-measuring");
    const stickTop = parseFloat(win.getComputedStyle(first).top) || 0;
    const travel = Math.max(1, heroBottom - stickTop);
    const width = natural.width, height = natural.height;
    const viewWidth = root.clientWidth, viewHeight = win.innerHeight;
    const left = box.right + Math.min(64, viewWidth * 0.04);
    const scale = Math.min(1, (viewWidth + Math.min(viewWidth * 0.06, 120) - left) / Math.max(1, width), (viewHeight - nav - 48) / Math.max(1, height));
    const copyCenter = box.top + win.scrollY + box.height / 2;
    const top = Math.max(nav + 20, Math.min(copyCenter - (height * scale) / 2, viewHeight - 24 - height * scale));
    geometry = { stickTop, travel, x: left - natural.left, top, scale };
    const inner = first.querySelector(".landing-folder-inner");
    inner.style.setProperty("--hero-x", `${geometry.x}px`);
    inner.style.setProperty("--hero-y", `${top - natural.top - win.scrollY}px`);
    inner.style.setProperty("--hero-end-y", `${stickTop - natural.top - win.scrollY}px`);
    inner.style.setProperty("--hero-scale", scale);
    shell.style.setProperty("--hero-travel", `${travel}px`);
    needsMeasure = false;
  }
  function reveal(first, natural) {
    const { stickTop, travel, x, top, scale } = geometry;
    const progress = clamp(win.scrollY / travel);
    const eased = progress * progress * (3 - 2 * progress);
    const inner = first.querySelector(".landing-folder-inner");
    inner.style.setProperty("--tx", `${x * (1 - eased)}px`);
    // Once the stack itself scrolls away, follow it instead of holding the stop.
    const settled = top + (stickTop - top) * eased + Math.min(0, natural.top - stickTop);
    inner.style.setProperty("--ty", `${settled - natural.top}px`);
    inner.style.setProperty("--sc", scale + (1 - scale) * eased);
    copy.style.setProperty("--fade", clamp(progress * 1.7).toFixed(3));
  }
  function update() {
    frame = 0;
    const height = win.innerHeight;
    if (needsMeasure) {
      shell.style.removeProperty("--mobile-bar");
      const mobileCandidate = !stacking.matches && mobileStacking.matches && stack.length > 0;
      if (mobileCandidate) {
        // Equal caption heights keep every filed tab on the same baseline.
        const barHeight = Math.max(...stack.map((item) => item.querySelector(".landing-folder-bar").offsetHeight));
        shell.style.setProperty("--mobile-bar", `${barHeight}px`);
      }
      // Only pin a phone/tablet frame when its entire caption and image fit.
      // Short landscape screens keep the ordinary, readable flow.
      mobileStack = mobileCandidate
        && Math.max(...stack.map((item) => item.offsetHeight)) <= height - shell.querySelector(".landing-nav").offsetHeight - 44;
      shell.classList.toggle("mobile-stack", mobileStack);
      if (stacking.matches && stack.length) measure(stack[0]);
      else needsMeasure = false;
    }
    const stackActive = stacking.matches || mobileStack;
    // Read untransformed frames first. The inbox's own scaled bounds would
    // feed its last transform back into the next frame and make it oscillate.
    const boxes = stackActive ? stack.map((item) => item.getBoundingClientRect()) : [];
    const appBox = appFrame?.getBoundingClientRect();
    const devicesBox = devices?.getBoundingClientRect();
    const handsBox = hands?.getBoundingClientRect();
    if (stacking.matches && stack.length) {
      if (!nativeScroll) reveal(stack[0], boxes[0]);
    }
    if (stackActive && stack.length) {
      const stickTop = mobileStack ? parseFloat(win.getComputedStyle(stack[0]).top) || 0 : geometry.stickTop;
      let front = 0;
      boxes.forEach((box, index) => { if (box.top <= stickTop + 1) front = index; });
      stack.forEach((item, index) => {
        const state = index < front ? "filed" : index === front ? "front" : "ahead";
        if (item.dataset.state !== state) item.dataset.state = state;
      });
    }
    if (!stacking.matches && stack.length) {
      for (const name of ["--tx", "--ty", "--sc"]) stack[0].querySelector(".landing-folder-inner").style.removeProperty(name);
      copy.style.removeProperty("--fade");
      if (!mobileStack) stack.forEach((item) => { delete item.dataset.state; });
    }
    if (appBox) {
      // Starts close on the sidebar app, pulls back to the whole window.
      app.style.setProperty("--reveal", clamp((height - appBox.top) / (height * 0.9)).toFixed(3));
    }
    if (devicesBox) {
      devices.style.setProperty("--drift", clamp((height - devicesBox.top) / (height + devicesBox.height)).toFixed(3));
      // The device crossing the middle of the screen is the level of the
      // hierarchy that is lit: your browser, the work-fold agent, then the
      // work-folder. Layout offsets are cached; transforms never feed back.
      deviceCenters ??= [...devices.children].map((item) => item.offsetTop + item.offsetHeight / 2);
      const focus = height * 0.5;
      const centers = deviceCenters.map((center) => devicesBox.top + center);
      webSection.style.setProperty("--route", clamp((focus - centers[0]) / Math.max(1, centers.at(-1) - centers[0])).toFixed(3));
      let step = 0;
      centers.forEach((center, index) => { if (Math.abs(center - focus) < Math.abs(centers[step] - focus)) step = index; });
      if (webSection.dataset.step !== String(step)) webSection.dataset.step = String(step);
    }
    if (handsBox) {
      // The browser, the step trail and the Mac app slide together as they arrive.
      hands.style.setProperty("--hand", clamp((height - handsBox.top) / (height * 0.85)).toFixed(3));
    }
  }
  // Keyboard focus never lands on something faded or covered: the hero copy
  // returns to the top of the page, and a folder control brings that folder
  // to the front of the stack.
  function naturalTop(folder) {
    shell.classList.add("is-measuring");
    const top = folder.getBoundingClientRect().top + win.scrollY;
    shell.classList.remove("is-measuring");
    return top;
  }
  function align(target) {
    if ((!stacking.matches && !mobileStack) || !shell.contains(target)) return;
    if (copy.contains(target)) {
      if (win.scrollY > 0) win.scrollTo({ top: 0, behavior: "instant" });
      return;
    }
    const folder = stack.find((item) => item.contains(target));
    if (!folder) return;
    const stickTop = parseFloat(win.getComputedStyle(folder).top) || 0;
    // Already settled at the front of the stack: leave the page where it is.
    if (folder.dataset.state === "front" && Math.abs(folder.getBoundingClientRect().top - stickTop) <= 1) return;
    win.scrollTo({ top: Math.max(0, naturalTop(folder) - stickTop), behavior: "instant" });
  }

  const nextFrame = win.requestAnimationFrame?.bind(win) ?? ((callback) => setTimeout(callback, 16));
  // Run after the browser's own focus scrolling has finished.
  shell.addEventListener("focusin", (event) => nextFrame(() => { align(event.target); update(); }));
  const request = () => { if (!frame) frame = nextFrame(update); };
  win.addEventListener("scroll", request, { passive: true });
  const remeasure = () => { needsMeasure = true; deviceCenters = null; request(); };
  win.addEventListener("resize", remeasure);
  stacking.addEventListener?.("change", remeasure);
  mobileStacking.addEventListener?.("change", remeasure);
  shell.ownerDocument.fonts?.ready.then(remeasure);
  update();
}
