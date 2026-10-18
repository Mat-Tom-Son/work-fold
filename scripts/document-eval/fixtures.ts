/**
 * Seeded document tasks for the document-checking evaluation (2026-10-18).
 *
 * Each task seeds ordinary input files into a disposable work-folder and asks
 * for one deliverable. What a correct result looks like lives only in
 * check.ts, outside the work-folder and the Worker's context.
 */

export interface DocumentTask {
  id: "budget" | "deck" | "report";
  deliverable: string;
  files: Record<string, string>;
  prompt: string;
}

export const transactions: Array<[string, string, string, number]> = [
  ["2026-10-01", "October rent", "Rent", 1850.00],
  ["2026-10-02", "Trader Joe's", "Groceries", 86.42],
  ["2026-10-03", "Metro card reload", "Transport", 40.00],
  ["2026-10-04", "Pizza night", "Dining Out", 38.75],
  ["2026-10-05", "Electric bill", "Utilities", 72.18],
  ["2026-10-06", "Whole Foods", "Groceries", 124.09],
  ["2026-10-08", "Movie tickets", "Entertainment", 31.00],
  ["2026-10-09", "Gas station", "Transport", 48.60],
  ["2026-10-10", "Internet", "Utilities", 65.00],
  ["2026-10-11", "Farmers market", "Groceries", 42.50],
  ["2026-10-12", "Brunch", "Dining Out", 56.20],
  ["2026-10-14", "Concert", "Entertainment", 89.00],
  ["2026-10-15", "Water bill", "Utilities", 38.44],
  ["2026-10-16", "Costco", "Groceries", 213.77],
  ["2026-10-18", "Rideshare", "Transport", 23.15],
  ["2026-10-19", "Thai takeout", "Dining Out", 41.30],
  ["2026-10-21", "Streaming service", "Entertainment", 15.99],
  ["2026-10-22", "Grocery refund", "Groceries", -18.25],
  ["2026-10-24", "Coffee shop", "Dining Out", 12.40],
  ["2026-10-25", "Parking", "Transport", 18.00],
  ["2026-10-27", "Corner store", "Groceries", 27.63],
  ["2026-10-28", "Phone bill", "Utilities", 55.00],
  ["2026-10-30", "Dinner with friends", "Dining Out", 94.85],
  ["2026-10-31", "Train tickets", "Transport", 62.40],
];

export const budgetTargets: Record<string, number> = { Rent: 1850, Groceries: 450, Transport: 200, "Dining Out": 200, Utilities: 250, Entertainment: 120 };

export const findings = [
  "First-response time improved from 9.2 hours to 4.1 hours after the September staffing change, but weekend tickets still wait an average of 13 hours because only one agent covers Saturday and Sunday shifts, and weekend customers rate their experience nine points lower than weekday customers.",
  "Ticket volume grew 28 percent quarter over quarter, driven mostly by billing questions after the new invoice layout launched in July; billing now accounts for 41 percent of all incoming tickets, up from 26 percent in the second quarter, while every other category stayed roughly flat.",
  "Customer satisfaction held steady at 86 percent overall, yet satisfaction on billing tickets dropped to 71 percent, and the most common complaint in surveys was having to explain the same issue twice when a ticket moved between the chat, email and phone teams.",
  "Only 23 percent of customers used the help center before contacting support, and search logs show that the top ten failed searches all relate to invoices, refunds, or changing a payment method, which are exactly the topics where our articles are oldest and least complete.",
  "Escalations to engineering fell from 312 to 198 after the triage checklist was introduced, and the median time to resolve an escalated ticket dropped from six days to just under four days, although escalations involving the payments provider still take more than a week.",
  "Chat now handles 37 percent of conversations, up from 22 percent, and chat tickets are resolved in a single contact 64 percent of the time compared with 48 percent for email, but chat queues back up sharply between 11 a.m. and 2 p.m. on weekdays.",
  "Agent turnover reached 18 percent this quarter; exit interviews point to repetitive billing work and unclear paths for promotion, and two of the five departures were among our most experienced agents, which left the billing queue without a senior reviewer for most of September.",
  "The pilot of suggested replies saved agents an estimated 6 minutes per ticket on routine questions, but agents rejected the suggestion 30 percent of the time, mostly on account-specific billing questions where the suggested text quoted the wrong plan, price, or renewal date.",
];

export const workstreams: Array<[string, string, string, string, string, string, string, string, string]> = [
  ["Scheduling software", "Priya Raman", "On track", "72%", "Jul 7", "Nov 21", "$148,000", "$101,500", "Vendor configuration complete; integration testing with billing starts next week."],
  ["Patient portal", "Marcus Lee", "At risk", "45%", "Jul 14", "Dec 12", "$96,000", "$61,200", "Accessibility review found 14 issues; fixes need two extra sprints."],
  ["Data migration", "Elena Vasquez", "On track", "60%", "Aug 4", "Dec 5", "$54,000", "$29,800", "Second trial load matched 99.6% of records; remaining gaps are archived visits."],
  ["Staff training", "Dana Whitfield", "Not started", "0%", "Oct 27", "Jan 16", "$38,500", "$0", "Curriculum approved; waiting on a stable training environment."],
  ["Front-desk hardware", "Tomás Okafor", "Complete", "100%", "Jul 7", "Sep 26", "$61,000", "$58,940", "All 42 check-in kiosks installed and inventoried across the five clinics."],
  ["Reminder messages", "Aisha Karim", "On track", "80%", "Aug 18", "Nov 14", "$22,000", "$17,300", "Text and email templates approved by compliance; voice reminders deferred."],
  ["Insurance verification", "Ben Hollis", "Delayed", "35%", "Aug 11", "Nov 28", "$47,500", "$31,000", "Clearinghouse contract signed late; real-time checks slip about three weeks."],
  ["Clinic workflows", "Grace Nakamura", "On track", "55%", "Sep 1", "Dec 19", "$18,000", "$7,450", "Four of nine clinics have mapped their new check-in and rooming steps."],
  ["Reporting dashboards", "Ivan Petrov", "At risk", "25%", "Sep 15", "Jan 9", "$29,000", "$9,800", "Metric definitions still disputed between operations and finance teams."],
  ["Security review", "Hannah Brooks", "On track", "50%", "Sep 8", "Dec 5", "$35,000", "$16,100", "Penetration test booked for November; no critical findings so far."],
  ["Go-live support", "Luis Moreno", "Not started", "0%", "Jan 5", "Feb 13", "$42,000", "$0", "Floor-support rota drafted; needs sign-off from all five clinic managers."],
  ["Change management", "Olivia Chen", "On track", "40%", "Aug 25", "Feb 13", "$26,000", "$10,400", "Clinic champions named; monthly town halls continue through go-live."],
];

const csv = ["Date,Description,Category,Amount", ...transactions.map(([date, description, category, amount]) => `${date},${description},${category},${amount.toFixed(2)}`)].join("\n") + "\n";

const targets = `# October budget targets

Monthly budget for each spending category:

${Object.entries(budgetTargets).map(([category, amount]) => `- ${category}: $${amount.toLocaleString("en-US")}`).join("\n")}
`;

const notes = `# Customer Support Review — Q3 2026

Presenter: Support Operations, October 2026

## Agenda

- Where we stand after Q3
- Key findings
- Recommendations
- Next steps

## Key findings

${findings.map((finding, index) => `${index + 1}. ${finding}`).join("\n")}

## Recommendations

- Add a second weekend agent so Saturday and Sunday tickets are answered within six hours.
- Rewrite the invoice help articles and add a guided refund flow inside the billing page.
- Give billing specialists a career track with two senior levels and quarterly reviews.
- Retrain suggested replies on billing tickets before expanding the pilot to every queue.

## Next steps

- Hire the weekend agent — Support Operations, by November 30.
- Publish the new invoice articles — Content team, by December 12.
- Review the suggested-replies retraining results — Support Tools, by January 16.
`;

// The summary's "Ten of twelve" disagrees with the table (seven). It crept in by accident and is kept so
// reruns match the recorded results; a Worker flagging it is a bonus, not scored.
const status = `# Clinic Scheduling Rollout — status for the steering committee

Reporting period: October 2026. Program lead: Rachel Adeyemi.

## Summary

The rollout is 52% complete against a plan of 58%. Ten of twelve workstreams are on track or complete; the patient portal and reporting dashboards are at risk, and insurance verification is about three weeks late. Spending is $343,490 of a $617,000 budget. Go-live remains planned for January 5, 2027, with a decision checkpoint on December 1.

## Workstreams

| Workstream | Owner | Status | % complete | Start | Due | Budget | Spent | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${workstreams.map((row) => `| ${row.join(" | ")} |`).join("\n")}

## Risks

- Portal accessibility fixes could push the portal past go-live; a fallback is to launch without online booking.
- Late insurance verification may mean manual checks for the first two weeks after go-live.
- Disputed dashboard metrics could leave clinic managers without reliable reports in January.
- Training cannot start until the training environment is stable; a slip compresses the schedule.
`;

export const tasks: DocumentTask[] = [
  {
    id: "budget", deliverable: "budget.xlsx",
    files: { "transactions.csv": csv, "budget-targets.md": targets },
    prompt: `Make a budget workbook for October, budget.xlsx, from transactions.csv and the monthly targets in budget-targets.md.

- Sheet "Transactions": all the transactions.
- Sheet "By Category": one row per category with Budget, Actual (a SUMIF formula over the Transactions sheet), Difference (Budget minus Actual) and Status (a formula that shows "Over" when Actual is more than Budget, otherwise "OK"), plus a Total row.
- Sheet "Summary": Total budget, Total spent and Percent of budget used, as formulas that refer to the By Category sheet.

Show money as dollars and the percent as a percentage.`,
  },
  {
    id: "deck", deliverable: "findings.pptx",
    files: { "notes.md": notes },
    prompt: "Make a 16:9 slide deck, findings.pptx, from notes.md with exactly five slides: a title slide, the agenda, the key findings, the recommendations, and the next steps. The key findings slide must include all eight findings word for word.",
  },
  {
    id: "report", deliverable: "report.docx",
    files: { "status.md": status },
    prompt: "Write report.docx, a status report for the steering committee, from status.md. Include a title, a short summary, the full workstream table with every row and every column, and the risks. Use a portrait Letter page.",
  },
];
