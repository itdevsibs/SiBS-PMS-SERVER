// Source-aware conversions without changing shared import semantics.
import { toDateTimeValue, toDurationSecondsValue } from "../../shared/valueConversionService.js";
export function durationForCell(value, cell) {
  const fmt = String(cell?.numFmt || "").replace(/"[^"]*"/g, "");
  if (typeof value === "number" && /\[h+\]|\[m+\]|\[s+\]|h+:m+|m+:s+/i.test(fmt)) {
    return value >= 0 && Number.isFinite(value) ? {ok:true,value:Math.round(value*86400*10000)/10000} : toDurationSecondsValue(value);
  }
  // Numeric values without an elapsed-time format have ambiguous units. Do not guess.
  if (typeof value === "number" && value !== 0) return {ok:false,value:null,errorCode:"DURATION_UNIT_UNVERIFIED",message:"Numeric duration has no verified elapsed-time format."};
  return toDurationSecondsValue(value);
}
export function timestampForSource(value, date) {
  if (typeof value === "number" && value>=0 && value<1) {if(!date)return {ok:false,value:null,errorCode:"DATE_REQUIRED_FOR_CLOCK",message:"Excel clock requires date"};const seconds=Math.round(value*86400);if(seconds>=86400)return {ok:false,value:null,errorCode:"INVALID_DATETIME",message:"Clock outside day"};value=[Math.floor(seconds/3600),Math.floor(seconds%3600/60),seconds%60].map(x=>String(x).padStart(2,"0")).join(":");}
  if (typeof value === "string" && /^\d{1,2}:\d{2}(?::\d{2})?$/.test(value.trim())) {
    if (!date) return {ok:false,value:null,errorCode:"DATE_REQUIRED_FOR_CLOCK",message:"A clock time requires a source date."};
    const [h,m,s=0]=value.trim().split(":").map(Number);if(h>23||m>59||s>59)return {ok:false,value:null,errorCode:"INVALID_DATETIME",message:"Invalid source clock"};
    return toDateTimeValue(`${date} ${value.trim()}`);
  }
  if (typeof value === "string") {
    const iso=value.trim().match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if(iso && (!classifyPeriod(iso[1],iso[1]) || (iso[2]!==undefined && (+iso[2]>23||+iso[3]>59||+(iso[4]||0)>59)))) return {ok:false,value:null,errorCode:"INVALID_DATETIME",message:"Invalid source timestamp"};
  }
  return toDateTimeValue(value);
}
export function durationCell(workbook, sheetName, excelRowNumber, headers, name) {
  const header = headers.find(h => h.sourceHeader.trim().toLowerCase().replace(/\s+/g," ") === String(name).trim().toLowerCase().replace(/\s+/g," "));
  return header ? workbook.getWorksheet(sheetName)?.getRow(excelRowNumber)?.getCell(header.columnNumber) : null;
}
export function classifyPeriod(from, to) {
  const valid = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d||"")) && Number.isFinite(Date.parse(d+"T00:00:00Z")) && new Date(d+"T00:00:00Z").toISOString().slice(0,10)===d;
  if (!valid(from)||!valid(to)||from>to) return null;
  if (from===to) return "DAILY";
  const start=new Date(from+"T00:00:00Z"), end=new Date(to+"T00:00:00Z");
  if (start.getUTCDate()===1 && start.getUTCMonth()===end.getUTCMonth() && start.getUTCFullYear()===end.getUTCFullYear() && new Date(Date.UTC(end.getUTCFullYear(),end.getUTCMonth()+1,0)).getUTCDate()===end.getUTCDate()) return "MONTHLY";
  if (start.getUTCDay()===0 && (end-start)/86400000===6) return "WEEKLY";
  return "CUSTOM_RANGE";
}
