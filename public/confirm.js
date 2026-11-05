/**
 * Two-step delete. The first press arms the button: it turns into a red "Delete" confirm in place.
 * Only a second press on the armed button runs `onConfirm`. A press anywhere else, a scroll, Escape,
 * losing focus or `ms` of waiting puts it back. A second press within `guardMs` of arming is ignored,
 * so a fast accidental double tap can't delete. Enter and Space work through the button's own click.
 */
export function armDelete(button, { label, idleHTML, onConfirm, ms = 3000, guardMs = 350, doc = document, win = window, clock = () => Date.now() }) {
  let armedAt = 0, timer;
  const idleLabel = `Delete ${label}`, armedLabel = `Confirm delete ${label}`;
  const outside = (e) => { if (!button.contains(e.target)) disarm(); };
  const onKey = (e) => { if (e.key === "Escape") disarm(); };
  const disarm = () => {
    if (!armedAt) return;
    armedAt = 0;
    clearTimeout(timer);
    doc.removeEventListener("pointerdown", outside, true);
    doc.removeEventListener("keydown", onKey, true);
    win.removeEventListener("scroll", disarm, true);
    delete button.dataset.confirm;
    button.innerHTML = idleHTML;
    button.setAttribute("aria-label", idleLabel);
    button.title = idleLabel;
  };
  const arm = () => {
    armedAt = clock();
    button.dataset.confirm = "1";
    button.textContent = "Delete";
    button.setAttribute("aria-label", armedLabel);
    button.title = armedLabel;
    timer = setTimeout(disarm, ms);
    doc.addEventListener("pointerdown", outside, true);
    doc.addEventListener("keydown", onKey, true);
    win.addEventListener("scroll", disarm, true);
  };
  button.addEventListener("click", () => {
    if (!armedAt) return arm();
    if (clock() - armedAt < guardMs) return;
    disarm();
    onConfirm();
  });
  button.addEventListener("blur", disarm);
  return { disarm, armed: () => armedAt > 0 };
}
/* asset-rev 2 */
