const {pool,redis,fire_db}=require("../connectdb")
const bookingQueue=require("../queues/bookingQueue")
const sendNotification = require("../expoNotification")
const sendEmail=require("../email")
async function saveCancelRequestToFirebase({
  bookingId,
  title,
  message,
  type,
  fromEmail,
  toEmail,
}) {
  const notificationRef = fire_db.ref("notifications").push();

  await notificationRef.set({
    bookingId,
    title,
    message,
    type,
    from: fromEmail,
    to: toEmail,
    read: false,
    createdAt: Date.now(),
  });

  return notificationRef.key;
}
const rideReminderJob = async ({ bookingId, expoToken }) => {
  try {
    if (!expoToken) {
      console.log("No expo token found");
      return;
    }

    // 1. Notify customer
    const title = "Ride ends in 3 Hours 🚗";
    const body = "Your Ride ends soon. Tap to view booking details.";
    const data = {
      url: `/(customer)/booking/${bookingId}`,
      bookingId,
    };
    await sendNotification(expoToken, title, body, data);

    // 2. Fetch booking + branch info
    const bookingRes = await pool.query(
      `SELECT b."branchId", b.id, br."branchHeadId"
       FROM bookings b
       JOIN branches br ON br.id = b."branchId"
       WHERE b.id = $1`,
      [bookingId]
    );

    if (bookingRes.rows.length === 0) {
      console.log("Booking not found");
      return;
    }

    const { branchId, branchHeadId } = bookingRes.rows[0];

    // 3. Fetch staff/subadmin/admin from users table for this branch
    const staffRes = await pool.query(
      `SELECT expo_token, email
       FROM users
       WHERE role IN ('staff', 'subadmin', 'admin')
         AND "branchId" = $1
         AND expo_token IS NOT NULL AND expo_token != ''`,
      [branchId]
    );

    // 4. Fetch staff/sub_admin from management table for this branch
    const mgmtRes = await pool.query(
      `SELECT expo_token, email
       FROM management
       WHERE branch = $1
         AND role IN ('staff', 'sub_admin')
         AND expo_token IS NOT NULL AND expo_token != ''`,
      [branchId.toString()]
    );

    // 5. Fetch branch head from management table (if exists)
    let branchHeadRows = [];
    if (branchHeadId) {
      const branchHeadRes = await pool.query(
        `SELECT expo_token, email
         FROM management
         WHERE id = $1
           AND expo_token IS NOT NULL AND expo_token != ''`,
        [branchHeadId]
      );
      branchHeadRows = branchHeadRes.rows;
    }

    // 6. Merge all recipients, deduplicate by email
    const allRecipients = [
      ...staffRes.rows,
      ...mgmtRes.rows,
      ...branchHeadRows,
    ];

    const seen = new Set();
    const uniqueRecipients = allRecipients.filter((r) => {
      if (!r.email || seen.has(r.email)) return false;
      seen.add(r.email);
      return true;
    });

    // 7. Notify all unique recipients
    await Promise.all(
      uniqueRecipients.map(async (recipient) => {
        try {
          await sendNotification(
            recipient.expo_token,
            "Ride Ending Soon 🚗",
            `Booking #${bookingId} ends in 3 hours.`,
            { url: `/(staff)/booking/${bookingId}`, bookingId }
          );

          await saveCancelRequestToFirebase({
            bookingId,
            title: "Ride Ending Soon 🚗",
            message: `Booking #${bookingId} ends in 3 hours.`,
            type: "ride_end_reminder",
            fromEmail: "system",
            toEmail: recipient.email,
          });
        } catch (err) {
          console.log(
            `Failed to notify recipient ${recipient.email}:`,
            err.message
          );
        }
      })
    );

    console.log("✅ Ride end reminder sent for booking:", bookingId);
  } catch (e) {
    console.log("❌ rideEndReminderJob failed:", e.message);
    throw e;
  }
};
// const ridePenaltyJob = async ({ bookingId, expoToken, seater }) => {

//   console.log("Penalty job for booking:", bookingId);
//   const client = await pool.connect();

//   try {
//     await client.query("BEGIN");

//     const bookingRes = await client.query(
//       `
//       SELECT
//         id,
//         "dropoffDate",
//         ride_end_time,
//         penalty_amount,
//         remaining_amount,
//         penalty_hours
//       FROM bookings
//       WHERE id = $1
//       FOR UPDATE
//       `,
//       [bookingId]
//     );

//     if (bookingRes.rows.length === 0) {
//       throw new Error("Booking not found");
//     }

//     const booking = bookingRes.rows[0];

//     if (booking.ride_end_time) {
//       console.log("Vehicle already returned");
//       await client.query("ROLLBACK");
//       return;
//     }

//     const currentPenaltyCount = Number(booking.penalty_hours || 0);

//     if (currentPenaltyCount >= 3) {
//       console.log("Already applied 3 penalties, skipping further penalty");
//       await client.query("ROLLBACK");
//       return;
//     }

//     const penalty = Number(seater) === 7 ? 200 : 150;

//     await client.query(
//       `
//       UPDATE bookings
//       SET
//         penalty_hours = COALESCE(penalty_hours, 0) + 1,
//         penalty_amount = COALESCE(penalty_amount, 0) + $1,
//         remaining_amount = COALESCE(remaining_amount, 0) + $1,
//         "updatedAt" = NOW()
//       WHERE id = $2
//       `,
//       [penalty, bookingId]
//     );

//     await client.query("COMMIT");

//     console.log("Penalty applied:", penalty);

//     if (expoToken) {
//       await sendNotification(
//         expoToken,
//         "Late Return Charge Applied ⏰",
//         `₹${penalty} penalty added to your booking.`,
//         {
//           bookingId,
//           url: `/(customer)/booking/${bookingId}`,
//         }
//       );
//     }
//   } catch (error) {
//     await client.query("ROLLBACK");
//     console.log("Penalty job failed:", error.message);
//     throw error;
//   } finally {
//     client.release();
//   }
// };
const ridePenaltyJob = async ({ bookingId, seater }) => {
  console.log("Penalty job for booking:", bookingId);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const bookingRes = await client.query(
      `
      SELECT
        b.id,
        b."dropoffDate",
        b.ride_end_time,
        b.penalty_amount,
        b.remaining_amount,
        b.penalty_hours,
        b."userId"
      FROM bookings b
      WHERE b.id = $1
      FOR UPDATE
      `,
      [bookingId]
    );

    if (bookingRes.rows.length === 0) throw new Error("Booking not found");

    const booking = bookingRes.rows[0];

    if (booking.ride_end_time) {
      console.log("Vehicle already returned");
      await client.query("ROLLBACK");
      return;
    }

    const currentPenaltyCount = Number(booking.penalty_hours || 0);
    if (currentPenaltyCount >= 3) {
      console.log("Already applied 3 penalties, skipping further penalty");
      await client.query("ROLLBACK");
      return;
    }

    const penalty = Number(seater) === 7 ? 200 : 150;

    await client.query(
      `
      UPDATE bookings
      SET
        penalty_hours   = COALESCE(penalty_hours, 0) + 1,
        penalty_amount  = COALESCE(penalty_amount, 0) + $1,
        remaining_amount = COALESCE(remaining_amount, 0) + $1,
        "updatedAt"     = NOW()
      WHERE id = $2
      `,
      [penalty, bookingId]
    );

    // ── Fetch customer token + email inside the same transaction ──
    const userRes = await client.query(
      `SELECT expo_token, email FROM users WHERE id = $1`,
      [booking.userId]
    );
    const user = userRes.rows[0] ?? null;

    await client.query("COMMIT");
    console.log("Penalty applied:", penalty);

    // ── Notify customer via Expo + Email (after commit) ──
    if (user?.expo_token) {
      await sendNotification(
        user.expo_token,
        "Late Return Charge Applied ⏰",
        `₹${penalty} penalty added to your booking.`,
        { bookingId, url: `/(customer)/booking/${bookingId}` }
      );
    }

    if (user?.email) {
      await sendEmail({
        to: user.email,
        subject: "Late Return Charge Applied ⏰ – Booking #" + bookingId,
        text: `A late return charge of ₹${penalty} has been added to your booking #${bookingId}. Please return the vehicle as soon as possible to avoid further charges.`,
        html: `
          <p>Hi,</p>
          <p>A late return charge of <strong>₹${penalty}</strong> has been added to your booking <strong>#${bookingId}</strong>.</p>
          <p>Please return the vehicle as soon as possible to avoid further charges.</p>
          <p>— Car24 Travels</p>
        `,
      });
    }
    const body=`
          <p>Hi,</p>
          <p>A late return charge of <strong>₹${penalty}</strong> has been added to your booking <strong>#${bookingId}</strong>.</p>
          <p>Please return the vehicle as soon as possible to avoid further charges.</p>
          <p>— Car24 Travels</p>
        `
await saveCancelRequestToFirebase({
    bookingId: Number(bookingId),
    title: "Penalty-added",
    message: body,
    type: "Ride-Penalty",
    fromEmail: "car24Travels",
    toEmail: userData.email,
  });
  } catch (error) {
    await client.query("ROLLBACK");
    console.log("Penalty job failed:", error.message);
    throw error;
  } finally {
    client.release();
  }
};
const rideAutoExtendJob = async ({ bookingId }) => {
  const client = await pool.connect();
  let userData = null;

  try {
    await client.query("BEGIN");

    const bookingRes = await client.query(
      `SELECT id, "userId", "carId", extension_hours, extension_amount,
              auto_extention_hours_status, penalty_hours, status
       FROM bookings WHERE id = $1 FOR UPDATE`,
      [bookingId]
    );

    if (bookingRes.rows.length === 0) throw new Error("Booking not found");

    const booking = bookingRes.rows[0];

    if (Number(booking.penalty_hours || 0) < 3) {
      await client.query("ROLLBACK");
      return;
    }

    if (booking.status === "completed" || booking.status === "cancelled") {
      await client.query("COMMIT");
      return;
    }

    const carRes = await client.query(
      `SELECT "six_hr_price" FROM cars WHERE id = $1`,
      [booking.carId]
    );

    if (carRes.rows.length === 0) throw new Error("Car not found");

    const carPrice = Number(carRes.rows[0].six_hr_price || 0);
    if (!carPrice) throw new Error("Unable to find extension price for car");

    const EXTcharge = carPrice + 300;

    await client.query(
      `UPDATE bookings SET
         penalty_extention_hours = COALESCE(penalty_extention_hours, 0) + 6,
         penalty_extention_amount = COALESCE(penalty_extention_amount, 0) + $1,
         auto_extention_hours_status = true,
         "updatedAt" = NOW()
       WHERE id = $2`,
      [EXTcharge, bookingId]
    );

    // ✅ Fetch user inside transaction
    const userRes = await client.query(
      `SELECT expo_token, email FROM users WHERE id = $1`,
      [booking.userId]
    );
    userData = userRes.rows[0] ?? null;

    await client.query("COMMIT"); // ✅ Commit last
if (userData.expo_token) {
    await sendNotification(userData.expo_token, "Auto extended trip to 6 hours", body, {
      type: "auto-extension applied",
      bookingId: String(bookingId),
    });
  }

  // ── Email notification (after Expo push) ──
  if (userData.email) {
    await sendEmail({
      to: userData.email,
      subject: `Trip Auto-Extended by 6 Hours – Booking #${bookingId}`,
      text: body,
      html: `
        <p>Hi,</p>
        <p>Your trip for booking <strong>#${bookingId}</strong> has been <strong>auto-extended by 6 hours</strong>.</p>
        <p>An additional charge of has been added to your booking. Please return the vehicle at the earliest to avoid further extensions.</p>
        <p>— Car24 Travels</p>
      `,
    });
  }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // ✅ Queue job and notify AFTER transaction is fully closed
  const jobTimestamp = Date.now();
  await bookingQueue.add("ride-auto-extend", { bookingId }, {
    jobId: `extend-${bookingId}-${jobTimestamp}`,
    delay: 6 * 60 * 60 * 1000,
    removeOnComplete: true,
  });

  if (!userData) {
    console.log("User not found for notification");
    return;
  }

  const body = `Auto-extension for booking #${bookingId} is approved.`;

  await saveCancelRequestToFirebase({
    bookingId: Number(bookingId),
    title: "Ride auto-extended",
    message: body,
    type: "auto-extension",
    fromEmail: "car24Travels",
    toEmail: userData.email,
  });

  if (userData.expo_token) {
    await sendNotification(userData.expo_token, "Auto extended trip to 6 hours", body, {
      type: "auto-extension applied",
      bookingId: String(bookingId),
    });
  }
};
const rideStartReminderJob = async ({ bookingId, expoToken }) => {
  try {
    console.log("Auto reminder job for booking:", bookingId);
    console.log("Auto reminder job for booking:", expoToken);

    if (!expoToken) {
      console.log("No expo token found");
      return;
    }

    // 1. Notify customer
    await sendNotification(
      expoToken,
      "Ride Starts in 3 Hours 🚗",
      "Your booking starts soon. Tap to view booking details.",
      { url: `/(customer)/booking/${bookingId}`, bookingId }
    );

    // 2. Fetch booking + branch head in one query
    const bookingRes = await pool.query(
      `SELECT b."branchId", br."branchHeadId"
       FROM bookings b
       JOIN branches br ON br.id = b."branchId"
       WHERE b.id = $1`,
      [bookingId]
    );

    if (bookingRes.rows.length === 0) {
      console.log("Booking not found");
      return;
    }

    const { branchId, branchHeadId } = bookingRes.rows[0];

    // 3. Fetch staff from users table
    const staffRes = await pool.query(
      `SELECT expo_token, email
       FROM users
       WHERE role IN ('staff', 'subadmin', 'admin')
         AND "branchId" = $1
         AND expo_token IS NOT NULL AND expo_token != ''`,
      [branchId]
    );

    // 4. Fetch staff from management table
    const mgmtRes = await pool.query(
      `SELECT expo_token, email
       FROM management
       WHERE branch = $1
         AND role IN ('staff', 'sub_admin')
         AND expo_token IS NOT NULL AND expo_token != ''`,
      [branchId.toString()]
    );

    // 5. Fetch branch head from management table
    let branchHeadRows = [];
    if (branchHeadId) {
      const branchHeadRes = await pool.query(
        `SELECT expo_token, email
         FROM management
         WHERE id = $1
           AND expo_token IS NOT NULL AND expo_token != ''`,
        [branchHeadId]
      );
      branchHeadRows = branchHeadRes.rows;
    }

    // 6. Merge and deduplicate by email
    const seen = new Set();
    const uniqueRecipients = [
      ...staffRes.rows,
      ...mgmtRes.rows,
      ...branchHeadRows,
    ].filter((r) => {
      if (!r.email || seen.has(r.email)) return false;
      seen.add(r.email);
      return true;
    });

    // 7. Notify all unique recipients
    await Promise.all(
      uniqueRecipients.map(async (recipient) => {
        try {
          await sendNotification(
            recipient.expo_token,
            "Ride Starting Soon 🚗",
            `Booking #${bookingId} starts in 3 hours.`,
            { url: `/(staff)/booking/${bookingId}`, bookingId }
          );

          await saveCancelRequestToFirebase({
            bookingId,
            title: "Ride Starting Soon 🚗",
            message: `Booking #${bookingId} starts in 3 hours.`,
            type: "ride_start_reminder",
            fromEmail: "system",
            toEmail: recipient.email,
          });
        } catch (err) {
          console.log(
            `Failed to notify recipient ${recipient.email}:`,
            err.message
          );
        }
      })
    );

    console.log("✅ Start reminder sent for booking:", bookingId);
  } catch (e) {
    console.log("❌ rideStartReminderJob failed:", e.message);
    throw e;
  }
};
const autoCancle = async ({ bookingId, expoToken }) => {
  console.log("running auto cancle for booking", bookingId);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `
      UPDATE bookings
      SET
        status = 'cancelled',
        cancellation_status = 'approved',
        "updatedAt" = NOW()
      WHERE id = $1
      `,
      [bookingId]
    );

    await client.query("COMMIT");

    console.log("cancelled trip:", bookingId);

    if (expoToken) {
      await sendNotification(
        expoToken,
        "Booking cancelled⏰",
        "Your booking has been cancelled",
        {
          bookingId,
          url: `/(customer)/booking/${bookingId}`,
        }
      );
    }
    console.log("successfully completed add auto cancle job")
  } catch (e) {
    await client.query("ROLLBACK");
    console.log("error at auto cancle job", e);
  } finally {
    client.release();
  }
};
const paymentAutoCancel = async ({ bookingId, expoToken }) => {
  try {
    console.log(`⏰ Payment timeout check for booking ${bookingId}`);

    const result = await pool.query(
      `SELECT
        id,
        status,
        payment_status,
        payment_completed
       FROM bookings
       WHERE id = $1`,
      [bookingId]
    );

    if (result.rows.length === 0) {
      console.log(`❌ Booking ${bookingId} not found`);
      return;
    }

    const booking = result.rows[0];

    console.log("Payment timeout booking:", booking);

    // Payment already completed
    if (booking.payment_completed === true) {
      console.log(
        `✅ Booking ${bookingId} already paid. Payment auto-cancel skipped.`
      );
      return;
    }

    // Booking is no longer pending
    if (booking.status !== "pending") {
      console.log(
        `ℹ️ Booking ${bookingId} is ${booking.status}. Payment auto-cancel skipped.`
      );
      return;
    }

    // Cancel pending booking
    await pool.query(
      `UPDATE bookings
       SET
         status = 'cancelled',
         payment_status = 'cancelled',
         cancellation_status = 'auto_cancelled',
         "updatedAt" = NOW()
       WHERE id = $1
         AND status = 'pending'
         AND payment_completed = false`,
      [bookingId]
    );

    console.log(
      `🚫 Booking ${bookingId} automatically cancelled because payment was not completed within 10 minutes`
    );

    // Notify customer
    if (expoToken) {
      try {
        const data = {
          url: `/(customer)/booking/${bookingId}`,
          bookingId
        };

        const notificationSent = await sendNotification(
          expoToken,
          "Booking Cancelled ⏰",
          "Your payment was not completed within 10 minutes. The booking has been cancelled.",
          data
        );

        if (notificationSent) {
          console.log(
            `✅ Payment timeout notification sent for booking ${bookingId}`
          );
        } else {
          console.log(
            `❌ Payment timeout notification failed for booking ${bookingId}`
          );
        }
      } catch (notificationError) {
        console.error(
          "🚨 Payment cancellation notification error:",
          notificationError
        );
      }
    }

  } catch (error) {
    console.error(
      `❌ Payment auto-cancel failed for booking ${bookingId}:`,
      error
    );

    throw error;
  }
};

module.exports = {
  rideReminderJob,
  ridePenaltyJob,
  rideAutoExtendJob,
    rideStartReminderJob,
    autoCancle,
    paymentAutoCancel
};