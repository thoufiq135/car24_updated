const ExcelJS = require("exceljs");
const { pool } = require("./connectdb");

function getTodayRange() {
  const now = new Date();

  const start = new Date(now);
  start.setHours(0, 0, 0, 0);

  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  return { start, end };
}

function getDateRange(from, to) {
  const start = new Date(from);
  start.setHours(0, 0, 0, 0);

  const end = new Date(to);
  end.setHours(23, 59, 59, 999);

  return { start, end };
}
async function fetchCollectionData(start, end) {
  if (!start || !end) {
    const range = getTodayRange();
    start = range.start;
    end = range.end;
  }

  const result = await pool.query(
    `SELECT
      bi.id,
      bi.booking_id,
      bi.ownerid,
      bi."carId",
      bi."branchId",
      bi.total_income,
      bi.amount,
      bi.paid_to,
      bi.receiver_id,
      bi.status,
      bi.created_at,
      bi.paid_at,
      bi.reduced_amount,
      bi.deduction_reason,

      -- Booking financials
      b."totalPrice",
      b.advance_paid,
      b.remaining_amount,
      b.ride_start_amount,
      b.ride_end_amount,
      b.credits_used,
      b.penalty_amount,
      b.penalty_hours,
      b.penalty_extention_amount,
      b.penalty_extention_hours,
      b.extension_amount,
      b.extension_hours,
      b.extension_status,
      b.payment_status,
      b.payment_completed,
      b.cancellation_status,
      b.extras,
      b.status              AS booking_status,
      b."confirmationNumber",
      b."pickupDate",
      b."dropoffDate",
      b.ride_start_time,
      b.ride_end_time,
      b.onsite,
      b.razorpay_payment_id,

      -- Customer
      u.name                AS customer_name,
      u.email               AS customer_email,
      u.mobileno            AS customer_mobile,

      -- Car  ✅ cars has no 'name', only 'model'
      c.model               AS car_name,
      c."licensePlate"      AS car_reg,
      c.colour              AS car_colour,
      c.category            AS car_category,

      -- Branch
      br.name               AS branch_name,
      br.city               AS branch_city

    FROM booking_income bi
    LEFT JOIN bookings b  ON b.id  = bi.booking_id
    LEFT JOIN users u     ON u.id  = b."userId"
    LEFT JOIN cars c      ON c.id  = bi."carId"
    LEFT JOIN branches br ON br.id = bi."branchId"
    WHERE bi.paid_to = 'superadmin'
      AND bi.created_at BETWEEN $1 AND $2
    ORDER BY bi."branchId", bi.created_at ASC`,
    [start, end]
  );

  return result.rows;
}

async function createCollectionExcel(rows) {
  const workbook = new ExcelJS.Workbook();
  const toNum = (v) => Number(v || 0);
  const fix2 = (n) => Number(Number(n).toFixed(2));

  // ── Helper: style a header row ──
  const styleHeader = (row, bgColor = "1F4E79") => {
    row.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: `FF${bgColor}` },
      };
      cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      cell.border = {
        top:    { style: "thin" },
        left:   { style: "thin" },
        bottom: { style: "thin" },
        right:  { style: "thin" },
      };
    });
  };

  const styleDataRow = (row, isAlt = false) => {
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: isAlt ? "FFEFF7FF" : "FFFFFFFF" },
      };
      cell.border = {
        top:    { style: "thin", color: { argb: "FFD0D0D0" } },
        left:   { style: "thin", color: { argb: "FFD0D0D0" } },
        bottom: { style: "thin", color: { argb: "FFD0D0D0" } },
        right:  { style: "thin", color: { argb: "FFD0D0D0" } },
      };
      cell.alignment = { vertical: "middle", wrapText: true };
    });
  };

  // ════════════════════════════════════════════
  // SHEET 1 — Summary
  // ════════════════════════════════════════════
  const summarySheet = workbook.addWorksheet("📊 Summary");

  // Aggregate
  const byBranch = {};
  const byStatus = {};
  let totalAmount       = 0;
  let totalIncome       = 0;
  let totalPenalty      = 0;
  let totalExtension    = 0;
  let totalCredits      = 0;
  let totalAdvance      = 0;
  let totalRideStart    = 0;
  let totalRideEnd      = 0;
  let totalRemaining    = 0;
  let totalExtras       = 0;
  let paymentCompletedCount = 0;
  let pendingCount      = 0;
  let partialPaidCount  = 0;
  let cancelledCount    = 0;
  let onsiteCount       = 0;

  rows.forEach((row) => {
    totalAmount     += toNum(row.amount);
    totalIncome     += toNum(row.total_income);
    totalPenalty    += toNum(row.penalty_amount);
    totalExtension  += toNum(row.extension_amount);
    totalCredits    += toNum(row.credits_used);
    totalAdvance    += toNum(row.advance_paid);
    totalRideStart  += toNum(row.ride_start_amount);
    totalRideEnd    += toNum(row.ride_end_amount);
    totalRemaining  += toNum(row.remaining_amount);

    const extras = Array.isArray(row.extras)
      ? row.extras.reduce((s, e) => s + toNum(e.price || e.amount), 0)
      : 0;
    totalExtras += extras;

    if (row.payment_completed)                                      paymentCompletedCount++;
    if (row.payment_status === "pending")                           pendingCount++;
    if (row.payment_status === "partial_paid")                      partialPaidCount++;
    if (row.cancellation_status && row.cancellation_status !== "none") cancelledCount++;
    if (row.onsite)                                                 onsiteCount++;

    // By branch
    const bKey = `${row.branchId}_${row.branch_name}`;
    if (!byBranch[bKey]) {
      byBranch[bKey] = {
        name: row.branch_name || `Branch ${row.branchId}`,
        city: row.branch_city || "—",
        count: 0, amount: 0, income: 0,
        penalty: 0, extension: 0, credits: 0, remaining: 0,
      };
    }
    byBranch[bKey].count     += 1;
    byBranch[bKey].amount    += toNum(row.amount);
    byBranch[bKey].income    += toNum(row.total_income);
    byBranch[bKey].penalty   += toNum(row.penalty_amount);
    byBranch[bKey].extension += toNum(row.extension_amount);
    byBranch[bKey].credits   += toNum(row.credits_used);
    byBranch[bKey].remaining += toNum(row.remaining_amount);

    // By booking status
    const st = row.booking_status || "unknown";
    if (!byStatus[st]) byStatus[st] = { count: 0, amount: 0 };
    byStatus[st].count  += 1;
    byStatus[st].amount += toNum(row.amount);
  });

  // Summary KPI block
  summarySheet.mergeCells("A1:D1");
  const titleCell = summarySheet.getCell("A1");
  titleCell.value = `Daily Collection Summary — ${new Date().toLocaleDateString("en-IN")}`;
  titleCell.font  = { bold: true, size: 14, color: { argb: "FF1F4E79" } };
  titleCell.alignment = { horizontal: "center", vertical: "middle" };
  summarySheet.getRow(1).height = 30;

  summarySheet.addRow([]);

  const kpiData = [
    ["Total Records",           rows.length],
    ["Total Amount Collected",  `₹ ${fix2(totalAmount)}`],
    ["Total Income",            `₹ ${fix2(totalIncome)}`],
    ["Advance Paid",            `₹ ${fix2(totalAdvance)}`],
    ["Ride Start Amount",       `₹ ${fix2(totalRideStart)}`],
    ["Ride End Amount",         `₹ ${fix2(totalRideEnd)}`],
    ["Remaining Amount",        `₹ ${fix2(totalRemaining)}`],
    ["Penalty Amount",          `₹ ${fix2(totalPenalty)}`],
    ["Extension Amount",        `₹ ${fix2(totalExtension)}`],
    ["Credits Used",            `₹ ${fix2(totalCredits)}`],
    ["Extras Total",            `₹ ${fix2(totalExtras)}`],
    ["Payment Completed",       paymentCompletedCount],
    ["Pending Payments",        pendingCount],
    ["Partial Payments",        partialPaidCount],
    ["Cancellations",           cancelledCount],
    ["Onsite Bookings",         onsiteCount],
  ];

  kpiData.forEach(([label, value], i) => {
    const r = summarySheet.addRow([label, value]);
    r.getCell(1).font = { bold: true };
    styleDataRow(r, i % 2 === 0);
  });

  summarySheet.getColumn(1).width = 28;
  summarySheet.getColumn(2).width = 22;

  // Branch breakdown table
  summarySheet.addRow([]);
  summarySheet.addRow([]);
  const branchHeaderRow = summarySheet.addRow([
    "Branch", "City", "Records", "Amount (₹)", "Income (₹)",
    "Penalty (₹)", "Extension (₹)", "Credits (₹)", "Remaining (₹)",
  ]);
  styleHeader(branchHeaderRow, "2E75B6");

  Object.values(byBranch).forEach((br, i) => {
    const r = summarySheet.addRow([
      br.name, br.city, br.count,
      fix2(br.amount), fix2(br.income),
      fix2(br.penalty), fix2(br.extension),
      fix2(br.credits), fix2(br.remaining),
    ]);
    styleDataRow(r, i % 2 === 0);
  });

  // Status breakdown table
  summarySheet.addRow([]);
  summarySheet.addRow([]);
  const statusHeaderRow = summarySheet.addRow(["Booking Status", "Count", "Amount (₹)"]);
  styleHeader(statusHeaderRow, "375623");

  Object.entries(byStatus).forEach(([status, val], i) => {
    const r = summarySheet.addRow([status, val.count, fix2(val.amount)]);
    styleDataRow(r, i % 2 === 0);
  });

  // ════════════════════════════════════════════
  // SHEET 2 — Full Booking Details
  // ════════════════════════════════════════════
  const detailSheet = workbook.addWorksheet("📋 Booking Details");

  detailSheet.columns = [
    { header: "Income ID",          key: "id",                    width: 10 },
    { header: "Booking ID",         key: "booking_id",            width: 12 },
    { header: "Confirmation No.",   key: "confirmationNumber",    width: 18 },
    { header: "Booking Status",     key: "booking_status",        width: 16 },
    { header: "Payment Status",     key: "payment_status",        width: 16 },
    { header: "Payment Completed",  key: "payment_completed",     width: 18 },
    { header: "Cancellation",       key: "cancellation_status",   width: 16 },
    { header: "Onsite",             key: "onsite",                width: 10 },
    // Customer
    { header: "Customer Name",      key: "customer_name",         width: 20 },
    { header: "Customer Email",     key: "customer_email",        width: 26 },
    { header: "Customer Mobile",    key: "customer_mobile",       width: 16 },
    // Car & Branch
    { header: "Car",                key: "car_name",              width: 18 },
    { header: "Reg. No.",           key: "car_reg",               width: 14 },
    { header: "Branch",             key: "branch_name",           width: 18 },
    { header: "Branch City",        key: "branch_city",           width: 14 },
    // Dates
    { header: "Pickup Date",        key: "pickupDate",            width: 20 },
    { header: "Dropoff Date",       key: "dropoffDate",           width: 20 },
    { header: "Ride Start Time",    key: "ride_start_time",       width: 20 },
    { header: "Ride End Time",      key: "ride_end_time",         width: 20 },
    // Financials
    { header: "Total Price (₹)",    key: "totalPrice",            width: 15 },
    { header: "Advance Paid (₹)",   key: "advance_paid",          width: 16 },
    { header: "Ride Start Amt (₹)", key: "ride_start_amount",     width: 18 },
    { header: "Ride End Amt (₹)",   key: "ride_end_amount",       width: 16 },
    { header: "Collected (₹)",      key: "collected",             width: 15 },
    { header: "Remaining (₹)",      key: "remaining_amount",      width: 15 },
    { header: "Credits Used (₹)",   key: "credits_used",          width: 15 },
    { header: "Penalty Amt (₹)",    key: "penalty_amount",        width: 15 },
    { header: "Penalty Hrs",        key: "penalty_hours",         width: 13 },
    { header: "Ext. Penalty (₹)",   key: "penalty_extention_amount", width: 16 },
    { header: "Ext. Penalty Hrs",   key: "penalty_extention_hours",  width: 16 },
    { header: "Extension Amt (₹)",  key: "extension_amount",      width: 16 },
    { header: "Extension Hrs",      key: "extension_hours",       width: 14 },
    { header: "Extras (₹)",         key: "extrasTotal",           width: 13 },
    { header: "Outstanding (₹)",    key: "outstanding",           width: 15 },
    // Income record
    { header: "Income Amount (₹)",  key: "amount",                width: 16 },
    { header: "Total Income (₹)",   key: "total_income",          width: 16 },
    { header: "Paid To",            key: "paid_to",               width: 14 },
    { header: "Razorpay ID",        key: "razorpay_payment_id",   width: 24 },
    { header: "Created At",         key: "created_at",            width: 24 },
  ];

  styleHeader(detailSheet.getRow(1));

  rows.forEach((row, i) => {
    const extrasTotal = Array.isArray(row.extras)
      ? row.extras.reduce((s, e) => s + toNum(e.price || e.amount), 0)
      : 0;

    const collected =
      toNum(row.advance_paid) +
      toNum(row.ride_start_amount) +
      toNum(row.ride_end_amount);

    const outstanding =
      toNum(row.totalPrice) +
      toNum(row.penalty_amount) +
      toNum(row.penalty_extention_amount) +
      toNum(row.extension_amount) -
      collected -
      toNum(row.credits_used);

    const r = detailSheet.addRow({
      id:                       row.id,
      booking_id:               row.booking_id,
      confirmationNumber:       row.confirmationNumber || "—",
      booking_status:           row.booking_status || "—",
      payment_status:           row.payment_status || "—",
      payment_completed:        row.payment_completed ? "Yes" : "No",
      cancellation_status:      row.cancellation_status || "none",
      onsite:                   row.onsite ? "Yes" : "No",
      customer_name:            row.customer_name || "—",
      customer_email:           row.customer_email || "—",
      customer_mobile:          row.customer_mobile || "—",
      car_name:                 row.car_name || "—",
      car_reg:                  row.car_reg || "—",
      branch_name:              row.branch_name || "—",
      branch_city:              row.branch_city || "—",
      pickupDate:               row.pickupDate ? new Date(row.pickupDate).toLocaleString("en-IN") : "—",
      dropoffDate:              row.dropoffDate ? new Date(row.dropoffDate).toLocaleString("en-IN") : "—",
      ride_start_time:          row.ride_start_time ? new Date(row.ride_start_time).toLocaleString("en-IN") : "—",
      ride_end_time:            row.ride_end_time ? new Date(row.ride_end_time).toLocaleString("en-IN") : "—",
      totalPrice:               fix2(row.totalPrice),
      advance_paid:             fix2(row.advance_paid),
      ride_start_amount:        fix2(row.ride_start_amount),
      ride_end_amount:          fix2(row.ride_end_amount),
      collected:                fix2(collected),
      remaining_amount:         fix2(row.remaining_amount),
      credits_used:             fix2(row.credits_used),
      penalty_amount:           fix2(row.penalty_amount),
      penalty_hours:            toNum(row.penalty_hours),
      penalty_extention_amount: fix2(row.penalty_extention_amount),
      penalty_extention_hours:  toNum(row.penalty_extention_hours),
      extension_amount:         fix2(row.extension_amount),
      extension_hours:          toNum(row.extension_hours),
      extrasTotal:              fix2(extrasTotal),
      outstanding:              fix2(outstanding),
      amount:                   fix2(row.amount),
      total_income:             fix2(row.total_income),
      paid_to:                  row.paid_to || "—",
      razorpay_payment_id:      row.razorpay_payment_id || "—",
      created_at:               row.created_at ? new Date(row.created_at).toLocaleString("en-IN") : "—",
    });

    styleDataRow(r, i % 2 === 0);
  });

  // Totals row
  detailSheet.addRow({});
  const totalsRow = detailSheet.addRow({
    customer_name:    "TOTALS",
    totalPrice:       fix2(rows.reduce((s, r) => s + toNum(r.totalPrice), 0)),
    advance_paid:     fix2(totalAdvance),
    ride_start_amount: fix2(totalRideStart),
    ride_end_amount:  fix2(totalRideEnd),
    remaining_amount: fix2(totalRemaining),
    credits_used:     fix2(totalCredits),
    penalty_amount:   fix2(totalPenalty),
    extension_amount: fix2(totalExtension),
    extrasTotal:      fix2(totalExtras),
    amount:           fix2(totalAmount),
    total_income:     fix2(totalIncome),
  });
  totalsRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FF1F4E79" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDCE6F1" } };
    cell.border = { top: { style: "medium" }, bottom: { style: "medium" } };
  });

  // ════════════════════════════════════════════
  // SHEET 3 — Extras Breakdown
  // ════════════════════════════════════════════
  const extrasSheet = workbook.addWorksheet("🧾 Extras Breakdown");
  extrasSheet.columns = [
    { header: "Booking ID",   key: "booking_id", width: 14 },
    { header: "Customer",     key: "customer",   width: 22 },
    { header: "Extra Name",   key: "name",       width: 24 },
    { header: "Qty",          key: "qty",        width: 8  },
    { header: "Unit Price (₹)", key: "price",    width: 16 },
    { header: "Total (₹)",    key: "total",      width: 14 },
  ];
  styleHeader(extrasSheet.getRow(1));

  let extrasRowIdx = 0;
  rows.forEach((row) => {
    if (!Array.isArray(row.extras) || row.extras.length === 0) return;
    row.extras.forEach((extra) => {
      const qty   = toNum(extra.quantity || extra.qty || 1);
      const price = toNum(extra.price || extra.amount || 0);
      const r = extrasSheet.addRow({
        booking_id: row.booking_id,
        customer:   row.customer_name || "—",
        name:       extra.name || extra.label || "Extra",
        qty,
        price:      fix2(price),
        total:      fix2(qty * price),
      });
      styleDataRow(r, extrasRowIdx % 2 === 0);
      extrasRowIdx++;
    });
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

module.exports = {
  fetchCollectionData,
  createCollectionExcel,getDateRange
};