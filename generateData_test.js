const ExcelJS = require("exceljs");
const nodemailer = require("nodemailer");
const path = require("path");
const {pool}=require("./connectdb")
const os = require("os");
const rateLimiter=require("./rateLimiter")
const express=require("express")
const router=express.Router()
const { fetchCollectionData,createCollectionExcel,getDateRange } = require("./getExcel");
// ─── helpers ────────────────────────────────────────────────────────────────
const toNum = (v) => Number(v || 0);
const fix2  = (n) => Number(Number(n).toFixed(2));
const fmt   = (v) => (v == null ? "" : v);
const fmtDate = (v) => (v ? new Date(v).toLocaleString("en-IN") : "");

// ─── styles ─────────────────────────────────────────────────────────────────
const COLORS = {
  headerBg:    "1F3864",   // dark navy
  headerFont:  "FFFFFF",
  summaryBg:   "D9E1F2",   // light blue
  altRow:      "F2F2F2",
  accent:      "2E75B6",
  green:       "E2EFDA",
  red:         "FCE4D6",
  sectionBg:   "BDD7EE",
};

function applyHeader(cell, text) {
  cell.value = text;
  cell.font  = { bold: true, color: { argb: COLORS.headerFont }, name: "Arial", size: 10 };
  cell.fill  = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.headerBg } };
  cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  cell.border = {
    top:    { style: "thin" }, bottom: { style: "thin" },
    left:   { style: "thin" }, right:  { style: "thin" },
  };
}

function applyCell(cell, value, align = "left", bold = false, bgColor = null) {
  cell.value = value ?? "";
  cell.font  = { name: "Arial", size: 9, bold };
  cell.alignment = { horizontal: align, vertical: "middle" };
  if (bgColor) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bgColor } };
  cell.border = {
    top:    { style: "hair" }, bottom: { style: "hair" },
    left:   { style: "hair" }, right:  { style: "hair" },
  };
}

// ─── parse extras ────────────────────────────────────────────────────────────
function parseExtras(extras) {
  let raw = extras;
  if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { raw = []; } }
  if (!Array.isArray(raw)) raw = [];
  const out = { pickupUpi: 0, pickupCash: 0, dropoffUpi: 0, dropoffCash: 0 };
  for (const e of raw) {
    const upi = toNum(e.upi), cash = toNum(e.cash);
    if (e.type === "handover_out")      { out.pickupUpi += upi;  out.pickupCash += cash; }
    else if (e.type === "handover_in")  { out.dropoffUpi += upi; out.dropoffCash += cash; }
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN: generateCombinedReport
// ════════════════════════════════════════════════════════════════════════════
async function generateCombinedReport({ collectionRows, overallRows, fromDate, toDate }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Car24 System";
  wb.created = new Date();

  // ── 1. SUMMARY SHEET ──────────────────────────────────────────────────────
  const sumSheet = wb.addWorksheet("📊 Summary");
  sumSheet.columns = [
    { width: 35 }, { width: 22 }, { width: 22 }, { width: 22 },
  ];

  // Title block
  sumSheet.mergeCells("A1:D1");
  const title = sumSheet.getCell("A1");
  title.value = "CAR24 FINANCIAL REPORT";
  title.font  = { bold: true, size: 16, color: { argb: COLORS.headerFont }, name: "Arial" };
  title.fill  = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.headerBg } };
  title.alignment = { horizontal: "center", vertical: "middle" };
  sumSheet.getRow(1).height = 30;

  sumSheet.mergeCells("A2:D2");
  const subTitle = sumSheet.getCell("A2");
  subTitle.value = `Period: ${fromDate}  →  ${toDate}`;
  subTitle.font  = { bold: true, size: 11, color: { argb: COLORS.accent }, name: "Arial" };
  subTitle.alignment = { horizontal: "center" };
  sumSheet.getRow(2).height = 20;

  // ─ Overall financial summary ─
  const overallSummary = overallRows.reduce((acc, row) => {
    const ex = parseExtras(row.extras);
    acc.totalBookings++;
    acc.totalPrice      += toNum(row.totalPrice);
    acc.advancePaid     += toNum(row.advance_paid);
    acc.remainingAmount += toNum(row.remaining_amount);
    acc.rideStartAmount += toNum(row.ride_start_amount);
    acc.rideEndAmount   += toNum(row.ride_end_amount);
    acc.creditsUsed     += toNum(row.credits_used);
    acc.penaltyAmount   += toNum(row.penalty_amount);
    acc.penaltyExtAmt   += toNum(row.penalty_extention_amount);
    acc.extensionAmount += toNum(row.extension_amount);
    acc.totalPickupUpi  += ex.pickupUpi;
    acc.totalPickupCash += ex.pickupCash;
    acc.totalDropoffUpi += ex.dropoffUpi;
    acc.totalDropoffCash+= ex.dropoffCash;
    if (row.payment_completed)                  acc.completedCount++;
    if (row.payment_status === "fully_paid")    acc.fullyPaidCount++;
    if (row.payment_status === "partial_paid")  acc.partialCount++;
    if (row.cancellation_status && row.cancellation_status !== "none") acc.cancelledCount++;
    return acc;
  }, {
    totalBookings: 0, totalPrice: 0, advancePaid: 0, remainingAmount: 0,
    rideStartAmount: 0, rideEndAmount: 0, creditsUsed: 0, penaltyAmount: 0,
    penaltyExtAmt: 0, extensionAmount: 0,
    totalPickupUpi: 0, totalPickupCash: 0, totalDropoffUpi: 0, totalDropoffCash: 0,
    completedCount: 0, fullyPaidCount: 0, partialCount: 0, cancelledCount: 0,
  });

  // ─ Collection summary ─
  const collSummary = collectionRows.reduce((acc, r) => {
    acc.totalIncome  += toNum(r.total_income);
    acc.totalAmount  += toNum(r.amount);
    acc.totalReduced += toNum(r.reduced_amount);
    return acc;
  }, { totalIncome: 0, totalAmount: 0, totalReduced: 0 });

  const totalUpi  = overallSummary.totalPickupUpi  + overallSummary.totalDropoffUpi;
  const totalCash = overallSummary.totalPickupCash + overallSummary.totalDropoffCash;

  // Summary sections
  const sections = [
    { title: "📋 BOOKING OVERVIEW", rows: [
      ["Total Bookings",           overallSummary.totalBookings,    "",   ""],
      ["Completed (Payment)",      overallSummary.completedCount,   "",   ""],
      ["Fully Paid",               overallSummary.fullyPaidCount,   "",   ""],
      ["Partial Paid",             overallSummary.partialCount,     "",   ""],
      ["Cancelled",                overallSummary.cancelledCount,   "",   ""],
    ]},
    { title: "💰 REVENUE SUMMARY", rows: [
      ["Total Booking Value",      fix2(overallSummary.totalPrice),      "₹", ""],
      ["Advance Collected",        fix2(overallSummary.advancePaid),     "₹", ""],
      ["Remaining Amount",         fix2(overallSummary.remainingAmount), "₹", ""],
      ["Ride Start Amount",        fix2(overallSummary.rideStartAmount), "₹", ""],
      ["Ride End Amount",          fix2(overallSummary.rideEndAmount),   "₹", ""],
      ["Credits Used",             fix2(overallSummary.creditsUsed),     "₹", ""],
    ]},
    { title: "⚠️ PENALTIES & EXTENSIONS", rows: [
      ["Penalty Amount",           fix2(overallSummary.penaltyAmount),   "₹", ""],
      ["Penalty Extension Amount", fix2(overallSummary.penaltyExtAmt),   "₹", ""],
      ["Extension Amount",         fix2(overallSummary.extensionAmount), "₹", ""],
    ]},
    { title: "💳 CASH / UPI BREAKDOWN", rows: [
      ["Pickup UPI",               fix2(overallSummary.totalPickupUpi),   "₹", ""],
      ["Pickup Cash",              fix2(overallSummary.totalPickupCash),  "₹", ""],
      ["Dropoff UPI",              fix2(overallSummary.totalDropoffUpi),  "₹", ""],
      ["Dropoff Cash",             fix2(overallSummary.totalDropoffCash), "₹", ""],
      ["Total UPI",                fix2(totalUpi),                        "₹", ""],
      ["Total Cash",               fix2(totalCash),                       "₹", ""],
      ["Grand Total Collected",    fix2(totalUpi + totalCash),            "₹", "BOLD"],
    ]},
    { title: "🏦 COLLECTION (Superadmin)", rows: [
      ["Total Income",             fix2(collSummary.totalIncome),   "₹", ""],
      ["Total Paid Amount",        fix2(collSummary.totalAmount),   "₹", ""],
      ["Total Deductions",         fix2(collSummary.totalReduced),  "₹", ""],
      ["Net Collection",           fix2(collSummary.totalAmount - collSummary.totalReduced), "₹", "BOLD"],
    ]},
  ];

  let rowIdx = 4;
  for (const section of sections) {
    // Section header
    sumSheet.mergeCells(`A${rowIdx}:D${rowIdx}`);
    const sh = sumSheet.getCell(`A${rowIdx}`);
    sh.value = section.title;
    sh.font  = { bold: true, size: 10, color: { argb: COLORS.headerFont }, name: "Arial" };
    sh.fill  = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.accent } };
    sh.alignment = { horizontal: "left", vertical: "middle", indent: 1 };
    sumSheet.getRow(rowIdx).height = 18;
    rowIdx++;

    for (const [label, value, currency, flag] of section.rows) {
      const r = sumSheet.getRow(rowIdx);
      const isBold = flag === "BOLD";
      const bg = isBold ? COLORS.sectionBg : (rowIdx % 2 === 0 ? COLORS.altRow : null);
      applyCell(r.getCell(1), label,   "left",   isBold, bg);
      applyCell(r.getCell(2), currency,"center",  false,  bg);
      applyCell(r.getCell(3), value,   "right",  isBold, bg);
      applyCell(r.getCell(4), "",      "left",   false,  bg);
      r.height = 16;
      rowIdx++;
    }
    rowIdx++; // blank row between sections
  }

  // ── 2. COLLECTION DETAIL SHEET ────────────────────────────────────────────
  const colSheet = wb.addWorksheet("💼 Collection Detail");

  const colHeaders = [
    "ID", "Booking ID", "Branch", "Car", "Customer", "Customer Email",
    "Customer Mobile", "Total Income", "Amount", "Paid To", "Status",
    "Reduced Amount", "Deduction Reason", "Paid At", "Created At",
    "Booking Status", "Total Price", "Advance Paid", "Remaining",
    "Ride Start Amt", "Ride End Amt", "Credits Used",
    "Penalty Amt", "Penalty Hrs", "Ext Amt", "Ext Hrs",
    "Payment Status", "Confirmation #", "Pickup Date", "Dropoff Date",
  ];
  const colWidths = [
    6, 10, 18, 18, 20, 24, 14,
    13, 13, 12, 12,
    14, 20, 18, 18,
    14, 12, 12, 12,
    13, 13, 12,
    12, 10, 10, 10,
    14, 16, 18, 18,
  ];

  colSheet.columns = colWidths.map(w => ({ width: w }));
  colSheet.getRow(1).height = 30;

  colHeaders.forEach((h, i) => applyHeader(colSheet.getRow(1).getCell(i + 1), h));

  collectionRows.forEach((r, idx) => {
    const row = colSheet.addRow([
      r.id, r.booking_id,
      fmt(r.branch_name), fmt(r.car_name),
      fmt(r.customer_name), fmt(r.customer_email), fmt(r.customer_mobile),
      toNum(r.total_income), toNum(r.amount),
      fmt(r.paid_to), fmt(r.status),
      toNum(r.reduced_amount), fmt(r.deduction_reason),
      fmtDate(r.paid_at), fmtDate(r.created_at),
      fmt(r.booking_status), toNum(r.totalPrice),
      toNum(r.advance_paid), toNum(r.remaining_amount),
      toNum(r.ride_start_amount), toNum(r.ride_end_amount), toNum(r.credits_used),
      toNum(r.penalty_amount), toNum(r.penalty_hours),
      toNum(r.extension_amount), toNum(r.extension_hours),
      fmt(r.payment_status), fmt(r.confirmationNumber),
      fmtDate(r.pickupDate), fmtDate(r.dropoffDate),
    ]);
    const bg = idx % 2 === 0 ? null : COLORS.altRow;
    row.eachCell(cell => {
      cell.font = { name: "Arial", size: 9 };
      cell.alignment = { vertical: "middle" };
      if (bg) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bg } };
      cell.border = { top: { style: "hair" }, bottom: { style: "hair" },
                      left: { style: "hair" }, right: { style: "hair" } };
    });
    row.height = 15;
  });

  colSheet.autoFilter = { from: "A1", to: `${String.fromCharCode(64 + colHeaders.length)}1` };
  colSheet.views = [{ state: "frozen", ySplit: 1 }];

  // ── 3. OVERALL BOOKINGS SHEET ─────────────────────────────────────────────
  const ovrSheet = wb.addWorksheet("📅 All Bookings");

  const ovrHeaders = [
    "Booking ID", "Confirmation #", "Status", "Payment Status", "Pickup Date",
    "Dropoff Date", "Total Price", "Advance Paid", "Remaining",
    "Ride Start Amt", "Ride End Amt", "Credits Used",
    "Penalty Amt", "Penalty Hrs", "Ext Amt", "Ext Hrs",
    "Penalty Ext Amt", "Penalty Ext Hrs",
    "Payment Done", "Cancellation", "Onsite",
    "Pickup UPI", "Pickup Cash", "Dropoff UPI", "Dropoff Cash",
    "Total UPI", "Total Cash",
  ];
  const ovrWidths = [
    10, 16, 12, 14, 18,
    18, 12, 12, 12,
    13, 13, 12,
    12, 10, 10, 10,
    14, 14,
    12, 14, 8,
    11, 11, 12, 12,
    10, 10,
  ];

  ovrSheet.columns = ovrWidths.map(w => ({ width: w }));
  ovrSheet.getRow(1).height = 30;
  ovrHeaders.forEach((h, i) => applyHeader(ovrSheet.getRow(1).getCell(i + 1), h));

  overallRows.forEach((r, idx) => {
    const ex = parseExtras(r.extras);
    const totalUpiRow  = ex.pickupUpi  + ex.dropoffUpi;
    const totalCashRow = ex.pickupCash + ex.dropoffCash;

    const row = ovrSheet.addRow([
      r.id, fmt(r.confirmationNumber), fmt(r.status), fmt(r.payment_status),
      fmtDate(r.pickupDate), fmtDate(r.dropoffDate),
      toNum(r.totalPrice), toNum(r.advance_paid), toNum(r.remaining_amount),
      toNum(r.ride_start_amount), toNum(r.ride_end_amount), toNum(r.credits_used),
      toNum(r.penalty_amount), toNum(r.penalty_hours),
      toNum(r.extension_amount), toNum(r.extension_hours),
      toNum(r.penalty_extention_amount), toNum(r.penalty_extention_hours),
      r.payment_completed ? "Yes" : "No",
      fmt(r.cancellation_status), r.onsite ? "Yes" : "No",
      ex.pickupUpi, ex.pickupCash, ex.dropoffUpi, ex.dropoffCash,
      totalUpiRow, totalCashRow,
    ]);

    let bg = idx % 2 === 0 ? null : COLORS.altRow;
    if (r.status === "completed")  bg = COLORS.green;
    if (r.cancellation_status && r.cancellation_status !== "none") bg = COLORS.red;

    row.eachCell(cell => {
      cell.font = { name: "Arial", size: 9 };
      cell.alignment = { vertical: "middle" };
      if (bg) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bg } };
      cell.border = { top: { style: "hair" }, bottom: { style: "hair" },
                      left: { style: "hair" }, right: { style: "hair" } };
    });
    row.height = 15;
  });

  ovrSheet.autoFilter = { from: "A1", to: `${String.fromCharCode(64 + ovrHeaders.length)}1` };
  ovrSheet.views = [{ state: "frozen", ySplit: 1 }];

  // ── Save ──────────────────────────────────────────────────────────────────
  const filePath = path.join(os.tmpdir(), `car24_report_${Date.now()}.xlsx`);
  await wb.xlsx.writeFile(filePath);
  return filePath;
}

// ════════════════════════════════════════════════════════════════════════════
// EMAIL SENDER
// ════════════════════════════════════════════════════════════════════════════
async function sendFinancialReportEmail({ filePath, fromDate, toDate, toEmail }) {
  // Configure your SMTP transport here
  const transporter = nodemailer.createTransport({
  service:"gmail",
  auth:{
  user:"car24travelsnlr@gmail.com",
  pass:process.env.nodemailer_pass
  }
  })

  await transporter.sendMail({
    from: `"Car24 Reports" <car24travelsnlr@gmail.com>`,
    to: toEmail.join(","),
    subject: `📊 Car24 Financial Report — ${fromDate} to ${toDate}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px">
        <h2 style="color:#1F3864">Car24 Financial Report</h2>
        <p>Please find attached the financial report for the period:</p>
        <p style="font-size:16px;color:#2E75B6"><strong>${fromDate} → ${toDate}</strong></p>
        <p>The report includes:</p>
        <ul>
          <li>📊 Executive Summary (revenue, collections, penalties)</li>
          <li>💼 Collection Detail (superadmin payments)</li>
          <li>📅 All Bookings (full booking financials)</li>
        </ul>
        <p style="color:#888;font-size:12px">Generated automatically by Car24 system.</p>
      </div>
    `,
    attachments: [{
      filename: `car24_report_${fromDate}_to_${toDate}.xlsx`,
      path: filePath,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }],
  });
}

// ════════════════════════════════════════════════════════════════════════════
// COMBINED ENTRY POINT  ← call this from your router
// ════════════════════════════════════════════════════════════════════════════
async function sendFinancialReport({ fromDate, toDate, toEmail }) {
  // 1. Fetch both datasets in parallel
  const [collectionRows, overallRows] = await Promise.all([
    fetchCollectionData(fromDate, toDate),      // your existing function
    fetchOverallBookings(fromDate, toDate),      // your existing query result rows
  ]);

  // 2. Build Excel file
  const filePath = await generateCombinedReport({
    collectionRows,
    overallRows,
    fromDate,
    toDate,
  });

  // 3. Email it
  await sendFinancialReportEmail({ filePath, fromDate, toDate, toEmail });

  return { success: true, message: `Report sent to ${toEmail}` };
}

// ════════════════════════════════════════════════════════════════════════════
// fetchOverallBookings  ← extracted query from getOverallFinancialStatus
// ════════════════════════════════════════════════════════════════════════════
async function fetchOverallBookings(fromDate, toDate) {
  const result = await pool.query(
    `SELECT
      id, "userId", "carId", "branchId",
      "pickupDate", "dropoffDate", "totalPrice", status,
      "confirmationNumber", extras,
      advance_paid, payment_status, ride_start_time, ride_end_time,
      penalty_amount, remaining_amount, razorpay_payment_id,
      credits_used, payment_completed, cancellation_status,
      ride_start_amount, ride_end_amount, extension_amount, extension_hours,
      onsite, extension_status, penalty_hours,
      penalty_extention_hours, auto_extention_hours_status, penalty_extention_amount
    FROM bookings
    WHERE "pickupDate"::date <= $2::date
      AND "dropoffDate"::date >= $1::date
    ORDER BY "pickupDate" ASC`,
    [fromDate, toDate]
  );
  return result.rows;
}

// ════════════════════════════════════════════════════════════════════════════
// ROUTER EXAMPLE
// ════════════════════════════════════════════════════════════════════════════

router.post("/sendFinancialReport", rateLimiter, async (req, res) => {
  try {
    const { fromDate, toDate, toEmail } = req.query;

    if (!fromDate || !toDate || !toEmail) {
      return res.status(400).json({ message: "fromDate, toDate, and toEmail are required" });
    }

    const result = await sendFinancialReport({ fromDate, toDate, toEmail });
    return res.status(200).json(result);
  } catch (err) {
    console.error("❌ Error sending financial report:", err);
    return res.status(500).json({ message: "Failed to send report", error: err.message });
  }
});

module.exports = router;
module.exports.sendFinancialReport = sendFinancialReport;