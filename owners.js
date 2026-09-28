const express=require("express")
const router=express.Router()
const {createJwt,veriftJWT}=require("./jwt")
const {pool,redis}=require("./connectdb")
const sendEmail=require("./email")
const rateLimiter=require("./rateLimiter")
const bcrypt=require("bcrypt")




router.post("/CreateOwnerAccount",rateLimiter,async(req,res)=>{
    const {Name,Username,Email,DOB,NativePlace,Mobileno,pass,role}=req.body
    if(!Name||!Username||!Email||!DOB||!NativePlace||!Mobileno||!pass||!role){
        res.status(400).json({message:"data not recived"})
        return
    }
    const password=await bcrypt.hash(pass,10)
    const Role="owner"

    try{
        const isUser=await query(
            `SELECT * FROM ${process.env.table} WHERE email=$1`,[Email]
        )
        if(isUser.rows.length!=0){
            user=isUser.rows[0]
            const payload={
                email:Email,
                id:user.id
            }
            const token=await createJwt(payload)
            if(!token){
                res.status(500).json({message:"internal server error"})
                return
            }
            res.status(400).json({message:"user already exists"})
            return
        }
        const marriedDate=""
       const result=await pool.query(
            `INSERT INTO ${process.env.table}
            (name, username, email, dob, married_date, native_place, mobileno, encrypted_pass,Role)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
            RETURNING *`,
            [Name,Username, Email, DOB, marriedDate, NativePlace, Mobileno,password,role]
        )
        const otp=Math.floor(100000 + Math.random() * 900000)
        await redis.set(`otp:${Email}`, otp, "EX", 300)
          await sendEmail(Email, "OTP Verification", `Your OTP is ${otp} expires in 5 minutes`);
        res.status(200).json({message:"OTP send",Email:Email})
    }catch(e){
        if(e. code=="23505"){
    res.status(400).json({message:"user name already exists"})
    return
}
        res.status(500).json({message:"internal server error",e})
    }
})

router.post("/LoginOwnerAccount",rateLimiter,async(req,res)=>{
    const {email,password}=req.body
if(!email&&!password){
        res.status(400).json({message:"email or password is missing"})
        return
    }
    try{
 const isUser=await pool.query(
        `SELECT * FROM ${process.env.table} WHERE email=$1`,
        [email]  
    )
    const owner=isUser.rows[0]
    if(!isUser){
        res.status(400).json({message:"user not found"})
        return
    }
    if(owner.role!=="owner"){
        res.status(401).json({message:"unauthoraized access"})
        return
    }
    const correctPass=await bcrypt.compare(password,user.encrypted_pass)
    if(!correctPass){
        res.status(400).json({message:"invalid password"})
        return
    }    
    if(!user.is_verified){
        const payload={
             email:user.email,
    id:user.id
        }
        const token=await createJwt(payload)
        if(!token){
    res.status(500).json({message:"token creation error"})
    return
}
        res.status(401).json({reVerificationToken:token})
        return
    }
const payload={
     id:user.id,
        name:user.name,
        role:user.role
}
const token=await createJwt(payload)
if(!token){
    res.status(500).json({message:"token creation error"})
    return
}
res.status(200).json({token:token})
    }catch(e){
        res.status(500).json({message:"internal server err at /ownerAccount",e})
    }
})

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

// ✅ FIXED calculatePrice — no changes needed, looks correct
// (already handles 24/12/6 hr breakdown properly)

// ✅ FIXED /getOwnerData — minor hardening only
router.get("/getOwnerData", rateLimiter, async (req, res) => { 
  try {
    // 1. JWT & Auth
    const header = req.headers.authorization;
    if (!header) return res.status(401).json({ message: "No token provided" });
    const token = header.split(" ")[1];
    const payload = await veriftJWT(token); 

    if (!payload?.id) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // 2. Get Date Filters from Query
    const { startDate, endDate } = req.query;
    const sDate = startDate ? startDate : null;
    const eDate = endDate ? endDate : null;

    // 3. Owner Details
    const ownerRes = await pool.query(
      `SELECT id, name, email, mobileno, city, state 
       FROM ${process.env.table} 
       WHERE id = $1`,
      [payload.id]
    );

    if (ownerRes.rows.length === 0) {
      return res.status(404).json({ message: "Owner not found" });
    }

    // 4. Cars
    const carsRes = await pool.query(
      `SELECT id, model, year, category, transmission, "fuelType", "seatingCapacity", status
       FROM ${process.env.cars_table}
       WHERE ownerid = $1`,
      [payload.id]
    );

    // 5. 💥 TOTAL BOOKINGS (Pulled directly from bookings table)
// 5. 💥 TOTAL BOOKINGS (Fixed Date Logic & Case Sensitivity)
   // 5. 💥 TOTAL BOOKINGS & BREAKDOWN (Fixed Midnight Bug)
    const bookingsRes = await pool.query(
      `SELECT 
         COUNT(b.id) AS total_bookings,
         COUNT(CASE WHEN b.status = 'confirmed' THEN 1 END) AS confirmed_bookings,
         COUNT(CASE WHEN b.status = 'completed' THEN 1 END) AS completed_bookings,
         COUNT(CASE WHEN b.status = 'cancelled' THEN 1 END) AS cancelled_bookings,
         COUNT(CASE WHEN b.status = 'pending' THEN 1 END) AS pending_bookings
       FROM bookings b
       JOIN ${process.env.cars_table} c ON b."carId" = c.id
       WHERE c.ownerid = $1
         AND ($2::timestamp IS NULL OR b."createdAt" >= $2::timestamp)
         -- 💥 THE FIX: Add 23h 59m 59s so it covers the entire end day!
         AND ($3::timestamp IS NULL OR b."createdAt" <= ($3::timestamp + INTERVAL '23 hours 59 minutes 59 seconds'))`,
      [payload.id, sDate, eDate]
    );

    // 6. 💥 STATS (Apply the exact same Midnight Fix here!)
    // 6. 💥 STATS (Added 'range_paid_out')
    const statsRes = await pool.query(
      `
      SELECT
        -- 🌍 ALL TIME
        COALESCE(SUM(amount), 0) AS all_time_gross,
        COALESCE(SUM(reduced_amount), 0) AS all_time_deductions,
        COALESCE(SUM(amount - reduced_amount), 0) AS all_time_net,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN (amount - reduced_amount) ELSE 0 END), 0) AS all_time_paid_out,
        COALESCE(SUM(CASE WHEN status != 'paid' THEN (amount - reduced_amount) ELSE 0 END), 0) AS all_time_pending,

        -- 📅 SELECTED DATE RANGE
        COALESCE(SUM(CASE 
          WHEN ($2::timestamp IS NULL OR created_at >= $2::timestamp) 
           AND ($3::timestamp IS NULL OR created_at <= ($3::timestamp + INTERVAL '23 hours 59 minutes 59 seconds')) 
          THEN amount ELSE 0 END), 0) AS range_gross,

        COALESCE(SUM(CASE 
          WHEN ($2::timestamp IS NULL OR created_at >= $2::timestamp) 
           AND ($3::timestamp IS NULL OR created_at <= ($3::timestamp + INTERVAL '23 hours 59 minutes 59 seconds')) 
          THEN (amount - reduced_amount) ELSE 0 END), 0) AS range_net,

        -- 💥 NEW: How much was PAID from the bookings in this date range
        COALESCE(SUM(CASE 
          WHEN status = 'paid'
           AND ($2::timestamp IS NULL OR created_at >= $2::timestamp) 
           AND ($3::timestamp IS NULL OR created_at <= ($3::timestamp + INTERVAL '23 hours 59 minutes 59 seconds')) 
          THEN (amount - reduced_amount) ELSE 0 END), 0) AS range_paid_out

      FROM booking_income
      WHERE ownerid = $1
        AND paid_to = 'owner'
      `,
      [payload.id, sDate, eDate]
    );

    // 7. 💥 CHART (Apply Midnight Fix)
    const chartRes = await pool.query(
      `
      SELECT 
        TO_CHAR(created_at AT TIME ZONE 'Asia/Kolkata', 'Mon DD') AS day,
        COALESCE(SUM(amount - reduced_amount), 0) AS value
      FROM booking_income
      WHERE ownerid = $1
        AND paid_to = 'owner'
        AND ($2::timestamp IS NULL OR created_at >= $2::timestamp)
        AND ($3::timestamp IS NULL OR created_at <= ($3::timestamp + INTERVAL '23 hours 59 minutes 59 seconds'))
      GROUP BY DATE(created_at AT TIME ZONE 'Asia/Kolkata'), day
      ORDER BY DATE(created_at AT TIME ZONE 'Asia/Kolkata') ASC;
      `,
      [payload.id, sDate, eDate]
    );

    // 8. 💥 BREAKDOWN (Apply Midnight Fix)
    const breakdownRes = await pool.query(
      `
      SELECT 
        booking_id,
        status, 
        SUM(amount) AS total_amount,
        SUM(reduced_amount) AS total_reduced_amount,
        SUM(amount - reduced_amount) AS net_earnings,
        STRING_AGG(deduction_reason, ', ') AS deduction_reasons,
        created_at::text,
        paid_at::text
      FROM booking_income
      WHERE ownerid = $1
        AND paid_to = 'owner'
        AND ($2::timestamp IS NULL OR created_at >= $2::timestamp)
        AND ($3::timestamp IS NULL OR created_at <= ($3::timestamp + INTERVAL '23 hours 59 minutes 59 seconds'))
      GROUP BY booking_id, status, created_at::text, paid_at::text
      ORDER BY created_at DESC;
      `,
      [payload.id, sDate, eDate]
    );

    // 9. 💥 Return everything cleanly
    return res.status(200).json({
      owner: ownerRes.rows[0],
      cars: carsRes.rows,
      booking_stats: bookingsRes.rows[0], // <-- Passes the whole breakdown object!
      stats: statsRes.rows[0],
      chart: chartRes.rows,
      breakdown: breakdownRes.rows
    });

    

  } catch (err) {
    console.error("Owner Data Error:", err);
    res.status(500).json({ message: "Server error" });
  }
});



// ✅ FULLY FIXED /getCarStats/:carId
router.get("/getCarStats/:carId", rateLimiter, async (req, res) => {
  try {
    const header = req.headers.authorization;
    const token = header.split(" ")[1];
    const payload = await veriftJWT(token);

    if (!payload?.id) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { carId } = req.params;

    const carRes = await pool.query(
      `SELECT id, model, year, category, transmission, "fuelType", "seatingCapacity", status
       FROM ${process.env.cars_table}
       WHERE id = $1 AND ownerid = $2`,
      [carId, payload.id]
    );

    if (carRes.rows.length === 0) {
      return res.status(404).json({ message: "Car not found" });
    }

    const statsRes = await pool.query(
      `
      SELECT
        COUNT(b.id)                                                            AS total_bookings,

        -- ✅ FIXED: uses pickupDate/dropoffDate diff, not missing "slot" column
        COALESCE(
          SUM(EXTRACT(EPOCH FROM (b."dropoffDate" - b."pickupDate")) / 3600) / 12.0,
          0
        )                                                                      AS total_trips,

        -- ✅ FIXED: uses status = 'confirmed', not missing payment_completed column
        COALESCE(SUM(b."totalPrice") FILTER (WHERE b.status = 'confirmed'), 0) AS total_earnings,

        COALESCE(SUM(b."totalPrice") FILTER (
          WHERE b.status = 'confirmed'
          AND DATE(b."createdAt" AT TIME ZONE 'Asia/Kolkata') = CURRENT_DATE
        ), 0) AS today_earnings,

        COALESCE(SUM(b."totalPrice") FILTER (
          WHERE b.status = 'confirmed'
          AND b."createdAt" >= NOW() - INTERVAL '7 days'
        ), 0) AS week_earnings,

        COALESCE(SUM(b."totalPrice") FILTER (
          WHERE b.status = 'confirmed'
          AND b."createdAt" >= NOW() - INTERVAL '30 days'
        ), 0) AS month_earnings,

        COUNT(b.id) FILTER (
          WHERE NOW() BETWEEN b."pickupDate" AND b."dropoffDate"
        ) AS active_rides,

        COUNT(b.id) FILTER (
          WHERE b."pickupDate" > NOW()
        ) AS upcoming_rides

      FROM bookings b
      WHERE b."carId" = $1
      `,
      [carId]
    );

    const activeRides = await pool.query(
      `SELECT * FROM bookings
       WHERE "carId" = $1
       AND NOW() BETWEEN "pickupDate" AND "dropoffDate"`,
      [carId]
    );

    const upcomingRides = await pool.query(
      `SELECT * FROM bookings
       WHERE "carId" = $1
       AND "pickupDate" > NOW()
       ORDER BY "pickupDate" ASC`,
      [carId]
    );

    return res.status(200).json({
      car:          carRes.rows[0],
      stats:        statsRes.rows[0],
      activeRides:  activeRides.rows,
      upcomingRides: upcomingRides.rows,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/getGroupedPayoutHistory", rateLimiter, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    // 💥 FIXED: Extract Owner ID from token manually
    const header = req.headers.authorization;
    if (!header) return res.status(401).json({ message: "No token provided" });
    const token = header.split(" ")[1];
    const payload = await veriftJWT(token);
    const ownerId = payload.id; 

    // 1. Base query without dates
    let query = `
      SELECT 
        bi.paid_at::text AS paid_at,
        COUNT(bi.id) AS total_bookings,
        SUM(bi.amount) AS total_paid,
        SUM(bi.reduced_amount) AS total_reduced_amount
      FROM booking_income bi
      WHERE bi.ownerid = $1
        AND bi.paid_to = 'owner'
        AND bi.status = 'paid'
    `;
    const params = [ownerId];

    // 2. Add Date filter ONLY if frontend sends them
    if (startDate && endDate) {
      query += ` AND bi.paid_at >= $2::timestamp AND bi.paid_at <= $3::timestamp`;
      params.push(startDate, endDate);
    }

    // 3. Group and Order
    query += `
      GROUP BY bi.paid_at::text
      ORDER BY bi.paid_at::text DESC
    `;

    const result = await pool.query(query, params);

    // Calculate totals
    let totalNet = 0;
    let totalDeductions = 0;
    result.rows.forEach(row => {
        totalNet += (parseFloat(row.total_paid) - parseFloat(row.total_reduced_amount));
        totalDeductions += parseFloat(row.total_reduced_amount);
    });

    res.status(200).json({ summary: { totalNet, totalDeductions }, data: result.rows });
  } catch (err) {
    console.error("Grouped History Error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.get("/getPayoutDetailsByTime", rateLimiter, async (req, res) => {
  try {
    const { paidAt } = req.query;

    // 💥 FIXED: Extract Owner ID from token manually
    const header = req.headers.authorization;
    if (!header) return res.status(401).json({ message: "No token provided" });
    const token = header.split(" ")[1];
    const payload = await veriftJWT(token);
    const ownerId = payload.id;

    const result = await pool.query(`
      SELECT 
        bi.id, bi.booking_id, bi.amount, bi.reduced_amount, bi.deduction_reason,
        c.model as car_model, c."licensePlate"
      FROM booking_income bi
      JOIN ${process.env.cars_table} c ON bi."carId" = c.id
      WHERE bi.ownerid = $1 
        AND bi.paid_to = 'owner'
        AND bi.paid_at::text = $2
    `, [ownerId, paidAt]);

    res.status(200).json(result.rows);
  } catch (err) {
    console.error("Payout Details Error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});
 
router.get("/carGps/:carId", rateLimiter, async (req, res) => {
  try {
    console.log("=== GPS API HIT ===");

    const header = req.headers.authorization;
    console.log("Authorization Header:", header);

    if (!header) {
      console.log("❌ Missing auth header");
      return res.status(401).json({ message: "Missing authorization headers" });
    }

    const token = header.split(" ")[1];
    console.log("Token:", token);

    if (!token) {
      console.log("❌ Token not found");
      return res.status(401).json({ message: "Token not found" });
    }

    const payload = await veriftJWT(token);
    console.log("JWT Payload:", payload);

    if (!payload) {
      console.log("❌ Invalid token");
      return res.status(401).json({ message: "Invalid or expired token" });
    }

    const { carId } = req.params;
    console.log("Car ID:", carId);

    // ✅ FIXED QUERY (ONLY CHANGE)
    const result = await pool.query(
      "SELECT \"licensePlate\" FROM cars WHERE id = $1",
      [carId]
    );

    console.log("DB Result:", result.rows);

    if (result.rows.length === 0) {
      console.log("❌ Car not found");
      return res.status(404).json({ message: "Car not found" });
    }

    const licensePlate = result.rows[0].licensePlate;
    console.log("License Plate:", licensePlate);

    const apiRes = await fetch(
      "https://api.wheelseye.com/currentLoc?accessToken=5592c132-c784-401e-8b37-dcf7ff478f38"

    );

    const data = await apiRes.json();

    console.log("API Status:", apiRes.status);
    console.log("Total Vehicles:", data?.data?.list?.length);

    const vehicles = data?.data?.list || [];

    const normalize = (str) =>
      str ? str.replace(/\s/g, "").toLowerCase() : "";

    const vehicle = vehicles.find((v) => {
      const apiNum = normalize(v.vehicleNumber);
      const dbNum = normalize(licensePlate);

      if (apiNum === dbNum) {
        console.log("✅ MATCH FOUND:", apiNum);
        return true;
      }
      return false;
    });

    if (!vehicle) {
      console.log("❌ No vehicle match");
      console.log("DB Plate:", licensePlate);
      console.log(
        "Sample API Plates:",
        vehicles.slice(0, 5).map(v => v.vehicleNumber)
      );

      return res.status(404).json({
        message: "Vehicle location not found",
      });
    }

    console.log("📍 Vehicle Found:", vehicle);

    return res.status(200).json({
      success: true,
      carId,
      location: {
        latitude: vehicle.latitude,
        longitude: vehicle.longitude,
        speed: vehicle.speed,
        ignition: vehicle.ignition,
        time: vehicle.dttime,
      },
    });

  } catch (e) {
    console.error("=== GPS Error ===");
    console.error("Message:", e?.message);
    console.error("Stack:", e?.stack);

    return res.status(500).json({
      message: "internal server error",
      error: e?.message ?? String(e),
    });
  }
});

module.exports=router