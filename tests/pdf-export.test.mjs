/* Offline PDF export: boot the real index.html in jsdom with every fetch
   failing — the device is in airplane mode — and prove that all three report
   views still assemble and save their PDFs entirely in the browser. The bytes
   are built by the app's own savePdf(); the test captures the Blob and the
   save anchor instead of the file system. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM, VirtualConsole } from "jsdom";

const HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");

/* Every booted app arms live-channel backoff timers; closing the windows lets
   `node --test` exit instead of waiting on a device that keeps retrying. */
const bootedWindows = [];
after(() => {
  for (const window of bootedWindows) {
    try {
      window.close();
    } catch {
      /* already gone */
    }
  }
});

const day = (date, cash) => ({
  date,
  places: "4",
  cash,
  clearing: "",
  rtgs: "",
  npsb: "",
  agent: "",
  officers: [{ name: "Harun Or Rashid", designation: "Assistant Vice President" }],
  visits: [{ officer: "Harun Or Rashid", type: "School", name: "Tantar High", address: "Tantar", mobile: "01711111111" }],
  accounts: [{ category: "Savings", no: "1001", amount: "20000" }],
  created: date + "T09:00:00.000Z",
  updated: date + "T09:00:00.000Z"
});

function bootOffline({ records = [] } = {}) {
  const downloads = [];
  const blobs = [];
  let fetches = 0;

  const vc = new VirtualConsole();
  vc.on("jsdomError", () => {
    /* offline boot noise (failed live watch, failed auto-upload) is the point */
  });
  vc.on("error", () => {});

  const dom = new JSDOM(HTML, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "https://example.test/",
    virtualConsole: vc,
    beforeParse(window) {
      window.matchMedia = () => ({
        media: "", matches: false, onchange: null,
        addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false
      });
      Object.defineProperty(window, "crypto", {
        configurable: true,
        value: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256); return a; } }
      });
      window.navigator.serviceWorker = { register: () => Promise.resolve({}), ready: new Promise(() => {}), controller: null, addEventListener() {} };
      window.confirm = () => true;
      window.alert = () => {};
      window.prompt = () => null;

      if (records.length) window.localStorage.setItem("bmr_v1_records", JSON.stringify(records));
      window.localStorage.setItem(
        "bmr_v1_settings",
        JSON.stringify({ branch: "Tantar Branch", zone: "Cumilla", team: "Team-8", totalBranch: 21, target: 5000000 })
      );

      /* Airplane mode: every network call fails. */
      window.fetch = async () => {
        fetches++;
        throw new TypeError("Failed to fetch");
      };

      /* Capture what would have been saved to disk. */
      window.Blob = class {
        constructor(parts, opts) {
          this.parts = parts;
          this.type = (opts && opts.type) || "";
          blobs.push(this);
        }
      };
      window.URL.createObjectURL = () => "blob:fake/" + blobs.length;
      window.URL.revokeObjectURL = () => {};
      window.HTMLAnchorElement.prototype.click = function () {
        downloads.push({ href: this.href, download: this.download });
      };
    }
  });

  bootedWindows.push(dom.window);
  return {
    window: dom.window,
    downloads,
    blobs,
    fetchCount: () => fetches
  };
}

const pdfText = (blob) => String(blob.parts.join(""));

test("PDF export works with the network completely down", async () => {
  const { window, downloads, blobs, fetchCount } = bootOffline({ records: [day("2026-09-21", "1250000")] });
  // let start-up try (and fail) to reach the cloud first
  await new Promise((r) => setTimeout(r, 250));
  window.renderReports("monthly", "2026-09-01");

  const before = fetchCount();
  window.document.querySelector("#downloadPDF").click();          // generate the preview
  window.document.querySelector("#pdfDownloadBtn").click();       // save it from the preview
  assert.equal(fetchCount(), before, "saving a PDF must not touch the network");

  assert.equal(downloads.length, 1);
  assert.match(downloads[0].download, /^BranchMarketingReport_Monthly_Report_September_2026\.pdf$/);
  const pdf = pdfText(blobs[0]);
  assert.ok(pdf.startsWith("%PDF-1.4"), "a real PDF header");
  assert.ok(pdf.trimEnd().endsWith("%%EOF"), "a complete PDF file");
  assert.equal(blobs[0].type, "application/pdf");
});

function statementCells(line, cols) {
  let i = 0;
  return cols.map((c, idx) => {
    const text = line.slice(i, i + c.width);
    i += c.width + (idx < cols.length - 1 ? 1 : 0);
    return text;
  });
}

test("the monthly statement PDF is a date table with blank columns", async () => {
  const { window, downloads, blobs } = bootOffline({
    records: [day("2026-09-21", "1250000"), day("2026-09-23", "880000")]
  });
  await new Promise((r) => setTimeout(r, 250));
  const doc = window.document;
  window.renderReports("monthly", "2026-09-01");
  doc.querySelector("#downloadPDF").click();
  assert.equal(doc.querySelector("#pdfPreviewTitle").textContent, "Monthly Statement");
  const previewText = [...doc.querySelectorAll(".pdfpage pre")].map((p) => p.textContent).join("\n");
  doc.querySelector("#pdfDownloadBtn").click();

  const pdf = pdfText(blobs[0]);
  assert.match(pdf, /MONTHLY STATEMENT/);
  assert.match(pdf, /TANTAR BRANCH/);
  assert.match(pdf, /September 2026/);
  assert.match(pdf, /Total Deposit: Tk 21,30,000/);
  assert.match(pdf, /MediaBox \[0 0 842 595\]/);
  assert.match(pdf, /BaseFont \/Courier/);
  assert.doesNotMatch(pdf, /DAILY RECORDS/);
  assert.doesNotMatch(pdf, /21 September 2026 \| Deposit/);
  assert.equal(downloads.length, 1);

  const cols = window.statementColumns();
  const lines = window.statementLines("2026-09-01");
  for (let d = 1; d <= 30; d++) {
    const label = String(d).padStart(2, "0") + " Sep";
    assert.ok(lines.some((l) => l.startsWith(label)), "missing date " + label);
  }
  const empty = lines.find((l) => l.startsWith("01 Sep"));
  assert.equal(empty.trim(), "01 Sep", "a day with no entry keeps every column blank");
  assert.equal(statementCells(empty, cols).slice(1).every((c) => c.trim() === ""), true);

  const row21 = lines.find((l) => l.startsWith("21 Sep"));
  const cells21 = statementCells(row21, cols);
  assert.equal(cells21[0].trim(), "21 Sep");
  assert.equal(cells21[1].trim(), "4");
  assert.equal(cells21[2].trim(), "12,50,000");
  assert.equal(cells21[3].trim(), "", "clearing column stays blank when there is no clearing entry");
  assert.equal(cells21[4].trim(), "");
  assert.equal(cells21[5].trim(), "");
  assert.equal(cells21[6].trim(), "");
  const body = lines.join("\n");
  assert.match(body, /Harun Or Rashid/);
  assert.match(body, /School/);
  assert.match(body, /Tantar High/);
  assert.match(body, /01711111111/);
  assert.match(body, /Savings 1001 20,000/);
  const total = lines.find((l) => l.startsWith("TOTAL"));
  const totalCells = statementCells(total, cols);
  assert.equal(totalCells[2].trim(), "21,30,000");
  assert.equal(totalCells[3].trim(), "");
  assert.equal(totalCells[7].trim(), "");
  assert.equal(totalCells[8].trim(), "");
  assert.equal(totalCells[9].trim(), "");

  const feb2024 = window.statementLines("2024-02-01");
  assert.equal(feb2024.find((l) => l.startsWith("29 Feb")).trim(), "29 Feb");
  assert.equal(feb2024.some((l) => l.startsWith("30 Feb")), false);
  const feb2026 = window.statementLines("2026-02-01");
  assert.equal(feb2026.find((l) => l.startsWith("28 Feb")).trim(), "28 Feb");
  assert.equal(feb2026.some((l) => l.startsWith("29 Feb")), false);

  const inPdf = [...pdf.matchAll(/\((.*?)\) Tj/g)].map((m) => m[1]).filter((s) => s.trim()).join("\n");
  const inPreview = previewText.split("\n").filter((s) => s.trim())
    .map((s) => s.replace(/[\\()]/g, "\\$&").replace(/[^\x20-\x7E]/g, "?")).join("\n");
  assert.equal(inPdf, inPreview, "the preview must show exactly what the PDF contains");
});

test("a partial day leaves the missing statement columns empty", async () => {
  const sparse = {
    date: "2026-09-02",
    places: "",
    cash: "5000",
    clearing: "0",
    rtgs: "",
    npsb: "",
    agent: "",
    officers: [],
    visits: [{ officer: "", type: "School", name: "", address: "", mobile: "" }],
    accounts: [{ category: "Savings", no: "", amount: "" }],
    created: "2026-09-02T09:00:00.000Z",
    updated: "2026-09-02T09:00:00.000Z"
  };
  const { window } = bootOffline({ records: [sparse] });
  await new Promise((r) => setTimeout(r, 250));
  const cols = window.statementColumns();
  const lines = window.statementLines("2026-09-01");
  const row = lines.find((l) => l.startsWith("02 Sep"));
  const cells = statementCells(row, cols);
  assert.equal(cells[1].trim(), "", "blank places stay blank");
  assert.equal(cells[2].trim(), "5,000");
  assert.equal(cells[3].trim(), "", "a zero clearing entry is an empty column");
  assert.equal(cells[4].trim(), "");
  assert.equal(cells[5].trim(), "");
  assert.equal(cells[6].trim(), "");
  assert.equal(cells[7].trim(), "");
  assert.equal(cells[8].trim(), "", "a visit with no entered detail does not fill the column");
  assert.equal(cells[9].trim(), "", "an account row with no number and no amount stays blank");
  assert.equal(lines.find((l) => l.startsWith("03 Sep")).trim(), "03 Sep");
});

test("the visiting and account reports export offline too", async () => {
  const { window, downloads, blobs, fetchCount } = bootOffline({ records: [day("2026-09-21", "1250000")] });
  await new Promise((r) => setTimeout(r, 250));

  window.renderVisitReport("monthly", "2026-09-01");
  const before = fetchCount();
  window.document.querySelector(".pdf-dl").click();
  window.document.querySelector("#pdfDownloadBtn").click();
  assert.equal(fetchCount(), before, "saving a PDF must not touch the network");
  assert.equal(downloads.length, 1);
  assert.match(downloads[0].download, /^BranchVisitingReport_September_2026\.pdf$/);
  const visitPdf = pdfText(blobs[0]);
  assert.match(visitPdf, /MONTHLY STATEMENT/);
  assert.match(visitPdf, /MediaBox \[0 0 842 595\]/);
  assert.match(visitPdf, /BaseFont \/Courier/);
  assert.doesNotMatch(visitPdf, /VISITING REPORT/);
  assert.match(visitPdf, /School/);
  assert.match(visitPdf, /Tantar High/);
  assert.match(visitPdf, /01711111111/);
  assert.match(visitPdf, /Savings 1001 20,000/);
  const visitText = [...visitPdf.matchAll(/\((.*?)\) Tj/g)].map((m) => m[1]).filter((s) => s.trim()).join("\n");
  const expected = window.statementLines("2026-09-01").filter((s) => s.trim())
    .map((s) => s.replace(/[\\()]/g, "\\$&").replace(/[^\x20-\x7E]/g, "?")).join("\n");
  assert.equal(visitText, expected, "the visiting PDF is the same statement table");

  window.renderAccountReport("monthly", "2026-09-01");
  window.document.querySelector(".pdf-dl").click();
  assert.equal(window.document.querySelector("#pdfPreviewTitle").textContent, "Monthly Statement");
  window.document.querySelector("#pdfDownloadBtn").click();
  assert.equal(downloads.length, 2);
  assert.match(downloads[1].download, /^BranchAccountReport_September_2026\.pdf$/);
  const accountPdf = pdfText(blobs[1]);
  assert.match(accountPdf, /MONTHLY STATEMENT/);
  assert.doesNotMatch(accountPdf, /NEW ACCOUNT REPORT/);
  assert.match(accountPdf, /Savings 1001 20,000/);
  assert.match(accountPdf, /12,50,000/);
  const accountText = [...accountPdf.matchAll(/\((.*?)\) Tj/g)].map((m) => m[1]).filter((s) => s.trim()).join("\n");
  assert.equal(accountText, visitText, "account and visiting PDFs are the same statement");
});

test("pick a date, generate, preview, then download from the preview", async () => {
  const { window, downloads, blobs, fetchCount } = bootOffline({
    records: [day("2026-09-21", "1250000"), day("2026-09-24", "2405000")]
  });
  await new Promise((r) => setTimeout(r, 250));
  const doc = window.document;
  window.nav("reports");

  // pick one day: Daily segment + the date field
  doc.querySelector('#repSeg [data-tp="daily"]').onclick();
  const input = doc.querySelector("#repDate");
  input.value = "2026-09-21";
  input.onchange({ target: input });
  assert.match(doc.querySelector(".rh-period").textContent, /21 September 2026/);

  // generate: the preview opens and nothing has been written yet
  const before = fetchCount();
  [...doc.querySelectorAll("#reports .pdf-dl")].pop().click();
  assert.ok(doc.querySelector("#pdfModal").classList.contains("show"), "preview did not open");
  assert.equal(blobs.length, 0, "generating a preview must not write a file");
  assert.equal(doc.querySelectorAll(".pdfpage").length, 1);
  assert.match(doc.querySelector("#pdfPreviewMeta").textContent, /^BranchMarketingReport_Daily_Report_21_September_2026\.pdf · 1 page · \d+ lines$/);

  // the preview text is exactly what the PDF will contain
  const previewText = [...doc.querySelectorAll(".pdfpage pre")].map((p) => p.textContent).join("\n");
  assert.equal(doc.querySelector("#pdfPreviewTitle").textContent, "Daily Statement");
  assert.match(previewText, /DAILY STATEMENT/);
  assert.match(previewText, /Total Deposit: Tk 12,50,000/);
  assert.match(previewText, /21 Sep/);
  assert.ok(!previewText.includes("24 Sep"), "the other day must not be in a single-day report");
  assert.ok(!previewText.includes("24 September 2026"), "the other day must not be in a single-day report");

  // download from inside the preview
  doc.querySelector("#pdfDownloadBtn").click();
  assert.equal(fetchCount(), before, "the whole generate→preview→download flow is offline");
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].download, "BranchMarketingReport_Daily_Report_21_September_2026.pdf");
  assert.ok(!doc.querySelector("#pdfModal").classList.contains("show"), "preview should close after saving");

  const inPdf = [...pdfText(blobs[0]).matchAll(/\((.*?)\) Tj/g)].map((m) => m[1]).filter((s) => s.trim()).join("\n");
  const inPreview = previewText.split("\n").filter((s) => s.trim())
    .map((s) => s.replace(/[\\()]/g, "\\$&").replace(/[^\x20-\x7E]/g, "?")).join("\n");
  assert.equal(inPdf, inPreview, "the preview must show exactly what the PDF contains");
});

test("daily and weekly reports use the same statement table", async () => {
  const { window } = bootOffline({
    records: [day("2026-09-21", "1250000"), day("2026-09-24", "2405000")]
  });
  await new Promise((r) => setTimeout(r, 250));
  const cols = window.statementColumns();
  const dateRows = (lines) => lines.filter((l) => /^\d\d [A-Z][a-z]{2} /.test(l));
  const daily = window.statementLines("2026-09-21", "daily");
  assert.match(daily.join("\n"), /DAILY STATEMENT/);
  assert.equal(dateRows(daily).length, 1);
  assert.equal(daily.find((l) => l.startsWith("21 Sep")).trim().startsWith("21 Sep"), true);
  assert.equal(statementCells(daily.find((l) => l.startsWith("21 Sep")), cols)[3].trim(), "");
  assert.equal(daily.some((l) => l.startsWith("24 Sep")), false);

  const weekly = window.statementLines("2026-09-21", "weekly");
  assert.match(weekly.join("\n"), /WEEKLY STATEMENT/);
  const weekDays = dateRows(weekly);
  assert.equal(weekDays.map((l) => l.slice(0, 6).trim()).join(","), "20 Sep,21 Sep,22 Sep,23 Sep,24 Sep");
  assert.equal(weekDays.find((l) => l.startsWith("20 Sep")).trim(), "20 Sep");
  assert.equal(statementCells(weekDays.find((l) => l.startsWith("22 Sep")), cols).slice(1).every((c) => c.trim() === ""), true);
  assert.equal(statementCells(weekDays.find((l) => l.startsWith("24 Sep")), cols)[2].trim(), "24,05,000");
  assert.equal(weekly.some((l) => l.startsWith("01 Sep")), false);
});

test("WhatsApp share stays the daily message, not the statement table", async () => {
  const { window } = bootOffline({ records: [day("2026-09-21", "1250000")] });
  await new Promise((r) => setTimeout(r, 250));
  window.openShareModal(day("2026-09-21", "1250000"));
  const summary = window.document.querySelector("#summaryPreview").textContent;
  const details = window.document.querySelector("#detailPreview").textContent;
  assert.match(summary, /Daily Report Date : 21 September 2026/);
  assert.match(summary, /Total Deposit: Tk 12,50,000/);
  assert.match(summary, /Total Places Visited: 4/);
  assert.match(details, /\*DAILY BRANCH ACTIVITY DETAILS\*/);
  assert.match(details, /Harun Or Rashid \| School: Tantar High \| Tantar \| 01711111111/);
  assert.match(details, /Savings: 1001 — Tk 20,000/);
  assert.doesNotMatch(summary, /STATEMENT/);
  assert.doesNotMatch(details, /DAILY STATEMENT|MONTHLY STATEMENT|Clr\/BFTN/);
});

test("closing the preview saves nothing", async () => {
  const { window, downloads, blobs } = bootOffline({ records: [day("2026-09-21", "1250000")] });
  await new Promise((r) => setTimeout(r, 250));
  const doc = window.document;
  window.renderReports("monthly", "2026-09-01");

  doc.querySelector("#downloadPDF").click();
  assert.ok(doc.querySelector("#pdfModal").classList.contains("show"));
  doc.querySelector("#pdfBackBtn").click();
  assert.ok(!doc.querySelector("#pdfModal").classList.contains("show"));

  doc.querySelector("#downloadPDF").click();
  doc.querySelector("#closePdfPreview").click();
  assert.equal(blobs.length, 0);
  assert.equal(downloads.length, 0, "no file may be written unless Download is tapped");
});
