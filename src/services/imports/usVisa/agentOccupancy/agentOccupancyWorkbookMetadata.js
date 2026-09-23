function getCellValue(cell) {
  const value = cell?.value;
  if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "result")) return value.result;
  if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "text")) return value.text;
  if (value && typeof value === "object" && Array.isArray(value.richText)) {
    return value.richText.map((part) => part.text || "").join("");
  }
  return value;
}

function normalizeLabel(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase().replace(/:$/, "");
}

function extractTaskOrderId(value) {
  const text = String(value || "").trim();
  const match = text.match(/\bTO\s*([0-9]+)\b/i);
  return match ? `TO${Number(match[1])}` : null;
}

function collectRowValues(row) {
  const values = [];
  row?.eachCell?.({ includeEmpty: true }, (cell, columnNumber) => {
    values[columnNumber - 1] = getCellValue(cell);
  });
  return values;
}

export function extractAgentOccupancyWorkbookMetadata(workbook, preferredSheetName = null) {
  const worksheet =
    (preferredSheetName ? workbook?.getWorksheet?.(preferredSheetName) : null) ||
    workbook?.worksheets?.[0] ||
    null;

  if (!worksheet) {
    return {
      sourceTimezone: null,
      declaredTaskOrderId: null,
      declaredProjectText: null,
    };
  }

  let sourceTimezone = null;
  let declaredProjectText = null;
  let declaredTaskOrderId = null;
  const maxRow = Math.min(Number(worksheet.rowCount) || 15, 15);

  for (let rowNumber = 1; rowNumber <= maxRow; rowNumber += 1) {
    const values = collectRowValues(worksheet.getRow(rowNumber));
    for (let index = 0; index < values.length; index += 1) {
      const label = normalizeLabel(values[index]);
      const adjacentValue = values[index + 1];
      if (!label) continue;

      if (label === "timezone" && adjacentValue !== undefined && adjacentValue !== null) {
        sourceTimezone = String(adjacentValue).trim() || null;
      }

      if (["project", "task order", "skill group"].includes(label)) {
        const text = String(adjacentValue ?? values[index] ?? "").trim();
        if (text) {
          declaredProjectText = text;
          declaredTaskOrderId = extractTaskOrderId(text) || declaredTaskOrderId;
        }
      }

    }
  }

  return {
    sourceTimezone,
    declaredTaskOrderId,
    declaredProjectText,
  };
}
