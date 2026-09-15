/**
 * The persistent top navigation bar shared by every teacher-facing screen --
 * one script so Launch, Library, and Rooms cannot drift into three
 * different headers. Each page calls initTopNav() as soon as it knows its
 * console token, then setTopNavWho() once its own data has loaded (the bar
 * renders immediately either way, rather than waiting on that fetch).
 */
(() => {
  "use strict";

  const TABS = [
    { id: "launch", label: "Launch", href: "launch.html" },
    { id: "library", label: "Library", href: "library.html" },
    { id: "rooms", label: "Rooms", href: "rooms.html" },
  ];

  const STYLE = `
    .topnav {
      position: sticky; top: 0; z-index: 30; height: 52px; box-sizing: border-box;
      display: flex; align-items: center; gap: 2px;
      background: var(--card, #fff); border-bottom: 1px solid var(--line, #d5ded9);
      padding: 0 20px; font: 15px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    .topnav .brand {
      display: flex; align-items: center; gap: 8px; font-weight: 800; font-size: 15px;
      color: var(--ink, #18211f); text-decoration: none; white-space: nowrap;
      height: 100%; padding-right: 18px; margin-right: 8px;
    }
    .topnav .brand .dot { width: 9px; height: 9px; border-radius: 50%;
                           background: var(--accent, #0c6a5e); flex: none; }
    .topnav a.tab {
      display: flex; align-items: center; height: 100%; box-sizing: border-box;
      color: var(--muted, #66756f); text-decoration: none; font-weight: 600;
      padding: 0 14px; border-bottom: 3px solid transparent; white-space: nowrap;
    }
    .topnav a.tab:hover { color: var(--ink, #18211f); }
    .topnav a.tab:focus-visible { outline: 3px solid var(--accent, #0c6a5e); outline-offset: -3px; }
    .topnav a.tab.active { color: var(--accent, #0c6a5e); border-bottom-color: var(--accent, #0c6a5e); }
    .topnav .spacer { flex: 1 1 auto; }
    .topnav .who { color: var(--muted, #66756f); font-size: 14px; white-space: nowrap;
                    padding-left: 10px; }
    @media (max-width: 640px) {
      .topnav { overflow-x: auto; }
      .topnav .who { display: none; }
    }
  `;

  let whoEl = null;

  function initTopNav({ token, active }) {
    if (!document.getElementById("topnav-style")) {
      const style = document.createElement("style");
      style.id = "topnav-style";
      style.textContent = STYLE;
      document.head.append(style);
    }

    const bar = document.createElement("nav");
    bar.className = "topnav";
    bar.setAttribute("aria-label", "Main");

    const brand = document.createElement("a");
    brand.className = "brand";
    brand.href = `launch.html#${token}`;
    const dot = document.createElement("span");
    dot.className = "dot";
    brand.append(dot, document.createTextNode("Socrative Local"));
    bar.append(brand);

    for (const tab of TABS) {
      const a = document.createElement("a");
      a.className = "tab" + (tab.id === active ? " active" : "");
      a.href = `${tab.href}#${token}`;
      a.textContent = tab.label;
      if (tab.id === active) a.setAttribute("aria-current", "page");
      bar.append(a);
    }

    const spacer = document.createElement("span");
    spacer.className = "spacer";
    bar.append(spacer);

    whoEl = document.createElement("span");
    whoEl.className = "who";
    bar.append(whoEl);

    document.body.prepend(bar);
  }

  function setTopNavWho(name) {
    if (whoEl) whoEl.textContent = name || "";
  }

  window.initTopNav = initTopNav;
  window.setTopNavWho = setTopNavWho;
})();
