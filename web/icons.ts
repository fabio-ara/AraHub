// Adapted from AraLearn; MIT Copyright (c) 2026 Fabio Eidi Ara. See THIRD_PARTY_NOTICES.md.
export function renderUiIcon(iconName: string, className = "ui-icon") {
  const classes = `${className}`.trim();

  const toolPaths = {
    audio: '<path d="M2 6h3l4-3v10l-4-3H2zM11 5a5 5 0 0 1 0 6M13 3a8 8 0 0 1 0 10"/>',
    calculator:
      '<rect x="3" y="1.5" width="10" height="13" rx="1.5"/><path d="M5 4h6M5 7h1M10 7h1M5 10h1M10 10h1M5 12h1M10 12h1"/>',
    "book-open": '<path d="M8 4C6 2 3 2 1 3v10c2-1 5-1 7 1 2-2 5-2 7-1V3c-2-1-5-1-7 1v10"/>',
    "book-text": '<path d="M4 2h9v12H4a2 2 0 0 1 0-4h9M2 12V4a2 2 0 0 1 2-2M6 5h4M6 7h4"/>',
    languages: '<path d="M1 3h8M5 1v2M3 3c0 4 3 6 6 7M8 3c0 4-3 7-6 8M8 14l3-8 3 8M9 11h4"/>',
  };
  if (Object.hasOwn(toolPaths, iconName)) {
    return `<svg class="${classes}" viewBox="0 0 16 16" aria-hidden="true" focusable="false"` +
      ' fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round">' +
      (toolPaths as Record<string, string>)[iconName] + "</svg>";
  }

  if (iconName === "account") {
    return (
      '<svg class="' + classes + '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<circle cx="8" cy="5.2" r="2.5" fill="none" stroke="currentColor" stroke-width="1.25"></circle>' +
      '<path d="M3.1 13.4c.5-2.5 2.2-3.8 4.9-3.8s4.4 1.3 4.9 3.8" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"></path>' +
      "</svg>"
    );
  }

  if (iconName === "home") {
    return (
      '<svg class="' + classes + '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<path d="M2.2 7.1 8 2.3l5.8 4.8v6.2H9.9V9.5H6.1v3.8H2.2z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"></path>' +
      "</svg>"
    );
  }

  if (iconName === "sparkles") {
    return (
      '<svg class="' +
      classes +
      '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<path d="M6.2 1.7l1 2.8 2.8 1-2.8 1-1 2.8-1-2.8-2.8-1 2.8-1z" fill="currentColor"></path>' +
      '<path d="M11.8 7.2l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6z" fill="currentColor"></path>' +
      '<path d="M4.1 10.7l.4 1.2 1.2.4-1.2.4-.4 1.2-.4-1.2-1.2-.4 1.2-.4z" fill="currentColor"></path>' +
      "</svg>"
    );
  }

  if (iconName === "experiment") {
    return (
      '<svg class="' + classes + '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<path d="M6.1 2.1h3.8M7 2.1v3.4l-3.4 6a1.5 1.5 0 0 0 1.3 2.3h6.2a1.5 1.5 0 0 0 1.3-2.3L9 5.5V2.1" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"></path>' +
      '<path d="M5.3 9.2h5.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"></path>' +
      '<circle cx="7" cy="11.2" r=".7" fill="currentColor"></circle>' +
      '<circle cx="9.6" cy="10.5" r=".55" fill="currentColor"></circle>' +
      "</svg>"
    );
  }

  if (iconName === "folder") {
    return (
      '<svg class="' +
      classes +
      '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<path d="M2.2 4.4h4l1.1 1.3h6.5v6.1a1.4 1.4 0 0 1-1.4 1.4H3.6a1.4 1.4 0 0 1-1.4-1.4z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"></path>' +
      '<path d="M2.2 5.7V4.2a1.2 1.2 0 0 1 1.2-1.2h3.1l1.1 1.4" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"></path>' +
      "</svg>"
    );
  }

  if (iconName === "edit") {
    return (
      '<svg class="' +
      classes +
      '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<path d="M11.9 1.6a1.4 1.4 0 0 1 2 0l.5.5a1.4 1.4 0 0 1 0 2L6 12.5l-3 .7.7-3z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"></path>' +
      '<path d="M9.8 3.7l2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"></path>' +
      "</svg>"
    );
  }

  if (iconName === "preview") {
    return (
      '<svg class="' +
      classes +
      '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<path d="M1.3 8s2.4-4 6.7-4 6.7 4 6.7 4-2.4 4-6.7 4-6.7-4-6.7-4z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"></path>' +
      '<circle cx="8" cy="8" r="2.1" fill="none" stroke="currentColor" stroke-width="1.3"></circle>' +
      "</svg>"
    );
  }

  if (iconName === "tags") {
    return (
      '<svg class="' +
      classes +
      '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<path d="M8.2 2.2H3.5v4.7l5.4 5.4a1.2 1.2 0 0 0 1.7 0l2.7-2.7a1.2 1.2 0 0 0 0-1.7z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"></path>' +
      '<circle cx="5.5" cy="5.2" r="0.9" fill="currentColor"></circle>' +
      "</svg>"
    );
  }

  if (iconName === "study") {
    return (
      '<svg class="' +
      classes +
      '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<circle cx="3.2" cy="12.3" r="1.1" fill="currentColor"></circle>' +
      '<circle cx="8" cy="7.9" r="1.1" fill="currentColor"></circle>' +
      '<circle cx="12.8" cy="3.5" r="1.1" fill="currentColor"></circle>' +
      '<path d="M4.2 11.4l2.9-2.7M8.9 7l2.9-2.7" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"></path>' +
      '<path d="M2.6 3.6h3.2M2.6 6.2h2.2" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" opacity="0.72"></path>' +
      "</svg>"
    );
  }

  if (iconName === "graph") {
    return (
      '<svg class="' +
      classes +
      '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<circle cx="3.3" cy="8.2" r="1.5" fill="currentColor"></circle>' +
      '<circle cx="8" cy="3.4" r="1.5" fill="currentColor"></circle>' +
      '<circle cx="12.7" cy="8.2" r="1.5" fill="currentColor"></circle>' +
      '<circle cx="8" cy="12.6" r="1.5" fill="currentColor"></circle>' +
      '<path d="M4.4 7.1l2.5-2.6M9.1 4.5l2.5 2.6M4.5 9.2l2.3 2.2M9.2 11.4l2.3-2.2M4.8 8.2h6.4" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"></path>' +
      "</svg>"
    );
  }

  if (iconName === "add") {
    return (
      '<svg class="' +
      classes +
      '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<path d="M8 3.1v9.8M3.1 8h9.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"></path>' +
      "</svg>"
    );
  }

  if (iconName === "save") {
    return (
      '<svg class="' +
      classes +
      '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<path d="M3.2 2.8h8l1.6 1.6v8.8H3.2z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"></path>' +
      '<path d="M5 2.8v3.2h5V2.8" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"></path>' +
      '<rect x="5.1" y="9" width="5.8" height="2.8" rx="0.6" fill="none" stroke="currentColor" stroke-width="1.1"></rect>' +
      "</svg>"
    );
  }

  if (iconName === "upload") {
    return (
      '<svg class="' +
      classes +
      '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<path d="M8 10.8V2.7M4.9 5.8L8 2.7l3.1 3.1" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"></path>' +
      '<path d="M3 9.4v3.1c0 .6.5 1.1 1.1 1.1h7.8c.6 0 1.1-.5 1.1-1.1V9.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"></path>' +
      "</svg>"
    );
  }

  if (iconName === "trash") {
    return (
      '<svg class="' +
      classes +
      '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<path d="M4.3 4.6h7.4l-.6 8a1 1 0 0 1-1 .9H6a1 1 0 0 1-1-.9z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"></path>' +
      '<path d="M3.6 4.6h8.8M6.1 4.6V3.4a.7.7 0 0 1 .7-.7h2.4a.7.7 0 0 1 .7.7v1.2M6.6 7.1v4M9.4 7.1v4" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"></path>' +
      "</svg>"
    );
  }

  if (iconName === "reset") {
    return (
      '<svg class="' + classes + '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<path d="M4.2 4.6A5.2 5.2 0 1 1 3 9.4" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"></path>' +
      '<path d="M1.9 4.6h2.8v2.8" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"></path>' +
      "</svg>"
    );
  }

  if (iconName === "intent") {
    return (
      '<svg class="' +
      classes +
      '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<circle cx="8" cy="8" r="4.6" fill="none" stroke="currentColor" stroke-width="1.3"></circle>' +
      '<circle cx="8" cy="8" r="1.2" fill="currentColor"></circle>' +
      '<path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"></path>' +
      "</svg>"
    );
  }

  if (iconName === "prompt") {
    return (
      '<svg class="' +
      classes +
      '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<path d="M3.2 3.2h9.6v7.1H7.1L4 12.8v-2.5H3.2z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"></path>' +
      '<path d="M5.6 5.8h4.8M5.6 8h3.4" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"></path>' +
      "</svg>"
    );
  }

  if (iconName === "title") {
    return (
      '<svg class="' +
      classes +
      '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<path d="M3 4.1h10M3 8h7.2M3 11.9h10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"></path>' +
      "</svg>"
    );
  }

  if (iconName === "microsequence") {
    return (
      '<svg class="' +
      classes +
      '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<rect x="2.7" y="4.6" width="4.9" height="7.9" rx="0.9" transform="rotate(-16 5.15 8.55)" fill="none" stroke="currentColor" stroke-width="1.05"></rect>' +
      '<rect x="5.55" y="3.35" width="4.9" height="8.35" rx="0.9" fill="none" stroke="currentColor" stroke-width="1.15"></rect>' +
      '<rect x="8.3" y="4.55" width="4.9" height="7.9" rx="0.9" transform="rotate(16 10.75 8.5)" fill="none" stroke="currentColor" stroke-width="1.05"></rect>' +
      "</svg>"
    );
  }

  if (iconName === "reposition") {
    return (
      '<svg class="' +
      classes +
      '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<path d="M3.2 5.2h7.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"></path>' +
      '<path d="M8.5 3.3l2 1.9-2 2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"></path>' +
      '<path d="M12.8 10.8H5.6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"></path>' +
      '<path d="M7.5 8.8l-2 2 2 1.9" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"></path>' +
      '<circle cx="3.2" cy="5.2" r="1" fill="currentColor"></circle>' +
      '<circle cx="12.8" cy="10.8" r="1" fill="currentColor"></circle>' +
      "</svg>"
    );
  }

  if (iconName === "sign-in") {
    return (
      '<svg class="' + classes + '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<path d="M6.2 3H3.5v10h2.7M8.2 5.1L11.1 8l-2.9 2.9M5.1 8h6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"></path>' +
      "</svg>"
    );
  }

  if (iconName === "sign-out") {
    return (
      '<svg class="' + classes + '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<path d="M9.8 3h2.7v10H9.8M7.8 5.1L4.9 8l2.9 2.9M10.9 8h-6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"></path>' +
      "</svg>"
    );
  }

  if (iconName === "account-add") {
    return (
      '<svg class="' + classes + '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<circle cx="6.1" cy="5.2" r="2.3" fill="none" stroke="currentColor" stroke-width="1.2"></circle>' +
      '<path d="M2.5 12.8c.3-2.2 1.5-3.5 3.6-3.5s3.4 1.3 3.6 3.5M12.2 6.5v4M10.2 8.5h4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"></path>' +
      "</svg>"
    );
  }

  if (iconName === "mail") {
    return (
      '<svg class="' + classes + '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<rect x="2.2" y="3.5" width="11.6" height="9" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.2"></rect>' +
      '<path d="M3.1 4.5L8 8.4l4.9-3.9" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"></path>' +
      "</svg>"
    );
  }

  if (iconName === "key") {
    return (
      '<svg class="' + classes + '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<circle cx="5.3" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.2"></circle>' +
      '<path d="M8.3 8h5.2M11.2 8v2M13.3 8v1.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"></path>' +
      "</svg>"
    );
  }

  if (iconName === "copy") {
    return (
      '<svg class="' + classes + '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<rect x="5.2" y="4.8" width="7.7" height="8" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2"></rect>' +
      '<path d="M10.8 4.8V3.6a1.2 1.2 0 0 0-1.2-1.2H3.8a1.2 1.2 0 0 0-1.2 1.2v6.1a1.2 1.2 0 0 0 1.2 1.2h1.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"></path>' +
      "</svg>"
    );
  }

  if (iconName === "rotate") {
    return (
      '<svg class="' + classes + '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<path d="M12.8 5.7A5.2 5.2 0 1 0 13 9.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"></path>' +
      '<path d="M9.8 5.6h3.1V2.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"></path>' +
      "</svg>"
    );
  }

  if (iconName === "arrow-left") {
    return (
      '<svg class="' + classes + '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<path d="M12.7 8H3.5M7.2 4.3L3.5 8l3.7 3.7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"></path>' +
      "</svg>"
    );
  }

  if (iconName === "arrow-right") {
    return (
      '<svg class="' + classes + '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<path d="M3.3 8h9.2M8.8 4.3L12.5 8l-3.7 3.7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"></path>' +
      "</svg>"
    );
  }

  if (iconName === "arrow-up" || iconName === "arrow-down") {
    const path = iconName === "arrow-up"
      ? "M8 12.5V3.8M4.8 7l3.2-3.2L11.2 7"
      : "M8 3.5v8.7M4.8 9l3.2 3.2L11.2 9";
    return (
      '<svg class="' +
      classes +
      '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<path d="' + path +
      '" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"></path>' +
      "</svg>"
    );
  }

  if (iconName === "search") {
    return (
      '<svg class="' +
      classes +
      '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<circle cx="7" cy="7" r="4" fill="none" stroke="currentColor" stroke-width="1.25"></circle>' +
      '<path d="M10 10l3.2 3.2" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"></path>' +
      "</svg>"
    );
  }

  if (iconName === "study-unit") {
    return (
      '<svg class="' +
      classes +
      '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<rect x="4.2" y="2.3" width="7.6" height="11.4" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.25"></rect>' +
      '<path d="M5.8 5.1h4.4M5.8 7.3h4.4M5.8 9.5h2.9" fill="none" stroke="currentColor" stroke-width="1.05" stroke-linecap="round"></path>' +
      "</svg>"
    );
  }

  if (iconName === "progress") {
    return (
      '<svg class="' +
      `${classes} ui-icon-progress`.trim() +
      '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<circle cx="8" cy="8" r="4.8" fill="none" stroke="currentColor" stroke-width="1.1" opacity="0.45"></circle>' +
      '<path d="M8 3.2a4.8 4.8 0 0 1 4.8 4.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"></path>' +
      '<circle cx="8" cy="8" r="1.05" fill="currentColor"></circle>' +
      "</svg>"
    );
  }

  if (iconName === "module") {
    return (
      '<svg class="' +
      classes +
      '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<rect x="3" y="3" width="10" height="3.7" rx="0.9" fill="none" stroke="currentColor" stroke-width="1.15"></rect>' +
      '<rect x="3" y="9.3" width="10" height="3.7" rx="0.9" fill="none" stroke="currentColor" stroke-width="1.15"></rect>' +
      "</svg>"
    );
  }

  if (iconName === "lesson") {
    return (
      '<svg class="' +
      classes +
      '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<path d="M4.2 2.5h5l2.6 2.6v8.4H4.2z" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round"></path>' +
      '<path d="M9.2 2.5v2.6h2.6" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round"></path>' +
      '<path d="M5.7 7.1h4.6M5.7 9.2h4.6M5.7 11.3h3.2" fill="none" stroke="currentColor" stroke-width="1.05" stroke-linecap="round"></path>' +
      "</svg>"
    );
  }

  if (iconName === "draft-state") {
    return (
      '<svg class="' +
      classes +
      '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<g transform="translate(0 1)">' +
      '<path d="M3.3 11.9l1.3-4.2L10 2.3a1.3 1.3 0 0 1 1.9 0l1.8 1.8a1.3 1.3 0 0 1 0 1.9L8.3 11.4 4 12.7z" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round"></path>' +
      '<path d="M9.1 3.2l3.7 3.7" fill="none" stroke="currentColor" stroke-width="1.05" stroke-linecap="round"></path>' +
      '<path d="M3 13h10" fill="none" stroke="currentColor" stroke-width="1.05" stroke-linecap="round" opacity="0.72"></path>' +
      "</g>" +
      "</svg>"
    );
  }

  if (iconName === "ready-state") {
    return (
      '<svg class="' +
      classes +
      '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<g transform="translate(0 1)">' +
      '<circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" stroke-width="1.15" opacity="0.5"></circle>' +
      '<path d="M5.1 8.1l1.9 1.9 3.8-4.1" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"></path>' +
      "</g>" +
      "</svg>"
    );
  }

  if (iconName === "excluded-state") {
    return (
      '<svg class="' +
      classes +
      '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<g transform="translate(0 1)">' +
      '<circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" stroke-width="1.15" opacity="0.58"></circle>' +
      '<path d="M6.2 5.4v5.2M9.8 5.4v5.2" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"></path>' +
      "</g>" +
      "</svg>"
    );
  }

  if (iconName === "remove-state") {
    return (
      '<svg class="' +
      classes +
      '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<g transform="translate(0 1)">' +
      '<circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" stroke-width="1.15" opacity="0.52"></circle>' +
      '<path d="M5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2" fill="none" stroke="currentColor" stroke-width="1.28" stroke-linecap="round"></path>' +
      "</g>" +
      "</svg>"
    );
  }

  if (iconName === "review") {
    return (
      '<svg class="' + classes + '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<path d="M4.2 2.4h7.6v11.2L8 11.2l-3.8 2.4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"></path>' +
      "</svg>"
    );
  }

  if (iconName === "info") {
    return `<svg class="${classes}" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round">` +
      '<circle cx="8" cy="8" r="6"/><path d="M8 7v4"/><circle cx="8" cy="4.5" r=".65" fill="currentColor" stroke="none"/></svg>';
  }

  if (iconName === "more") {
    return (
      '<svg class="' + classes + '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<circle cx="3.2" cy="8" r="1.1" fill="currentColor"></circle>' +
      '<circle cx="8" cy="8" r="1.1" fill="currentColor"></circle>' +
      '<circle cx="12.8" cy="8" r="1.1" fill="currentColor"></circle>' +
      "</svg>"
    );
  }

  if (iconName === "play") {
    return (
      '<svg class="' + classes + '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<path d="M5.2 3.1l7.1 4.9-7.1 4.9z" fill="currentColor" stroke="currentColor" stroke-width=".7" stroke-linejoin="round"></path>' +
      "</svg>"
    );
  }

  if (iconName === "cloud" || iconName === "cloud-alert") {
    return (
      '<svg class="' + classes + '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<path d="M4.1 12.2h7.6a2.5 2.5 0 0 0 .4-5 4.1 4.1 0 0 0-7.8-1.1 3.1 3.1 0 0 0-.2 6.1z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"></path>' +
      (iconName === "cloud-alert"
        ? '<path d="M8 6.2v2.1" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"></path>' +
          '<circle cx="8" cy="10.1" r=".7" fill="currentColor"></circle>'
        : "") +
      "</svg>"
    );
  }

  if (iconName === "offline") {
    return (
      '<svg class="' + classes + '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<path d="M4.1 11.9h7.1a2.3 2.3 0 0 0 .5-4.5A4.1 4.1 0 0 0 5 4.7a3 3 0 0 0-.9 5.9" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"></path>' +
      '<path d="M2.4 2.4l11.2 11.2" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"></path>' +
      "</svg>"
    );
  }

  if (iconName === "panel") {
    return (
      '<svg class="' + classes + '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<rect x="2.3" y="2.3" width="4.5" height="4.5" rx=".8" fill="none" stroke="currentColor" stroke-width="1.2"></rect>' +
      '<rect x="9.2" y="2.3" width="4.5" height="4.5" rx=".8" fill="none" stroke="currentColor" stroke-width="1.2"></rect>' +
      '<rect x="2.3" y="9.2" width="4.5" height="4.5" rx=".8" fill="none" stroke="currentColor" stroke-width="1.2"></rect>' +
      '<rect x="9.2" y="9.2" width="4.5" height="4.5" rx=".8" fill="none" stroke="currentColor" stroke-width="1.2"></rect>' +
      "</svg>"
    );
  }

  if (iconName === "drag") {
    return (
      '<svg class="' + classes + '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<path d="M4 4.3h8M4 8h8M4 11.7h8" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"></path>' +
      "</svg>"
    );
  }

  if (iconName === "download") {
    return (
      '<svg class="' + classes + '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<path d="M8 2.7v8.1M4.9 7.8L8 10.9l3.1-3.1M3 12.8h10" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"></path>' +
      "</svg>"
    );
  }

  if (iconName === "theme-system") {
    return (
      '<svg class="' + classes + '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<rect x="2.3" y="3" width="11.4" height="8" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.2"></rect>' +
      '<path d="M6.1 13h3.8M8 11v2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"></path>' +
      "</svg>"
    );
  }

  if (iconName === "theme-light") {
    return (
      '<svg class="' + classes + '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<circle cx="8" cy="8" r="2.6" fill="none" stroke="currentColor" stroke-width="1.2"></circle>' +
      '<path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"></path>' +
      "</svg>"
    );
  }

  if (iconName === "theme-dark") {
    return (
      '<svg class="' + classes + '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<path d="M11.9 10.8A5.2 5.2 0 0 1 5.2 4.1 5.5 5.5 0 1 0 11.9 10.8z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"></path>' +
      "</svg>"
    );
  }

  throw new TypeError(`Ícone de interface desconhecido: ${iconName}`);
}
