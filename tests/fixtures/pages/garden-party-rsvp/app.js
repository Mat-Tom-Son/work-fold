// Garden Party RSVP. The form saves itself through work-fold's form helper
// (data-page-table="rsvps"); this script shows the live spot count and the
// visitor's own RSVP. It talks only to window.workFoldPage: a page has no
// network and cannot fetch its own files, so the spot count lives here too.
const page = window.workFoldPage;
const TABLE = "rsvps";
const SPOTS = 50; // the table's "limit" in page.json

const form = document.getElementById("rsvp-form");
const rsvpSection = document.getElementById("rsvp");
const full = document.getElementById("full");
const taken = document.getElementById("taken");
const meterFill = document.getElementById("meter-fill");
const yours = document.getElementById("yours");
const yourList = document.getElementById("your-rsvps");
const statusLine = document.getElementById("status");
const another = document.getElementById("another");
const ownerNote = document.getElementById("owner-note");

let state = { count: 0, mine: [] };
let wantsAnother = false;
let generation = 0;

async function refresh() {
  const current = ++generation;
  try {
    const [count, mine] = await Promise.all([page.count(TABLE), page.mine(TABLE)]);
    if (current !== generation) return; // a newer refresh already ran
    state = { count, mine };
    render();
  } catch (error) {
    if (current !== generation) return;
    taken.textContent = "?";
    note(messageFor(error), true);
  }
}

function render() {
  const { count, mine } = state;
  const shown = Math.min(count, SPOTS);
  const isFull = count >= SPOTS;
  taken.textContent = String(shown);
  meterFill.style.width = `${(shown / SPOTS) * 100}%`;

  yourList.replaceChildren(...mine.map(rsvpItem));
  yours.hidden = mine.length === 0;
  another.hidden = isFull || wantsAnother;

  rsvpSection.hidden = mine.length > 0 && !wantsAnother;
  form.hidden = isFull;
  full.hidden = !isFull;
}

function rsvpItem(row) {
  const item = document.createElement("li");
  const who = document.createElement("span");
  who.textContent = row.bringing ? `${row.name}, bringing ${row.bringing.toLowerCase()}` : row.name;
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "quiet";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => cancelRsvp(row, cancel));
  item.append(who, cancel);
  return item;
}

// Dialogs such as confirm() are unavailable in a page, so cancelling takes a
// second click on the same button.
async function cancelRsvp(row, button) {
  if (button.dataset.confirm !== "yes") {
    button.dataset.confirm = "yes";
    button.textContent = "Yes, cancel it";
    return;
  }
  button.disabled = true;
  try {
    await page.remove(TABLE, row.id);
    note(`${row.name}'s RSVP is cancelled.`);
  } catch (error) {
    note(messageFor(error), true);
    button.disabled = false;
  }
  await refresh();
}

function note(text, isError = false) {
  statusLine.textContent = text;
  statusLine.classList.toggle("error", isError);
}

function messageFor(error) {
  return error && typeof error.message === "string" ? error.message : "Something went wrong. Please try again.";
}

form.addEventListener("page:sent", () => {
  wantsAnother = false;
  note("Thank you, you're on the list!");
  refresh();
});

form.addEventListener("page:error", (event) => {
  // The form helper already shows the message; a full table also hides the form.
  if (event.detail && event.detail.code === "LIMIT_REACHED") refresh();
});

another.addEventListener("click", () => {
  wantsAnother = true;
  note("");
  render();
  form.querySelector("input[name=name]").focus();
});

page.isOwner().then((owner) => { ownerNote.hidden = !owner; }, () => {});
page.onChange(() => refresh());
refresh();
