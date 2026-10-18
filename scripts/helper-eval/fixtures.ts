#!/usr/bin/env tsx
/**
 * Seeded fixtures for the helper-tool evaluation (docs/development.md,
 * "Focused harness evaluation"). Each task is an ordinary folder of prose a
 * person might keep, with known facts planted among realistic filler and
 * near-miss distractors. Expected answers are written to a separate file that
 * is never copied into a work-folder, so they stay outside model context.
 *
 * Usage: tsx scripts/helper-eval/fixtures.ts <out-dir>
 *   <out-dir>/tasks/<task-id>/   folder to copy into a disposable work-folder
 *   <out-dir>/expected.json      answers and scoring keys (never shown to a model)
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

type Files = Map<string, string>;

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function picker(random: () => number) {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const some = <T>(items: readonly T[], count: number): T[] => {
    const pool = [...items];
    const out: T[] = [];
    while (out.length < count && pool.length) out.push(pool.splice(Math.floor(random() * pool.length), 1)[0]!);
    return out;
  };
  return { pick, some };
}

// ---------------------------------------------------------------------------
// T1 — decision trail: find which notes matter and which living docs are stale
// ---------------------------------------------------------------------------

function officeLaunch(): { files: Files; expected: unknown } {
  const random = rng(101);
  const { pick, some } = picker(random);
  const files: Files = new Map();
  const people = ["Marta Silva", "Dana Okafor", "Piotr Nowak", "Ines Costa", "Sam Reed", "Joana Pires", "Kasia Wrona", "Luis Moreira", "Priya Raman"];
  const hiring = [
    "LIS: two of the four team-lead offers were accepted; the remaining two candidates asked for more time.",
    "OPO: recruiter shortlist for the support pod is down to six; first interviews next week.",
    "WAW: engineering manager role re-posted after the first candidate withdrew.",
    "Relocation package draft circulated; finance wants the cap expressed per household, not per person.",
    "Interview loops are running long; Sam asked panels to submit scorecards within 24 hours.",
    "LIS: local payroll provider shortlisted (two options); Priya to compare onboarding fees.",
    "OPO: two internal transfers confirmed for the founding team.",
    "Referral bonus for the new sites approved at the standard rate.",
    "WAW: university partnership for junior hires is on hold until the spring term.",
  ];
  const facilities = [
    "OPO: landlord sent the revised floor plan; meeting rooms reduced from five to four.",
    "WAW: building management confirmed after-hours HVAC can be scheduled per floor.",
    "Furniture vendor quote came in 8% above budget; Ines negotiating delivery bundling.",
    "LIS: bike storage request submitted to the building association.",
    "All sites: badge system will use the same provider as the London office.",
    "WAW: signage proof approved with one correction to the reception sign.",
    "OPO: kitchen fit-out quote accepted.",
    "LIS: acoustic survey booked for the open-plan area.",
    "Cleaning contracts will be tendered together for all three sites.",
  ];
  const it = [
    "Laptops for the first cohort ordered; delivery estimate is four weeks.",
    "WAW: ISP install window confirmed, with a backup line from a second provider.",
    "Network rack design reviewed; same template as London with smaller UPS.",
    "LIS: meeting-room AV vendor shortlisted; demo scheduled.",
    "Device management enrollment works for the new legal entities after the admin fix.",
    "OPO: printer lease declined; the team will use the shared print service.",
    "VPN capacity reviewed; no change needed for the additional headcount.",
    "Wi-Fi survey templates sent to the building contacts.",
  ];
  const legal = [
    "Portuguese entity bank account opened; signatories confirmed.",
    "WAW: lease redlines returned with two open points on service charges.",
    "Employment contract templates translated; review by local counsel pending.",
    "Data processing addendum for the payroll providers in review.",
    "OPO: lease registration filed with the tax authority.",
    "Insurance broker asked for the final headcount per site.",
    "Works council information requirements summarised for Poland.",
  ];
  const marketing = [
    "Hiring campaign creative drafted for all three cities; legal check on salary-range wording.",
    "Launch blog post outline shared; will be scheduled once dates are final.",
    "Local PR agency proposals: two received, one pending.",
    "Employer-brand photo shoot planned in each city once the offices are furnished.",
    "LinkedIn careers page refresh scheduled with the new site photos.",
    "Customer event idea parked until after the first quarter of operations.",
  ];
  const actions = [
    "Ines: confirm furniture delivery bundling.",
    "Sam: chase outstanding interview scorecards.",
    "Priya: payroll provider comparison.",
    "Piotr: WAW lease service-charge points.",
    "Joana: PR agency follow-up.",
    "Kasia: works council summary to leadership.",
    "Luis: AV vendor demo notes.",
    "Dana: budget variance summary for the steering group.",
  ];

  const planted: Record<number, { section: "Facilities" | "Decisions"; text: string }[]> = {
    3: [{ section: "Decisions", text: "We'll use site codes in notes from now on: LIS (Lisbon), OPO (Porto), WAW (Warsaw)." }],
    5: [{ section: "Decisions", text: "Lisbon office opening set for 1 March 2027. Marta to confirm the handover schedule with the landlord." }],
    8: [{ section: "Decisions", text: "OPO opening moves to 15 February 2027 to line up with the support pod start dates." }],
    11: [
      { section: "Facilities", text: "LIS: the municipal fit-out permit is delayed by roughly six weeks." },
      { section: "Decisions", text: "Given the permit delay, LIS go-live moves to 12 April 2027 (agreed by Dana and Marta)." },
    ],
    14: [{ section: "Facilities", text: "Travel for the Lisbon conference in November is booked for six people; hotel is near the venue, not the new office." }],
    16: [{ section: "Decisions", text: "WAW opening confirmed for 8 March 2027; no change." }],
    19: [
      { section: "Facilities", text: "LIS: the electrical contractor slipped three weeks; keys handover now 2 May 2027." },
      { section: "Decisions", text: "LIS opening now 17 May 2027 (approved by Dana). Marta updates the staff comms." },
    ],
    22: [{ section: "Decisions", text: "Reminder: LIS opening 17 May. Invitations for the opening breakfast go out in March." }],
  };

  const discussion = [
    "The steering group asked for a single view of open risks across the three sites, sorted by impact on the opening dates.",
    "Most of the hour went on furniture: the vendor can deliver in two waves, but the second wave lands after the first hires start.",
    "Finance flagged that invoices are arriving in the wrong cost centre; Dana will send a reminder with the correct codes.",
    "There was a long debate about whether the founding teams should start remotely before the offices open; no conclusion yet.",
    "Piotr walked through the Warsaw lease redlines. The service-charge cap is the main open point and may need legal escalation.",
    "Joana presented the draft launch narrative. People liked the 'three cities, one company' angle but want fewer superlatives.",
    "Sam reported that interview loops are now averaging nine days from first call to offer, down from fourteen.",
    "The IT checklist has grown to 140 items; Luis proposed splitting it into must-have-for-day-one and can-wait.",
    "Ines raised the question of whether to run a single opening event or one per city. Leaning towards one per city.",
    "Kasia summarised the Polish works council requirements; the information letter must go out at least 30 days before hiring starts.",
    "Priya compared three payroll providers on onboarding fees, monthly cost per head, and support language coverage.",
    "The group agreed to keep budget tracking monthly but to add a weekly variance note when a line moves by more than 5%.",
    "Marta shared photos from the latest site walk; the open-plan area is framed and the meeting rooms are partly drywalled.",
    "There was a reminder that every site needs a first-aider and a fire warden named before opening.",
    "Dana asked everyone to update their workstream status in the tracker by Thursday so the steering pack can be built on Friday.",
    "Luis demoed the meeting-room booking panel; the team asked for the panels to show the next two bookings, not just the current one.",
    "Insurance needs final headcounts per site by the end of the month; numbers are still moving because of late offers.",
    "The group discussed relocation for internal transfers and agreed to apply the same package as external hires.",
    "Signage for all three sites will follow the same template, translated by the local teams.",
    "A question came up about parking. None of the sites will have dedicated parking; transit passes will be offered instead.",
    "Sam noted that two candidates declined offers because of the start date uncertainty; firmer dates would help hiring.",
    "Joana asked for a launch photo shoot window in each city once desks are installed.",
    "The team reviewed the access-card process; cards will be printed centrally and couriered to each site the week before opening.",
    "Kasia reminded everyone that the employee handbook needs a local appendix for each country.",
  ];
  for (let week = 1; week <= 30; week += 1) {
    const attendees = some(people, 5 + Math.floor(random() * 3));
    const extra = planted[week] ?? [];
    const section = (name: string, pool: readonly string[], count: number) => {
      const items = some(pool, count).map((item) => `- ${item}`);
      for (const item of extra.filter((entry) => entry.section === name)) items.splice(Math.floor(random() * (items.length + 1)), 0, `- ${item.text}`);
      return [`### ${name}`, "", ...items, ""];
    };
    const decisions = extra.filter((entry) => entry.section === "Decisions").map((entry) => `- ${entry.text}`);
    if (!decisions.length) decisions.push(pick(["- No decisions this week.", "- Budget tracking stays monthly.", "- Next steering review in two weeks."]));
    const body = [
      `# Atlas launch weekly — 2026 week ${String(week).padStart(2, "0")}`,
      "",
      `Attendees: ${attendees.join(", ")}`,
      `Notes: ${pick(attendees)}`,
      "",
      "## Updates",
      "",
      ...section("Hiring", hiring, 4),
      ...section("Facilities", facilities, 5),
      ...section("IT", it, 4),
      ...section("Legal", legal, 4),
      ...section("Marketing", marketing, 3),
      "## Discussion",
      "",
      some(discussion, 5).join(" "),
      "",
      some(discussion, 4).join(" "),
      "",
      "## Decisions",
      "",
      ...decisions,
      "",
      "## Action items",
      "",
      ...some(actions, 5).map((item) => `- [ ] ${item}`),
      "",
    ].join("\n");
    files.set(`meetings/2026-W${String(week).padStart(2, "0")}.md`, body);
  }

  const email = (from: string, subject: string, lines: string[]) =>
    [`From: ${from}`, `To: atlas-launch@example.com`, `Subject: ${subject}`, "", ...lines, "", "Best regards,", from.split(" <")[0], ""].join("\n");
  files.set("emails/landlord-lisbon-handover.txt", email("Rui Almeida <rui@example.pt>", "Handover schedule", [
    "Dear Marta,",
    "",
    "Following the contractor's update, we can confirm the keys handover for your floor on 2 May 2027.",
    "The building association has approved the bike storage request; installation will follow handover.",
    "Please send the names of the people who will collect the access cards.",
  ]));
  files.set("emails/porto-landlord.txt", email("Carla Mendes <carla@example.pt>", "Lease registration", [
    "Hello Ines,", "", "The lease registration was filed. The registered copy will follow by post.", "The kitchen fit-out team can start the week of 11 January.",
  ]));
  files.set("emails/warsaw-isp.txt", email("Support <support@example.pl>", "Installation window", [
    "Dear customer,", "", "Your installation is confirmed for the morning slot. A technician will call 30 minutes before arrival.",
  ]));
  files.set("emails/av-vendor.txt", email("Tomas Ferreira <tomas@example.com>", "Meeting-room AV demo", [
    "Hi Luis,", "", "Thanks for the call. As discussed, we can demo the room kit at your Lisbon site after fit-out, or at our showroom any weekday.",
  ]));
  files.set("emails/pr-agency.txt", email("Agency Team <hello@example.com>", "Proposal", [
    "Hi Joana,", "", "Attached is our proposal for the three-city launch. We suggest anchoring the Lisbon story on the opening breakfast once the date is final.",
  ]));

  files.set("README.md", [
    "# Atlas launch",
    "",
    "Shared folder for opening the Lisbon, Porto and Warsaw offices.",
    "",
    "- `meetings/` — weekly notes (one file per week)",
    "- `emails/` — saved correspondence with landlords and vendors",
    "- `launch-plan.md`, `faq-for-staff.md`, `team-calendar.md` — living documents; keep them current",
    "- `budget-summary.md` — monthly budget snapshot",
    "",
  ].join("\n"));
  files.set("launch-plan.md", [
    "# Atlas launch plan",
    "",
    "## Goals",
    "",
    "Open three new offices with a founding team in each, without disrupting existing customer support coverage.",
    "",
    "## Sites",
    "",
    "| Site | Opening | Founding team | Owner |",
    "|---|---|---|---|",
    "| Porto | 15 February 2027 | Support pod (8) | Ines Costa |",
    "| Warsaw | 8 March 2027 | Engineering (10) | Piotr Nowak |",
    "| Lisbon | 12 April 2027 | Sales and success (12) | Marta Silva |",
    "",
    "## Workstreams",
    "",
    "- Hiring: founding team offers by end of Q4 2026.",
    "- Facilities: fit-out, furniture, signage and access.",
    "- IT: devices, network, meeting rooms.",
    "- Legal: entities, leases, contracts.",
    "- Marketing: hiring campaign and launch communications.",
    "",
    "## Risks",
    "",
    "- Permit timelines in Lisbon.",
    "- Furniture lead times.",
    "",
  ].join("\n"));
  files.set("faq-for-staff.md", [
    "# Atlas launch — staff FAQ",
    "",
    "**Which offices are opening?** Lisbon, Porto and Warsaw.",
    "",
    "**When does Lisbon open?** The Lisbon office opens on 1 March 2027.",
    "",
    "**Can I transfer to a new site?** Yes — talk to your manager and the People team. Internal transfers are reviewed monthly.",
    "",
    "**Will there be a relocation package?** Yes, details will be shared by the People team.",
    "",
    "**Who do I ask about the launch?** Post in the atlas-launch channel.",
    "",
  ].join("\n"));
  files.set("team-calendar.md", [
    "# Team calendar — key dates",
    "",
    "- 11 January 2027 — Porto kitchen fit-out starts",
    "- 15 February 2027 — Porto opening",
    "- 8 March 2027 — Warsaw opening",
    "- 2 May 2027 — Lisbon keys handover",
    "- 17 May 2027 — Lisbon opening (breakfast at 09:00)",
    "- 30 June 2027 — Atlas retrospective",
    "",
  ].join("\n"));
  files.set("budget-summary.md", [
    "# Budget summary — November 2026",
    "",
    "| Line | Budget | Committed | Variance |",
    "|---|---|---|---|",
    "| Fit-out | €1.2m | €1.05m | +€150k |",
    "| Furniture | €310k | €335k | −€25k |",
    "| IT | €220k | €190k | +€30k |",
    "| Hiring | €160k | €98k | +€62k |",
    "",
    "Lisbon fit-out spend is tracking under budget after the permit delay pushed some invoices into Q1.",
    "",
  ].join("\n"));

  return {
    files,
    expected: {
      finalDate: "17 May 2027",
      changes: [
        { file: "meetings/2026-W05.md", date: "1 March 2027", note: "initial date" },
        { file: "meetings/2026-W11.md", date: "12 April 2027", note: "permit delay" },
        { file: "meetings/2026-W19.md", date: "17 May 2027", note: "electrical contractor slip" },
      ],
      staleLivingDocs: [
        { file: "launch-plan.md", shows: "12 April 2027" },
        { file: "faq-for-staff.md", shows: "1 March 2027" },
      ],
      currentLivingDocs: ["team-calendar.md"],
      distractors: [
        "meetings/2026-W14.md mentions Lisbon (conference travel), not the opening",
        "meetings/2026-W19.md keys handover 2 May 2027 is not the opening date",
        "meetings/2026-W08.md is Porto (OPO), meetings/2026-W16.md is Warsaw (WAW)",
        "meetings/2026-W22.md restates 17 May (not a change)",
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// T2 — reconcile current values across superseding documents
// ---------------------------------------------------------------------------

function travelPolicy(): { files: Files; expected: unknown } {
  const random = rng(202);
  const { some } = picker(random);
  const files: Files = new Map();
  const boiler = [
    "Managers are expected to apply this policy consistently and to raise exceptions with the People team before commitments are made.",
    "Where this policy is silent, use good judgement and choose the option a reasonable colleague would consider prudent.",
    "Receipts must be itemised. Card slips alone are not sufficient evidence of the expense.",
    "Claims older than 90 days may be rejected unless there are exceptional circumstances.",
    "Questions about this policy can be sent to the People team mailbox.",
    "This policy applies to employees and contractors engaged through the company's standard agreement.",
    "Exceptions approved in writing must be attached to the related claim.",
    "The company reserves the right to update this policy; the latest version is kept in this folder.",
    "Personal travel combined with business travel must be clearly separated in bookings and claims.",
    "Loyalty points earned on business travel may be kept by the traveller.",
    "Travellers are responsible for holding a valid passport and any visas required for their destination.",
    "The travel portal shows negotiated rates first; choosing a more expensive option requires a short justification.",
    "Cancellation fees caused by business changes are reimbursed; fees caused by personal changes are not.",
    "Duty of care: the company may contact travellers during emergencies using the details held in the travel portal.",
    "Upgrades paid for personally are allowed provided the company pays only the approved fare.",
    "Expenses must be submitted in the currency they were incurred in; the expense tool converts them at the monthly company rate.",
    "Team offsites are planned with the events team and have their own budget line.",
    "Tips are reimbursed up to customary local levels and must be shown on the receipt where possible.",
    "Laundry is reimbursable only for trips longer than five consecutive nights.",
    "Internet charges at hotels are reimbursed when needed for work.",
    "Travellers should avoid booking non-refundable fares unless the saving is significant and plans are firm.",
    "Visa and vaccination costs required for business travel are reimbursed.",
    "Expense claims are reviewed by the traveller's manager and audited by finance on a sample basis.",
    "Misuse of the travel and expenses policy may lead to disciplinary action.",
    "Accessibility needs should be noted in the travel profile so bookings can account for them.",
  ];
  const para = (count: number) => some(boiler, count).join(" ");

  files.set("travel-policy-2025.md", [
    "# Travel and expenses policy (2025)",
    "",
    "Effective 1 January 2025. This is the base policy; amendments and regional addenda are published separately in this folder.",
    "",
    "## 1. Booking",
    "",
    "Book all air and rail travel through the company travel portal at least 14 days in advance where possible. " + para(6),
    "",
    "## 2. Air travel",
    "",
    "Economy class for flights under six hours. Premium economy may be booked for flights of six hours or more. Business class requires VP approval. " + para(2),
    "",
    "## 3. Hotels",
    "",
    "The nightly hotel cap for standard US cities is $190 (before taxes). High-cost US cities (New York, San Francisco, Boston, Washington DC) have a cap of $310. International hotel caps are set by the regional addenda. " + para(2),
    "",
    "## 4. Meals",
    "",
    "The daily meal per diem is $65 for travel days. Client meals are reimbursed at cost with attendee names. Alcohol is not reimbursed except at approved client events. " + para(2),
    "",
    "## 5. Ground transport and mileage",
    "",
    "Use public transport or ride-hailing where practical. Personal car use is reimbursed at $0.67 per mile. " + para(2),
    "",
    "## 6. Approvals",
    "",
    "Trips over $2,500 in total estimated cost require director approval before booking. " + para(6),
    "",
    "## 7. Claims",
    "",
    para(7),
    "",
    "## 8. Duty of care",
    "",
    para(7),
    "",
  ].join("\n"));
  files.set("travel-policy-2026-amendments.md", [
    "# Travel policy — 2026 amendments",
    "",
    "Effective 1 February 2026. These amendments change the 2025 base policy as follows. Everything not listed here is unchanged.",
    "",
    "1. **Hotels (section 3):** the nightly cap for standard US cities increases from $190 to $220. The high-cost US city cap stays at $310.",
    "2. **Meals (section 4):** the daily meal per diem increases from $65 to $75.",
    "3. **Mileage (section 5):** the mileage rate becomes $0.70 per mile.",
    "4. **Regional addenda:** regional addenda continue to take precedence for the cities they list.",
    "",
    para(3),
    "",
  ].join("\n"));
  files.set("regional-addendum-emea-v1.md", [
    "# Regional addendum — EMEA (version 1, 2024)",
    "",
    "Superseded by version 2.",
    "",
    "| City | Nightly hotel cap |",
    "|---|---|",
    "| London | £230 |",
    "| Paris | €240 |",
    "| Amsterdam | €210 |",
    "",
    para(2),
    "",
  ].join("\n"));
  files.set("regional-addendum-emea-v2.md", [
    "# Regional addendum — EMEA (version 2)",
    "",
    "Effective 1 January 2026. Replaces version 1 in full.",
    "",
    "| City | Nightly hotel cap |",
    "|---|---|",
    "| London | £260 |",
    "| Paris | €250 |",
    "| Amsterdam | €220 |",
    "| Dublin | €210 |",
    "",
    "Meal per diem in EMEA follows the global travel policy, converted at the monthly company rate.",
    "",
    para(2),
    "",
  ].join("\n"));
  files.set("faq.md", [
    "# Travel FAQ",
    "",
    "_Last reviewed March 2026._",
    "",
    "**What's the hotel cap?** $190 a night for most US cities, $310 in the high-cost cities. Outside the US, check the regional addendum.",
    "",
    "**What's the meal per diem?** $75 per travel day.",
    "",
    "**Can I book business class?** Only with VP approval.",
    "",
    "**How do I claim mileage?** Use the mileage form in the expense tool.",
    "",
    "**Who approves trips?** Your manager; trips over $2,500 also need a director.",
    "",
  ].join("\n"));
  files.set("onboarding-handbook.md", [
    "# New starter handbook",
    "",
    "Welcome! This handbook covers the essentials for your first month.",
    "",
    "## Your first week",
    "",
    "You'll meet your onboarding buddy, set up your laptop and accounts, and attend the company introduction session. " + para(7),
    "",
    "## Your first month",
    "",
    para(8),
    "",
    "## How we work",
    "",
    para(8),
    "",
    "## Tools",
    "",
    "Most of our work happens in the shared drive, the chat tool and the project tracker. " + para(2),
    "",
    "## Time off",
    "",
    "You accrue paid time off from your first day. Book time off in the HR system and tell your team. " + para(2),
    "",
    "## Travel",
    "",
    "If your role involves travel, read the travel policy before your first trip. In short: book through the travel portal, keep itemised receipts, and claim within 90 days. The meal per diem is $65 per travel day. In London the hotel cap is £230 a night. " + para(2),
    "",
    "## Equipment",
    "",
    "You'll receive a laptop, a monitor and a headset. Additional equipment can be requested through the IT portal. " + para(2),
    "",
    "## Security",
    "",
    "Complete the security-awareness training in your first two weeks. " + para(2),
    "",
  ].join("\n"));
  files.set("expense-tool-help.md", [
    "# Expense tool help",
    "",
    "The expense tool checks hotel claims against the current caps automatically. For example, a London hotel claim above £260 a night is flagged for approval, and a standard US city claim above $220 is flagged too.",
    "",
    "Attach itemised receipts to each line. " + para(2),
    "",
  ].join("\n"));
  const noise: Array<[string, string, string]> = [
    ["pto-policy.md", "Paid time off policy", "Full-time employees receive 25 days of paid time off per year plus public holidays."],
    ["remote-work.md", "Remote work guidelines", "Teams agree core collaboration hours; home-office stipends are paid once per year."],
    ["equipment-policy.md", "Equipment policy", "Equipment remains company property and must be returned when you leave."],
    ["code-of-conduct.md", "Code of conduct", "We expect respectful, honest and inclusive behaviour from everyone."],
    ["benefits-overview.md", "Benefits overview", "Health, dental and vision coverage starts on your first day."],
    ["parental-leave.md", "Parental leave", "Birth and non-birth parents receive 20 weeks of paid leave."],
    ["learning-budget.md", "Learning budget", "Each employee has an annual learning budget. Conference travel follows the travel policy, including its meal per diem and hotel caps."],
    ["security-awareness.md", "Security awareness", "Report phishing attempts using the report button in your mail client."],
    ["holiday-calendar-2026.md", "Holiday calendar 2026", "Public holidays differ by country; your local calendar is in the HR system."],
    ["performance-reviews.md", "Performance reviews", "Reviews happen twice a year, with calibration across teams."],
    ["company-card.md", "Company card", "Company cards are for business expenses only; personal use must be repaid within 30 days."],
    ["relocation.md", "Relocation support", "Relocation support covers moving costs and up to 30 nights of temporary housing at the standard hotel caps."],
  ];
  for (const [name, title, lead] of noise) files.set(name, [`# ${title}`, "", lead, "", para(6), "", "## Details", "", para(7), "", para(6), "", "## Questions", "", para(6), ""].join("\n"));

  return {
    files,
    expected: {
      standardUsHotelCap: { value: "$220", source: "travel-policy-2026-amendments.md" },
      londonHotelCap: { value: "£260", source: "regional-addendum-emea-v2.md" },
      mealPerDiem: { value: "$75", source: "travel-policy-2026-amendments.md" },
      wrong: {
        required: [
          { file: "faq.md", states: "$190 standard US hotel cap" },
          { file: "onboarding-handbook.md", states: "$65 meal per diem and £230 London cap" },
        ],
        acceptable: ["travel-policy-2025.md (superseded base values)", "regional-addendum-emea-v1.md (superseded £230)"],
        falsePositives: ["expense-tool-help.md", "travel-policy-2026-amendments.md", "regional-addendum-emea-v2.md", "learning-budget.md", "relocation.md"],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// T3 — survey a folder before a rename
// ---------------------------------------------------------------------------

function renameSurvey(): { files: Files; expected: unknown } {
  const random = rng(303);
  const { some } = picker(random);
  const files: Files = new Map();
  const filler = [
    "Teams of every size use it to plan launches, track requests and keep stakeholders in the loop.",
    "Setup takes minutes, and you can import existing projects from a spreadsheet.",
    "Every plan includes unlimited viewers, so the whole company can follow along.",
    "Our support team answers within one business day, and enterprise customers get a named contact.",
    "Data is encrypted in transit and at rest, and you can export everything at any time.",
    "Integrations with the tools you already use keep updates flowing without copy and paste.",
    "Templates help new teams get started with a proven structure.",
    "Permissions let you decide who can edit, comment or only view.",
    "Automations take care of the repetitive steps, like assigning reviewers or moving items when a form is submitted.",
    "Views can be saved and shared, so each team sees the work the way it prefers.",
    "Comments, mentions and approvals keep decisions next to the work instead of buried in email.",
    "Admins can manage seats, billing and security settings from one place.",
    "Mobile apps for iOS and Android let you approve requests on the go.",
    "Guests can be invited to specific projects without seeing the rest of your account.",
    "The audit log records who changed what and when, which helps with compliance reviews.",
    "Recurring work can be scheduled so nothing slips through the cracks.",
    "Custom fields let you track whatever matters to your process, from budget codes to risk ratings.",
    "Dependencies show which work is blocked and who is waiting on whom.",
    "Notifications can be tuned per project, so people only hear about what they own.",
    "Our status page publishes uptime and incident history for full transparency.",
  ];
  const help = [
    ["docs/help/notifications.md", "Managing notifications"], ["docs/help/permissions.md", "Roles and permissions"],
    ["docs/help/custom-fields.md", "Custom fields"], ["docs/help/automations.md", "Automations"],
    ["docs/help/views.md", "Saved views"], ["docs/help/guests.md", "Inviting guests"],
    ["docs/help/billing.md", "Billing and invoices"], ["docs/help/sso.md", "Single sign-on"],
    ["docs/help/import.md", "Importing from spreadsheets"], ["docs/help/mobile.md", "Mobile apps"],
  ] as const;
  const para = (count: number) => some(filler, count).join(" ");
  const page = (title: string, parts: string[]) => [`# ${title}`, "", ...parts.flatMap((part) => [part, ""]), "## More", "", para(5), "", para(5), ""].join("\n");

  // Customer-facing pages that mention the product.
  files.set("pages/home.md", page("Plan launches without the chaos", [
    "Orbit brings your launch plans, requests and approvals into one shared view.", para(3),
    "Start a free Orbit trial today — no credit card required.",
  ]));
  files.set("pages/pricing.md", page("Pricing", [
    "Orbit Starter is free for up to five people. Orbit Team is $12 per person per month, billed annually.",
    para(2), "Need more? Orbit Enterprise adds SSO, audit logs and a named contact.",
  ]));
  files.set("pages/features-planning.md", page("Planning", [
    para(2), "With Orbit timelines you can see every dependency at a glance.", para(2),
  ]));
  files.set("pages/features-requests.md", page("Requests", [
    para(2), "Intake forms route requests to the right team automatically.", para(2),
    "Requests submitted in Orbit stay linked to the work they create.",
  ]));
  files.set("pages/features-reporting.md", page("Reporting", [
    para(3), "Dashboards update in real time as work moves.",
  ]));
  files.set("pages/customers/northwind.md", page("How Northwind ships every month", [
    "Northwind's product team moved from spreadsheets to Orbit in a week.", para(2),
    "\"Orbit gave us one place to see every launch,\" says their head of product.",
  ]));
  files.set("pages/customers/orbit-logistics.md", page("Customer story: Orbit Logistics", [
    "Orbit Logistics runs freight across 40 countries. Their operations team adopted our product last year to plan warehouse openings.", para(2),
    "\"We needed a single plan for every site,\" says Orbit Logistics' COO. Today every warehouse launch at Orbit Logistics starts from an Orbit template.",
  ]));
  files.set("pages/partners.md", page("Partners", [
    "We work with implementation partners around the world.", para(1),
    "Featured partner: Orbit Logistics (logistics and supply chain).", "Featured partner: Brightline Consulting (change management).",
  ]));
  files.set("docs/getting-started.md", page("Getting started", [
    "1. Create your Orbit workspace at app.example.com.", "2. Invite your team.", "3. Import a project or start from a template.", para(2),
  ]));
  files.set("docs/api.md", page("API", [
    "The Orbit API lets you create and update work items programmatically.",
    "Authenticate by setting the `ORBIT_API_KEY` environment variable or passing the key in the `Authorization` header.",
    "```\ncurl -H \"Authorization: Bearer $ORBIT_API_KEY\" https://api.example.com/v2/items\n```",
    para(2),
  ]));
  files.set("docs/integrations.md", page("Integrations", [
    para(2), "Connect Orbit to your chat tool to post updates automatically.", para(1),
  ]));
  files.set("legal/terms.md", page("Terms of service", [
    "These terms govern your use of Orbit and related services provided by Example Inc.", para(1),
    "Example Inc. may update Orbit features from time to time.",
  ]));
  files.set("blog/2026-03-release-notes.md", page("March release notes", [
    "This month Orbit gets faster timelines and a new request inbox.", para(2),
  ]));
  files.set("blog/2025-05-astronomy-day.md", page("Our team's astronomy day", [
    "For our offsite we visited the planetarium and learned how the moon's orbit shapes the tides.", para(1),
    "Thanks to everyone who joined!",
  ]));
  // Customer-facing pages with no product mention.
  files.set("pages/about.md", page("About us", [para(3), "We're a remote-first team across eight countries."]));
  files.set("pages/careers.md", page("Careers", [para(2), "See our open roles below."]));
  files.set("pages/security.md", page("Security", [para(3)]));
  for (const [path, title] of help) files.set(path, page(title, [para(5), para(5), para(4)]));
  files.set("docs/faq.md", page("FAQ", ["**Can I export my data?** Yes, at any time.", "**Do you offer discounts?** Yes, for nonprofits and education."]));
  // Internal-only notes.
  files.set("internal/naming-decision.md", page("Naming decision (internal)", [
    "We're renaming Orbit to Harbor because of a trademark conflict in the EU. Customer-facing copy changes first; the API key name stays ORBIT_API_KEY until v3.",
  ]));
  files.set("internal/roadmap-q1.md", page("Q1 roadmap (internal)", [
    "Orbit mobile beta, request inbox, faster timelines.", para(2),
  ]));
  files.set("internal/support-retro.md", page("Support retro (internal)", [
    "Most Orbit tickets this quarter were about SSO setup.", para(1),
  ]));
  files.set("README.md", [
    "# Website copy",
    "",
    "Source for the marketing site and help docs. `pages/`, `docs/`, `blog/` and `legal/` are published; `internal/` is never published.",
    "",
  ].join("\n"));

  return {
    files,
    expected: {
      needsChange: [
        "pages/home.md", "pages/pricing.md", "pages/features-planning.md", "pages/features-requests.md",
        "pages/customers/northwind.md", "pages/customers/orbit-logistics.md", "docs/getting-started.md",
        "docs/api.md", "docs/integrations.md", "legal/terms.md", "blog/2026-03-release-notes.md",
      ],
      mustNotChange: [
        { file: "pages/customers/orbit-logistics.md", what: "Orbit Logistics (customer company name)" },
        { file: "pages/partners.md", what: "Orbit Logistics (partner name)" },
        { file: "docs/api.md", what: "ORBIT_API_KEY (environment variable; changing it breaks customers)" },
        { file: "blog/2025-05-astronomy-day.md", what: "moon's orbit (astronomy, not the product)" },
      ],
      internalOnly: ["internal/naming-decision.md", "internal/roadmap-q1.md", "internal/support-retro.md"],
      noMention: ["pages/features-reporting.md", "pages/about.md", "pages/careers.md", "pages/security.md", "docs/faq.md", "docs/help/*.md (10 files)"],
      notes: "pages/customers/orbit-logistics.md needs change (product mention 'Orbit template') AND has must-not-change mentions; partners.md has only the company name, so it needs no product change.",
    },
  };
}

// ---------------------------------------------------------------------------
// T4 — find every report of one bug across many interview transcripts
// ---------------------------------------------------------------------------

function interviews(): { files: Files; expected: unknown } {
  const random = rng(404);
  const { pick, some } = picker(random);
  const files: Files = new Map();
  const interviewer = "Alex (research)";
  const generic = [
    ["How do you use the app day to day?", [
      "Mostly for weekly planning. I open it on Monday, look at what's due, and assign the week's work.",
      "We run our client onboarding in it. Every new client gets a project from a template.",
      "I use it to keep track of requests coming in from the sales team.",
      "Honestly, mostly the board view. My team lives in it.",
      "It's our source of truth for the content calendar.",
    ]],
    ["What's working well?", [
      "Templates. We cut setup time in half.",
      "The mobile app is good enough that I can approve things on the train.",
      "Comments and mentions — people actually reply now.",
      "Search is fast, which matters when you have thousands of items.",
      "The calendar view is the reason we picked you over the alternatives.",
    ]],
    ["What's frustrating?", [
      "Notifications are noisy. I've turned most of them off.",
      "Permissions are confusing for guests. We had a client see an internal comment once.",
      "Recurring tasks don't handle holidays well.",
      "The dashboard widgets don't remember my filters.",
      "Bulk editing is slow when we have more than a few hundred items.",
    ]],
    ["How did your team get started with the app?", [
      "A colleague brought it in from her previous job, and it spread team by team over about six months.",
      "We ran a proper evaluation against two competitors and picked it for the calendar and the templates.",
      "It started as a pilot in the marketing team; IT took over the rollout once three departments were using it.",
      "Our previous tool was discontinued, so we migrated everything over a long weekend.",
      "Our CEO saw a demo at a conference and asked us to try it.",
      "We imported about four hundred projects from spreadsheets, which mostly worked, although dates needed cleaning up.",
    ]],
    ["Which integrations do you rely on?", [
      "Chat notifications and the calendar sync. Everything else we do by hand.",
      "The email integration — clients email requests and they turn into tasks.",
      "We push time tracking into our billing system through the API.",
      "None really. We tried the drive integration but people kept attaching the wrong versions.",
      "The single sign-on setup and the chat bot. The bot is surprisingly popular.",
      "We connect it to our CRM so sales handoffs create onboarding projects automatically.",
    ]],
    ["How do you report on work to leadership?", [
      "Every Friday I build a status summary from the dashboard and paste it into an email.",
      "Leadership has their own dashboard with the portfolio view. They mostly look at overdue items.",
      "We export data monthly and build charts in a spreadsheet, because the built-in charts are limited.",
      "Honestly, in a meeting. People talk through the board on screen.",
      "We use the goals feature and review it quarterly.",
      "I send a screenshot of the timeline. It's not elegant but it works.",
    ]],
    ["How has support been when you needed help?", [
      "Fast. Usually an answer within a few hours.",
      "Mixed — the first answer is often a help-centre link, but the second reply is usually useful.",
      "We have a named contact on the enterprise plan, which makes a big difference.",
      "I haven't needed them much. The help centre covers most things.",
      "Once we had an outage and the status page was slow to update; the support team was good though.",
      "They helped us untangle our permissions after a reorganisation, which took a few calls.",
    ]],
    ["Anything you'd change first?", [
      "Better reporting for managers.",
      "Let me set default views per project.",
      "Make guest permissions simpler.",
      "A proper timeline for dependencies.",
      "Faster bulk edits.",
    ]],
  ] as const;
  const people = [
    ["Hannah", "Lumen Studio"], ["Marco", "Pellucid Health"], ["Aisha", "Granite Freight"], ["Tom", "Kestrel Labs"], ["Yuki", "Bramble & Co"],
    ["Sofia", "Northwind Retail"], ["Deepak", "Cobalt Insurance"], ["Laura", "Fieldstone Schools"], ["Kwame", "Tidewater Energy"], ["Elena", "Quarry Media"],
    ["Ben", "Saffron Foods"], ["Mei", "Helix Bio"], ["Oscar", "Juniper Legal"], ["Fatima", "Copperleaf Realty"], ["Ivan", "Ridgeline Outdoors"],
    ["Grace", "Meridian Travel"], ["Noah", "Atlas Robotics"], ["Leila", "Orchard Credit Union"], ["Pablo", "Beacon Logistics"], ["Zoe", "Vantage Analytics"],
    ["Ravi", "Silverpine Hotels"], ["Anna", "Foxglove Nonprofit"], ["Chris", "Summit Dental"], ["Nadia", "Harborview City"], ["Jonas", "Ember Games"],
    ["Clara", "Willow Architects"], ["Sam", "Driftwood Coffee"], ["Ade", "Prism Security"],
  ] as const;
  const reports: Record<number, string[]> = {
    2: ["Oh — one thing. When I export the board to CSV, the last row is always missing. We're on 4.2.1. I only noticed because the totals didn't match."],
    7: ["The spreadsheet export is short by one. Every time. The final task just isn't in the file. Version? The about box says 4.3.0."],
    11: ["Exports are truncated — the download is missing the final line. We updated to 4.2 two weeks ago, maybe that's when it started?"],
    16: ["My finance colleague complained that the exported report always drops the bottom entry. That's on 4.1.3, we haven't updated yet."],
    23: ["Small but annoying: export to Excel loses the last item in the list. We're running 4.3.0."],
  };
  const distractors: Record<number, string[]> = {
    4: ["PDF export looks off — the fonts get substituted and headings wrap weirdly. We're on 4.2.1."],
    9: ["Exporting works great for us, we send a CSV to the board every month. We're on 4.3.0."],
    13: ["When I import a CSV, the last row is skipped. I have to add a blank line at the end as a workaround. Version 4.2.1."],
    19: ["Our IT team is still on 4.0.8 because of the SSO migration. No complaints about exports though."],
  };
  people.forEach(([name, company], index) => {
    const turns: string[] = [];
    for (const [question, answers] of generic) {
      turns.push(`**${interviewer}:** ${question}`, "", `**${name}:** ${some(answers, 3).join(" ")}`, "");
      if (question.startsWith("What's frustrating") && (reports[index] || distractors[index])) {
        turns.push(`**${interviewer}:** Anything else that's bothered you recently?`, "", `**${name}:** ${(reports[index] ?? distractors[index])!.join(" ")}`, "");
      }
    }
    const month = String(1 + (index % 6)).padStart(2, "0");
    const day = String(3 + ((index * 5) % 25)).padStart(2, "0");
    const slug = `${name.toLowerCase()}-${company.toLowerCase().replace(/[^a-z]+/g, "-").replace(/-+$/, "")}`;
    files.set(`interviews/2026-${month}-${day}-${slug}.md`, [
      `# Interview — ${name}, ${company}`,
      "",
      `Date: 2026-${month}-${day} · Role: ${pick(["Operations lead", "Project manager", "Team lead", "Head of marketing", "Office manager", "Product owner"])} · Plan: ${pick(["Team", "Business", "Enterprise"])}`,
      "",
      ...turns,
      `**${interviewer}:** Thanks, that's really helpful.`,
      "",
    ].join("\n"));
  });
  files.set("README.md", "# Customer interviews\n\nTranscripts from the 2026 customer interview programme. One file per interview.\n");
  const fileFor = (index: number) => [...files.keys()][index]!;
  return {
    files,
    expected: {
      reporters: Object.keys(reports).map(Number).map((index) => ({
        name: people[index]![0], company: people[index]![1], version: /\d\.\d(?:\.\d)?/.exec(reports[index]![0]!)![0], file: fileFor(index),
      })),
      distractors: Object.keys(distractors).map(Number).map((index) => ({ name: people[index]![0], file: fileFor(index), why: distractors[index]![0] })),
    },
  };
}

const tasks = {
  "office-launch": {
    folder: "Atlas launch",
    build: officeLaunch,
    question: "When is the Lisbon office opening now? List each change to the opening date with the meeting note that records it, and tell me which of our living documents (anything outside meetings/ and emails/) still show an old Lisbon date.",
  },
  "travel-policy": {
    folder: "People policies",
    build: travelPolicy,
    question: "What are the current rules for (1) the nightly hotel cap in a standard US city, (2) the nightly hotel cap in London, and (3) the daily meal per diem? Cite the document that sets each. Then list every document in this folder that states one of those three values incorrectly, with the wrong value it gives.",
  },
  "rename-survey": {
    folder: "Website copy",
    build: renameSurvey,
    question: "We're renaming our product from Orbit to Harbor in customer-facing copy. Don't edit anything yet. Survey this folder and give me: (a) every customer-facing file that mentions the product and will need changes; (b) any mentions of \"Orbit\" in customer-facing files that must NOT change because they mean something else or would break customers; (c) files that mention Orbit but are internal-only.",
  },
  "export-bug": {
    folder: "Customer research",
    build: interviews,
    question: "Which interviewees reported the bug where exported files are missing the last row? For each, give their name, company, the app version they were on, and the transcript file.",
  },
} as const;

export type HelperEvalTaskId = keyof typeof tasks;
export const helperEvalTasks = tasks;

async function main(): Promise<void> {
  const out = process.argv[2];
  if (!out) throw new Error("Usage: tsx scripts/helper-eval/fixtures.ts <out-dir>");
  const root = resolve(out);
  await rm(join(root, "tasks"), { recursive: true, force: true });
  const expected: Record<string, unknown> = {};
  for (const [id, task] of Object.entries(tasks)) {
    const { files, expected: answer } = task.build();
    let bytes = 0;
    for (const [path, text] of files) {
      const target = join(root, "tasks", id, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, text);
      bytes += Buffer.byteLength(text);
    }
    expected[id] = { folder: task.folder, question: task.question, fileCount: files.size, bytes, answer };
    console.log(`${id}: ${files.size} files, ${bytes} bytes`);
  }
  await writeFile(join(root, "expected.json"), `${JSON.stringify(expected, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
