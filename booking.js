const express=require("express")
const router=express.Router()
const {pool,redis,fire_db}=require("./connectdb")
const {veriftJWT,createJwt}=require("./jwt")
const minioClient = require("./minioConnect")
const rateLimiter = require("./rateLimiter")
const razorpay = require("./connectRazorPay") 
const sendNotification = require("./expoNotification")
const crypto = require("crypto");
const sendfireNotification=require("./testFirebase")
const bookingQueue=require("./queues/bookingQueue")
const { fetchCollectionData,
  createCollectionExcel,getDateRange}=require("./getExcel")
require("dotenv").config()
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
function calculatePrice(slots, pricing) {
  if (!Array.isArray(slots) || slots.length === 0) {
    throw new Error("Slots are required");
  }

  const { six_hr_price, twelve_hr_price, twentyfour_hr_price } = pricing;

  if (!six_hr_price || !twelve_hr_price || !twentyfour_hr_price) {
    throw new Error("Incomplete pricing configuration");
  }

  // ── Total hours from slots array ──
  const totalHours = slots.reduce((sum, s) => sum + s, 0);

  // ── Smart breakdown ──
  let remaining  = totalHours;
  let totalPrice = 0;

  const days     = Math.floor(remaining / 24);
  totalPrice    += days * twentyfour_hr_price;
  remaining     -= days * 24;

  const halfDays = Math.floor(remaining / 12);
  totalPrice    += halfDays * twelve_hr_price; 
  remaining     -= halfDays * 12;

  const sixHrs   = Math.floor(remaining / 6);
  totalPrice    += sixHrs * six_hr_price;

  console.log(`Smart pricing:
    Total hours : ${totalHours}
    24hr slots  : ${days}     × ₹${twentyfour_hr_price} = ₹${days * twentyfour_hr_price}
    12hr slots  : ${halfDays} × ₹${twelve_hr_price}     = ₹${halfDays * twelve_hr_price}
    6hr slots   : ${sixHrs}   × ₹${six_hr_price}        = ₹${sixHrs * six_hr_price}
    Subtotal    : ₹${totalPrice}
  `);

  const platformFee = Math.ceil(totalPrice * 0.0236);
  const finalAmount = totalPrice + platformFee;

  return finalAmount;
}
const parseISTToUTC = (dateValue) => {
  const dateStr =
    typeof dateValue === 'string'
      ? dateValue
      : dateValue.toISOString().replace('T', ' ').split('.')[0];

  const [datePart, timePart] = dateStr.split(' ');

  const [year, month, day] =
    datePart.split('-').map(Number);

  const [hour, minute, second] =
    timePart.split(':').map(Number);

  // Create UTC timestamp from IST clock time
  return new Date(
    Date.UTC(
      year,
      month - 1,
      day,
      hour - 5,
      minute - 30,
      second || 0
    )
  );
};
async function paymentfunction(amount, bookingId) {
  const order=await razorpay.orders.create({
    amount: amount * 100,
    currency: "INR",
    receipt: `booking_${bookingId}`
  })  
  return order
}
function calculateAdvanceAmount(totalHours) {
  let remaining = totalHours;
  let advance = 0;

  const days = Math.floor(remaining / 24);
  advance += days * 500;
  remaining -= days * 24;

  const halfDays = Math.floor(remaining / 12);
  advance += halfDays * 500;
  remaining -= halfDays * 12;

  const sixHrs = Math.floor(remaining / 6);
  advance += sixHrs * 400;

  console.log(`Smart Advance Calculation:
    Total hours : ${totalHours}
    24hr blocks : ${days}     × ₹500 = ₹${days * 500}
    12hr blocks : ${halfDays} × ₹500 = ₹${halfDays * 500}
    6hr blocks  : ${sixHrs}   × ₹500 = ₹${sixHrs * 400}
    Total Advance : ₹${advance}
  `);

  return advance;
}
router.post("/bookCar", rateLimiter, async (req, res) => {
  const client  = await pool.connect();
  const { carId, branchId, startTime, endTime, useCredits } = req.body;
  
  const lockKey = `lock:car:${carId}`;

  console.log('=== BookCar Request ===');
  console.log('Body:', { carId, branchId, startTime, endTime, useCredits });

  try {
    // ── 1. Extract and Verify JWT Token ──
    const header = req.headers.authorization;
    if (!header) {
      return res.status(401).json({ message: "Missing authorization headers" });
    }
    
    const token = header.split(" ")[1];
    if (!token) {
      return res.status(401).json({ message: "Token not found" });
    }

    const payload = await veriftJWT(token);
    if (!payload) {
      return res.status(401).json({ message: "Invalid or expired token" });
    }

    const userId = payload.id; 
    // ── 1. Redis lock ──
    const lock = await redis.set(lockKey, userId, "NX", "EX", 15);
    console.log('Lock acquired:', lock);

    if (!lock) {
      return res.status(409).json({ message: "Another user is booking this car" });
    }

    await client.query("BEGIN");

    // ── 2. Validate max 30 days (FIX 2) ──
    // In your backend controller
    const pickupDate = new Date(req.body.startTime.replace('T', ' ').replace('Z', ''));
    const dropoffDate = new Date(req.body.endTime.replace('T', ' ').replace('Z', ''));

    // Now your diffDays calculation will be accurate to what the user saw
    const diffDays = (dropoffDate - pickupDate) / (1000 * 60 * 60 * 24);
    
    if (diffDays > 30) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Maximum booking duration is 30 days" });
    }

    const diffMs = dropoffDate.getTime() - pickupDate.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);

    // Prevent negative times or bookings under 6 hours
    if (diffHours < 6) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Minimum booking duration is 6 hours" });
    }

    // Safely calculate the number of 6-hour chunks and generate the array
    const numSlots = Math.round(diffHours / 6);
    const slots = Array(numSlots).fill(6); // e.g., creates [6, 6, 6] for 18 hours
    
    console.log(`Backend securely calculated ${numSlots} slots:`, slots);

    // ── 3. Clean up old pending bookings (FIX 1 - You did this perfectly) ──
    await client.query(`
      DELETE FROM bookings 
      WHERE status = 'pending' 
      AND "createdAt" < NOW() - INTERVAL '15 minutes'
      AND "carId" = $1
    `, [carId]);

    // ── 4. Get user credits ──
    let creditsData = { rows: [] };
    if (useCredits) {
      creditsData = await client.query(
        `SELECT id, remaining_amount, expiry_date
         FROM user_credit
         WHERE user_id = $1
           AND remaining_amount > 0
           AND expiry_date > NOW()
         ORDER BY expiry_date ASC
         FOR UPDATE`,
        [userId]
      );
      console.log('Available credits:', creditsData.rows);
    }

    // ── 5. Get car pricing ──
    const carPrice = await pool.query(
      `SELECT six_hr_price, twelve_hr_price, twentyfour_hr_price 
       FROM ${process.env.cars_table} WHERE id=$1`,
      [carId]
    ); 
    console.log('Car pricing:', carPrice.rows[0]);

    if (carPrice.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Car not found" });
    }

    const pricing = carPrice.rows[0];

    if (!pricing.six_hr_price || !pricing.twelve_hr_price || !pricing.twentyfour_hr_price) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Pricing not configured for this car" });
    }

    // ── 6. Calculate price ──
    console.log('Slots:', slots);
    const price         = calculatePrice(slots, pricing);
    const totalHours = slots.reduce((sum, s) => sum + s, 0);
    const advanceAmount = calculateAdvanceAmount(totalHours);
    console.log('Base price:', price);
    console.log('Advance amount:', advanceAmount);

    // ── 7. Apply credits to ADVANCE ONLY ──
    let usedCredits  = 0;
    let advancePayable = advanceAmount; 

    if (useCredits && creditsData.rows.length > 0) {
      for (let credit of creditsData.rows) {
        if (advancePayable <= 0) break;
        const available = parseFloat(credit.remaining_amount);
        if (available <= advancePayable) {
          advancePayable -= available;
          usedCredits    += available;
        } else {
          usedCredits    += advancePayable;
          advancePayable  = 0;
        }
      }
    }

    console.log('Credits used:', usedCredits);
    console.log('Advance payable after credits:', advancePayable);

    // ── 8. Create booking ──
    const bookingResult = await client.query(
      `INSERT INTO bookings (
        "userId", "carId", "branchId",
        "pickupDate", "dropoffDate",
        "totalPrice", "status", "payment_status",
        "advance_paid", "remaining_amount", "credits_used",
        "createdAt", "updatedAt"
      )
      VALUES ($1,$2,$3,$4,$5,$6,'pending','pending', 0, $6, $7, NOW(),NOW())
      RETURNING id`,
      [
        userId,       // $1
        carId,        // $2
        branchId,     // $3
        startTime,    // $4
        endTime,      // $5
        price,        // $6
        usedCredits,  // $7 
      ]
    );

    const bookingId = bookingResult.rows[0].id;
    console.log('Booking created:', bookingId);

    // ── 9. Credits cover full advance — no Razorpay needed (FIX 3) ──
    if (advancePayable === 0) {
      const otp = Math.floor(100000 + Math.random() * 900000);

      // Deduct credits immediately
      let remainingToDeduct = usedCredits;
      for (let credit of creditsData.rows) {
        if (remainingToDeduct <= 0) break;
        const available = parseFloat(credit.remaining_amount);
        if (available <= remainingToDeduct) {
          remainingToDeduct -= available;
          await client.query(
            `UPDATE user_credit SET remaining_amount = 0 WHERE id = $1`,
            [credit.id]
          );
        } else {
          await client.query(
            `UPDATE user_credit SET remaining_amount = remaining_amount - $1 WHERE id = $2`,
            [remainingToDeduct, credit.id]
          );
          remainingToDeduct = 0;
        }
      }

     
      await client.query(
        `UPDATE bookings 
         SET status = 'confirmed', 
             payment_status = 'partial_paid', 
             "confirmationNumber" = $1,  
             advance_paid = $2,
             remaining_amount = $3
         WHERE id = $4`,
        [otp, advanceAmount, price - advanceAmount, bookingId] 
      );
if(useCredits){
   const userRes=await client.query(
      `SELECT * FROM  users WHERE id=$1`,[payload.id]
          )
        if(userRes.rows.length===0){

        return res.status(400).json({message:"user not found"})
          }
          userData=userRes.rows[0]
       const expoToken=userData.expo_token
const now = Date.now();
const startReminderDelay =
  parseISTToUTC(pickupDate).getTime()
  - now
  - (3 * 60 * 60 * 1000);

console.log("start delay time value=", startReminderDelay);

const reminderDelay =
  parseISTToUTC(dropoffDate).getTime()
  - now
  - (3 * 60 * 60 * 1000);

const penaltyDelay =
  parseISTToUTC(dropoffDate).getTime()
  - now;
    const autoCancletime =
  penaltyDelay - (5 * 60 * 60 * 1000);
  if (startReminderDelay > 0) {
  await bookingQueue.add("ride-start-reminder", { bookingId,expoToken }, {
    jobId: `ride-start-${bookingId}`,
    delay: startReminderDelay,
    removeOnComplete: true
  });
  console.log("job created")
}
if (autoCancletime > 0) {
  await bookingQueue.add("auto-cancle", { bookingId,expoToken }, {
    jobId: `auto-cancle-${bookingId}`,
    delay: autoCancletime,
    removeOnComplete: true
  });
  console.log("job created")
  
}
if (expoToken) {
        try {
          const data = {
            url: `/(customer)/booking/${bookingId}`,
            bookingId: bookingId
          };

          const expoSend = await sendNotification(
            expoToken,
            "Booking Confirmed 🎉",
            "Tap to view your booking & OTP", // 👈 clean UX
            data
          );

          if (expoSend) {
            console.log("✅ Notification sent");
          } else {
            console.log("❌ Notification failed");
          }

        } catch (error) {
          console.error("🚨 Notification error:", error);
        }
      }
}
      await client.query("COMMIT");
      console.log('=== Advance covered by Credits ===');

      

      return res.status(200).json({
        message:       "Advance covered by credits!",
        bookingId,
        price,
        advanceAmount,
        usedCredits,
        advancePayable: 0,
        order:          null,  // no Razorpay
      });
    }

    // ── 10. Create Razorpay order for remaining advance ──
    console.log('Creating Razorpay order for amount:', advancePayable);
    const order = await paymentfunction(advancePayable, bookingId);
    console.log('Razorpay order:', order?.id);

    // Save order id
    await client.query(
      `UPDATE bookings SET "paymentId" = $1 WHERE id = $2`,
      [order.id, bookingId]
    );

    await client.query("COMMIT");
    console.log('=== BookCar Success ===');

    return res.status(200).json({
      message:       "Booking created",
      bookingId,
      price,
      advanceAmount,
      usedCredits,
      advancePayable,  
      order,
    });

  } catch (e) {
    await client.query("ROLLBACK");
    console.error('=== BookCar Error ===');
    console.error('Message:', e?.message);

    return res.status(500).json({
      message: "internal server error",
      error:   e?.message ?? String(e),
    });

  } finally {
    await redis.del(lockKey);
    client.release();
  }
});
router.post("/verify-payment", async (req, res) => {
  const client = await pool.connect();

  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ message: "Missing payment details" });
    }

    // ── Verify signature ──
    const generated_signature = crypto
      .createHmac("sha256", process.env.RazorpayKeySecret)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");

    if (generated_signature !== razorpay_signature) {
      return res.status(400).json({ message: "Invalid payment signature" });
    }

    await client.query("BEGIN");

    // ── Get booking with EXPLICIT columns — no casing issues ──
    const bookingRes = await client.query(
      `SELECT 
        id,
        "userId",
        "totalPrice",
        "paymentId",
        payment_status,
        advance_paid,
        remaining_amount,
        credits_used,
        "pickupDate",   -- 💥 Added to calculate total hours
        "dropoffDate"   -- 💥 Added to calculate total hours
       FROM bookings 
       WHERE "paymentId" = $1`,
      [razorpay_order_id]
    );

    if (bookingRes.rows.length === 0) {
      return res.status(404).json({ message: "Booking not found" });
    }

    const booking = bookingRes.rows[0];
    console.log('Booking fetched:', booking);

    // ── Idempotency check ──
    if (booking.payment_status === "partial_paid") {
      return res.json({ message: "Payment already processed" });
    }

    // ── Calculate amounts — now totalPrice is correct casing ──
    const totalPrice = Number(booking.totalPrice);
    const pickupDate = new Date(booking.pickupDate);
    const dropoffDate = new Date(booking.dropoffDate);
    const totalHours = Math.ceil((dropoffDate - pickupDate) / (1000 * 60 * 60));

    // 💥 Get the exact same advance amount using our new function!
    const advance    = calculateAdvanceAmount(totalHours);
    const remaining  = totalPrice - advance;
    const otp        = Math.floor(100000 + Math.random() * 900000);

    console.log('totalPrice:', totalPrice);
    console.log('advance:', advance);
    console.log('remaining:', remaining);

    // ── Deduct credits if used ──
    const creditsToDeduct = Number(booking.credits_used || 0);
    console.log('Credits to deduct:', creditsToDeduct);

    if (creditsToDeduct > 0) {
      let remainingToDeduct = creditsToDeduct;

      const creditsData = await client.query(
        `SELECT id, remaining_amount
         FROM user_credit
         WHERE user_id = $1
           AND remaining_amount > 0
           AND expiry_date > NOW()
         ORDER BY expiry_date ASC
         FOR UPDATE`,
        [booking.userId]  // ← now correct because explicit SELECT
      );

      console.log('Credits rows:', creditsData.rows);

      for (let credit of creditsData.rows) {
        if (remainingToDeduct <= 0) break;
        const available = parseFloat(credit.remaining_amount);
        if (available <= remainingToDeduct) {
          remainingToDeduct -= available;
          await client.query(
            `UPDATE user_credit SET remaining_amount = 0 WHERE id = $1`,
            [credit.id]
          );
        } else {
          await client.query(
            `UPDATE user_credit SET remaining_amount = remaining_amount - $1 WHERE id = $2`,
            [remainingToDeduct, credit.id]
          );
          remainingToDeduct = 0;
        }
      }
      console.log('Credits deducted successfully');
    }

    // ── Update booking ──
    await client.query(
      `UPDATE bookings
       SET
         status                = 'confirmed',
         payment_status        = 'partial_paid',
         advance_paid          = $1,
         remaining_amount      = $2,
         "razorpay_payment_id" = $3,
         "updatedAt"           = NOW(),
         "confirmationNumber"  = $4
       WHERE "paymentId" = $5`,
      [advance, remaining, razorpay_payment_id, otp, razorpay_order_id]
    );

    await client.query("COMMIT");
        console.log(`✅ Booking ${booking.id} confirmed`);

    const userRes=await client.query(
      `SELECT * FROM  users WHERE id=$1`,[bookingRes.rows[0].userId]
          )
        if(userRes.rows.length===0){

        return res.status(400).json({message:"user not found"})
          }
          userData=userRes.rows[0]
       const expoToken=userData.expo_token
const now = Date.now();

const bookingId=booking.id
const IST_OFFSET = 0;
const startReminderDelay =
  parseISTToUTC(booking.pickupDate).getTime()
  - now
  - (3 * 60 * 60 * 1000);

console.log("start delay time value=", startReminderDelay);

const reminderDelay =
  parseISTToUTC(booking.dropoffDate).getTime()
  - now
  - (3 * 60 * 60 * 1000);

const penaltyDelay =
  parseISTToUTC(booking.dropoffDate).getTime()
  - now;

    console.log('\n──────── BOOKING TIME DEBUG ────────');

console.log('Booking ID:', bookingId);

console.log('\nRAW DB VALUES:');
console.log('Pickup DB:', booking.pickupDate);
console.log('Dropoff DB:', booking.dropoffDate);

// console.log('\nCONVERTED UTC VALUES:');
// console.log('Pickup UTC:', pickupUTC.toISOString());
// console.log('Dropoff UTC:', dropoffUTC.toISOString());

// console.log('\nLOCAL IST DISPLAY:');
// console.log('Pickup IST:', pickupUTC.toLocaleString('en-IN'));
// console.log('Dropoff IST:', dropoffUTC.toLocaleString('en-IN'));

console.log('\nDELAYS:');
console.log('Start Reminder Delay:', startReminderDelay);
console.log('Reminder Delay:', reminderDelay);
console.log('Penalty Delay:', penaltyDelay);

console.log('────────────────────────────────────\n');
console.log("start delay time value=",reminderDelay)
  console.log("start delay time value=",penaltyDelay)
  console.log(typeof booking.dropoffDate);
console.log(booking.dropoffDate);
  const autoCancletime =
  penaltyDelay - (5 * 60 * 60 * 1000);
console.log("pickup raw:", booking.pickupDate);
console.log("pickup parsed:", new Date(booking.pickupDate).toString());
console.log("pickup ISO:", new Date(booking.pickupDate).toISOString());
console.log("now ISO:", new Date(now).toISOString());
if (startReminderDelay > 0) {
  await bookingQueue.add("ride-start-reminder", { bookingId,expoToken }, {
    jobId: `ride-start-${bookingId}`,
    delay: startReminderDelay,
    removeOnComplete: true
  });
  console.log("job created")
}
if (autoCancletime > 0) {
  await bookingQueue.add("auto-cancle", { bookingId,expoToken }, {
    jobId: `auto-cancle-${bookingId}`,
    delay: autoCancletime,
    removeOnComplete: true
  });
  console.log("job created")
}
    res.json({
      message:   "Payment verified successfully",
      bookingId: booking.id,
      otp,
    });


    if (expoToken) {
        try {
          const data = {
            url: `/(customer)/booking/${booking.id}`,
            bookingId: booking.id
          };

          const expoSend = await sendNotification(
            expoToken,
            "Booking Confirmed 🎉",
            "Tap to view your booking & OTP", // 👈 clean UX
            data
          );

          if (expoSend) {
            console.log("✅ Notification sent");
          } else {
            console.log("❌ Notification failed");
          }

        } catch (error) {
          console.error("🚨 Notification error:", error);
        }
      }

  } catch (err) {
    console.error('=== verify-payment ERROR ===');
    console.error('Message:', err.message);
    await client.query("ROLLBACK");
    res.status(500).json({ message: "Verification failed", error: err.message });
  } finally {
    client.release();
  }
});
router.post(
  "/razorpay/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const client = await pool.connect();
    try {
      // ── Verify signature ──
      const signature = req.headers["x-razorpay-signature"];
      const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
      const expected = crypto
        .createHmac("sha256", secret)
        .update(req.body)
        .digest("hex");

      if (expected !== signature) {
        return res.status(400).json({ message: "Invalid webhook signature" });
      }

      const event = JSON.parse(req.body.toString("utf8"));

      // ── Handle payment failure ──
      if (event.event === "payment.failed") {
        const failedPayment = event.payload?.payment?.entity;
        const razorpayOrderId = failedPayment?.order_id;
        const failReason = failedPayment?.error_description || "Payment failed";

        if (razorpayOrderId) {
          const bookingRes = await pool.query(
            `SELECT b.id, b."branchId", u.expo_token, u.email, u.phone
             FROM bookings b
             JOIN users u ON u.id = b."userId"
             WHERE b."paymentId" = $1`,
            [razorpayOrderId]
          );

          if (bookingRes.rows.length > 0) {
            const { id: bookingId, branchId, expo_token, email, phone } = bookingRes.rows[0];

            // ── Fetch admins for this branch ──
            const adminsRes = await pool.query(
              `SELECT email, expo_token
               FROM management
               WHERE role IN ('admin', 'sub_admin')
                 AND branch = $1`,
              [branchId.toString()]
            );
            const admins = adminsRes.rows;

            // ── Save to Firebase + notify each admin ──
            await Promise.all(
              admins.map(async (admin) => {
                await saveCancelRequestToFirebase({
                  bookingId,
                  title: "Payment Failed ❌",
                  message: `Payment failed for booking #${bookingId}. Customer phone: ${phone}. Reason: ${failReason}`,
                  type: "payment_failed",
                  fromEmail: email,
                  toEmail: admin.email,
                });

                if (admin.expo_token) {
                  await sendNotification(
                    admin.expo_token,
                    "Payment Failed ❌",
                    `Booking #${bookingId} — payment failed. Customer: ${phone}`,
                    { url: `/(staff)/booking/${bookingId}`, bookingId }
                  );
                }

                if (admin.email) {
                  await sendEmail({
                    to: admin.email,
                    subject: `Payment Failed – Booking #${bookingId}`,
                    text: `Payment failed for booking #${bookingId}. Customer phone: ${phone}. Reason: ${failReason}`,
                    html: `
                      <p>Hi,</p>
                      <p>A payment has failed for booking <strong>#${bookingId}</strong>.</p>
                      <p><strong>Customer Phone:</strong> ${phone}</p>
                      <p><strong>Reason:</strong> ${failReason}</p>
                      <p>— Car24 Travels</p>
                    `,
                  });
                }
              })
            );

            // ── Notify customer ──
            if (expo_token) {
              await sendNotification(
                expo_token,
                "Payment Failed ❌",
                `Your payment could not be processed. Reason: ${failReason}`,
                { url: `/(customer)/booking/${bookingId}`, bookingId }
              );
            }

            if (email) {
              await sendEmail({
                to: email,
                subject: `Payment Failed for Booking #${bookingId}`,
                text: `Your payment for booking #${bookingId} failed. Reason: ${failReason}. Please retry your payment.`,
                html: `
                  <p>Hi,</p>
                  <p>Your payment for booking <strong>#${bookingId}</strong> could not be processed.</p>
                  <p><strong>Reason:</strong> ${failReason}</p>
                  <p>Please retry your payment to confirm your booking.</p>
                  <p>— Car24 Travels</p>
                `,
              });
            }
          }
        }

        return res.status(200).json({ message: "Failure handled" });
      }

      // ── Ignore all events except payment.captured / order.paid ──
      if (
        event.event !== "payment.captured" &&
        event.event !== "order.paid"
      ) {
        return res.status(200).json({ message: "Ignored" });
      }

      // ── Success flow ──
      const payment = event.payload?.payment?.entity;
      const order = event.payload?.order?.entity;
      const razorpayOrderId = payment?.order_id || order?.id;
      const razorpayPaymentId = payment?.id;

      if (!razorpayOrderId || !razorpayPaymentId) {
        return res.status(400).json({ message: "Missing payment data" });
      }

      await client.query("BEGIN");

      const bookingRes = await client.query(
        `SELECT id, "userId", "totalPrice", "paymentId", payment_status, advance_paid,
                remaining_amount, credits_used, "pickupDate", "dropoffDate", "razorpay_payment_id"
         FROM bookings
         WHERE "paymentId" = $1
         FOR UPDATE`,
        [razorpayOrderId]
      );

      if (bookingRes.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Booking not found" });
      }

      const booking = bookingRes.rows[0];

      if (
        booking.payment_status === "partial_paid" ||
        booking.razorpay_payment_id === razorpayPaymentId
      ) {
        await client.query("ROLLBACK");
        return res.status(200).json({ message: "Already processed" });
      }

      await client.query("COMMIT");

      const userRes = await pool.query(
        `SELECT * FROM users WHERE id = $1`,
        [booking.userId]
      );

      if (userRes.rows.length === 0) {
        return res.status(400).json({ message: "User not found" });
      }

      const userData = userRes.rows[0];
      const expoToken = userData.expo_token;
      const now = Date.now();
      const bookingId = booking.id;

      const startReminderDelay = new Date(booking.pickupDate).getTime() - now - (3 * 60 * 60 * 1000);
      const penaltyDelay       = new Date(booking.dropoffDate).getTime() - now;
      const autoCancletime     = penaltyDelay - (5 * 60 * 60 * 1000);

      console.log("start delay time value=", startReminderDelay);
      console.log(expoToken);

      if (startReminderDelay > 0) {
        await bookingQueue.add("ride-start-reminder", { bookingId, expoToken }, {
          jobId: `ride-start-${bookingId}`,
          delay: startReminderDelay,
          removeOnComplete: true,
        });
        console.log("job created");
      }

      if (autoCancletime > 0) {
        await bookingQueue.add("auto-cancle", { bookingId, expoToken }, {
          jobId: `auto-cancle-${bookingId}`,
          delay: autoCancletime,
          removeOnComplete: true,
        });
        console.log("job created");
      }

      return res.status(200).json({ ok: true });

    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Webhook error:", err.message);
      return res.status(500).json({ message: "Webhook failed" });
    } finally {
      client.release();
    }
  }
);
router.post("/staff-booking", rateLimiter, async (req, res) => {
  const client = await pool.connect();

  try {
   
    const header = req.headers.authorization;
    if (!header) {
      return res.status(401).json({ message: "Missing authorization headers" });
    }

    const token = header.split(" ")[1];
    const payload = await veriftJWT(token);

    if (!payload || (payload.role !== "staff" && payload.role !== "admin")) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    const staffId = payload.id;

    const {
      userId,
      carId,
      branchId,
      startTime,
      endTime,
      advancePaid
    } = req.body;

    await client.query("BEGIN");

    // 🕒 TIME VALIDATION
    const pickupDate  = new Date(startTime);
    const dropoffDate = new Date(endTime);

    const diffMs = dropoffDate - pickupDate;
    const diffHours = diffMs / (1000 * 60 * 60);

    if (diffHours < 6) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Minimum 6 hours booking required" });
    }

    // 🚗 GET CAR PRICE
    const carPrice = await client.query(
      `SELECT six_hr_price, twelve_hr_price, twentyfour_hr_price 
       FROM cars WHERE id=$1`,
      [carId]
    );

    if (carPrice.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Car not found" });
    }

    const pricing = carPrice.rows[0];

    const numSlots = Math.round(diffHours / 6);
    const slots = Array(numSlots).fill(6);

    const totalPrice = calculatePrice(slots, pricing);

    // 💰 CALCULATE REMAINING
    const remainingAmount = totalPrice - (advancePaid || 0);

    // 🔢 OTP / confirmation
    const otp = Math.floor(100000 + Math.random() * 900000);

    // 📝 INSERT BOOKING
    const bookingResult = await client.query(
      `INSERT INTO bookings (
        "userId", "carId", "branchId",
        "pickupDate", "dropoffDate",
        "totalPrice",
        status,
        payment_status,
        advance_paid,
        remaining_amount,
        onsite,
        "createdBy",
        "confirmationNumber",
        "createdAt",
        "updatedAt"
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),NOW())
      RETURNING *`,
      [
        userId,
        carId,
        branchId,
        startTime,
        endTime,
        totalPrice,
        "confirmed",                 // 👈 direct confirm
        advancePaid > 0 ? "partial_paid" : "pending",
        advancePaid || 0,
        remainingAmount,
        true,                        // 👈 onsite
        staffId,
        otp
      ]
    );

    const booking = bookingResult.rows[0];

    await client.query("COMMIT");
const IST_OFFSET =0;
    // 🔥 SAME CRON JOBS (NO CHANGE)
    const now = Date.now();
    const bookingId = booking.id;

   const reminderDelay =
  parseISTToUTC(booking.dropoffDate).getTime()
  - now
  - (3 * 60 * 60 * 1000);

const penaltyDelay =
  parseISTToUTC(booking.dropoffDate).getTime()
  - now;
    const autoExtendDelay =
      penaltyDelay + (60 * 60 * 1000);

    if (reminderDelay > 0) {
      await bookingQueue.add("ride-reminder", { bookingId }, {
        delay: reminderDelay
      });
    }

    if (penaltyDelay > 0) {
      await bookingQueue.add("ride-penalty", { bookingId }, {
        delay: penaltyDelay
      });
    }

    if (autoExtendDelay > 0) {
      await bookingQueue.add("ride-auto-extend", { bookingId }, {
        delay: autoExtendDelay
      });
    }

   

    return res.status(201).json({
      message: "Onsite booking created successfully",
      booking
    });

  } catch (e) {
    await client.query("ROLLBACK");
    console.error("Staff Booking Error:", e);

    return res.status(500).json({
      message: "internal server error",
      error: e.message
    });
  } finally {
    client.release();
  }
});
router.post("/request-cancel/:bookingId", rateLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    const header = req.headers.authorization;
if (!header) {
  return res.status(401).json({ message: "Missing authorization headers" });
}

const token = header.split(" ")[1];
if (!token) {
  return res.status(401).json({ message: "Token not found" });
}

const payload = await veriftJWT(token);
if (!payload?.id) {
  return res.status(401).json({ message: "Invalid or expired token" });
}

const userId = payload.id; // ✅ REAL USER ID
    const { bookingId } = req.params;

    await client.query("BEGIN");


    const bookingRes = await client.query(
      `SELECT id, "userId", "branchId", status, credits_used, cancellation_status 
       FROM bookings WHERE id = $1 FOR UPDATE`,
      [bookingId]
    );

    if (bookingRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Booking not found" });
    }

    const booking = bookingRes.rows[0];

    if (booking.userId !== userId) {
      await client.query("ROLLBACK");

      return res.status(403).json({
        message: "Unauthorized cancellation request"
      });
    }

    // 2. Validations
    if (booking.cancellation_status === 'pending') {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Cancellation already requested." });
    }
    if (Number(booking.credits_used) > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Bookings paid with credits cannot be cancelled." });
    }
    if (['completed', 'cancelled'].includes(booking.status)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: `Booking already ${booking.status}` });
    }

    // 3. Update cancellation status to pending
    await client.query(
      `UPDATE bookings 
       SET cancellation_status = 'pending', "updatedAt" = NOW() 
       WHERE id = $1`,
      [bookingId]
    );

    // 4. Find ALL Staff and Admins for this branch (Assuming users.branch is varchar)
   


    await client.query("COMMIT");

const userRes = await pool.query(
  `SELECT email
   FROM users
   WHERE id = $1`,
  [booking.userId]
);
const userEmail = userRes.rows[0]?.email;
const staffTokensRes = await pool.query(
  `SELECT  expo_token,email
   FROM management
   WHERE branch = $1 AND role IN ('staff', 'sub_admin')`,
  [booking.branchId.toString()]
);


const expoTokens = staffTokensRes.rows
  .map(row => row.expo_token)
  .filter(Boolean);
  const staffEmails = staffTokensRes.rows
  .map(row => row.email)
  .filter(Boolean);

const title = "New Cancellation Request";
const body = `Customer requested cancellation for booking #${bookingId}. Waiting for approval.`;
const data = {
  type: "cancel_request",
  bookingId: String(bookingId),
  from: String(userId),
};


for (const expoToken of expoTokens) {
  await sendNotification(expoToken, title, body, data);
}
if (!userEmail) {
  return res.status(404).json({ message: "Customer email not found" });
}
for (const email of staffEmails) {
  await saveCancelRequestToFirebase({
    bookingId: Number(bookingId),
    title: "Ride Cancellation Request",
    message: body,
    type: "cancel_request",
    fromEmail: userEmail,
    toEmail: email,
  });
}

    return res.status(200).json({
      message: "Cancellation request sent to branch staff for approval."
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error('Request Cancel Error:', error.message);
    return res.status(500).json({ message: "Internal server error" });
  } finally {
    client.release();
  }
});
router.post("/reject-cancel/:id", rateLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    // ── 1. Security: Extract Staff ID from Token ──
    const header = req.headers.authorization;
    if (!header) {
      return res.status(401).json({ message: "Missing authorization headers" });
    }

    const token = header.split(" ")[1];
    if (!token) {
      return res.status(401).json({ message: "Token not found" });
    }

    const payload = await veriftJWT(token);
    if (!payload?.id) {
      return res.status(401).json({ message: "Invalid or expired token" });
    }

    const staffId = payload.id; 
    const bookingId = req.params.id;

    // ── 2. Start Transaction ──
    await client.query("BEGIN");

    // Lock the row so no double-clicks happen
    const bookingRes = await client.query(
      `SELECT id, "userId", "totalPrice", status, payment_status, advance_paid, cancellation_status 
       FROM bookings WHERE id = $1 FOR UPDATE`,
      [bookingId]
    );

    if (bookingRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Booking not found" });
    }

    const booking = bookingRes.rows[0];

    // Ensure it's actually waiting for approval
    if (booking.cancellation_status !== 'pending') {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "No pending cancellation request found for this booking." });
    }

    await client.query(
      `UPDATE bookings 
       SET  
         cancellation_status = 'rejected', 
         "updatedAt" = NOW()
       WHERE id = $1`,
      [bookingId]
    );

    await client.query("COMMIT");
const userRes=await client.query(
      `SELECT * FROM  users WHERE id=$1`,[booking.userId]
          )
        if(userRes.rows.length===0){

        return res.status(400).json({message:"user not found"})
          }
          userData=userRes.rows[0]
       const expoToken=userData.expo_token
       const userEmail=userData.email
       const title = "Cancellation Request rejected";
const body = `cancellation for booking #${bookingId}.is rejected.`;
const data = {
  type: "cancel_request accepted",
  bookingId: String(bookingId),
  from: String(staffId),
};


await saveCancelRequestToFirebase({
    bookingId: Number(bookingId),
    title: "Ride Cancellation Request rejected",
    message: body,
    type: "cancel_request_rejected",
    fromEmail: userEmail,
    toEmail: userEmail,
  });
if(expoToken){
  await sendNotification(expoToken, title, body, data);

}
    return res.status(200).json({
      message: "Booking cancelled rejected and user notified successfully.",
      refundedToCredits: advancePaid > 0,
      refundAmount: advancePaid,
    });

  } catch (e) {
    await client.query("ROLLBACK");
    console.error('Approve Cancel Error:', e.message);
    return res.status(500).json({ message: "Internal server error" });
  } finally {
    client.release();
  }
});
router.post("/approve-cancel/:id", rateLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    // ── 1. Security: Extract Staff ID from Token ──
    const header = req.headers.authorization;
    if (!header) {
      return res.status(401).json({ message: "Missing authorization headers" });
    }

    const token = header.split(" ")[1];
    if (!token) {
      return res.status(401).json({ message: "Token not found" });
    }

    const payload = await veriftJWT(token);
    if (!payload?.id) {
      return res.status(401).json({ message: "Invalid or expired token" });
    }

    const staffId = payload.id; 
    const bookingId = req.params.id;

    // ── 2. Start Transaction ──
    await client.query("BEGIN");

    // Lock the row so no double-clicks happen
    const bookingRes = await client.query(
      `SELECT id, "userId", "totalPrice", status, payment_status, advance_paid, cancellation_status 
       FROM bookings WHERE id = $1 FOR UPDATE`,
      [bookingId]
    );

    if (bookingRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Booking not found" });
    }

    const booking = bookingRes.rows[0];

    // Ensure it's actually waiting for approval
    if (booking.cancellation_status !== 'pending') {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "No pending cancellation request found for this booking." });
    }
 if (!booking.advance_paid ) {
      await client.query("ROLLBACK");
      console.log("advance paid=",booking.advance_paid)
      return res.status(400).json({ message: "not getting advance paid from server" });
    }

    const advancePaid = Number(booking.advance_paid);
console.log("advance paid=",advancePaid)
    // ── 3. Add Money to User Credits (Wallet) ──
    if (booking.payment_status === 'partial_paid' && advancePaid > 0) {
      await client.query(
        `INSERT INTO user_credit (user_id, amount, remaining_amount, expiry_date, created_at)
         VALUES ($1, $2, $2, NOW() + INTERVAL '1 months', NOW())`,
        [booking.userId, advancePaid]
      );
      console.log(`✅ Refunded ₹${advancePaid} to User ${booking.userId}'s wallet.`);
    }

    // ── 4. Cancel Booking, Approve Request, and Update Payment Status ──
    await client.query(
      `UPDATE bookings 
       SET 
         status = 'cancelled', 
         cancellation_status = 'approved', 
         payment_status = CASE 
            WHEN advance_paid > 0 THEN 'refunded' 
            ELSE payment_status 
         END,
         "updatedAt" = NOW()
       WHERE id = $1`,
      [bookingId]
    );

    // ── 5. Send Firebase Notification to User ──
    const autoCancelJobId = `auto-cancle-${bookingId}`;
const penaltyJobCancle=`penalty-${bookingId}`
const rideStartJobCancle=`ride-start-${bookingId}`
const rideExtendJobCancle=`extend-${bookingId}`
try {
  const removed = await bookingQueue.remove(autoCancelJobId);
  const pj=await bookingQueue.remove(penaltyJobCancle)
    const sj=await bookingQueue.remove(rideStartJobCancle)
      const ej=await bookingQueue.remove(rideExtendJobCancle)
  console.log("Removed all job");
} catch (err) {
  console.error("Error removing auto-cancel job:", err);
}

    // ── 6. Commit & Send Response ──
    await client.query("COMMIT");
const userRes=await client.query(
      `SELECT * FROM  users WHERE id=$1`,[booking.userId]
          )
        if(userRes.rows.length===0){

        return res.status(400).json({message:"user not found"})
          }
          userData=userRes.rows[0]
       const expoToken=userData.expo_token
       const userEmail=userData.email
       const title = "Cancellation Request approved";
const body = `cancellation for booking #${bookingId}.is approved.`;
const data = {
  type: "cancel_request accepted",
  bookingId: String(bookingId),
  from: String(staffId),
};


await saveCancelRequestToFirebase({
    bookingId: Number(bookingId),
    title: "Ride Cancellation Request accepted",
    message: body,
    type: "cancel_request_accepted",
    fromEmail: userEmail,
    toEmail: userEmail,
  });
if(expoToken){
  await sendNotification(expoToken, title, body, data);

}
    return res.status(200).json({
      message: "Booking cancelled and user notified successfully.",
      refundedToCredits: advancePaid > 0,
      refundAmount: advancePaid,
    });

  } catch (e) {
    await client.query("ROLLBACK");
    console.error('Approve Cancel Error:', e.message);
    return res.status(500).json({ message: "Internal server error" });
  } finally {
    client.release();
  }
});
router.get("/cancellation-requests", rateLimiter, async (req, res) => {
  try {
    console.log("========================================");
    console.log("🔍 [API] /cancellation-requests STARTED");
    
    // 1. Verify Token
    const header = req.headers.authorization;
    if (!header) return res.status(401).json({ message: "Missing authorization headers" });
    
    const token = header.split(" ")[1];
    if (!token) return res.status(401).json({ message: "Token not found" });

    const payload = await veriftJWT(token);
    if (!payload) return res.status(401).json({ message: "Invalid or expired token" });

    // 2. Get Branch ID
    const { branchId } = req.query;
    console.log("➡️ 1. Raw branchId from frontend:", branchId);
    
    if (!branchId) {
      console.log("❌ ERROR: No branchId provided!");
      return res.status(400).json({ message: "Branch ID is required to fetch cancellations" });
    }

    const numericBranchId = Number(branchId);
    console.log("➡️ 2. Converted numericBranchId:", numericBranchId);

    // 💥 --- DIAGNOSTIC X-RAY START --- 💥
    // Let's ask the database what it actually has for this branch!
    const testQuery = await pool.query(
      `SELECT id, cancellation_status FROM bookings WHERE "branchId" = $1 ORDER BY id DESC LIMIT 5`, 
      [numericBranchId]
    );
    console.log("➡️ 3. DIAGNOSTIC: Here are the last 5 bookings for this branch:");
    console.table(testQuery.rows); // This will print a nice table in your terminal!
    // 💥 --- DIAGNOSTIC X-RAY END --- 💥

    // 3. MAIN SQL QUERY
    const query = `
      SELECT 
        b.id AS booking_id,
        b."pickupDate",
        b."dropoffDate",
        b."totalPrice",
        b.advance_paid,
        b.payment_status,
        b.cancellation_status,
        b.status AS booking_status,
        b."userId",
        u.name AS user_name,
        u.email AS user_email,
        u.mobileno AS user_mobile,
        u.address AS user_address,
        c.model AS car_name,               
        c."licensePlate" AS car_number     
      FROM bookings b
      LEFT JOIN users u ON b."userId" = u.id
      LEFT JOIN cars c ON b."carId" = c.id
      WHERE b.cancellation_status = 'pending' 
        AND b."branchId" = $1
      ORDER BY b."updatedAt" DESC
    `;

    const result = await pool.query(query, [numericBranchId]);
    
    console.log(`➡️ 4. SUCCESS: Found ${result.rows.length} pending cancellation requests!`);
    console.log("========================================");

    return res.status(200).json({
      success: true,
      data: result.rows
    });

  } catch (error) {
    console.error("❌ Fetch Cancellations Error:", error.message);
    return res.status(500).json({ message: "Internal server error" });
  }
});
// router.post("/cancelBooking/:id", rateLimiter, async (req, res) => {
//   const client = await pool.connect();
//   try {
//     await client.query("BEGIN");

//     // ── Get booking with explicit columns ──
//     const bookingRes = await client.query(
//       `SELECT 
//         id,
//         "userId",
//         "totalPrice",
//         status,
//         payment_status,
//         advance_paid,
//         credits_used
//        FROM bookings 
//        WHERE id = $1`,
//       [req.params.id]
//     );

//     if (bookingRes.rows.length === 0) {
//       return res.status(404).json({ message: "Booking not found" });
//     }

//     const booking = bookingRes.rows[0];
//     console.log('Cancel booking:', booking);

//     // ── Can't cancel if credits were used ──
//     if (Number(booking.credits_used) > 0) {
//       return res.status(400).json({
//         message: "Bookings paid with credits cannot be cancelled"
//       });
//     }

//     // ── Can't cancel if already completed/cancelled ──
//     if (['completed', 'cancelled'].includes(booking.status)) {
//       return res.status(400).json({
//         message: `Booking already ${booking.status}`
//       });
//     }

//     // ── Refund advance to credits if payment was done ──
//     const advancePaid = Number(booking.advance_paid);

//     if (booking.payment_status === 'partial_paid' && advancePaid > 0) {
//       await client.query(
//         `INSERT INTO user_credit (user_id, amount, remaining_amount, expiry_date, created_at)
//          VALUES ($1, $2, $2, NOW() + INTERVAL '1 months', NOW())`,
//         [booking.userId, advancePaid]  // ← correct casing now
//       );
//       console.log(`Refund ₹${advancePaid} added to credits for user ${booking.userId}`);
//     }

//     // ── Update booking status ──
//     await client.query(
//       `UPDATE bookings 
//        SET 
//          status = 'cancelled', 
//          payment_status = CASE 
//             WHEN advance_paid > 0 THEN 'refunded' 
//             ELSE payment_status 
//          END,
//          "updatedAt" = NOW()
//        WHERE id = $1`,
//       [req.params.id]
//     );
//     await client.query("COMMIT");

//     res.json({
//       message:           "Booking cancelled successfully",
//       refundedToCredits: advancePaid > 0,
//       refundAmount:      advancePaid,
//     });

//   } catch (e) {
//     await client.query("ROLLBACK");
//     console.error('cancelBooking error:', e.message);
//     res.status(500).json({ message: "Internal server error", error: e.message });
//   } finally {
//     client.release();
//   }
// });
router.get("/getBooking/:id", rateLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    console.log('=== getBooking ===', id);

    // 💥 UPDATED QUERY: Added LEFT JOIN on the ratings table
    const result = await pool.query(`
      SELECT 
        b.*,
        c.model, 
        c.images, 
        c."fuelType",          
        c.transmission, 
        c."seatingCapacity",   
        c.colour,
        br.name as branch_name, 
        br.city as branch_city,
        br.phone as branch_phone,
        br.id as branch_id,
        br.location_link as location_link,
        r.id as rating_id  -- 💥 Returns the row ID if rated, or null if not rated
      FROM bookings b
      JOIN ${process.env.cars_table} c ON b."carId" = c.id
      JOIN branches br ON b."branchId" = br.id
      LEFT JOIN ratings r ON b.id = r.booking_id  -- 💥 Left join handles empty/non-existent ratings cleanly
      WHERE b.id = $1
    `, [id]);

    console.log('Rows found:', result.rows.length);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Booking not found" });
    }

    let booking = result.rows[0];

    // 💥 THE MAGIC: Convert filenames to Live URLs for this booking!
    if (booking.images && booking.images.length > 0) {
      const finalUrls = await Promise.all(booking.images.map(async (imgString) => {
        try {
          // Keep old Unsplash URLs exactly as they are
          if (imgString.startsWith("http://") || imgString.startsWith("https://")) {
            return imgString; 
          }
          
          // Generate secure MinIO URLs for new uploads
          return await minioClient.presignedGetObject("carimages", imgString, 24 * 60 * 60);
          
        } catch (err) {
          // 💥 NOW WE PRINT THE ACTUAL ERROR!
          console.error("Failed to generate URL for:", imgString, "👉 ACTUAL ERROR:", err.message ? err.message : err);
          return null; 
        }
      }));
      
      // Update the booking object with the live URLs
      booking.images = finalUrls.filter(url => url !== null);
    }

    // Send the updated booking object to the frontend
    res.json(booking);

    // console.log(result)
    
  } catch (e) {
    console.error('getBooking error:', e.message);
    res.status(500).json({ message: "Internal server error", error: e.message });
  }
});
router.get("/myBookings", rateLimiter, async (req, res) => {
  try {
    // ── 1. Extract and Verify JWT Token ──
    const header = req.headers.authorization;
    if (!header) {
      return res.status(401).json({ message: "Missing authorization headers" });
    }
    
    const token = header.split(" ")[1];
    if (!token) {
      return res.status(401).json({ message: "Token not found" });
    }

    const payload = await veriftJWT(token);
    if (!payload) {
      return res.status(401).json({ message: "Invalid or expired token" });
    }

    const userId = payload.id; 

    // ── 2. Fetch Bookings for this Specific User ──
    const result = await pool.query(`
      SELECT 
        b.id, b."userId", b."carId", b."branchId", b."pickupDate",
        b."dropoffDate", b."totalPrice", b.status, b.payment_status,
        b.advance_paid, b.remaining_amount, b."paymentId", b.cancellation_status,
         b."confirmationNumber", b."createdAt", b."updatedAt",b."extension_hours", b."extension_status",
        b.razorpay_payment_id, b."penalty_extention_hours", b."auto_extention_hours_status",
        
        b.ride_start_time, 
        b.ride_end_time,
        
        c.model, c.images, c."fuelType", c.transmission, c."seatingCapacity",c."licensePlate",
        br.name as branch_name, br.city as branch_city
      FROM bookings b
      JOIN ${process.env.cars_table} c ON b."carId" = c.id
      JOIN branches br ON b."branchId" = br.id
      WHERE b."userId" = $1 AND b.status != 'pending'
      ORDER BY b."createdAt" DESC
    `, [userId]);

    // ── 3. THE MAGIC: Convert all filenames to Live URLs! ──
    // Notice we skip the old display_status logic and just map over result.rows directly
    const finalBookings = await Promise.all(result.rows.map(async (booking) => {
      if (booking.images && booking.images.length > 0) {
        const liveUrls = await Promise.all(booking.images.map(async (imgString) => {
          try {
            if (imgString.startsWith("http://") || imgString.startsWith("https://")) {
              return imgString; 
            }
            return await minioClient.presignedGetObject("carimages", imgString, 24 * 60 * 60);
          } catch (err) {
            console.error("Failed to generate URL for:", imgString);
            return null; 
          }
        }));
        
        booking.images = liveUrls.filter(url => url !== null);
      }
      return booking;
    }));

    console.log(`Bookings found for User ${userId}:`, finalBookings.length);
    res.json(finalBookings);
    // console.log(result);

  } catch (e) {
    console.error('myBookings error:', e.message);
    res.status(500).json({ message: "Internal server error", error: e.message });
  }
});
router.get("/ownerBookings", rateLimiter, async (req, res) => {
  try {
    // ── 1. Extract and Verify JWT Token ──
    const header = req.headers.authorization;
    if (!header) {
      return res.status(401).json({ message: "Missing authorization headers" });
    }
    
    const token = header.split(" ")[1];
    if (!token) {
      return res.status(401).json({ message: "Token not found" });
    }

    const payload = await veriftJWT(token);
    if (!payload) {
      return res.status(401).json({ message: "Invalid or expired token" });
    }

    // 💥 Boom! This is now the Owner's ID from their login token!
    const ownerId = payload.id; 

    // ── 2. Fetch Bookings for this Specific OWNER ──
    const result = await pool.query(`
      SELECT 
        b.id,
        b."userId",
        b."carId",
        b."branchId",
        b."pickupDate",
        b."dropoffDate",
        b."totalPrice",
        b.status,
        b.payment_status,
        b.advance_paid,
        b.remaining_amount,
        b."paymentId",
        b."confirmationNumber",
        b."createdAt",
        b."updatedAt",
        b.razorpay_payment_id,
        c.model,
        c.images,
        c."fuelType",
        c.transmission,
        c."seatingCapacity",
        c."licensePlate",
        br.name as branch_name,
        br.city as branch_city
      FROM bookings b
      JOIN ${process.env.cars_table} c ON b."carId" = c.id
      JOIN branches br ON b."branchId" = br.id
      WHERE c.ownerid = $1    -- 💥 THE FIX: Filter by the car's owner!
      ORDER BY b."createdAt" DESC
    `, [ownerId]);

    // ── Calculate display_status in JS — no enum conflict ──
    const now = new Date();

    const bookings = result.rows.map(b => {
      const pickup   = new Date(b.pickupDate);
      const dropoff  = new Date(b.dropoffDate);

      let display_status;

      if (b.status === 'cancelled') {
        display_status = 'cancelled';
      } else if (b.status === 'pending') {
        display_status = 'pending';
      } else if (dropoff < now) {
        display_status = 'completed';
      } else if (pickup <= now && dropoff >= now) {
        display_status = 'ongoing';
      } else if (pickup > now) {
        display_status = 'upcoming';
      } else {
        display_status = b.status;
      }

      return { ...b, display_status };
    });

    console.log(`Bookings found for Owner ${ownerId}:`, bookings.length);
    res.json(bookings);

  } catch (e) {
    console.error('ownerBookings error:', e.message);
    res.status(500).json({ message: "Internal server error", error: e.message });
  }
});
router.get("/myCredits", rateLimiter, async (req, res) => {
  try {
    // 💥 1. Extract the JWT Token
    const header = req.headers.authorization;
    if (!header) {
      return res.status(401).json({ message: "Missing authorization headers" });
    }
    
    const token = header.split(" ")[1];
    if (!token) {
      return res.status(401).json({ message: "Token not found" });
    }

    // 💥 2. Verify and get the REAL User ID
    const payload = await veriftJWT(token); // Make sure veriftJWT is imported in this file!
    if (!payload) {
      return res.status(401).json({ message: "Invalid or expired token" });
    }

    const userId = payload.id; 
 
    // 💥 3. Run the query for the REAL user
    const result = await pool.query(
      `SELECT 
        id,
        amount,
        remaining_amount,
        expiry_date,
        created_at,
        -- Is this expiring soon (within 30 days)?
        CASE WHEN expiry_date < NOW() + INTERVAL '30 days' 
             THEN true ELSE false 
        END as expiring_soon
       FROM user_credit
       WHERE user_id = $1
         AND remaining_amount > 0
         AND expiry_date > NOW()
       ORDER BY expiry_date ASC`,
      [userId]
    );

    // ── Total available ──
    const totalCredits = result.rows.reduce(
      (sum, row) => sum + Number(row.remaining_amount), 0
    );

    res.json({
      totalCredits,
      credits: result.rows,
    });

  } catch (e) {
    res.status(500).json({ message: "Internal server error", error: e.message });
  }
});
router.get("/checkAvailability", rateLimiter, async (req, res) => {
  try {
    const { carId, pickupDate, dropoffDate } = req.query;

    const result = await pool.query(`
      SELECT COUNT(*) 
      FROM bookings
      WHERE "carId" = $1
      AND status NOT IN ('cancelled', 'completed', 'pending')
      
      -- DIRECT COMPARISON: Comparing raw database time to your raw input
      AND "pickupDate" < $2::timestamp
      AND COALESCE(ride_end_time, "dropoffDate") > $3::timestamp
    `, [carId, dropoffDate, pickupDate]);

    const isBooked = parseInt(result.rows[0].count) > 0;
    
    console.log(`\n--- Direct Comparison ---`);
    console.log(`Your Pickup:  ${pickupDate}`);
    console.log(`Your Dropoff: ${dropoffDate}`);
    console.log(`DB Result: ${isBooked ? '❌ BLOCKED' : '✅ AVAILABLE'}`);

    res.json({ available: !isBooked });

  } catch (e) {
    console.error('checkAvailability error:', e.message);
    res.status(500).json({ message: "Internal server error" });
  }
});
router.get("/getStaffTasks", rateLimiter, async (req, res) => {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ message: "missing headers" });

  const token = header.split(" ")[1];
  const payload = await veriftJWT(token);
  if (!payload) return res.status(401).json({ message: "invalid token" });

  if (
    payload.role !== "staff" &&
    payload.role !== "subadmin" &&
    payload.role !== "superadmin"
  ) {
    return res.status(403).json({ message: "unauthorized" });
  }

  const { date, branchId } = req.query;

  if (!date) {
    return res.status(400).json({ message: "Date is required" });
  }

  // ── 🔍 1. TELEMETRY: LOGGING FRONTEND INBOUND PARAMETERS ──
  console.log("=================================================");
  console.log("📡 [INBOUND STAFF REQUEST]");
  console.log(`• Raw Date String String from Mobile: "${date}"`);
  console.log(`• Target Branch ID Parameter:        "${branchId}"`);
  console.log(`• Server Local Clock Time (NOW):     ${new Date().toString()}`);
  console.log("=================================================");

  try {
    // 1. Execute the query layout matrix
    // 1. Execute the query layout matrix (Updated with dynamic extension calculations)
    // 1. Execute the query layout matrix (Enforcing extension_status === 'approved')
    const tasks = await pool.query(
      `
      SELECT 
        b.id AS booking_id,
        b."userId",
        b."pickupDate",
        
        -- 💥 THE CONDITION: Dynamic calculation occurs ONLY if the extension status is explicitly 'approved'
        CASE 
          WHEN COALESCE(b.extension_hours, 0) > 0 AND b.extension_status = 'approved'
          THEN (b."dropoffDate" + (b.extension_hours || ' hours')::INTERVAL)
          ELSE b."dropoffDate"
        END AS "dropoffDate",
        
        b."totalPrice",
        b."paymentId",
        b.advance_paid,
        b.ride_start_time,
        b.ride_end_time,
        b.remaining_amount,
        b.ride_start_amount,
        b.ride_end_amount,
        b.penalty_amount,
        b.penalty_hours,
        b.penalty_extention_amount,
        b.penalty_extention_hours,
        b.extension_amount,
        b.extension_hours,

        u.name AS customer_name,
        u.email AS customer_email,
        u.mobileno AS customer_phone,
        u.dob AS customer_dob,
        u.city AS customer_city,
        
        u.dp_bucket,
        u.dp_file_name,
        u.aadhar_masked_bucket,
        u.aadhar_masked_file_name,
        u.license_masked_bucket,
        u.license_masked_file_name,
        
        c.model AS car_model,
        c."licensePlate" AS car_plate
      FROM bookings b
      JOIN users u ON b."userId" = u.id
      JOIN cars c ON b."carId" = c.id
      WHERE b."branchId" = $2
        AND b.status = 'confirmed'
        AND (
          -- Pickups logic: Unchanged
          (b.ride_start_time IS NULL AND DATE(b."pickupDate") <= $1::date)
          OR 
          -- Returns logic: 💥 Filters based on the newly calculated timeline if approved
          (
            b.ride_start_time IS NOT NULL 
            AND b.ride_end_time IS NULL 
            AND DATE(
              CASE 
                WHEN COALESCE(b.extension_hours, 0) > 0 AND b.extension_status = 'approved'
                THEN (b."dropoffDate" + (b.extension_hours || ' hours')::INTERVAL)
                ELSE b."dropoffDate"
              END
            ) <= $1::date
          )
        )
      ORDER BY b."pickupDate" ASC
      `,
      [date, branchId]
    );
    // ── 🔍 TELEMETRY DEEP ANALYSIS PRINT BLOCK ──
    console.log(`📊 [DATABASE ENGINE EVALUATION] Matches Found: ${tasks.rows.length}`);
    if (tasks.rows.length > 0) {
      tasks.rows.forEach((row, index) => {
        console.log(`--- [Task Record #${index + 1}] ---`);
        console.log(`  • Booking ID:         #${row.booking_id}`);
        console.log(`  • DB raw pickupDate:  "${row.pickupDate}"`);
        console.log(`  • DB raw dropoffDate: "${row.dropoffDate}"`);
        console.log(`  • ride_start_time:    "${row.ride_start_time || 'NULL'}"`);
        console.log(`  • ride_end_time:      "${row.ride_end_time || 'NULL'}"`);
      });
      console.log("=================================================");
    } else {
      console.log("  ⚠️ No matching database tasks found.");
      console.log("=================================================");
    }

    // 2. Presigned URLs Client Helper Asset Generator
    const generateUrl = async (bucket, fileName) => {
      if (!bucket || !fileName) return null;
      try {
        if (fileName.startsWith("http://") || fileName.startsWith("https://")) {
          return fileName;
        }
        return await minioClient.presignedGetObject(bucket, fileName, 24 * 60 * 60);
      } catch (err) {
        console.error(`Failed to generate URL for ${fileName}:`, err.message);
        return null; 
      }
    };

    // 3. Concurrently map rows to pre-signed assets 
    const tasksWithUrls = await Promise.all(
      tasks.rows.map(async (task) => {
        const dpUrl = await generateUrl(task.dp_bucket, task.dp_file_name);
        const idMaskedUrl = await generateUrl(task.aadhar_masked_bucket, task.aadhar_masked_file_name);
        const licenseMaskedUrl = await generateUrl(task.license_masked_bucket, task.license_masked_file_name);

        return {
          ...task,
          customer_dp_url: dpUrl,
          customer_id_masked_url: idMaskedUrl,
          customer_license_masked_url: licenseMaskedUrl,
        };
      })
    );

    return res.status(200).json(tasksWithUrls);

  } catch (err) {
    console.error("Staff Tasks Error:", err);
    return res.status(500).json({ message: "internal server error" });
  }
});
router.get("/carKeyVerify", rateLimiter, async (req, res) => {
  try {
    const header = req.headers.authorization;
    if (!header) {
      return res.status(401).json({ message: "missing headers" });
    }
    
    const token = header.split(" ")[1];
    const payload = await veriftJWT(token);
    if (!payload) {
      return res.status(401).json({ message: "invalid token" });
    }

    // 💥 Safely check roles
    const allowedRoles = ["staff", "subadmin", "admin", "superadmin"];
    if (!allowedRoles.includes(payload.role)) {
      return res.status(403).json({ message: "unauthorized" });
    }

    const { bookingId, key, id } = req.query;

    // 1. Verify the Key
    const bookingQuery = await pool.query(
      `SELECT "confirmationNumber" FROM bookings WHERE id=$1`,
      [bookingId]
    );

    if (bookingQuery.rows.length === 0) {
      return res.status(404).json({ message: "Booking not found" });
    }

    // 💥 FIXED BUG 1: Extract the actual string from the object!
    // Postgres sometimes lowercases columns depending on how they were created, so we check both.
    const dbKey = bookingQuery.rows[0].confirmationNumber || bookingQuery.rows[0].confirmationnumber;

    if (dbKey !== key) {
      return res.status(401).json({ message: "Invalid confirmation key" });
    }

    // 2. Get User Data
    if (id) {
      const userQuery = await pool.query(
        `SELECT * FROM ${process.env.table} WHERE id=$1`,
        [id]
      );
      
      if (userQuery.rows.length === 0) {
        return res.status(400).json({ message: "User data not found" });
      }

      const userData = userQuery.rows[0];

      const safeUserData = {
        name: userData.name,
        username: userData.username,
        email: userData.email,
        dob: userData.dob,
        mobileno: userData.mobileno,
        role: userData.role,
        is_verified: userData.is_verified,
        is_profile_completed: userData.is_profile_completed
      };

      // 3. Create the temporary action token for the staff member
      // 💥 FIXED BUG 2: Removed the non-existent 'slot' column!
      const actionPayload = {
        userId: id,
        staffId: payload.id,
        bookingId: bookingId
      };
      
      const actionToken = await createJwt(actionPayload);

      return res.status(200).json({ 
        userdata: safeUserData, 
        bookingToken: actionToken 
      });
    }

  } catch (err) {
    console.error("Key Verify Error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
});
router.put("/startRide", rateLimiter, async (req, res) => {
  try {
    const header = req.headers.authorization;
    if (!header) return res.status(401).json({ message: "missing headers" });
    const staffToken = header.split(" ")[1];
    const staffPayload = await veriftJWT(staffToken);
    if (!staffPayload) return res.status(401).json({ message: "invalid staff token" });

    const { odometer, fuelLevel, fastagBalance, bookingToken,  ride_start_amount,upiID,upi,cash } = req.body || {};
    if (!bookingToken) return res.status(401).json({ message: "missing booking token" });

    const actionPayload = await veriftJWT(bookingToken);
    if (!actionPayload || !actionPayload.bookingId) {
      return res.status(401).json({ message: "invalid token" });
    }

    const startTime = new Date();
    const updated = await pool.query(
      `
      UPDATE bookings
      SET
        ride_start_time = $1,
        ride_start_amount = $2,
        extras = COALESCE(extras, '[]'::jsonb) || $3::jsonb
      WHERE id = $4
      RETURNING *
      `,
      [
        startTime,
        ride_start_amount,
        JSON.stringify([{
          type: "handover_out",
          odometer,
          fuelLevel,
          fastagBalance,
          upiID,
          cash,
          upi,
          time: startTime
        }]),
        actionPayload.bookingId
      ]
    );


    if (updated.rows.length === 0) {
      return res.status(404).json({ message: "Booking not found" });
    }

    const booking = updated.rows[0];
    const bookingId = booking.id;
    const now = Date.now();

    // ── Extension-aware dropoff calculation ──
    const baseDropoffMs = parseISTToUTC(booking.dropoffDate).getTime();
    const hasApprovedExtension =
      booking.extension_status === "approved" &&
      booking.extension_hours > 0;

    const extensionMs = hasApprovedExtension
      ? Number(booking.extension_hours) * 60 * 60 * 1000
      : 0;

    const effectiveDropoffMs = baseDropoffMs + extensionMs;

    if (hasApprovedExtension) {
      console.log(`Extension detected: +${booking.extension_hours}hrs. Effective dropoff shifted by ${extensionMs / 3600000}hrs.`);
    }

    // ── Schedule penalty & auto-extend jobs based on effective dropoff ──
    const firstPenaltyDelay  = effectiveDropoffMs - now;
    const secondPenaltyDelay = firstPenaltyDelay  + (1 * 60 * 60 * 1000) + (15 * 60 * 1000);;
    const thirdPenaltyDelay  = firstPenaltyDelay  + (2 * 60 * 60 * 1000) + (15 * 60 * 1000);;
    const autoExtendDelay    = firstPenaltyDelay  + (3 * 60 * 60 * 1000) + (15 * 60 * 1000);;

    if (firstPenaltyDelay > 0) {
      await bookingQueue.add("ride-penalty", { bookingId }, {
        jobId: `penalty-1-${bookingId}`,
        delay: firstPenaltyDelay,
        removeOnComplete: true,
      });
    }
    if (secondPenaltyDelay > 0) {
      await bookingQueue.add("ride-penalty", { bookingId }, {
        jobId: `penalty-2-${bookingId}`,
        delay: secondPenaltyDelay,
        removeOnComplete: true,
      });
    }
    if (thirdPenaltyDelay > 0) {
      await bookingQueue.add("ride-penalty", { bookingId }, {
        jobId: `penalty-3-${bookingId}`,
        delay: thirdPenaltyDelay,
        removeOnComplete: true,
      });
    }
    if (autoExtendDelay > 0) {
      await bookingQueue.add("ride-auto-extend", { bookingId }, {
        jobId: `extend-${bookingId}`,
        delay: autoExtendDelay,
        removeOnComplete: true,
      });
    }

    // ── Remove any stale auto-cancel job ──
    const autoCancelJobId = `auto-cancle-${bookingId}`;
    try {
      const removed = await bookingQueue.remove(autoCancelJobId);
      console.log("Removed auto-cancel job:", autoCancelJobId, removed);
    } catch (err) {
      console.error("Error removing auto-cancel job:", err);
    }

    return res.status(200).json({
      message: "Ride started successfully",
      data: booking
    });

  } catch (e) {
    console.error("Start Ride Error:", e);
    return res.status(500).json({ message: "internal server error" });
  }
});
router.put("/endRide/:bookingId", rateLimiter, async (req, res) => {
  try {
    // 1. Auth & Role Verification
    const header = req.headers.authorization;
    if (!header) {
      return res.status(401).json({ message: "missing headers" });
    }
    
    const token = header.split(" ")[1];
    const payload = await veriftJWT(token);
    if (!payload) {
      return res.status(401).json({ message: "invalid token" });
    }

    const allowedRoles = ["staff", "subadmin", "superadmin", "admin"];
    if (!allowedRoles.includes(payload.role)) {
      return res.status(403).json({ message: "unauthorized" });
    }

    const { bookingId } = req.params;
    
    // 2. Destructure with safe fallbacks for the checklist
    const { odometer, fuelLevel, fastagBalance,  ride_end_amount, penaltyAmount,upiID , upi , cash } = req.body || {}; 

    // 3. Fetch Booking Data
    const booking = await pool.query(
      `SELECT 
        "dropoffDate", 
        "totalPrice", 
        "userId", 
        "carId", 
        "branchId",
        COALESCE(ride_start_amount, 0) AS ride_start_amount,
        COALESCE(advance_paid, 0) AS advance_paid,
        COALESCE(penalty_amount, 0) AS db_penalty_amount,
        ride_end_time
       FROM bookings 
       WHERE id=$1`,
      [bookingId]
    );

    if (booking.rows.length === 0) {
      return res.status(404).json({ message: "Booking not found" });
    }

    // Optional Safety: Prevent double-ending a ride
    if (booking.rows[0].ride_end_time) {
      return res.status(400).json({ message: "Vehicle already returned" });
    }
    
    const { userId, carId, branchId } = booking.rows[0];
    const data = booking.rows[0];
    
    // 4. Fetch Owner ID
    const ownerId = await pool.query(`SELECT "ownerid" FROM cars WHERE id=$1`, [carId]);
    if (ownerId.rows.length === 0) {
      return res.status(404).json({ message: "Car owner not found" });
    }
    const { ownerid } = ownerId.rows[0];
    
    const expectedEnd = new Date(data.dropoffDate); 
    const actualEnd = new Date();
    
    // 5. Update the Booking to 'completed' and save checkout data
    const updated = await pool.query(
      `
      UPDATE bookings
      SET 
        status = 'completed',
        ride_end_time = $1,
        ride_end_amount = $2,
        payment_status = 'fully_paid',
        extras = COALESCE(extras, '[]'::jsonb) || $3::jsonb
      WHERE id = $4
      RETURNING *
      `,
      [
        actualEnd,                     
        Number(ride_end_amount || 0),  
        JSON.stringify([{ 
          type: 'handover_in', 
          odometer: odometer || "Not provided", 
          fuelLevel: fuelLevel || "Not provided", 
          fastagBalance, 
          upi,
          cash,
          upiID,
          penaltyAmount: penaltyAmount !== undefined && penaltyAmount !== null ? Number(penaltyAmount) : 0, 
          time: actualEnd 
        }]),                           
        bookingId                      
      ]
    );

    // 6. Fetch Split Percentages AND Seating Capacity for the specific car
    const carAndBranchData = await pool.query(
      `SELECT 
         c.ownerid, 
         c."branchId", 
         c."seatingCapacity", 
         c.percentage AS owner_percentage, 
         b.percentage AS branch_percentage
       FROM cars c
       JOIN branches b ON c."branchId" = b.id
       WHERE c.id = $1`, 
      [carId]
    );

    if (carAndBranchData.rows.length === 0) {
        return res.status(404).json({ message: "Car or branch data not found" });
    }

    const { owner_percentage, branch_percentage, seatingCapacity } = carAndBranchData.rows[0];

    // 7. Calculate Total Income (All cash collected)
    const totalIncome = 
      Number(data.advance_paid) +                      
      Number(data.ride_start_amount || 0) +            
      Number(ride_end_amount || 0) +                   
      Number(penaltyAmount || data.db_penalty_amount); 

    // 💥 8. THE PENALTY MATH LOGIC 💥
    // Perfectly matches your pricing: 7-seater is ₹200, everything else is ₹150
    const hourlyPenaltyRate = Number(seatingCapacity) === 7 ? 200 : 150;

    let firstHourPenaltyToDeduct = 0;
    const actualPenaltyCollected = Number(penaltyAmount || data.db_penalty_amount);
    
    if (actualPenaltyCollected > 0) {
      firstHourPenaltyToDeduct = hourlyPenaltyRate;
      
      // Safety check: We can't deduct 200 if they only paid 100 in total penalties!
      if (firstHourPenaltyToDeduct > actualPenaltyCollected) {
        firstHourPenaltyToDeduct = actualPenaltyCollected;
      }
    }

    // 9. THE WATERFALL SPLIT
    // Remove the 1st hour penalty from the owner's pool FIRST
    const ownerBaseAmount = totalIncome - firstHourPenaltyToDeduct;

    // Owner gets their percentage ONLY on the base amount
    const ownerShare = (ownerBaseAmount * Number(owner_percentage)) / 100;

    // The remainder is the TRUE total income minus what the owner actually got
    // (This automatically keeps that 1st hour penalty cash safe for the Branch/Admin)
    const remainingAfterOwner = totalIncome - ownerShare;

    // Branch gets their percentage of the REMAINING amount
    const branchShare = (remainingAfterOwner * Number(branch_percentage)) / 100;

    // Superadmin sweeps up the final remainder
    const adminShare = remainingAfterOwner - branchShare;

    // 10. Database Logging
    await pool.query(`
      INSERT INTO booking_income 
      (booking_id, paid_to, receiver_id, amount, "carId", ownerid, user_id, total_income, "branchId", status)
      VALUES 
      ($1, 'owner', $2, $3, $4, $2, $5, $6, $7, 'pending'),
      ($1, 'branch', $7, $8, $4, $2, $5, $6, $7, 'pending'), 
      ($1, 'superadmin', NULL, $9, $4, $2, $5, $6, $7, 'pending') 
    `, [
      bookingId,     // $1
      ownerid,       // $2
      ownerShare,    // $3
      carId,         // $4
      userId,        // $5
      totalIncome,   // $6
      branchId,      // $7
      branchShare,   // $8
      adminShare     // $9
    ]);

    // 11. Send Success Response
    return res.status(200).json({
      message: actualPenaltyCollected > 0 
        ? `Ride ended with penalty ₹${actualPenaltyCollected}` 
        : "Ride ended successfully",
      data: updated.rows[0]
    });

  } catch (err) {
    console.error("End Ride Error:", err); 
    return res.status(500).json({ message: "internal server error" });
  }
});
router.get("/getBranchBookingsByDate", rateLimiter, async (req, res) => {
  try {
    const { branchId, date } = req.query; // date should be 'YYYY-MM-DD'
    
    if (!branchId || !date) {
      return res.status(400).json({ message: "Branch ID and Date are required" });
    }

    // ── 🔍 TELEMETRY COCKPIT ──
    console.log("=================================================");
    console.log("📡 [ROSTER REQUEST RECEIVED]");
    console.log(`• Inbound Filter Target Date : "${date}"`);
    console.log(`• Node Process Clock (ISO)   :  ${new Date().toISOString()}`);

    const result = await pool.query(
      `
      SELECT 
        b.id AS booking_id,
        b."pickupDate",
        
        -- 💥 THE CRITICAL FIX: If extension_hours exist AND extension_status is approved, dynamically extend the dropoffDate
        CASE 
          WHEN COALESCE(b.extension_hours, 0) > 0 AND b.extension_status = 'approved'
          THEN (b."dropoffDate" + (b.extension_hours || ' hours')::INTERVAL)
          ELSE b."dropoffDate"
        END AS "dropoffDate",
        
        b."totalPrice",
        b."ride_start_time",
        b."ride_end_time",
        b.status AS system_status,
        b.payment_status,
        
        b."paymentId",
        b.razorpay_payment_id,
        b.advance_paid,
        b.remaining_amount,
        b.ride_start_amount,
        b.ride_end_amount,
        b.penalty_amount,
        b.penalty_hours,
        b.penalty_extention_amount,
        b.penalty_extention_hours,
        b.extension_amount,
        b.extension_hours,
        b.credits_used,
        
        b.extras, 
        b."confirmationNumber",
        b.onsite,
        b."createdAt",

        c.model AS car_model,
        c."licensePlate" AS number_plate,
        u.name AS customer_name,
        u.mobileno AS customer_phone,
        
        -- Diagnostic helpers for console print tracking
        (NOW() + INTERVAL '5 hours 30 minutes')::timestamp AS debug_current_kolkata,
        b."pickupDate"::timestamp AS debug_pickup_kolkata,

        CASE 
          -- 1. Checked System Cancellations
          WHEN b.status::text = 'cancelled' THEN 'Cancelled'
          
          -- 2. Completed Lifecycle States
          WHEN b.ride_end_time IS NOT NULL THEN 'Ride Ended' 
          
          -- 3. In-flight Active Lifecycles
          WHEN b.ride_start_time IS NOT NULL THEN 'Ride Started'
          
          -- 4. Upcoming Evaluator (Compare literal text clock faces)
          WHEN b."pickupDate"::timestamp > (NOW() + INTERVAL '5 hours 30 minutes')::timestamp THEN 'Upcoming'
          
          -- 5. 💥 FIXED: Active Overdue Evaluator now scales against the dynamic approved extension window
          WHEN b.ride_start_time IS NOT NULL 
               AND b.ride_end_time IS NULL 
               AND (
                 CASE 
                   WHEN COALESCE(b.extension_hours, 0) > 0 AND b.extension_status = 'approved'
                   THEN (b."dropoffDate" + (b.extension_hours || ' hours')::INTERVAL)
                   ELSE b."dropoffDate"
                 END
               )::timestamp < (NOW() + INTERVAL '5 hours 30 minutes')::timestamp THEN 'Overdue Return'
          
          -- 6. Unfulfilled Backlog Default
          ELSE 'Pending Pickup / Overdue'
        END AS live_status

      FROM bookings b
      JOIN ${process.env.cars_table} c ON b."carId" = c.id
      JOIN users u ON b."userId" = u.id
      
      WHERE b."branchId" = $1
        AND b.payment_status != 'pending' 
        AND DATE(b."pickupDate") <= $2::date 
        
        -- 💥 FIXED: Logs range query filters against the dynamic approved extension dropoff window
        AND DATE(
          CASE 
            WHEN COALESCE(b.extension_hours, 0) > 0 AND b.extension_status = 'approved'
            THEN (b."dropoffDate" + (b.extension_hours || ' hours')::INTERVAL)
            ELSE b."dropoffDate"
          END
        ) >= $2::date
        
      ORDER BY b."pickupDate" ASC
      `,
      [branchId, date]
    );
    // ── 🔍 ENGINE DEEP EVALUATION LOG MATRIX ──
    console.log(`📊 [DATABASE ENGINE EVALUATION] Matches Loaded: ${result.rows.length}`);
    if (result.rows.length > 0) {
      result.rows.forEach((row, index) => {
        console.log(`--- [Roster Record #${index + 1}] ---`);
        console.log(`  • Booking ID          : #${row.booking_id} (${row.customer_name})`);
        console.log(`  • DB Raw pickupDate   : "${row.pickupDate}"`);
        console.log(`  • Pickup in Kolkata   : "${row.debug_pickup_kolkata}"`);
        console.log(`  • Current in Kolkata  : "${row.debug_current_kolkata}"`);
        console.log(`  • Status Evaluated As : ⚡ "${row.live_status}" ⚡`);
      });
      console.log("=================================================");
    } else {
      console.log("  ⚠️ No records matched raw UTC date filter matrices.");
      console.log("=================================================");
    }

    res.status(200).json({
      message: "Daily roster fetched successfully",
      total_active_cars: result.rows.length,
      data: result.rows
    });
  } catch (err) {
    console.error("Daily Roster Error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});
router.post("/collectPayment", rateLimiter, async (req, res) => {
  try {
    const header = req.headers.authorization;
    if (!header) return res.status(401).json({ message: "missing headers" });
    const token = header.split(" ")[1];
    const payload = await veriftJWT(token);
    if (!payload) return res.status(401).json({ message: "invalid token" });

    const allowedRoles = ["staff", "subadmin", "superadmin", "admin"];
    if (!allowedRoles.includes(payload.role)) {
      return res.status(403).json({ message: "unauthorized" });
    }

    const { bookingId, amount, paymentMethod, transactionId, remarks, collectedBy } = req.body;
    if (!bookingId || !amount) {
      return res.status(400).json({ message: "bookingId and amount are required" });
    }

    // Mark booking as fully paid and record payment details
    const result = await pool.query(
      `UPDATE bookings
       SET payment_status = 'fully_paid',
           remaining_amount = 0,
           "updatedAt" = NOW()
       WHERE id = $1
       RETURNING id, "totalPrice", advance_paid, remaining_amount, payment_status`,
      [bookingId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Booking not found" });
    }

    console.log(`✅ Offline payment collected for booking ${bookingId}: ₹${amount} via ${paymentMethod}`);

    return res.status(200).json({
      success: true,
      message: `Payment of ₹${amount} collected via ${paymentMethod}`,
      booking: result.rows[0]
    });
  } catch (err) {
    console.error("collectPayment error:", err);
    return res.status(500).json({ message: "internal server error" });
  }
});
router.get('/car/:carId/availability',rateLimiter ,async (req, res) => {
  try {
    const { carId } = req.params;

    const query = `
      SELECT 
        id as booking_id,
        "pickupDate",
        "dropoffDate",
        status
      FROM bookings 
      WHERE "carId" = $1 
        AND "dropoffDate" >= NOW() 
        AND status NOT IN ('cancelled', 'completed')
      ORDER BY "pickupDate" ASC
    `;

    const { rows } = await pool.query(query, [carId]);

    // 💥 1. Log the RAW data coming straight from PostgreSQL
    console.log(`\n=== RAW DB ROWS FOR CAR ${carId} ===`);
    console.log(rows);

    const blockedSlots = rows.map(booking => ({
      bookingId: booking.booking_id,
      start: booking.pickupDate, 
      end: booking.dropoffDate,  
    }));

    // Package the response data into a variable first
    const responseData = {
      success: true,
      carId: carId,
      blockedSlots: blockedSlots,
    };

    // 💥 2. Log the EXACT JSON you are sending to the frontend
    console.log("\n=== FINAL RESPONSE DATA ===");
    console.log(JSON.stringify(responseData, null, 2)); // Adds spacing so it's easy to read

    return res.status(200).json(responseData);

  } catch (error) {
    console.error("=== Availability Check Error ===");
    console.error(error);
    return res.status(500).json({
      success: false,
      message: "Internal server error while fetching availability.",
      error: error.message
    });
  }
});
router.get("/test-razorpay", async (req, res) => {
  try {
    console.log("Attempting Razorpay Test with Key:", process.env.RazorpayAPIKey?.substring(0, 8) + "...");
    
    // Attempt to create a 1 INR (100 paise) dummy order
    const order = await razorpay.orders.create({
      amount: 100, 
      currency: "INR",
      receipt: "test_receipt_999"
    });

    console.log("✅ Razorpay Test SUCCESS!");
    res.json({ 
      message: "Keys are working perfectly!", 
      orderId: order.id 
    });

  } catch (error) {
    console.error("❌ Razorpay Test FAILED:", error);
    res.status(500).json({ 
      message: "Razorpay authentication failed", 
      error: error 
    });
  }
}); 
router.get("/financialExcel/:from/:to", rateLimiter, async (req, res) => {
  try {
    const { from, to } = req.params;

    const { start, end } = getDateRange(from, to);

    const rows = await fetchCollectionData(start, end);

    if (rows.length === 0) {
      return res.status(404).json({
        message: "No data found",
      });
    }

    const excelBuffer = await createCollectionExcel(rows);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="financial-report.xlsx"'
    );

    return res.status(200).send(excelBuffer);
  } catch (error) {
    console.error("❌ Excel download FAILED:", error);
    return res.status(500).json({
      message: "Failed to generate excel file",
      error: error.message,
    });
  }
});
router.put("/requestExtend",rateLimiter,async(req,res)=>{
try{
  console.log("came to request cancletion")
const {time,bookingId}=req.body
 const client = await pool.connect();
 console.log("time",time)
 console.log("booking id",bookingId)
     const header = req.headers.authorization;
if (!header) {
  return res.status(401).json({ message: "Missing authorization headers" });
}

const token = header.split(" ")[1];
if (!token) {
  return res.status(401).json({ message: "Token not found" });
}

const payload = await veriftJWT(token);
if (!payload?.id) {
  return res.status(401).json({ message: "Invalid or expired token" });
}
await client.query("BEGIN");
// if(time!="6"||time!="12"||time!="24"){
//   return res.status(500).json({message:"invalid exetnd time"})
// }
 const bookingRes = await client.query(
      `SELECT id, "userId", "branchId", status, credits_used, cancellation_status 
       FROM bookings WHERE id = $1 FOR UPDATE`,
      [bookingId]
    );

    if (bookingRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Booking not found" });
    }
    const booking = bookingRes.rows[0];
console.log("booking info=",booking)
    if (booking.userId !== payload.id) {
      await client.query("ROLLBACK");

      return res.status(403).json({
        message: "Unauthorized extention request"
      });
    }

    // 2. Validations
    if (booking.extension_status === 'pending') {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Extention already requested." });
    }
   
    if (['completed', 'cancelled'].includes(booking.status)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: `Booking already ${booking.status}` });
    }

    await client.query(
      `UPDATE bookings 
       SET extension_status = 'pending',extension_hours=$1, "updatedAt" = NOW() 
       WHERE id = $2`,
      [time,bookingId]
    );

    await client.query("COMMIT");

const userRes = await pool.query(
  `SELECT email
   FROM users
   WHERE id = $1`,
  [booking.userId]
);
const userEmail = userRes.rows[0]?.email;
const staffTokensRes = await pool.query(
  `SELECT  expo_token,email
   FROM management
   WHERE branch = $1 AND role IN ('staff', 'sub_admin')`,
  [booking.branchId.toString()]
);


const expoTokens = staffTokensRes.rows
  .map(row => row.expo_token)
  .filter(Boolean);
  const staffEmails = staffTokensRes.rows
  .map(row => row.email)
  .filter(Boolean);

const title = "New extention Request";
const body = `Customer requested extention for booking #${bookingId}. Waiting for approval.`;
const data = {
  type: "extention_request",
  bookingId: String(bookingId),
  from: String(booking.userId),
};


for (const expoToken of expoTokens) {
  await sendNotification(expoToken, title, body, data);
}
if (!userEmail) {
  return res.status(404).json({ message: "Customer email not found" });
}
for (const email of staffEmails) {
  await saveCancelRequestToFirebase({
    bookingId: Number(bookingId),
    title: "Ride extention Request",
    message: body,
    type: "extention_request",
    fromEmail: userEmail,
    toEmail: email,
  });
}

    return res.status(200).json({
      message: "Cancellation request sent to branch staff for approval."
    });

}catch(err){
console.error("❌ ride extention failed:", err);
    return res.status(500).json({
      message: "Failed toextend ride",
      error: err.message,
    });
}
})
router.get("/extension-requests", rateLimiter, async (req, res) => {
  try {
    console.log("========================================");
    console.log("🔍 [API] /extension-requests STARTED");
    
    // 1. Verify Token
    const header = req.headers.authorization;
    if (!header) return res.status(401).json({ message: "Missing authorization headers" });
    
    const token = header.split(" ")[1];
    if (!token) return res.status(401).json({ message: "Token not found" });

    const payload = await veriftJWT(token);
    if (!payload) return res.status(401).json({ message: "Invalid or expired token" });

    // 2. Get Branch ID
    const { branchId } = req.query;
    console.log("➡️ 1. Raw branchId from frontend:", branchId);
    
    if (!branchId) {
      console.log("❌ ERROR: No branchId provided!");
      return res.status(400).json({ message: "Branch ID is required to fetch extension requests" });
    }

    const numericBranchId = Number(branchId);
    console.log("➡️ 2. Converted numericBranchId:", numericBranchId);

    // 💥 --- DIAGNOSTIC X-RAY START --- 💥
    // Let's ask the database what extension data it actually has for this branch!
    const testQuery = await pool.query(
      `SELECT id, extension_status, extension_hours FROM bookings WHERE "branchId" = $1 ORDER BY id DESC LIMIT 5`, 
      [numericBranchId]
    );
    console.log("➡️ 3. DIAGNOSTIC: Here are the last 5 bookings for this branch:");
    console.table(testQuery.rows); // Prints a nice table in your terminal!
    // 💥 --- DIAGNOSTIC X-RAY END --- 💥

    // 3. MAIN SQL QUERY
    const query = `
      SELECT 
        b.id AS booking_id,
        b."pickupDate",
        b."dropoffDate",
        b."totalPrice",
        b.advance_paid,
        b.payment_status,
        b.extension_status,   -- 💥 Pulling the extension status
        b.extension_hours,    -- 💥 Pulling the requested hours
        b.status AS booking_status,
        b."userId",
        u.name AS user_name,
        u.email AS user_email,
        u.mobileno AS user_mobile,
        u.address AS user_address,
        c.model AS car_name,               
        c."licensePlate" AS car_number     
      FROM bookings b
      LEFT JOIN users u ON b."userId" = u.id
      LEFT JOIN cars c ON b."carId" = c.id
      WHERE b.extension_status = 'pending' -- 💥 Filtering by pending extensions
        AND b."branchId" = $1
      ORDER BY b."updatedAt" DESC
    `;

    const result = await pool.query(query, [numericBranchId]);
    
    console.log(`➡️ 4. SUCCESS: Found ${result.rows.length} pending extension requests!`);
    console.log("========================================");

    return res.status(200).json({
      success: true,
      data: result.rows
    });

  } catch (error) {
    console.error("❌ Fetch Extensions Error:", error.message);
    return res.status(500).json({ message: "Internal server error" });
  }
});
router.put("/rejectExtend",rateLimiter,async(req,res)=>{
  const client = await pool.connect();
  try {
  
    const header = req.headers.authorization;
    if (!header) {
      return res.status(401).json({ message: "Missing authorization headers" });
    }

    const token = header.split(" ")[1];
    if (!token) {
      return res.status(401).json({ message: "Token not found" });
    }

    const payload = await veriftJWT(token);
    if (!payload?.id) {
      return res.status(401).json({ message: "Invalid or expired token" });
    }

    const staffId = payload.id ; 
    const {bookingId} = req.body;

    // ── 2. Start Transaction ──
    await client.query("BEGIN");

    // Lock the row so no double-clicks happen
    const bookingRes = await client.query(
      `SELECT id, "userId","carId", "totalPrice", extension_hours,extension_amount , extension_status
       FROM bookings WHERE id = $1 FOR UPDATE`,
      [bookingId]
    );

    if (bookingRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Booking not found" });
    }

    const booking = bookingRes.rows[0];
console.log("found booking=",booking)
    // Ensure it's actually waiting for approval
    if (booking.extension_status !== 'pending') {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "No pending extention request found for this booking." });
    }
const car=await client.query(`SELECT "twentyfour_hr_price","twelve_hr_price","six_hr_price" FROM cars WHERE id=$1`,[booking.carId])
if(car.rows.length===0){
  await client.query("ROLLBACK");
      return res.status(404).json({ message: "car not found" });
}

// console.log("carPrice value in exetention is=",carPrice)
    await client.query(
      `UPDATE bookings 
       SET 
         extension_status = 'rejected'
      ,
         "updatedAt" = NOW()
       WHERE id = $1`,
      [bookingId]
    );
    // ── 6. Commit & Send Response ──
  
    await client.query("COMMIT");
const userRes=await client.query(
      `SELECT * FROM  users WHERE id=$1`,[booking.userId]
          )
        if(userRes.rows.length===0){

        return res.status(400).json({message:"user not found"})
          }
          userData=userRes.rows[0]
       const expoToken=userData.expo_token
       const userEmail=userData.email
       const title = "extention Request rejected";
const body = `extention for booking #${bookingId}.is rejected.`;
const data = {
  type: "extention-request is rejected",
  bookingId: String(bookingId),
  from: String(staffId),
};


await saveCancelRequestToFirebase({
    bookingId: Number(bookingId),
    title: "Ride Cancellation Request accepted",
    message: body,
    type: "cancel_request_accepted",
    fromEmail: userEmail,
    toEmail: userEmail,
  });
if(expoToken){
  await sendNotification(expoToken, title, body, data);

}
    return res.status(200).json({
      message: "Booking extend rejected and user notified successfully."
    
    });
  
}catch(err){
console.error("❌ ride extention failed:", err);
    return res.status(500).json({
      message: "Failed toextend ride",
      error: err.message,
    });
}})
router.put("/approveExtend", rateLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    // ── 1. Auth ──
    const header = req.headers.authorization;
    if (!header) return res.status(401).json({ message: "Missing authorization headers" });

    const token = header.split(" ")[1];
    if (!token) return res.status(401).json({ message: "Token not found" });

    const payload = await veriftJWT(token);
    if (!payload?.id) return res.status(401).json({ message: "Invalid or expired token" });

    const staffId = payload.id;
    const { bookingId } = req.body;

    // ── 2. Transaction ──
    await client.query("BEGIN");

    const bookingRes = await client.query(
      `SELECT id, "userId", "carId", "totalPrice", "dropoffDate",
              extension_hours, extension_amount, extension_status,
              ride_start_time
       FROM bookings WHERE id = $1 FOR UPDATE`,
      [bookingId]
    );

    if (bookingRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Booking not found" });
    }

    const booking = bookingRes.rows[0];
    console.log("found booking=", booking);

    if (booking.extension_status !== 'pending') {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "No pending extension request found for this booking." });
    }

    if (!booking.dropoffDate) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "dropoffDate missing" });
    }

    // ── 3. Get Car Price ──
    const car = await client.query(
      `SELECT "twentyfour_hr_price","twelve_hr_price","six_hr_price" FROM cars WHERE id=$1`,
      [booking.carId]
    );
    if (car.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "car not found" });
    }

    const carRow = car.rows[0];
    let carPrice = 0;
    if (booking.extension_hours == "6") {
      carPrice = carRow.six_hr_price;
    } else if (booking.extension_hours == "12") {
      carPrice = carRow.twelve_hr_price;
    } else if (booking.extension_hours == "24") {
      carPrice = carRow.twentyfour_hr_price;
    } else {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Not applicable extension hours" });
    }

    if (!carPrice) {
      await client.query("ROLLBACK");
      return res.status(500).json({ message: "Unable to get car price" });
    }

    console.log("carPrice value in extension is=", carPrice);

    
    await client.query(
      `UPDATE bookings 
       SET extension_status = 'approved', extension_amount = $1, "updatedAt" = NOW()
       WHERE id = $2`,
      [carPrice, bookingId]
    );

    await client.query("COMMIT");


    const userRes = await client.query(`SELECT * FROM users WHERE id=$1`, [booking.userId]);
    if (userRes.rows.length === 0) return res.status(400).json({ message: "user not found" });

    const userData = userRes.rows[0];
    const expoToken = userData.expo_token;
    const userEmail = userData.email;

 
    const title = "Extension Request Approved";
    const body = `Extension for booking #${bookingId} is approved.`;
    const data = {
      type: "extention_request accepted",
      bookingId: String(bookingId),
      from: String(staffId),
    };

    await saveCancelRequestToFirebase({
      bookingId: Number(bookingId),
      title: "Ride Extension Request Accepted",
      message: body,
      type: "extention_request_accepted",
      fromEmail: userEmail,
      toEmail: userEmail,
    });

    if (expoToken) {
      await sendNotification(expoToken, title, body, data);
    }

   
    const baseDropoffMs = parseISTToUTC(booking.dropoffDate).getTime();
    const extensionMs = Number(booking.extension_hours) * 60 * 60 * 1000;
    const extendedDropoffMs = baseDropoffMs + extensionMs;
    const now = Date.now();

    try {
      const removed = await bookingQueue.remove(`auto-cancle-${bookingId}`);
      console.log("Removed auto-cancel job:", `auto-cancle-${bookingId}`, removed);
    } catch (err) {
      console.error("Error removing auto-cancel job:", err);
    }

    const rideAlreadyStarted = !!booking.ride_start_time;

    if (rideAlreadyStarted) {
   
      console.log("Ride already started. Rescheduling penalty and auto-extend jobs...");

      const jobsToRemove = [
        `penalty-1-${bookingId}`,
        `penalty-2-${bookingId}`,
        `penalty-3-${bookingId}`,
        `extend-${bookingId}`,
      ];

      for (const jobId of jobsToRemove) {
        try {
          await bookingQueue.remove(jobId);
          console.log(`Removed job: ${jobId}`);
        } catch (err) {
          console.error(`Error removing job ${jobId}:`, err);
        }
      }

  
      const firstPenaltyDelay  = extendedDropoffMs - now;
      const secondPenaltyDelay = firstPenaltyDelay + (1 * 60 * 60 * 1000);
      const thirdPenaltyDelay  = firstPenaltyDelay + (2 * 60 * 60 * 1000);
      const autoExtendDelay    = firstPenaltyDelay + (3 * 60 * 60 * 1000);

      if (firstPenaltyDelay > 0) {
        await bookingQueue.add("ride-penalty", { bookingId }, {
          jobId: `penalty-1-${bookingId}`,
          delay: firstPenaltyDelay,
          removeOnComplete: true,
        });
      }
      if (secondPenaltyDelay > 0) {
        await bookingQueue.add("ride-penalty", { bookingId }, {
          jobId: `penalty-2-${bookingId}`,
          delay: secondPenaltyDelay,
          removeOnComplete: true,
        });
      }
      if (thirdPenaltyDelay > 0) {
        await bookingQueue.add("ride-penalty", { bookingId }, {
          jobId: `penalty-3-${bookingId}`,
          delay: thirdPenaltyDelay,
          removeOnComplete: true,
        });
      }
      if (autoExtendDelay > 0) {
        await bookingQueue.add("ride-auto-extend", { bookingId }, {
          jobId: `extend-${bookingId}`,
          delay: autoExtendDelay,
          removeOnComplete: true,
        });
      }

      console.log("Penalty and auto-extend jobs rescheduled with extended dropoff.");

    } else {
      // ── 9b. Ride not started yet → only schedule auto-cancel at extended dropoff ──
      const autoCancletime = (extendedDropoffMs - now) - (5 * 60 * 60 * 1000);

      if (autoCancletime > 0) {
        await bookingQueue.add("auto-cancle", { bookingId, expoToken }, {
          jobId: `auto-cancle-${bookingId}`,
          delay: autoCancletime,
          removeOnComplete: true,
        });
        console.log("Auto-cancel job created with extended dropoff.");
      }
    }

    return res.status(200).json({
      message: "Booking extended and user notified successfully.",
    });

  } catch (err) {
    console.error("❌ ride extension failed:", err);
    await client.query("ROLLBACK").catch(() => {});
    return res.status(500).json({
      message: "Failed to extend ride",
      error: err.message,
    });
  } finally {
    client.release();
  }
});
router.post("/addCarDamagePortal", rateLimiter, async (req, res) => {
  const client = await pool.connect();

  try {
    const header = req.headers.authorization;
    if (!header) {
      return res.status(401).json({ message: "Missing authorization headers" });
    }

    const token = header.split(" ")[1];
    if (!token) {
      return res.status(401).json({ message: "Token not found" });
    }

    const payload = await veriftJWT(token);
    if (!payload?.id) {
      return res.status(401).json({ message: "Invalid or expired token" });
    }

    const staffId = payload.id; 
    const {
      NumberPlate,
      date,
      Rname,
      Pnumber,
      des,
      Rcost,
    } = req.body;

    if (
      !NumberPlate ||
      !date ||
      !Rname ||
      !Pnumber ||
      !Rcost
    ) {
      return res.status(400).json({
        message: "All required fields must be provided",
      });
    }

    if (isNaN(Rcost)) {
      return res.status(400).json({
        message: "Invalid repair cost",
      });
    }

    await client.query("BEGIN");

    const insertQuery = `
      INSERT INTO car_damage_portal
      (
      addedBy,
        number_plate,
        damage_date,
        rname,
        pnumber,
        description,
        repair_cost
      )
      VALUES ($1, $2, $3, $4, $5, $6,$7)
      RETURNING *
    `;

    const values = [
      staffId,
      NumberPlate,
      date,
      Rname,
      Pnumber,
      des || "",
      Rcost,
    ];

    const result = await client.query(insertQuery, values);

    await client.query("COMMIT");

    return res.status(201).json({
      message: "Car damage record added successfully",
      data: result.rows[0],
    });

  } catch (err) {
    await client.query("ROLLBACK");

    console.error("❌ Error adding damage record:", err);

    return res.status(500).json({
      message: "Failed to add car damage record",
      error: err.message,
    });

  } finally {
    client.release();
  }
});
router.get("/getCarDamagePortal", rateLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    const header = req.headers.authorization;
    if (!header) return res.status(401).json({ message: "Missing authorization headers" });

    const token = header.split(" ")[1];
    if (!token) return res.status(401).json({ message: "Token not found" });

    const payload = await veriftJWT(token);
    if (!payload?.id) return res.status(401).json({ message: "Invalid or expired token" });

    const { numberPlate, mobileNumber, addedBy } = req.query;

    let query = `SELECT * FROM car_damage_portal WHERE 1=1`;
    const values = [];
    let index = 1;

    if (numberPlate) {
      query += ` AND LOWER(number_plate) = LOWER($${index})`;
      values.push(numberPlate);
      index++;
    }
    if (mobileNumber) {
      query += ` AND pnumber = $${index}`;
      values.push(mobileNumber);
      index++;
    }
    if (addedBy) {
      query += ` AND addedby = $${index}`; 
      values.push(addedBy);
      index++;
    }

    query += ` ORDER BY created_at DESC`;

    const result = await client.query(query, values);
    return res.status(200).json({
      count: result.rows.length,
      data: result.rows,
    });

  } catch (err) {
    console.error("❌ Error fetching car damage records:", err);
    return res.status(500).json({
      message: "Failed to fetch damage records",
      error: err.message,
    });
  } finally {
    client.release();
  }
});
const getCarTripFinancialStatus = async ({
  carId,
  fromDate,
  toDate,
  viewerRole = "owner",
}) => {
  if (!carId || !fromDate || !toDate) {
    throw new Error("carId, fromDate, and toDate are required");
  }

  const client = await pool.connect();

  try {
    const query = `
      SELECT
        b.*,
        to_jsonb(c) AS car_details
      FROM bookings b
      LEFT JOIN cars c ON c.id = b."carId"
      WHERE b."carId" = $1
        AND b."pickupDate"::date <= $3::date
        AND b."dropoffDate"::date >= $2::date
      ORDER BY b."pickupDate" ASC, b.id ASC
    `;

    const result = await client.query(query, [carId, fromDate, toDate]);

    const toNum = (val) => Number(val || 0);

    // ── Trip count based on booking duration (no extension counted) ──
    const getTripCount = (pickupDate, dropoffDate) => {
      if (!pickupDate || !dropoffDate) return 1;
      const diffMs = new Date(dropoffDate).getTime() - new Date(pickupDate).getTime();
      const diffHours = diffMs / (1000 * 60 * 60);

      if (diffHours <= 12) return 1;        // 6hr or 12hr = 1 trip
      if (diffHours <= 24) return 2;        // 24hr = 2 trips
      return Math.ceil(diffHours / 12);     // beyond 24hr, every 12hr = 1 trip
    };

    // ── 1hr free buffer for owner ──
    const adjustForOwner = (hours, amount) => {
      const h = toNum(hours);
      const a = toNum(amount);

      if (viewerRole !== "owner" || h <= 0) {
        return { hours: h, amount: a };
      }

      const perHour = a / h;
      const adjustedHours = Math.max(h - 1, 0);
      const adjustedAmount = Number(Math.max(a - perHour, 0).toFixed(2));

      return { hours: adjustedHours, amount: adjustedAmount };
    };

    const trips = result.rows.map((row) => {
      // ── Main penalty (penalty_hours + penalty_amount) with 1hr buffer ──
      const penalty = adjustForOwner(row.penalty_hours, row.penalty_amount);

      // ── Auto-extension penalty with 1hr buffer ──
      const penaltyExtension = adjustForOwner(
        row.penalty_extention_hours,
        row.penalty_extention_amount
      );

      const tripCount = getTripCount(row.pickupDate, row.dropoffDate);

      return {
        ...row,
        // Extension: pass-through raw, no buffer
        extension_hours_display: toNum(row.extension_hours),
        extension_amount_display: toNum(row.extension_amount),
        // Main penalty: 1hr buffer applied
        penalty_hours_display: penalty.hours,
        penalty_amount_display: penalty.amount,
        // Auto-extension penalty: 1hr buffer applied
        penalty_extention_hours_display: penaltyExtension.hours,
        penalty_extention_amount_display: penaltyExtension.amount,
        // Trip count for this booking
        trip_count: tripCount,
      };
    });

    const financialSummary = trips.reduce(
      (acc, row) => {
        acc.totalTrips += row.trip_count;
        acc.totalPrice += toNum(row.totalPrice);
        acc.advancePaid += toNum(row.advance_paid);
        acc.remainingAmount += toNum(row.remaining_amount);
        acc.rideStartAmount += toNum(row.ride_start_amount);
        acc.rideEndAmount += toNum(row.ride_end_amount);
        acc.creditsUsed += toNum(row.credits_used);

        // ✅ Main penalty with buffer
        acc.penaltyAmount += toNum(row.penalty_amount_display);
        acc.penaltyHours += toNum(row.penalty_hours_display);

        // Extension pass-through
        acc.extensionAmount += toNum(row.extension_amount_display);
        acc.extensionHours += toNum(row.extension_hours_display);

        // Auto-extension penalty with buffer
        acc.penaltyExtensionAmount += toNum(row.penalty_extention_amount_display);
        acc.penaltyExtensionHours += toNum(row.penalty_extention_hours_display);

        if (row.payment_completed === true) acc.paymentCompletedTrips += 1;
        if (row.payment_status === "pending") acc.pendingPaymentTrips += 1;
        if (row.payment_status === "partial_paid") acc.partialPaidTrips += 1;
        if (row.cancellation_status && row.cancellation_status !== "none") {
          acc.cancelledTrips += 1;
        }

        return acc;
      },
      {
        totalTrips: 0,
        totalPrice: 0,
        advancePaid: 0,
        remainingAmount: 0,
        rideStartAmount: 0,
        rideEndAmount: 0,
        penaltyAmount: 0,
        penaltyHours: 0,
        creditsUsed: 0,
        extensionAmount: 0,
        extensionHours: 0,
        penaltyExtensionAmount: 0,
        penaltyExtensionHours: 0,
        paymentCompletedTrips: 0,
        pendingPaymentTrips: 0,
        partialPaidTrips: 0,
        cancelledTrips: 0,
      }
    );

    return {
      carId: Number(carId),
      fromDate,
      toDate,
      viewerRole,
      financialSummary: {
        ...financialSummary,
        totalPrice: Number(financialSummary.totalPrice.toFixed(2)),
        advancePaid: Number(financialSummary.advancePaid.toFixed(2)),
        remainingAmount: Number(financialSummary.remainingAmount.toFixed(2)),
        rideStartAmount: Number(financialSummary.rideStartAmount.toFixed(2)),
        rideEndAmount: Number(financialSummary.rideEndAmount.toFixed(2)),
        penaltyAmount: Number(financialSummary.penaltyAmount.toFixed(2)),
        penaltyHours: financialSummary.penaltyHours,
        creditsUsed: Number(financialSummary.creditsUsed.toFixed(2)),
        extensionAmount: Number(financialSummary.extensionAmount.toFixed(2)),
        extensionHours: financialSummary.extensionHours,
        penaltyExtensionAmount: Number(financialSummary.penaltyExtensionAmount.toFixed(2)),
        penaltyExtensionHours: financialSummary.penaltyExtensionHours,
      },
      trips,
    };
  } finally {
    client.release();
  }
};
router.get("/carTripFinancialStatus", rateLimiter, async (req, res) => {
  try {
    const { carId, fromDate, toDate } = req.query;
//  const header = req.headers.authorization;
//     if (!header) {
//       return res.status(401).json({ message: "Missing authorization headers" });
//     }

//     const token = header.split(" ")[1];
//     if (!token) {
//       return res.status(401).json({ message: "Token not found" });
//     }

//     const payload = await veriftJWT(token);
//     if (!payload?.id) {
//       return res.status(401).json({ message: "Invalid or expired token" });
//     }

//     // You can get this from JWT too if needed
//     const viewerRole = payload.role ;
//     if(!viewerRole){
//        return res.status(401).json({ message: "Role not found" });
//     }

    if (!carId || !fromDate || !toDate) {
      return res.status(400).json({
        message: "carId, fromDate, and toDate are required",
      });
    }

    const report = await getCarTripFinancialStatus({
      carId,
      fromDate,
      toDate,

    });

    return res.status(200).json({
      message: "Car trip financial report fetched successfully",
      data: report,
    });
  } catch (err) {
    console.error("❌ Error fetching car trip financial status:", err);

    return res.status(500).json({
      message: "Failed to fetch car trip financial status",
      error: err.message,
    });
  }
});
const getOverallFinancialStatus = async ({
  fromDate,
  toDate,
}) => {
  if (!fromDate || !toDate) {
    throw new Error("fromDate and toDate are required");
  }

  const client = await pool.connect();

  try {
    const query = `
      SELECT
        b.id,
        b."userId",
        b."carId",
        b."branchId",
        b."pickupDate",
        b."dropoffDate",
        b."totalPrice",
        b.status,
        b."paymentId",
        b.extras,
        b."confirmationNumber",
        b."createdBy",
        b."createdAt",
        b."updatedAt",
        b.advance_paid,
        b.payment_status,
        b.ride_start_time,
        b.ride_end_time,
        b.penalty_amount,
        b.remaining_amount,
        b.razorpay_payment_id,
        b.razorpay_signature,
        b.credits_used,
        b.payment_completed,
        b.cancellation_status,
        b.ride_start_amount,
        b.ride_end_amount,
        b.extension_amount,
        b.extension_hours,
        b.onsite,
        b.extension_status,
        b.penalty_hours,
        b.penalty_extention_hours,
        b.auto_extention_hours_status,
        b.penalty_extention_amount
      FROM bookings b
      WHERE b."pickupDate"::date <= $2::date
        AND b."dropoffDate"::date >= $1::date
      ORDER BY b."pickupDate" ASC
    `;

    const result = await client.query(query, [fromDate, toDate]);

    const toNum = (val) => Number(val || 0);
    const fix2  = (n)   => Number(Number(n).toFixed(2));

    const parseExtras = (extras) => {
      let raw = extras;
      if (typeof raw === "string") {
        try { raw = JSON.parse(raw); } catch { raw = []; }
      }
      if (!Array.isArray(raw)) raw = [];

      const out = { pickupUpi: 0, pickupCash: 0, dropoffUpi: 0, dropoffCash: 0 };
      for (const entry of raw) {
        const upi  = toNum(entry.upi);
        const cash = toNum(entry.cash);
        if (entry.type === "handover_out") {
          out.pickupUpi  += upi;
          out.pickupCash += cash;
        } else if (entry.type === "handover_in") {
          out.dropoffUpi  += upi;
          out.dropoffCash += cash;
        }
      }
      return out;
    };

    const summary = result.rows.reduce(
      (acc, row) => {
        const ex = parseExtras(row.extras);

        acc.totalBookings     += 1;
        acc.totalPrice        += toNum(row.totalPrice);
        acc.advancePaid       += toNum(row.advance_paid);
        acc.remainingAmount   += toNum(row.remaining_amount);
        acc.rideStartAmount   += toNum(row.ride_start_amount);
        acc.rideEndAmount     += toNum(row.ride_end_amount);
        acc.creditsUsed       += toNum(row.credits_used);
        acc.penaltyAmount     += toNum(row.penalty_amount);
        acc.penaltyHours      += toNum(row.penalty_hours);
        acc.penaltyExtAmount  += toNum(row.penalty_extention_amount);
        acc.penaltyExtHours   += toNum(row.penalty_extention_hours);
        acc.extensionAmount   += toNum(row.extension_amount);
        acc.extensionHours    += toNum(row.extension_hours);

        // Extras cash breakdown
       acc.totalPickupUpi += ex.pickupUpi + toNum(row.advance_paid);
        acc.totalPickupCash   += ex.pickupCash;
        acc.totalDropoffUpi   += ex.dropoffUpi;
        acc.totalDropoffCash  += ex.dropoffCash;
        // ✅ Just change this one line
acc.totalUpi += ex.pickupUpi + ex.dropoffUpi + toNum(row.advance_paid);
        acc.totalCash         += ex.pickupCash + ex.dropoffCash;

        // Status counters
        if (row.payment_completed === true)        acc.paymentCompletedCount += 1;
        if (row.payment_status === "pending")      acc.pendingCount += 1;
        if (row.payment_status === "partial_paid") acc.partialPaidCount += 1;
        if (row.payment_status === "fully_paid")   acc.fullyPaidCount += 1;
        if (row.cancellation_status && row.cancellation_status !== "none") {
          acc.cancelledCount += 1;
        }

        acc.byStatus[row.status] = (acc.byStatus[row.status] || 0) + 1;

        return acc;
      },
      {
        totalBookings: 0,
        totalPrice: 0,
        advancePaid: 0,
        remainingAmount: 0,
        rideStartAmount: 0,
        rideEndAmount: 0,
        creditsUsed: 0,
        penaltyAmount: 0,
        penaltyHours: 0,
        penaltyExtAmount: 0,
        penaltyExtHours: 0,
        extensionAmount: 0,
        extensionHours: 0,
        totalPickupUpi: 0,
        totalPickupCash: 0,
        totalDropoffUpi: 0,
        totalDropoffCash: 0,
        totalUpi: 0,
        totalCash: 0,
        paymentCompletedCount: 0,
        pendingCount: 0,
        partialPaidCount: 0,
        fullyPaidCount: 0,
        cancelledCount: 0,
        byStatus: {},
      }
    );

    return {
      fromDate,
      toDate,
      financialSummary: {
  totalBookings:        summary.totalBookings,
  totalPrice:           fix2(summary.totalPrice),
  advancePaid:          fix2(summary.advancePaid),
  remainingAmount:      fix2(summary.remainingAmount),
  rideStartAmount:      fix2(summary.rideStartAmount),
  rideEndAmount:        fix2(summary.rideEndAmount),
  creditsUsed:          fix2(summary.creditsUsed),
  penaltyAmount:        fix2(summary.penaltyAmount),
  penaltyHours:         summary.penaltyHours,
  penaltyExtAmount:     fix2(summary.penaltyExtAmount),
  penaltyExtHours:      summary.penaltyExtHours,
  extensionAmount:      fix2(summary.extensionAmount),
  extensionHours:       summary.extensionHours,

  // ── Top-level totals across all bookings ──
  totalUpiCollected:  fix2(summary.totalUpi),   // 750 + 586 = 1336
  totalCashCollected: fix2(summary.totalCash),  // 100 + 17  = 117
  totalCollected:     fix2(summary.totalUpi + summary.totalCash), // 1453

  cashBreakdown: {
    pickup: {
      upi:   fix2(summary.totalPickupUpi),
      cash:  fix2(summary.totalPickupCash),
      total: fix2(summary.totalPickupUpi + summary.totalPickupCash),
    },
    dropoff: {
      upi:   fix2(summary.totalDropoffUpi),
      cash:  fix2(summary.totalDropoffCash),
      total: fix2(summary.totalDropoffUpi + summary.totalDropoffCash),
    },
    overall: {
      totalUpi:                fix2(summary.totalUpi),
      totalCash:               fix2(summary.totalCash),
      totalUpiAndCash:         fix2(summary.totalUpi + summary.totalCash),
      totalCollectedAtPickup:  fix2(summary.totalPickupUpi  + summary.totalPickupCash),
      totalCollectedAtDropoff: fix2(summary.totalDropoffUpi + summary.totalDropoffCash),
      grandTotal:              fix2(summary.totalUpi + summary.totalCash),
    },
  },

  paymentCompletedCount: summary.paymentCompletedCount,
  pendingCount:          summary.pendingCount,
  partialPaidCount:      summary.partialPaidCount,
  fullyPaidCount:        summary.fullyPaidCount,
  cancelledCount:        summary.cancelledCount,
  byStatus:              summary.byStatus,
},
      bookings: result.rows,
    };
  } finally {
    client.release();
  }
};
router.get("/overallFinancialStatus", rateLimiter, async (req, res) => {
  try {
    //  const header = req.headers.authorization;
    // if (!header) {
    //   return res.status(401).json({ message: "Missing authorization headers" });
    // }

    // const token = header.split(" ")[1];
    // if (!token) {
    //   return res.status(401).json({ message: "Token not found" });
    // }

    // const payload = await veriftJWT(token);
    // if (!payload?.id) {
    //   return res.status(401).json({ message: "Invalid or expired token" });
    // }

    const staffId = "9";
    const { fromDate, toDate, paymentMethod = "all" } = req.query;

    if (!fromDate || !toDate) {
      return res.status(400).json({
        message: "fromDate and toDate are required",
      });
    }

    const validMethods = ["cash", "upi", "all"];
    if (!validMethods.includes(paymentMethod.toLowerCase())) {
      return res.status(400).json({
        message: `paymentMethod must be one of: ${validMethods.join(", ")}`,
      });
    }

    const report = await getOverallFinancialStatus({
      fromDate,
      toDate,
      paymentMethod: paymentMethod.toLowerCase(),
    });
console.log("📊 Report:", JSON.stringify(report, null, 2));
    return res.status(200).json({
      message: "Overall financial report fetched successfully",
      data: report,
    });
  } catch (err) {
    console.error("❌ Error fetching overall financial status:", err);
    return res.status(500).json({
      message: "Failed to fetch overall financial status",
      error: err.message,
    });
  }
});
// 💥 NEW ROUTE: Highly optimized - Fetches UPI & Cash totals + Detailed Breakdown
router.get("/upiCashTotals", rateLimiter, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { fromDate, toDate } = req.query;

    if (!fromDate || !toDate) {
      return res.status(400).json({
        message: "fromDate and toDate are required",
      });
    }

    // 1. LIGHTWEIGHT SQL QUERY: Only fetch the 'extras' and 'advance_paid' columns
    const query = `
      SELECT extras, advance_paid 
      FROM bookings 
      WHERE "pickupDate"::date <= $2::date
        AND "dropoffDate"::date >= $1::date
    `;

    const result = await client.query(query, [fromDate, toDate]);

    // 2. SETUP OUR TRACKING BUCKETS
    let pickupUpi = 0;
    let pickupCash = 0;
    let dropoffUpi = 0;
    let dropoffCash = 0;
    let totalAdvance = 0; // 💥 FIX 1: Moved out here so it accumulates all rows together!

    // 3. PARSE AND SORT THE AMOUNTS
    for (const row of result.rows) { // 💥 FIX 2: Only ONE clean loop running through your rows!
      totalAdvance += Number(row.advance_paid || 0); 
      
      let raw = row.extras;
      
      if (typeof raw === "string") {
        try { raw = JSON.parse(raw); } catch { raw = []; }
      }
      if (!Array.isArray(raw)) raw = [];

      for (const entry of raw) {
        const u = Number(entry.upi || 0);
        const c = Number(entry.cash || 0);

        // Sort into the correct bucket based on the type
        if (entry.type === "handover_out") {
          pickupUpi += u;
          pickupCash += c;
        } else if (entry.type === "handover_in") {
          dropoffUpi += u;
          dropoffCash += c;
        }
      }
    } // 💥 FIX 3: Properly closing the single row loop. Everything aligns perfectly now!

    // 4. CALCULATE GRAND TOTALS
    const totalUpi = pickupUpi + dropoffUpi + totalAdvance; 
    const totalCash = pickupCash + dropoffCash;
    const totalPickup = pickupUpi + pickupCash;
    const totalDropoff = dropoffUpi + dropoffCash;
    const grandTotal = totalUpi + totalCash;

    // 5. SEND THE DETAILED PAYLOAD TO FRONTEND
    return res.status(200).json({
      message: "Payment totals fetched successfully",
      data: {
        // Quick access top-level totals
        upiTotal: Number(totalUpi.toFixed(2)),
        cashTotal: Number(totalCash.toFixed(2)),
        totalCollected: Number(grandTotal.toFixed(2)),
        
        // Detailed breakdown matching your old big code
        cashBreakdown: {
          pickup: {
            upi: Number(pickupUpi.toFixed(2)),
            cash: Number(pickupCash.toFixed(2)),
            total: Number(totalPickup.toFixed(2)),
          },
          dropoff: {
            upi: Number(dropoffUpi.toFixed(2)),
            cash: Number(dropoffCash.toFixed(2)),
            total: Number(totalDropoff.toFixed(2)),
          },
          overall: {
            totalUpi: Number(totalUpi.toFixed(2)),
            totalCash: Number(totalCash.toFixed(2)),
            totalCollectedAtPickup: Number(totalPickup.toFixed(2)),
            totalCollectedAtDropoff: Number(totalDropoff.toFixed(2)),
            grandTotal: Number(grandTotal.toFixed(2)),
          }
        }
      }
    });

  } catch (err) {
    console.error("❌ Error fetching payment totals:", err);
    return res.status(500).json({
      message: "Failed to fetch payment totals",
      error: err.message,
    });
  } finally {
    client.release();
  }
});

module.exports=router 
