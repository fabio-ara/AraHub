/** Render every proposed value as text; approval must never hide newly added content. */
export function actionPreview(
  operation: string,
  proposed: Record<string, unknown>,
): string {
  switch (operation) {
    case "docs_create":
    case "slides_create":
      return `Nome: ${proposed.title}`;
    case "sheets_create": {
      const name = `Nome: ${proposed.title}`;
      const sheet = proposed.sheet_title ??
        (proposed.rows ? "Dados" : undefined);
      return name + (sheet ? `\nAba: ${sheet}` : "") +
        (Array.isArray(proposed.rows)
          ? `\n\nCélulas:\n${
            proposed.rows.map((row, r) =>
              (row as unknown[]).map((value, c) => {
                const column = c < 26
                  ? String.fromCharCode(65 + c)
                  : "A" + String.fromCharCode(65 + c - 26);
                const type = value === null
                  ? "vazia"
                  : typeof value === "object"
                  ? "fórmula"
                  : typeof value === "string"
                  ? "texto literal"
                  : typeof value === "boolean"
                  ? "lógico"
                  : "número";
                const text = value === null
                  ? ""
                  : typeof value === "object"
                  ? (value as { formula: string }).formula
                  : typeof value === "boolean"
                  ? value ? "verdadeiro" : "falso"
                  : String(value);
                return `${column}${r + 1} · ${type}: ${text}`;
              }).join("\n")
            ).join("\n\n")
          }`
          : "\nPlanilha sem conteúdo inicial.");
    }
    case "docs_insert_text":
      return String(proposed.text);
    case "slides_replace_text":
      return `Encontrar:\n${proposed.find}\n\nSubstituir por:\n${proposed.replace}`;
    case "slides_add_text":
      return `Novo slide: ${proposed.slide_id}\nCaixa de texto: ${proposed.text_id}\nPosição: ${proposed.x}, ${proposed.y} pt\nTamanho: ${proposed.width} × ${proposed.height} pt\n\n${proposed.text}`;
    default:
      return JSON.stringify(proposed, null, 2);
  }
}
