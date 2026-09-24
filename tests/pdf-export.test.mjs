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
  window.document.querySelector("#downloadPDF").click();
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
  assert.equal(downloads.length, 2);
  assert.match(downloads[1].download, /^BranchAccountReport_September_2026\.pdf$/);
  const accountPdf = pdfText(blobs[1]);
  assert.match(accountPdf, /NEW ACCOUNT REPORT/);
  assert.match(accountPdf, /TOTAL ACCOUNTS: 1/);
  assert.match(accountPdf, /A\/C No: 1001/);
  assert.match(accountPdf, /Initial Deposit: Tk 20,000/);
});
