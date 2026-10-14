// Public product introduction. Saved Worker results are shown in the current
// desktop release; the bridge renders the saved demonstration conversation.
// Keep claims to what the screens show.
const source = "https://github.com/Mat-Tom-Son/work-fold";
const chromeExtension = "https://chromewebstore.google.com/detail/work-fold/ophmjbphcjmjcpcdpmfehbldiomkepgk";
const macDownload = "/download/macos";
const windowsDownload = "https://github.com/Mat-Tom-Son/work-fold/releases/tag/windows-test-0.4.50";
const linuxDownload = "https://github.com/Mat-Tom-Son/work-fold/releases/tag/linux-test-0.4.52";

// Each workflow is a work-folder; its colors are the folder's own colors in the app.
// `before` lists the files the Worker started from, exactly as in
// landing-assets/fixtures/<id>/inputs; the screen shows what it left behind.
// `added` outlines the new sidebar rows in that screen (x, y, width, height
// in the 1440 × 862 capture). `beforeShot` marks a real capture of the same
// window before the request, at work-<screen>-before-{1440,2880}.webp.
const range = (count, name) => Array.from({ length: count }, (_, index) => name(index + 1));
const folders = [
  {
    id: "receipts", tab: "Receipts", screen: "receipts", retina: true,
    request: "Add up September’s receipts into one spreadsheet.",
    text: "14 receipts. $1,063.79. Two dates to check.",
    alt: "The Receipts — September work-folder: 14 sample receipts beside the spreadsheet and CSV the Worker saved, with receipts-summary.md open to the checked $1,063.79 total and two missing dates.",
    before: ["brief.md", ...range(14, (n) => `receipt-${String(n).padStart(2, "0")}.txt`)],
    added: [[64, 312, 474, 93]],
  },
  {
    id: "orders", tab: "Purchase orders", screen: "orders", retina: true,
    request: "Check every quantity and price.",
    text: "Two purchase orders. $1,102. Emails drafted. Nothing sent.",
    alt: "The Purchasing — autumn workshop work-folder: two purchase orders and two email drafts in the sidebar, and order-register.md showing a $1,102.00 goods subtotal with both orders marked Draft — not sent.",
    before: ["approved-order.md", "vendors.md"],
    added: [[64, 219, 474, 183], [64, 434, 474, 31]],
  },
  {
    id: "job-search", tab: "Job search", screen: "job-search", retina: true,
    request: "Tailor my résumé to this job. Add nothing that isn’t in my résumé.",
    text: "A tailored résumé and cover letter. Original untouched.",
    alt: "The Job search — next step work-folder: the original résumé and job description beside the tailored résumé, cover letter and application notes created by the Worker.",
    before: ["resume-original.md", "job-description.md"],
    added: [[64, 219, 474, 123]],
  },
  {
    id: "downloads", tab: "Downloads", screen: "downloads", retina: true,
    request: "Sort my Downloads. Don’t delete anything. Log every move.",
    text: "31 files. Six folders. Every move logged. Nothing deleted.",
    alt: "The Downloads — a little order work-folder: 31 sample files sorted into six folders, with organization-log.md showing the before-and-after paths and unchanged file hashes.",
    before: [
      "organizing-brief.md",
      ...range(5, (n) => `export (${n}).csv`), ...range(5, (n) => `guide-${n}.html`), ...range(6, (n) => `image-${n}.svg`),
      "notes final copy.md", ...[1, 3, 4, 5, 6].map((n) => `notes${n}.md`), ...range(3, (n) => `old-plan-${n}.txt`), ...range(6, (n) => `scan_${n}.txt`),
    ],
    added: [[64, 281, 474, 216]],
  },
];

const tracker = {
  id: "tracker", tab: "Job tracker", screen: "tracker", retina: true,
  text: "Applications, next steps, and notes. Saved in your own app.",
  alt: "A job-application tracker built by a Worker, running in the work-fold sidebar with six sample applications, status groups, and an application open in its own tab with editable status, next step and notes.",
};

// Saved repair-café conversation rendered in the current bridge client.
const web = {
  chat: { src: "/screens/web-chat-desktop.webp", width: 876, height: 794, alt: "The work-fold web client in a desktop browser: a request to make the repair café a 9–12 morning event, and the work-fold agent's reply with the updated Saturday schedule." },
  plan: { src: "/screens/web-plan-desktop.webp", width: 876, height: 794, alt: "The work-fold web client showing workshop-plan.md, the plan the work-fold agent saved in the Community workshop work-folder." },
  phone: { src: "/screens/web-chat-phone.webp", width: 390, height: 844, alt: "The same conversation in the work-fold web client on a phone, showing the Saturday morning schedule." },
};

// Browser and computer use, drawn rather than captured: the Job search
// work-folder's Worker fills in a sample application in Chrome, stops before
// Submit, and adds an interview to Calendar when asked. Everything shown is fictional
// (Avery Stone and Fieldwork Studio come from landing-assets/fixtures; the form
// lives at a reserved .example address). Each step names a real tool, worded
// the way the app's step list words it: chrome_fill → "Used Chrome Fill".
const apply = {
  request: "Fill in this application from my résumé. Don’t submit it.",
  url: "careers.fieldwork.example/apply",
  letter: "Dear Fieldwork Studio team, I would like to express my interest in the Operations coordinator role. Your work running public workshops and small community events is close to what I do each week.",
  // The tracker chapter's Fieldwork Studio row: "Interview on October 14".
  invite: { from: "Fieldwork Studio", subject: "Interview invitation", preview: "Could you join us on Wednesday, October 14 at 10:00?" },
};
// One timeline, top to bottom as it appears in the work-fold window:
// [tool, detail, milliseconds, what the step does on screen]. "reply" is the
// Worker's answer; "mail" is a new request about an interview invitation.
const steps = [
  ["read", "resume-tailored.md", 260],
  ["read", "cover-letter.md", 260],
  ["document_run", "resume-tailored.pdf", 360],
  ["chrome_navigate", "", 700, { window: "chrome", navigate: true }],
  ["chrome_snapshot", "", 300, { window: "chrome" }],
  ["chrome_fill", "", 500, { window: "chrome", field: "name", value: "Avery Stone" }],
  ["chrome_fill", "", 600, { window: "chrome", field: "email", value: "avery@sample.example.test" }],
  ["chrome_fill", "", 500, { window: "chrome", field: "location", value: "Portland, Oregon" }],
  ["chrome_upload_file", "", 700, { window: "chrome", field: "resume", upload: true }],
  ["chrome_fill", "", 750, { window: "chrome", field: "letter", value: apply.letter }],
  ["chrome_snapshot", "", 550, { window: "chrome", field: "submit", hold: true }],
  ["reply", "The application is filled in and waiting for you. I didn’t submit it.", 900],
  ["mail", "New request · Add this interview to my calendar.", 1000, { window: "mail", mail: true }],
  ["observe_ui", "", 450, { window: "mail" }],
  ["find_roots", "", 300, { window: "calendar" }],
  ["act_ui", "", 800, { window: "calendar", event: true }],
  ["reply", "Your Fieldwork Studio interview is on your calendar: Wednesday, October 14 at 10:00.", 400],
];
const toolWords = (tool) => tool.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const stepLabel = ([tool, detail], active) => `${tool === "read" ? (active ? "Reading" : "Read") : `${active ? "Using" : "Used"} ${toolWords(tool)}`}${detail ? ` ${detail}` : ""}`;
const stepItem = (step, index) => step[0] === "reply"
  ? `<li class="scene-reply" data-step="${index}" data-state="done">${step[1]}</li>`
  : step[0] === "mail"
    ? `<li class="scene-event" data-step="${index}" data-state="done">${step[1]}</li>`
    : `<li data-step="${index}" data-state="done"><span class="scene-now">${stepLabel(step, true)}</span><span class="scene-was">${stepLabel(step, false)}</span></li>`;

// Markup shows the finished moment; with motion, the timeline rewinds it.
const field = (name, label, value, extra = "") => `<div class="scene-field scene-field-${name}" data-field="${name}"><span class="scene-label">${label}</span><span class="scene-input${extra}"><span class="scene-value" data-value="${value}">${value}</span></span></div>`;
const scene = `<div class="landing-scene">
  <p class="landing-sr">Request: ${apply.request} An illustration of the Worker's steps: it reads the tailored résumé and cover letter, opens the sample application in Chrome, fills in the name, email, location and cover letter, attaches the résumé, and leaves Submit for you. Later, an email from Fieldwork Studio invites Avery to an interview. You ask the Worker to add it to Calendar for Wednesday, October 14 at 10:00.</p>
  <div class="scene-shot">
    <div class="scene-stage" data-focus="all" data-page="loaded" data-held="yes" data-event="yes" data-mail="no" aria-hidden="true">
      <div class="scene-window scene-chrome" data-window="chrome">
        <div class="scene-tabs"><span class="scene-lights"><i></i><i></i><i></i></span><span class="scene-group">work-fold</span><span class="scene-tab"><b></b>Apply · Fieldwork Studio</span></div>
        <div class="scene-toolbar"><span class="scene-arrows">‹ ›</span><span class="scene-url"><span class="scene-url-text" data-value="${apply.url}">${apply.url}</span></span></div>
        <div class="scene-page">
          <p class="scene-brand">Fieldwork Studio</p>
          <p class="scene-heading">Operations coordinator</p>
          <p class="scene-meta">Portland, Oregon · Full time</p>
          <div class="scene-form">
            ${field("name", "Full name", "Avery Stone")}
            <div class="scene-row">${field("email", "Email", "avery@sample.example.test")}${field("location", "Location", "Portland, Oregon")}</div>
            <div class="scene-field scene-field-resume" data-field="resume" data-upload="attached"><span class="scene-label">Résumé</span><span class="scene-input scene-upload"><span class="scene-upload-empty">Upload a file</span><span class="scene-upload-file">resume-tailored.pdf</span><span class="scene-upload-bar"></span></span></div>
            ${field("letter", "Cover letter", apply.letter, " scene-letter")}
            <div class="scene-field scene-field-portfolio"><span class="scene-label">Portfolio link (optional)</span><span class="scene-input"></span></div>
            <div class="scene-submit" data-field="submit"><span class="scene-button">Submit application</span><span class="scene-held">Not submitted · waiting for you</span></div>
          </div>
        </div>
      </div>
      <div class="scene-window scene-steps" data-window="steps">
        <p class="scene-steps-head"><span class="landing-dot"></span>Job search — next step</p>
        <div class="scene-chat">
          <p class="scene-ask"><span class="landing-request-measure">${apply.request}</span><span class="landing-request-type">${apply.request}</span></p>
          <ol class="scene-step-list">
            ${steps.map(stepItem).join("")}
          </ol>
        </div>
      </div>
      <div class="scene-window scene-calendar" data-window="calendar">
        <div class="scene-cal-bar"><span class="scene-lights"><i></i><i></i><i></i></span><b>October 2026</b></div>
        <div class="scene-cal-grid">
          ${[["Mon", 12, "9:00 Studio shift"], ["Tue", 13], ["Wed", 14], ["Thu", 15, "9:00 Studio shift"], ["Fri", 16]].map(([day, date, busy]) => `<div class="scene-cal-day${date === 14 ? " is-target" : ""}"><span class="scene-cal-date">${day} <b>${date}</b></span>${busy ? `<i class="scene-cal-busy">${busy}</i>` : ""}${date === 14 ? '<i class="scene-cal-event"><b>10:00</b> Interview · Fieldwork Studio</i>' : ""}</div>`).join("")}
        </div>
      </div>
      <div class="scene-notice" data-window="mail"><span class="scene-notice-icon"></span><span class="scene-notice-text"><b>${apply.invite.from}</b><span>${apply.invite.subject}</span><span>${apply.invite.preview}</span></span><span class="scene-notice-app">Mail · now</span></div>
    </div>
  </div>
</div>`;

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

// A steady scatter, the same on every visit: 0 ≤ value < 1.
const scatter = (seed) => { const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453; return value - Math.floor(value); };
const fileKind = (name) => name.slice(name.lastIndexOf(".") + 1);

// The folder as the Worker found it, laid over the finished screen: the same
// window captured before the request when that capture exists. Otherwise the
// starting files are drawn, scattered, or as two pages for two documents,
// and the arriving work files them away to the left, toward the sidebar.
function beforeFiles(item) {
  if (!item.before) return "";
  if (item.beforeShot) {
    const src = (width) => `/screens/work-${item.screen}-before-${width}.webp`;
    return `<div class="landing-before landing-before-shot" aria-hidden="true"><img src="${src(1440)}" srcset="${src(1440)} 1440w, ${src(2880)} 2880w" sizes="${sizes}" width="1440" height="862" alt="" decoding="async" /></div>`;
  }
  const files = item.before;
  const pages = files.length <= 2;
  const cols = files.length > 16 ? 7 : 5;
  const rows = Math.ceil(files.length / cols);
  const order = files.map((name, index) => ({ name, key: scatter(index + item.id.length * 31) })).sort((a, b) => a.key - b.key);
  const placed = order.map(({ name }, slot) => {
    const seed = slot * 7 + item.id.length;
    // Loose files stay inside the frame: a 5% margin on each side.
    const x = pages ? 36 + slot * 28 : 5 + ((slot % cols) + 0.5 + (scatter(seed + 1) - 0.5) * 0.4) * (90 / cols);
    const y = pages ? 54 : 15 + (Math.floor(slot / cols) + 0.5 + (scatter(seed + 2) - 0.5) * 0.45) * (80 / rows);
    const turn = pages ? (slot ? 4 : -5) : (scatter(seed + 3) - 0.5) * 14;
    const position = `${x.toFixed(1)},${y.toFixed(1)},${turn.toFixed(1)},${(x / 100).toFixed(2)}`;
    const kind = fileKind(name);
    const receipt = /^receipt-/.test(name) ? " landing-file-receipt" : "";
    return `<li class="landing-file landing-file-${kind}${receipt}" data-file-position="${position}"><span class="landing-file-icon" data-ext="${kind.toUpperCase()}"><i></i></span><span class="landing-file-name">${name}</span></li>`;
  });
  return `<div class="landing-before${pages ? " landing-before-pages" : ""}" data-file-cell="${(90 / cols).toFixed(2)}" aria-hidden="true">
    <ul>${placed.join("")}</ul>
  </div>`;
}

// New rows in the finished screen are outlined once the work has landed.
const addedMarks = (item) => (item.added ?? []).map(([x, y, width, height]) =>
  `<span class="landing-added" data-added-rect="${x},${y},${width},${height}" aria-hidden="true"></span>`).join("");
// Before the request: which moment the screen below shows.
const check = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>`;
const status = `<p class="landing-status" aria-hidden="true"><span class="landing-status-before">Before</span><span class="landing-status-after">${check}After</span></p>`;

function folder(item, index, { eager = false } = {}) {
  const srcset = item.retina ? ` srcset="${screenSrc(item, 1440)} 1440w, ${screenSrc(item, 2880)} 2880w" sizes="${sizes}"` : "";
  return `<article class="landing-folder landing-folder-${item.id}" id="folder-${item.id}" data-index="${index}" aria-labelledby="folder-${item.id}-title">
    <div class="landing-folder-inner">
      <h3 class="landing-tab" id="folder-${item.id}-title"><span class="landing-dot" aria-hidden="true"></span>${item.tab}</h3>
      <div class="landing-folder-body">
        <div class="landing-folder-bar">
          ${item.before ? status : ""}
          <div class="landing-caption">${item.request ? `<p class="landing-request"><span class="landing-request-measure" aria-hidden="true">“${item.request}”</span><span class="landing-request-type" aria-hidden="true">“${item.request}”</span><span class="landing-sr">Request: ${item.request}</span></p>` : ""}<p class="landing-result">${item.text}</p>${item.before ? '<p class="landing-working" aria-hidden="true">Working…</p>' : ""}</div>
          <button class="landing-zoom-button" type="button" data-zoom="${item.id}" aria-label="View the ${item.tab.toLowerCase()} screen full size">${expandIcon}</button>
        </div>
        <div class="landing-shot">
          <div class="landing-shot-media">
            <img src="${screenSrc(item, 1440)}"${srcset} width="1440" height="862" alt="${item.alt}" decoding="async" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} data-zoom="${item.id}" />
            ${beforeFiles(item)}
            ${item.before ? addedMarks(item) : ""}
            ${item.id === "tracker" ? '<span class="landing-ring" aria-hidden="true"></span>' : ""}
          </div>
        </div>
      </div>
    </div>
  </article>`;
}

const downloads = `<div class="landing-download-group" role="group" aria-label="Download work-fold">
  <p class="landing-download-label">Download</p>
  <div class="landing-downloads">
    <a class="landing-download" href="${macDownload}" aria-label="Download for Mac — Apple silicon">${icon("apple")}<span>Mac<small>Apple silicon</small></span></a>
    <a class="landing-download landing-download-preview" href="${windowsDownload}" aria-label="Windows test preview — release notes and download">${icon("windows")}<span>Windows<small>Test preview</small></span></a>
    <a class="landing-download landing-download-preview" href="${linuxDownload}" aria-label="Linux test preview — release notes and downloads">${icon("linux")}<span>Linux<small>Test preview</small></span></a>
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
            <h1 id="landing-title"><span>Put your</span> <span>folders</span> <span>to work.</span></h1>
            <p class="landing-lede">work-fold is a desktop app that gives any folder its own AI Worker. Ask for what you need, and it reads your files, uses Chrome and your apps, and saves the work right there.</p>
            ${downloads}
          </div>
        </div>
        <h2 class="landing-sr">Real Worker runs with sample files</h2>
        ${folders.map((item, index) => folder(item, index, { eager: index === 0 })).join("")}
      </section>

      <section class="landing-chapter landing-hands" aria-labelledby="hands-title">
        <div class="landing-chapter-head">
          <h2 id="hands-title">Your own Chrome.<br />Your own apps.</h2>
          <p>A Worker can fill in forms in your Chrome and use the apps on your Mac. This illustrated workflow shows it filling in a job application, leaving Submit to you, then adding an interview invitation to your calendar when you ask.</p>
          <a class="landing-text-link" href="${chromeExtension}">${icon("chrome")}<span>Add work-fold to Chrome</span></a>
        </div>
        ${scene}
      </section>

      <section class="landing-chapter landing-app" aria-labelledby="app-title">
        <div class="landing-chapter-head">
          <h2 id="app-title">Need an app?<br />Ask for one.</h2>
          <p>A Worker built this job-application tracker. It runs inside work-fold, right in the sidebar.</p>
        </div>
        ${folder(tracker, folders.length)}
      </section>

      <section class="landing-chapter landing-web" aria-labelledby="web-title">
        <div class="landing-web-copy">
          <h2 id="web-title">Let your computer keep working.<br />Take it with you.</h2>
          <p>Message the work-fold agent from your phone or any browser. It can reach every work-folder you’ve set up and hand work to the Workers in them, as long as your computer stays on and online.</p>
          <p class="landing-alpha">Web access is in private alpha.</p>
          ${route}
        </div>
        ${devices}
      </section>

      <section class="landing-end" id="download" aria-labelledby="end-title" tabindex="-1">
        <h2 class="landing-sr" id="end-title">Download work-fold</h2>
        ${downloads}
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
  // The bridge forbids inline style attributes in HTML. Set individual CSSOM
  // properties from our numeric geometry, as the scroll player does below.
  for (const layer of shell.querySelectorAll("[data-file-cell]")) layer.style.setProperty("--cell", `${layer.dataset.fileCell}cqw`);
  for (const file of shell.querySelectorAll("[data-file-position]")) {
    const [x, y, turn, order] = file.dataset.filePosition.split(",");
    for (const [name, value] of [["--x", `${x}%`], ["--y", `${y}%`], ["--r", `${turn}deg`], ["--i", order]]) file.style.setProperty(name, value);
  }
  for (const mark of shell.querySelectorAll("[data-added-rect]")) {
    const [x, y, width, height] = mark.dataset.addedRect.split(",").map(Number);
    for (const [name, value, scale] of [["left", x, 14.4], ["top", y, 8.62], ["width", width, 14.4], ["height", height, 8.62]]) mark.style.setProperty(name, `${(value / scale).toFixed(2)}%`);
  }
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reducedMotion) shell.classList.add("motion-ok");

  const dialog = app.querySelector(".landing-zoom");
  const zoomImage = dialog.querySelector("img");
  const scroller = dialog.querySelector(".landing-zoom-scroll");
  const items = Object.fromEntries([...folders, tracker].map((item) => [item.id, item]));
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
  const requests = stack.map((item) => {
    const type = item.querySelector(".landing-request-type");
    return { item, type, text: type?.textContent ?? "", startedAt: null };
  });
  const app = shell.querySelector(".landing-app .landing-shot-media");
  const appFrame = app?.closest(".landing-shot");
  const devices = shell.querySelector(".landing-devices");
  const webSection = devices?.closest(".landing-web");
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
  let captionStop = 0;
  const clock = () => win.performance.now();
  const loadedAt = clock();
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
  // Each request plays on its own clock, not the scroll position, so it reads
  // at the same pace however the page is scrolled: the request is typed, the
  // Worker works, then the result lands and stays. The caption keeps its full
  // measured height throughout; the accessible request is always whole.
  const typeTime = (text) => Math.min(1600, Math.max(800, text.length * 30));
  const workTime = 900;
  function playback({ item, type, text, startedAt }, time) {
    const elapsed = startedAt === null ? -1 : time - startedAt;
    const typing = typeTime(text);
    const stage = startedAt === null ? "ahead" : elapsed < typing ? "asking" : elapsed < typing + workTime ? "working" : "done";
    const visible = text.slice(0, startedAt === null ? 0 : Math.round(text.length * clamp(elapsed / typing)));
    if (type && type.textContent !== visible) type.textContent = visible;
    if (item.dataset.workStage !== stage) item.dataset.workStage = stage;
    return stage === "asking" || stage === "working";
  }
  // The application scene: one timeline from the typed request through every
  // step to the reply. Each moment is a pure function of the elapsed time, so
  // it can rewind, replay, or be read at any frame.
  function scenePlayer(root) {
    const stage = root.querySelector(".scene-stage");
    const type = root.querySelector(".landing-request-type");
    const text = type.textContent;
    const items = [...root.querySelectorAll(".scene-step-list li")];
    const mailAt = steps.findIndex(([tool]) => tool === "mail");
    const eventAt = steps.findIndex(([, , , effect]) => effect?.event);
    const fields = Object.fromEntries([...root.querySelectorAll("[data-field]")].map((node) => [node.dataset.field, node]));
    const values = Object.fromEntries(Object.entries(fields).map(([name, node]) => [name, node.querySelector(".scene-value")]).filter(([, node]) => node));
    const url = root.querySelector(".scene-url-text");
    const typing = Math.min(1100, typeTime(text));
    const starts = [];
    let end = typing;
    for (const step of steps) { starts.push(end); end += step[2]; }
    const set = (node, key, value) => { if (node.dataset[key] !== value) node.dataset[key] = value; };
    const write = (node, value) => { if (node.textContent !== value) node.textContent = value; };
    const player = { root, startedAt: null, render(time) {
      const started = player.startedAt !== null;
      const elapsed = started ? time - player.startedAt : -1;
      const moment = !started ? "ahead" : elapsed < typing ? "asking" : elapsed < end + 300 ? "working" : "done";
      set(root, "workStage", moment);
      write(type, text.slice(0, started ? Math.round(text.length * clamp(elapsed / typing)) : 0));
      const progress = (index) => clamp((elapsed - starts[index]) / steps[index][2]);
      let current = -1;
      steps.forEach((step, index) => {
        const state = elapsed < starts[index] ? "ahead" : elapsed < starts[index] + step[2] ? "active" : "done";
        set(items[index], "state", state);
        if (state === "active") current = index;
      });
      // What each step shows on screen, rebuilt from the start every frame.
      let page = "blank", held = "no", event = "no", upload = "ahead", focused = null;
      // The Mail banner shows from the new email until the interview is added.
      const mail = progress(mailAt) > 0 && elapsed < starts[eventAt] + steps[eventAt][2] + 700 ? "yes" : "no";
      steps.forEach(([, , , effect = {}], index) => {
        const done = progress(index);
        if (effect.navigate) {
          write(url, url.dataset.value.slice(0, Math.round(url.dataset.value.length * clamp(done / 0.6))));
          if (done >= 0.75) page = "loaded";
        }
        if (effect.value) write(values[effect.field], effect.value.slice(0, Math.round(effect.value.length * clamp(done / 0.85))));
        if (effect.upload) {
          upload = done <= 0 ? "ahead" : done < 0.85 ? "uploading" : "attached";
          fields.resume.style.setProperty("--upload", clamp(done / 0.85).toFixed(2));
        }
        if (effect.hold && done > 0.35) held = "yes";
        if (effect.event && done > 0.45) event = "yes";
        if (index === current && effect.field) focused = effect.field;
      });
      set(stage, "page", page);
      set(stage, "held", held);
      set(stage, "event", event);
      set(stage, "mail", mail);
      set(fields.resume, "upload", upload);
      for (const [name, node] of Object.entries(fields)) {
        if (name === focused) set(node, "focus", "");
        else if (node.dataset.focus !== undefined) delete node.dataset.focus;
      }
      set(stage, "focus", current >= 0 ? steps[current][3]?.window ?? "steps" : moment === "done" ? "all" : "steps");
      return moment === "asking" || moment === "working";
    } };
    return player;
  }
  const sceneRoot = shell.querySelector(".landing-scene");
  const scene = sceneRoot ? scenePlayer(sceneRoot) : null;
  // Playback frames touch only text and data attributes: no layout reads.
  let ticking = 0;
  function tick() {
    ticking = 0;
    const time = clock();
    if ([...requests.map((entry) => playback(entry, time)), scene?.render(time)].some(Boolean)) play();
  }
  function play() { if (!ticking) ticking = nextFrame(tick); }
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
      captionStop = stacking.matches ? geometry.stickTop : mobileStack
        ? parseFloat(win.getComputedStyle(stack[0]).top) || 0 : height * 0.22;
    }
    const stackActive = stacking.matches || mobileStack;
    // Read untransformed frames first. The inbox's own scaled bounds would
    // feed its last transform back into the next frame and make it oscillate.
    const boxes = stack.map((item) => item.getBoundingClientRect());
    const appBox = appFrame?.getBoundingClientRect();
    const devicesBox = devices?.getBoundingClientRect();
    const sceneBox = scene?.root.getBoundingClientRect();
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
    const time = clock();
    requests.forEach((entry, index) => {
      // A request starts when its folder has risen about halfway into place;
      // on a wide screen the hero folder starts on its own just after load.
      // A folder that drops back below the screen resets, so it plays again.
      if (index === 0 && stacking.matches) entry.startedAt ??= loadedAt + 500;
      else {
        const arrival = clamp((height * 0.95 - boxes[index].top) / Math.max(1, height * 0.95 - captionStop));
        if (arrival <= 0) entry.startedAt = null;
        else if (arrival >= 0.45) entry.startedAt ??= time;
      }
    });
    if (scene) {
      // The application scene scrolls with the page, so it starts as soon as
      // it is well into view and resets once it drops back below the screen.
      const arrival = clamp((height * 0.95 - sceneBox.top) / Math.max(1, height * 0.73));
      if (arrival <= 0) scene.startedAt = null;
      else if (arrival >= 0.25) scene.startedAt ??= time;
    }
    if ([...requests.map((entry) => playback(entry, time)), scene?.render(time)].some(Boolean)) play();
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
