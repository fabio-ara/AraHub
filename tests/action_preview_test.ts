import assert from "node:assert/strict";
import { actionPreview } from "../web/action_preview.ts";

Deno.test("revisão de planilha conserva conteúdo e distingue fórmula de texto literal", () => {
  const rows = [["=SUM(A2:A3)", { formula: "=SUM(A2:A3)" }, true, null, 0], [
    "<script>última célula</script>",
  ]];
  const preview = actionPreview("sheets_create", { title: "Teste", rows });
  assert.ok(preview.includes("Aba: Dados"));
  for (
    const value of [
      "A1 · texto literal: =SUM(A2:A3)",
      "B1 · fórmula: =SUM(A2:A3)",
      "C1 · lógico: verdadeiro",
      "D1 · vazia:",
      "E1 · número: 0",
    ]
  ) assert.ok(preview.includes(value));
  assert.ok(preview.includes("última célula"));
  assert.ok(
    actionPreview("sheets_create", {
      title: "Larga",
      rows: [Array.from({ length: 50 }, (_, i) => i)],
    }).includes("AX1 · número: 49"),
  );
  assert.ok(
    actionPreview("sheets_create", { title: "Vazia", sheet_title: "Análise" })
      .includes("Aba: Análise"),
  );
});

Deno.test("revisão de slide apresenta destino, geometria e todo o texto fixado", () => {
  const text = "Primeira linha\nÚltima linha";
  const preview = actionPreview("slides_add_text", {
    slide_id: "slide_1",
    text_id: "text_1",
    x: 40,
    y: 20,
    width: 500,
    height: 300,
    text,
  });
  for (
    const value of ["slide_1", "text_1", "40, 20 pt", "500 × 300 pt", text]
  ) assert.ok(preview.includes(value));
});
