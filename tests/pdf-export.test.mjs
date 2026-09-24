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

test("the statement PDF carries the same numbers as the preview", async () => {
  const { window, downloads, blobs } = bootOffline({
    records: [day("2026-09-21", "1250000"), day("2026-09-23", "880000")]
  });
  await new Promise((r) => setTimeout(r, 250));
  window.renderReports("monthly", "2026-09-01");
  window.document.querySelector("#downloadPDF").click();
  window.document.querySelector("#pdfDownloadBtn").click();

  const pdf = pdfText(blobs[0]);
  assert.match(pdf, /BRANCH MARKETING REPORT/);
  assert.match(pdf, /TANTAR BRANCH/);
  assert.match(pdf, /Total Deposit: Tk 21,30,000/);
  assert.match(pdf, /DEPOSIT BREAKDOWN/);
  assert.match(pdf, /Cash: Tk 21,30,000/);
  assert.match(pdf, /DAILY RECORDS/);
  assert.match(pdf, /21 September 2026 \| Deposit: Tk 12,50,000/);
  assert.match(pdf, /23 September 2026 \| Deposit: Tk 8,80,000/);
  assert.equal(downloads.length, 1);
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
  assert.match(visitPdf, /VISITING REPORT/);
  assert.match(visitPdf, /TOTAL VISITS: 1/);
  assert.match(visitPdf, /School/);
  assert.match(visitPdf, /Place: Tantar High/);
  assert.match(visitPdf, /Mobile: 01711111111/);

  window.renderAccountReport("monthly", "2026-09-01");
  window.document.querySelector(".pdf-dl").click();
  window.document.querySelector("#pdfDownloadBtn").click();
  assert.equal(downloads.length, 2);
  assert.match(downloads[1].download, /^BranchAccountReport_September_2026\.pdf$/);
  const accountPdf = pdfText(blobs[1]);
  assert.match(accountPdf, /NEW ACCOUNT REPORT/);
  assert.match(accountPdf, /TOTAL ACCOUNTS: 1/);
  assert.match(accountPdf, /A\/C No: 1001/);
  assert.match(accountPdf, /Initial Deposit: Tk 20,000/);
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
  assert.match(previewText, /BRANCH MARKETING REPORT/);
  assert.match(previewText, /Total Deposit: Tk 12,50,000/);
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
