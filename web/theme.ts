import { renderUiIcon } from "./icons.ts";

// Shared by every public page; the classic bundle runs before CSS is painted.
const media = matchMedia("(prefers-color-scheme: dark)");
let preference = "system";
function readPreference() {
  try {
    const saved = localStorage.getItem("arahub.ui.theme");
    preference = saved && ["light", "dark", "system"].includes(saved) ? saved : "system";
  } catch { /* A blocked store must not prevent rendering. */ }
}
function applyTheme() {
  const dark = preference === "dark" || preference === "system" && media.matches;
  document.documentElement.dataset.colorMode = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    "content",
    dark ? "#111418" : "#f7f8fa",
  );
  const button = document.getElementById("theme");
  if (button) {
    const label = `Mudar tema: ${
      preference === "system" ? "sistema" : preference === "dark" ? "escuro" : "claro"
    }`;
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    button.innerHTML = renderUiIcon(`theme-${preference}`);
  }
}
readPreference();
applyTheme();
media.addEventListener("change", applyTheme);
window.addEventListener("storage", (event) => {
  if (event.key === "arahub.ui.theme" || event.key === null) {
    readPreference();
    applyTheme();
  }
});
window.addEventListener("pageshow", () => {
  readPreference();
  applyTheme();
});
document.addEventListener("DOMContentLoaded", () => {
  applyTheme();
  document.getElementById("theme")?.addEventListener("click", () => {
    preference = preference === "system" ? "light" : preference === "light" ? "dark" : "system";
    try {
      localStorage.setItem("arahub.ui.theme", preference);
    } catch { /* Session-only. */ }
    applyTheme();
  });
});
