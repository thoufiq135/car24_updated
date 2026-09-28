const express=require("express")
const router=express.Router()
const {pool}=require("./connectdb")
const rateLimiter = require("./rateLimiter")
const multer = require("multer")
const {veriftJWT}=require("./jwt")
require("dotenv").config()
const minioClient = require("./minioConnect")
async function uploadToMinio(bucket, fileName, buffer, mimeType) {
    await ensureBucket(bucket);
  await minioClient.putObject(
    bucket,
    fileName,
    buffer,
    {
      "Content-Type": mimeType
    }
  );

  const url = await minioClient.presignedGetObject(
    bucket,
    fileName,
    24 * 60 * 60 
  );

  return url;
}
async function ensureBucket(bucket) {

  const exists = await minioClient.bucketExists(bucket);

  if (!exists) {
    console.log("⚠️ Creating bucket:", bucket);
    await minioClient.makeBucket(bucket);
  }
}
const upload = multer({ storage: multer.memoryStorage() });
function generateFileName(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
}
router.post("/addCar/:branchId",rateLimiter,upload.fields([
    { name: "mainImage", maxCount: 1 },
    { name: "images", maxCount: 5 }
]),async(req,res)=>{
//     const header=req.headers.authorization
// if(!header){
//   return res.status(401).json({message:"missing headers"})
// }

// const token = header.split(" ")[1]
// const payload=await veriftJWT(token)
// if(!payload){
//   return res.status(401).json({message:"invalid token"})
// }
const userId=3
const branchId=req.params.branchId
const files = req.files;
if(!req.files || Object.keys(req.files).length === 0){
    return res.status(400).json({message:"missing images"})
}
const mainImageFile = req.files?.mainImage?.[0];
const otherImages = req.files?.images || [];


try{
    const branchRes=await pool.query(
    `
    SELECT * FROM ${process.env.branch_table} WHERE id=$1
    `,[branchId]
)
const branch_verify=branchRes.rows[0]
if(!branch_verify){
return res.status(400).json({message:"branch not found"})
}

let imageNames = [];
const {model,year,category,transmission,fuelType,seatingCapacity,features,licensePlate,mileage,colour}=req.body
console.log(colour)
  if (
 
    !model ||
    !year ||
    !category ||
    !transmission ||
    !fuelType ||
    !seatingCapacity ||
    
    !colour||
    !licensePlate
  ) {
    return res.status(400).json({ message: "Missing required fields" });
    
  }
  const plate = licensePlate.toUpperCase();
    const parsedFeatures = Array.isArray(features)
    ? features
    : features?.split(",") || [];
    const existing = await pool.query(
  `SELECT * FROM ${process.env.cars_table} WHERE "licensePlate"=$1`,
  [plate]
);

if (existing.rows.length > 0) {
  return res.status(400).json({
    message: "License plate already exists"
  });
}
// if (imageNames.length === 0) {
//   return res.status(400).json({
//     message: "At least one image required"
//   });
// }
if (!mainImageFile && otherImages.length === 0) {
  return res.status(400).json({
    message: "At least one image required"
  });
}
if (mainImageFile) {
  const fileName = generateFileName("main");

  await uploadToMinio(
    "carimages",
    fileName,
    mainImageFile.buffer,
    mainImageFile.mimetype
  );

  imageNames.push(fileName); 
}


for (let file of otherImages) {
  const fileName = generateFileName("car");

  await uploadToMinio(
    "carimages",
    fileName,
    file.buffer,
    file.mimetype
  );

  imageNames.push(fileName);
}


const result = await pool.query(
  `INSERT INTO ${process.env.cars_table} (
    "branchId",
    "ownerid",
    "model",
    "year",
    "category",
    "transmission",
    "fuelType",
    "seatingCapacity",
    "licensePlate",
    "mileage",
    "images",
    "features",
    "main_image",
    "approvalstatus",
    "status",
    "isAvailable",
    "colour",
    "createdAt",
    "updatedAt"
  )
  VALUES (
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
    $11,$12,$13,$14,$15,$16,$17,
    NOW(),NOW()
  )
  RETURNING *`,
  [
    branchId,        // 1
    userId,          // 2
    model,           // 3
    year,            // 4
    category,        // 5
    transmission,    // 6
    fuelType,        // 7
    seatingCapacity, // 8
    plate,           // 9
    mileage || 0,    // 10
    imageNames,      // 11
    parsedFeatures,  // 12
    0,               // 13 main_image
    "pending",       // 14
    "available",     // 15
    false,           // 16
    colour           // 17
  ]
);
  res.status(201).json({message: "Car created and sent for approval",data: result.rows[0]})
}catch(e){
   
    res.status(500).json({message:"internal server error",error:e.message})
}
})
router.get("/get_pending_cars",rateLimiter,async(req,res)=>{
//       const header=req.headers.authorization
// if(!header){
//   return res.status(401).json({message:"missing headers"})
// }

// const token = header.split(" ")[1]
// const payload=await veriftJWT(token)
// if(!payload){
//   return res.status(401).json({message:"invalid token"})
// }
try{
    console.log(process.env.cars_table)
    const result=await pool.query(
    `SELECT * FROM cars WHERE approvalstatus=$1`,["pending"]
)
 res.status(200).json({
      message: "Pending cars fetched successfully",
      count: result.rows.length,
      data: result.rows
    });
}catch(e){
    res.status(500).json({message:"internal server error",error:e.message})
}
})
router.put("/approve_pending_cars/:carId",rateLimiter,async(req,res)=>{
       const  {carId } = req.params;
     const {status,six,twelve,twentyFour}=req.body

           if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({
        message: "Status must be approved or rejected"
      });
    }
//       const header=req.headers.authorization
// if(!header){
//   return res.status(401).json({message:"missing headers"})
// }

// const token = header.split(" ")[1]
// const payload=await veriftJWT(token)
// if(!payload){
//   return res.status(401).json({message:"invalid token"})
// }
try{
     const car = await pool.query(
      `SELECT * FROM cars WHERE id=$1`,
      [carId]
    );

    if (car.rows.length === 0) {
      return res.status(404).json({
        message: "Car not found"
      });
    }

    
    if (car.rows[0].approvalstatus !== "pending") {
      return res.status(400).json({
        message: `Car already ${car.rows[0].approvalstatus}`
      });
    }


   const updated = await pool.query(
    `
    UPDATE cars 
    SET 
      approvalstatus = $1,
      "isAvailable" = $2,
      "six_hr_price" = COALESCE($3, "six_hr_price"),
      "twelve_hr_price" = COALESCE($4, "twelve_hr_price"),
      "twentyfour_hr_price" = COALESCE($5, "twentyfour_hr_price"),
      "updatedAt" = NOW()
    WHERE id = $6
    RETURNING *
    `,
    [
      status,
      status === "approved", 
      six || null,
      twelve || null,
      twentyFour || null,
      carId
    ]
  );
    res.status(200).json({
      message: `Car ${status} successfully`,
      data: updated.rows[0]
    });


}catch(e){
    res.status(500).json({message:"internal server error",error:e.message})
}
}) 
router.get("/get_cars", rateLimiter, async (req, res) => {
  try {
    const {
      limit,
      pageno,
      category,
      fuelType,
      seater,
      model,
      colour,
      transmission,
      branch,
      pickupDate,
      dropoffDate
    } = req.query;

    const limitVal = parseInt(limit) || 10;
    const pageVal = parseInt(pageno) || 0;
    const offset = pageVal * limitVal;

    let query = `
      SELECT c.*, b.name as branch_name
      FROM cars c
      JOIN branches b ON c."branchId" = b.id
      WHERE c.approvalstatus = 'approved'
      AND c."isAvailable" = true
    `;

    let values = [];
    let count = 1;

 

    if (category) {
      query += ` AND c.category = $${count++}`;
      values.push(category.toLowerCase());
    }

    if (fuelType) {
      query += ` AND c."fuelType" = $${count++}`;
      values.push(fuelType.toLowerCase());
    }

    if (transmission) {
      query += ` AND c.transmission = $${count++}`;
      values.push(transmission.toLowerCase());
    }

    if (seater) {
      query += ` AND c."seatingCapacity" = $${count++}`;
      values.push(parseInt(seater));
    }

    if (model) {
      query += ` AND c.model ILIKE $${count++}`;
      values.push(`%${model}%`);
    }

    if (colour) {
      query += ` AND c.colour = $${count++}`;
      values.push(colour);
    }

    if (branch) {
      query += ` AND c."branchId" = $${count++}`;
      values.push(parseInt(branch));
    }

   

    if (pickupDate && dropoffDate) {
      query += `
        AND NOT EXISTS (
          SELECT 1 FROM bookings b
          WHERE b."carId" = c.id
          AND b.status IN ('confirmed', 'ongoing')
          AND (
            b."pickupDate" < $${count}
            AND b."dropoffDate" > $${count + 1}
          )
        )
      `;
      values.push(dropoffDate, pickupDate);
      count += 2;
    }



    query += ` LIMIT $${count++} OFFSET $${count++}`;
    values.push(limitVal, offset);

    const dataResult = await pool.query(query, values);


    let countQuery = `
      SELECT COUNT(*) 
      FROM cars c
      JOIN branches b ON c."branchId" = b.id
      WHERE c.approvalstatus = 'approved'
      AND c."isAvailable" = true
    `;

    let countValues = [];
    let countIndex = 1;



    if (category) {
      countQuery += ` AND c.category = $${countIndex++}`;
      countValues.push(category.toLowerCase());
    }

    if (fuelType) {
      countQuery += ` AND c."fuelType" = $${countIndex++}`;
      countValues.push(fuelType.toLowerCase());
    }

    if (transmission) {
      countQuery += ` AND c.transmission = $${countIndex++}`;
      countValues.push(transmission.toLowerCase());
    }

    if (seater) {
      countQuery += ` AND c."seatingCapacity" = $${countIndex++}`;
      countValues.push(parseInt(seater));
    }

    if (model) {
      countQuery += ` AND c.model ILIKE $${countIndex++}`;
      countValues.push(`%${model}%`);
    }

    if (colour) {
      countQuery += ` AND c.colour = $${countIndex++}`;
      countValues.push(colour);
    }

    if (branch) {
      countQuery += ` AND c."branchId" = $${countIndex++}`;
      countValues.push(parseInt(branch));
    }



    if (pickupDate && dropoffDate) {
      countQuery += `
        AND NOT EXISTS (
          SELECT 1 FROM bookings b
          WHERE b."carId" = c.id
          AND b.status IN ('confirmed', 'ongoing')
          AND (
            b."pickupDate" < $${countIndex}
            AND b."dropoffDate" > $${countIndex + 1}
          )
        )
      `;
      countValues.push(dropoffDate, pickupDate);
      countIndex += 2;
    }

    const countResult = await pool.query(countQuery, countValues);

    const total = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(total / limitVal);

  

    res.json({
      page: pageVal,
      limit: limitVal,
      totalCars: total,
      totalPages,
      data: dataResult.rows
    });

  } catch (e) {
    res.status(500).json({
      message: "internal server error",
      error: e.message
    });
  }
});




router.post("/bookCar", rateLimiter, async (req, res) => {
  const client  = await pool.connect();
  const { carId, branchId, slots, pickupDate, dropDate, startTime, endTime } = req.body;
  const userId  = 1;
  const lockKey = `lock:car:${carId}`;

  console.log('=== BookCar Request ===');
  console.log('Body:', { carId, branchId, slots, startTime, endTime });

  try {
    // ── 1. Redis lock ──
    const lock = await redis.set(lockKey, userId, "NX", "EX", 15);
    console.log('Lock acquired:', lock);

    if (!lock) {
      return res.status(409).json({ message: "Another user is booking this car" });
    }

    await client.query("BEGIN");

    // ── 2. Get car pricing ──
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

    // ── 3. Calculate price ──
    console.log('Slots:', slots);
    const price         = calculatePrice(slots, pricing);
    const advanceAmount = calculateAdvanAmount(price);
    console.log('Price calculated:', { price, advanceAmount });

    // ── 4. Create booking ──
    const bookingResult = await client.query(
      `INSERT INTO bookings (
        "userId", "carId", "branchId",
        "pickupDate", "dropoffDate",
        "totalPrice", "status", "payment_status",
        "advance_paid", "remaining_amount",
        "createdAt", "updatedAt"
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'pending', 'pending', 0, $6, NOW(), NOW())
      RETURNING *`,
      [userId, carId, branchId, startTime, endTime, price]
    );
    console.log('Booking created:', bookingResult.rows[0]?.id);

    const booking = bookingResult.rows[0];
 
    // ── 5. Create Razorpay order ──
    console.log('Creating Razorpay order for amount:', advanceAmount);
    const order = await paymentfunction(advanceAmount, booking.id);
    console.log('Razorpay order:', order?.id);

    // ── 6. Save order id ──
    await client.query(
      `UPDATE bookings SET "paymentId" = $1 WHERE id = $2`,
      [order.id, booking.id]
    );

    await client.query("COMMIT");
    console.log('=== BookCar Success ===');

    return res.status(200).json({
      message:       "Booking created",
      bookingId:     booking.id,
      price,
      advanceAmount,
      order,
    });

  } catch (e) {
    await client.query("ROLLBACK");
    console.error('=== BookCar Error ===');
    console.error('Error:', e);
    console.error('Message:', e?.message);
    console.error('Code:', e?.code);
    console.error('Detail:', e?.detail);
    
    return res.status(500).json({
      message: "internal server error",
      error:   e?.message ?? String(e),
      code:    e?.code,
      detail:  e?.detail,
    });

  } finally {
    await redis.del(lockKey);
    client.release();
  }
});
router.post("/verify-payment", async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    } = req.body;

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

    // ── Get booking ──
    const bookingRes = await client.query(
      `SELECT * FROM bookings WHERE "paymentId" = $1`,
      [razorpay_order_id]
    );

    if (bookingRes.rows.length === 0) {
      return res.status(404).json({ message: "Booking not found" });
    }

    const booking = bookingRes.rows[0];

    console.log('Raw booking row:', booking);
console.log('totalPrice raw:', booking.totalPrice);
console.log('totalPrice type:', typeof booking.totalPrice);
console.log('All keys:', Object.keys(booking));

    // ── Idempotency check ──
    if (booking.payment_status === "partial_paid") {
      return res.json({ message: "Payment already processed" });
    }

    // ── Calculate amounts ──
    const advance   = Math.ceil(Number(booking.totalPrice) * 0.3);  // ← capital P
    const remaining = Number(booking.totalPrice) - advance;
    const otp       = Math.floor(100000 + Math.random() * 900000);

    // ── Update booking ──
    await client.query(
      `UPDATE bookings
       SET
         status = 'confirmed',
         payment_status = 'partial_paid',
         advance_paid = $1,
         remaining_amount = $2,
         "razorpay_payment_id" = $3,
         "updatedAt" = NOW(),
         "confirmationNumber" = $4
       WHERE "paymentId" = $5`,
      [advance, remaining, razorpay_payment_id, otp, razorpay_order_id]
    );

 
    // await client.query(
    //   `UPDATE ${process.env.cars_table}
    //    SET "isAvailable" = false, "updatedAt" = NOW()
    //    WHERE id = $1
    //    RETURNING id, "isAvailable"`,
       
    //   [booking.carid]
    // );

    await client.query("COMMIT");

    // console.log(`✅ Booking ${booking.id} confirmed, Car ${booking.carid} marked unavailable`);

    res.json({
      message:    "Payment verified successfully",
      bookingId:  booking.id,
      otp,
    });

  }  catch (err) {
    console.error('=== verify-payment ERROR ===');
    console.error('Message:', err.message);
    console.error('Detail:', err.detail);
    console.error('Stack:', err.stack);
    await client.query("ROLLBACK");
    res.status(500).json({ message: "Verification failed", error: err.message });
  }
});


module.exports=router