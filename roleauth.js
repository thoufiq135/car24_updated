
const express=require("express")
const router=express.Router()
const {pool,redis}=require("./connectdb")
const sendEmail=require("./email")
const rateLimiter=require("./rateLimiter")
const bcrypt=require("bcrypt")
const minioClient = require("./minioConnect");
const multer = require("multer")
const {createJwt,veriftJWT}=require("./jwt")


async function CreateSendOTP(email) {
    const otp=Math.floor(100000 + Math.random() * 900000)
        await redis.set(`otp:${email}`, otp, "EX", 300)
          await sendEmail(email, "OTP Verification", `Your OTP is ${otp} expires in 5 minutes`);
          return true
}

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



router.post("/createMangement", rateLimiter, async (req, res) => {
    if (!req.headers.authorization) {
  return res.status(401).json({ message: "missing headers" });
}
    const header=req.headers.authorization
    const token=header.split(" ")[1]
    const payload=await veriftJWT(token)
   if (payload.role !== "admin" && payload.role !== "superadmin") {
    return res.status(403).json({message: "unauthorized"}) // Also, 403 is better for unauthorized!
    }
  try {
    const { role, branch } = req.body;
    if (role === "staff" || role === "sub_admin") {
      if (!branch) {
        return res.status(400).json({ message: "please mention branch" });
      }
    }

    const {
      name, 
      mobile_no,
      email,
      password,
      dob,
      marrieddate,
      address,
      permissions
    } = req.body;
    const clientCheck = await pool.query(
      `SELECT * FROM ${process.env.table} WHERE email=$1`,
      [email]
    );

    if (clientCheck.rows.length > 0) {
      return res.status(400).json({
        message: "email already registered as client"
      });
    }


    const manageCheck = await pool.query(
      `SELECT * FROM ${process.env.Management} WHERE email=$1`,
      [email]
    );

    if (manageCheck.rows.length > 0) {
      return res.status(400).json({
        message: "account already exists"
      });
    }
    const encrypted_pass = await bcrypt.hash(password, 10);
    const isUser = await pool.query(
      `SELECT * FROM ${process.env.Management} WHERE email=$1`,
      [email]
    );

    if (isUser.rows.length !== 0) {
      return res.status(400).json({ message: "account already exists" });
    }
    const result = await pool.query(
      `INSERT INTO ${process.env.Management}
      (name, mobile_no, email, encrypted_pass, dob, married_date, address, role, permissions, branch)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *`,
      [
        name,
        mobile_no,
        email,
        encrypted_pass,
        dob,
        marrieddate,
        address,
        role,
        JSON.stringify(permissions), 
        branch
      ]
    );
const sendMail=await CreateSendOTP(email)
if(!sendMail){
    return res.status(500).json({message:"otp sending fail"})
}
    return res.status(201).json({
      message: "User created successfully",
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "internal server error" });
  }
});
router.put("/verifyManagementRegister",rateLimiter,async(req,res)=>{
    const {otp,email}=req.body
    const header=req.headers.authorization
    const token=header.split(" ")[1]
    const payload=await veriftJWT(token)
    if (payload.role !== "admin" && payload.role !== "superadmin") {
    return res.status(403).json({message: "unauthorized"}) // Also, 403 is better for unauthorized!
    }
    const storedotp=await redis.get(`otp:${email}`)

    // console.log(storedotp)
    if(!storedotp){
        // console.log("otp expired")
        res.status(400).json({message:"otp expired"})
        return
    }
if(storedotp!=otp){
        // console.log("otp invalid")
        res.status(400).json({message:"otp invalid"})
        return
    }
        await pool.query(
      `UPDATE ${process.env.Management}
       SET is_verified = true
       WHERE email = $1`,
      [email]
    );

    await redis.del(`otp:${email}`);
    res.status(200).json({message:"user verified successfully"})
})
// ============================================================================
// 1. MANAGEMENT DIRECTORY ROUTE (Staff, Subadmins, etc.)
// ============================================================================
router.get("/getManagementData/:id/:branch/:role/:number/:offset",
  rateLimiter,
  async (req, res) => {
    try {
      const { id, branch, role, number, offset } = req.params;
      
      // 💥 NEW: Catch the text search from the frontend!
      const { search } = req.query;

      const header = req.headers.authorization;
      if (!header) {
        return res.status(401).json({ message: "No token provided" });
      }

      const token = header.split(" ")[1];
      const payload = await veriftJWT(token);

      if (["user", "owner", "staff"].includes(payload.role)) {
        return res.status(403).json({ message: "unauthorized person" });
      }

      const formatUser = (user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        dob: user.dob,
        marriedDate: user.married_date,
        mobileNo: user.mobile_no,
        role: user.role,
        branch: user.branch,
        is_verified: Boolean(user.profile_verified),
        permissions: Array.isArray(user.permissions)
          ? user.permissions
          : JSON.parse(user.permissions || "[]"),
        address: user.address || "not added address",
        created_at: user.created_at
      });

      // ─── 1. FETCH SINGLE ID ───
      if (id && id !== "null") {
        const data = await pool.query(
          `SELECT * FROM ${process.env.Management} WHERE id=$1`,
          [id]
        );

        if (data.rows.length === 0) {
          return res.status(404).json({ message: "user not found" });
        }

        return res.status(200).json({
          data: formatUser(data.rows[0])
        });
      }

      // ─── 2. FETCH PAGINATED LIST ───
      let query = `SELECT * FROM ${process.env.Management}`;
      let values = [];
      let conditions = [];

      // Branch Filtering
      if (payload.role === "subadmin") {
        conditions.push(`branch=$${values.length + 1}`);
        values.push(payload.branch);
      } else if (branch && branch !== "null") {
        conditions.push(`branch=$${values.length + 1}`);
        values.push(branch);
      }
      
      // Role Filtering
      if (role && role !== "null") {
        conditions.push(`role=$${values.length + 1}`);
        values.push(role);
      }

      // 💥 NEW: Global Text Search (Searches Name, Email, or Phone!)
      if (search && search !== "null" && search !== "") {
        conditions.push(`(name ILIKE $${values.length + 1} OR email ILIKE $${values.length + 1} OR mobile_no ILIKE $${values.length + 1})`);
        values.push(`%${search}%`);
      }

      // Combine conditions
      if (conditions.length > 0) {
        query += " WHERE " + conditions.join(" AND ");
      }

      const limit = parseInt(number) || 100;
      const off = parseInt(offset) || 0;

      query += ` LIMIT $${values.length + 1} OFFSET $${values.length + 2}`;
      values.push(limit, off);

      const data = await pool.query(query, values);

      if (data.rows.length === 0) {
        // Return empty array instead of 404 so frontend doesn't crash on an empty search
        return res.status(200).json({ count: 0, data: [] });
      }

      const users = data.rows.map(formatUser);

      return res.status(200).json({
        count: users.length,
        data: users
      });

    } catch (e) {
      console.error(e);
      return res.status(500).json({ message: "internal server error" });
    }
  }
);


// ============================================================================
// 2. EXTERNAL DIRECTORY ROUTE (Customers & Owners)
// ============================================================================
router.get("/getUsersData/:id/:role/:number/:offset",
  rateLimiter,
  async (req, res) => {
    try {
      const { id, role, number, offset } = req.params;
      
      // 💥 NEW: Catch the text search from the frontend!
      const { search } = req.query;

      const header = req.headers.authorization;
      if (!header) {
        return res.status(401).json({ message: "No token provided" });
      }

      const token = header.split(" ")[1];
      const payload = await veriftJWT(token);

      if (["user", "owner", "staff"].includes(payload.role)) {
        return res.status(403).json({ message: "unauthorized person" });
      }

      const formatUser = (user) => ({
        id: user.id,
        name: user.name,
        username: user.username,
        email: user.email,
        dob: user.dob,
        marriedDate: user.married_date,
        mobileNo: user.mobileno,
        role: user.role,
        is_verified: user.is_verified,
        is_profile_completed: user.is_profile_completed,
        address: user.address || "Not added",
        city: user.city,
        state: user.state,
        pincode: user.pincode,
        created_at: user.created_at
      });

      // ─── 1. FETCH SINGLE ID ───
      if (id && id !== "null") {
        const data = await pool.query(
          `SELECT * FROM users WHERE id=$1`,
          [id]
        );

        if (data.rows.length === 0) {
          return res.status(404).json({ message: "user not found" });
        }

        return res.status(200).json({
          data: formatUser(data.rows[0])
        });
      }

      // ─── 2. FETCH PAGINATED LIST ───
      let query = `SELECT * FROM users`;
      let values = [];
      let conditions = [];

      // Role Filtering
      if (role && role !== "null") {
        conditions.push(`role=$${values.length + 1}`);
        values.push(role);
      } else {
        conditions.push(`role IN ('user', 'owner')`);
      }

      // 💥 NEW: Global Text Search (Searches Name, Email, or Phone!)
      if (search && search !== "null" && search !== "") {
        // Notice we use 'mobileno' here to match the users table!
        conditions.push(`(name ILIKE $${values.length + 1} OR email ILIKE $${values.length + 1} OR mobileno ILIKE $${values.length + 1})`);
        values.push(`%${search}%`);
      }

      // Combine conditions
      if (conditions.length > 0) {
        query += " WHERE " + conditions.join(" AND ");
      }

      query += ` ORDER BY created_at DESC`;

      const limit = parseInt(number) || 100;
      const off = parseInt(offset) || 0;

      query += ` LIMIT $${values.length + 1} OFFSET $${values.length + 2}`;
      values.push(limit, off);

      const data = await pool.query(query, values);
 
      if (data.rows.length === 0) {
        // Return empty array instead of 404 so frontend doesn't crash on an empty search
        return res.status(200).json({ count: 0, data: [] });
      }

      const users = data.rows.map(formatUser);

      return res.status(200).json({
        count: users.length, 
        data: users
      });

    } catch (e) {
      console.error("Get Users Error:", e);
      return res.status(500).json({ message: "internal server error" });
    }
  }
);

router.get("/getUserDocuments/:userId", rateLimiter, async (req, res) => {
  try {
    const { userId } = req.params;
    
    // 1. Auth & Role Check
    const header = req.headers.authorization;
    if (!header) return res.status(401).json({ message: "No token provided" });

    const token = header.split(" ")[1];
    const payload = await veriftJWT(token);

    if (["user", "owner", "staff"].includes(payload.role)) {
      return res.status(403).json({ message: "unauthorized person" });
    }

    // 2. Fetch ONLY the document fields from the database
    const data = await pool.query(
      `SELECT 
        dp_bucket, dp_file_name, 
        aadhar_bucket, aadhar_file_name, 
        license_bucket, license_file_name 
       FROM users WHERE id = $1`,
      [userId]
    );

    if (data.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const userDocs = data.rows[0];

    // 3. Helper to generate Presigned URLs
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

    // 4. Generate the UNMASKED URLs
    const customer_dp_url = await generateUrl(userDocs.dp_bucket, userDocs.dp_file_name);
    const customer_id_url = await generateUrl(userDocs.aadhar_bucket, userDocs.aadhar_file_name);
    const customer_license_url = await generateUrl(userDocs.license_bucket, userDocs.license_file_name);

    // 5. Send back to frontend
    return res.status(200).json({
      customer_dp_url,
      customer_id_url,        // Note: Using unmasked names per your request
      customer_license_url    // Note: Using unmasked names per your request
    });

  } catch (e) {
    console.error("Get User Documents Error:", e);
    return res.status(500).json({ message: "internal server error" });
  }
});

router.get('/getManagementProfile', async (req, res) => {
  try {
    // 🔐 JWT extract
    const header = req.headers.authorization;
    if (!header) {
      return res.status(401).json({ message: "Missing authorization" });
    }

    const token = header.split(" ")[1];
    const payload = await veriftJWT(token);

    if (!payload) {
      return res.status(401).json({ message: "Invalid token" });
    }

    const userId = payload.id;

    // 🔥 MAIN QUERY
    const result = await pool.query(
      `
      SELECT 
        m.id,
        m.name,
        m.email,
        m.mobile_no,
        m.role,
        m.permissions,
        m.address,
        m.is_verified,
        m.created_at,

        b.id          AS branch_id,
        b.name        AS branch_name,
        b.city        AS branch_city,
        b.state       AS branch_state,
        b."zipCode"   AS branch_zipcode,
        b.phone       AS branch_phone,
        b.email       AS branch_email

      FROM management m
      LEFT JOIN branches b 
        ON m.branch::integer = b.id

      WHERE m.id = $1
      `,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json(result.rows[0]);

  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.get("/branch_cars/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { isavailable, approvalstatus } = req.query;

    // 💥 FIX 1: Match exactly "branchId" (capital I)
    let query = `SELECT * FROM cars WHERE "branchId" = $1`;
    let values = [id];
    let index = 2;

    // ✅ Apply filter only if provided
    if (isavailable !== undefined) {
      // 💥 FIX 2: Match exactly "isAvailable" (capital A)
      query += ` AND "isAvailable" = $${index++}`;
      values.push(isavailable === "true");
    }

    if (approvalstatus !== undefined) {
      // approvalstatus is all lowercase in your DB, so no quotes needed!
      query += ` AND approvalstatus = $${index++}`;
      values.push(approvalstatus);
    }

    // Optional: Add an ORDER BY so newest cars show first
    query += ` ORDER BY "createdAt" DESC`;

    const result = await pool.query(query, values);
     // ✅ STEP 2: CONVERT MINIO FILENAMES → URLS
    const carsWithImageUrls = await Promise.all(
      result.rows.map(async (car) => {
        let finalUrls = [];

        if (car.images && car.images.length > 0) {
          finalUrls = await Promise.all(
            car.images.map(async (imgString) => {
              try {
                // 🔥 If already full URL → keep it
                if (
                  imgString.startsWith("http://") ||
                  imgString.startsWith("https://")
                ) {
                  return imgString;
                }

                // 🔥 Otherwise generate MinIO URL
                return await minioClient.presignedGetObject(
                  "carimages",
                  imgString,
                  24 * 60 * 60 // 1 day expiry
                );
              } catch (err) {
                console.error("Image URL Error:", imgString);
                return null;
              }
            })
          );
        }

        return {
          ...car,
          images: finalUrls.filter((url) => url !== null),
        };
      })
    );


    res.json({
      count: result.rows.length,
      data: carsWithImageUrls
    });

  } catch (err) {
    console.error("Error fetching branch cars:", err.message);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.get("/branch_dashboard/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { fromDate, toDate } = req.query; 

    // Default empty filters (All-Time)
    let bookingsCreatedFilter = "";
    let onRoadDateFilter = "";
    // let carsCreatedFilter = "";
    
    // $1 will ALWAYS be the branch ID. $2 and $3 will be the dates (if provided)
    let queryParams = [id];

    // 💥 THE MAGIC: Assign all three specific date filters!
    if (
      fromDate && toDate && 
      fromDate !== 'null' && toDate !== 'null' && 
      fromDate !== 'undefined' && toDate !== 'undefined'
    ) {
      // 1. For general bookings (uses createdAt)
      bookingsCreatedFilter = ` AND b."createdAt"::date >= $2::date AND b."createdAt"::date <= $3::date`;
      
      // 2. For on-road tracking (uses ride_start_time just like Superadmin)
      onRoadDateFilter = ` AND b.ride_start_time::date >= $2::date AND b.ride_start_time::date <= $3::date`;
      
      // 3. For total fleet (uses createdAt on the cars table)
      // carsCreatedFilter = ` AND "createdAt"::date >= $2::date AND "createdAt"::date <= $3::date`;
      
      queryParams.push(fromDate, toDate);
    }

    // 🔥 MAIN BOOKINGS QUERY (Scoped by branchId and filtered by dates)
    const result = await pool.query(`
      SELECT
        -- ✅ Total bookings created in this date range
        COUNT(*) FILTER (
          WHERE 1=1 ${bookingsCreatedFilter}
        ) AS total_bookings,

        -- ✅ Completed bookings from this date range
        COUNT(*) FILTER (
          WHERE b.ride_start_time IS NOT NULL
          AND b.ride_end_time IS NOT NULL
          ${bookingsCreatedFilter}
        ) AS completed_bookings,

        -- ✅ Cancelled bookings from this date range
        COUNT(*) FILTER (
          WHERE b.status = 'cancelled'
          ${bookingsCreatedFilter}
        ) AS cancelled_bookings,

        -- ✅ On-road (Went out during these dates, never came back)
        COUNT(DISTINCT b."carId") FILTER (
          WHERE b.ride_start_time IS NOT NULL
          AND b.ride_end_time IS NULL
          ${onRoadDateFilter}
        ) AS onroad_cars

      FROM bookings b
      JOIN cars c ON c.id = b."carId"
      WHERE c."branchId" = $1
    `, queryParams);

    // 🔥 TOTAL CARS QUERY (Now perfectly filtered by dates!)
    // 🔥 TOTAL CARS QUERY (Now perfectly filtered by dates!)
    const carsResult = await pool.query(`
      SELECT COUNT(*) AS total_cars
      FROM cars
      WHERE "branchId" = $1
    `, [id]);

    const totalCars = Number(carsResult.rows[0].total_cars);
    const onRoadCars = Number(result.rows[0].onroad_cars);

    // ✅ Idle cars (Registered during dates - On Road during dates)
    const idleCars = totalCars - onRoadCars;

    res.json({
      totalBookings: Number(result.rows[0].total_bookings),
      completedBookings: Number(result.rows[0].completed_bookings),
      cancelledBookings: Number(result.rows[0].cancelled_bookings),
      onRoadToday: onRoadCars,
      totalCars,
      idleCars,
    });

  } catch (err) {
    console.error("Dashboard error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});
router.put("/updateCar/:id", rateLimiter, async (req, res) => {
  try {
    const { id } = req.params;

    // const header = req.headers.authorization;
    // if (!header) {
    //   return res.status(401).json({ message: "Missing authorization header" });
    // }

    // const token = header.split(" ")[1];
    // if (!token) {
    //   return res.status(401).json({ message: "Token not found" });
    // }

    // const payload = await veriftJWT(token);
    // if (!payload) {
    //   return res.status(401).json({ message: "Invalid token" });
    // }
    const allowedFields = [
      "model",
      "year",
      "category",
      "transmission",
      "fuelType",
      "seatingCapacity",
      "pricePerDay",
      "images",
      "features",
      "isAvailable",
      "licensePlate",
      "mileage",
      "main_image",
      "approvalstatus",
      "status",
      "colour",

      "six_hr_price",
      "twelve_hr_price",
      "twentyfour_hr_price",

      "percentage",

      "branchId"
    ];

    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([key]) =>
        allowedFields.includes(key)
      )
    );
    const keys = Object.keys(updates);
    if (keys.length === 0) {
      return res.status(400).json({ message: "No fields to update" });
    }
    // 💥 FIX: Add double quotes around the key!
    const setClause = keys
      .map((key, i) => `"${key}" = $${i + 1}`) 
      .join(", ");

    const values = Object.values(updates);

    const query = `
      UPDATE cars
      SET ${setClause}, "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = $${keys.length + 1}
      RETURNING *
    `;

    const result = await pool.query(query, [...values, id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Car not found" });
    }

    res.status(200).json({
      message: "Car updated successfully",
      data: result.rows[0]
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

router.put("/changePass",rateLimiter,async(req,res)=>{
    const header=req.headers.authorization
const {pass}=req.body
    const token=header.split(" ")[1]
    if(!token){
        res.status(401).json({message:"token not found"})
        return
    }
    const payload=await veriftJWT(token)
    if(!payload){
        res.status(500).json({message:"jwt error"})
        return
    }
    
const newPass=await bcrypt.hash(pass,10)
    try{
        const user=await pool.query(
            `SELECT role FROM ${process.env.table} where email=$1`,[payload.email]
        )
        if(user.rows.length==0){
             res.status(400).json({message:"user not found"})
        return
        }
        const result=await pool.query(
            `UPDATE ${process.env.table} SET encrypted_pass=$1 WHERE email=$2`,
            [newPass,payload.email]
        )
        if(!result){
            res.status(500).json({message:"internal server error ",e})
            return
        }
        res.status(200).json({message:"password successfully changed"})
    }catch(e){
        res.status(500).json({message:`internal server error ${e}`})
    }
})

router.put("/superAdmin/changePass/:email",rateLimiter,async(req,res)=>{
    const header=req.headers.authorization
    const {pass}=req.body
    const {email}=req.params
    const token=header.split(" ")[1]
    if(!token){
        res.status(401).json({message:"token not found"})
        return
    }
    const payload=await veriftJWT(token)
    if(!payload){
        res.status(500).json({message:"jwt error"})
        return
    }
    if(payload.role!=="superadmin"){
        res.status(401).json({message:"unauthoraized"})
        return
    }


    try{
        const user=await pool.query(
            `SELECT role FROM ${process.env.Management} where email=$1`,[email]
        )
        if(user.rows.length==0){
             res.status(400).json({message:"user not found"})
        return
        }
        
        const newPass=await bcrypt.hash(pass,10)
        const result=await pool.query(
            `UPDATE ${process.env.Management} SET encrypted_pass=$1 WHERE email=$2`,
            [newPass,email]
        )
        if(result.rowCount === 0){
            res.status(500).json({message:"Failed to update password"})
            return
        }
        res.status(200).json({message:"password successfully changed"})
    }catch(e){
        res.status(500).json({message:`internal server error ${e}`})
    }
})

router.get("/get_income/:branchId", rateLimiter, async (req, res) => {
  try {
    const { branchId } = req.params;
    const branchIdNum = Number(branchId);
    // 💥 CHANGED: Grab your fromDate and toDate from the query parameters
    const { fromDate, toDate } = req.query; 

    let dateFilter = "";
    let queryParams = [branchIdNum];

    // 💥 THE MAGIC: Inject date range tracking without affecting columns or grouping
    if (fromDate && toDate) {
      dateFilter = ` AND created_at::date >= $2::date AND created_at::date <= $3::date`;
      queryParams.push(fromDate, toDate);
    }

    // 💥 The math and layout variables remain 100% untampered with!
    const result = await pool.query(
      `SELECT 
        booking_id,
        MAX(created_at) as created_at,
        
        -- Add up all the splits to get the true total booking price
        SUM(amount) as full_booking_price,
        
        -- Get the specific cuts using FILTER
        SUM(amount) FILTER (WHERE paid_to = 'owner') as owner_cut,
        SUM(amount) FILTER (WHERE paid_to = 'branch') as branch_cut,
        SUM(amount) FILTER (WHERE paid_to = 'superadmin') as superadmin_cut
        
       FROM booking_income 
       WHERE "branchId" = $1 AND booking_id IS NOT NULL ${dateFilter}
       GROUP BY booking_id
       ORDER BY MAX(created_at) DESC`,
      queryParams
    );

    console.log(`🚀 FETCHED CLEAN INCOME FOR BRANCH ${branchIdNum}:`, result.rows);

    return res.status(200).json({ data: result.rows });
  } catch (err) {
    console.error("Get Income Error:", err);
    res.status(500).json({ message: "internal server error" });
  }
});
// 2. Get revenue summary for all branches
router.get("/get_branches_revenue", async (req, res) => {
  try {
    // 1. Grab the dates from the frontend request
    const { fromDate, toDate } = req.query;

    let queryParams = [];
    
    // 2. Start the base join condition (ignores old test data)
    let joinCondition = `b.id = i."branchId" AND i.booking_id IS NOT NULL`;

    // 3. 💥 THE MAGIC: If dates are provided, append them to the JOIN condition!
    if (fromDate && toDate) {
      // We use i.created_at here to match the dates against the income logs
      joinCondition += ` AND i.created_at::date >= $1::date AND i.created_at::date <= $2::date`;
      queryParams.push(fromDate, toDate);
    }

    // 4. Set up the dynamic query string
    let queryText = `
      SELECT 
        b.id, 
        b.name, 
        b.city, 
        
        -- 1. Full Booking Price (Sum of ALL splits: owner + branch + superadmin)
        COALESCE(SUM(i.amount), 0) as total_volume,
        
        -- 2. What the Branch & Superadmin actually keep combined
        COALESCE(SUM(i.amount) FILTER (WHERE i.paid_to IN ('branch', 'superadmin')), 0) as branch_retained,
        
        -- 3. What goes to the car owners
        COALESCE(SUM(i.amount) FILTER (WHERE i.paid_to = 'owner'), 0) as owner_payout
        
      FROM branches b
      LEFT JOIN booking_income i ON ${joinCondition}
      GROUP BY b.id, b.name, b.city
      -- Orders the leaderboard by the highest total volume for the selected dates
      ORDER BY total_volume DESC 
    `;

    // 5. Execute the query
    const result = await pool.query(queryText, queryParams);
    
    // 💥 THIS WILL PRINT A TABLE IN YOUR TERMINAL
    console.log("====================================");
    console.log(`💰 CLEAN RAW DATA FOR /get_branches_revenue [${fromDate || 'ALL-TIME'} to ${toDate || 'ALL-TIME'}]:`);
    console.table(result.rows);
    console.log("====================================");

    res.json(result.rows);
  } catch (e) {
    console.error("Revenue Query Error:", e);
    res.status(500).json({ message: 'Internal server error' });
  }
});

router.get("/getAllData", rateLimiter, async (req, res) => {
  const header = req.headers.authorization;
  if (!header) {
    return res.status(401).json({ message: "Missing authorization header" });
  }

  const token = header.split(" ")[1];
  if (!token) {
    return res.status(401).json({ message: "Token not found" });
  }

  const payload = await veriftJWT(token);
  if (!payload) {
    return res.status(401).json({ message: "Invalid token" });
  }

  try {
    const { fromDate, toDate } = req.query;
    
    let queryParams = [];

    // 1. DEFAULT STATE (When no dates are selected)
    // let carsFilter = ``;
    // let pendingCarsFilter = ``;
    // let branchesFilter = ``;
    let totalBookingsFilter = ``; 
    // let verifiedUsersFilter = ``;
    // let ownersFilter = ``;

    // 🚗 Cars Used Today: Any car that went out today (even if returned)
    let carsUsedFilter = `WHERE DATE("ride_start_time") = CURRENT_DATE`; 
    
    // 🚙 On Road: Any car physically out RIGHT NOW
    let onRoadFilter = `WHERE "ride_start_time" IS NOT NULL AND "ride_end_time" IS NULL`;

    // 2. DATE SELECTED STATE
    if (
      fromDate && toDate && 
      fromDate !== 'null' && toDate !== 'null' && 
      fromDate !== 'undefined' && toDate !== 'undefined'
    ) {
      // carsFilter = `WHERE "createdAt"::date >= $1::date AND "createdAt"::date <= $2::date`;
      // pendingCarsFilter = `AND "createdAt"::date >= $1::date AND "createdAt"::date <= $2::date`;
      // branchesFilter = `WHERE "createdAt"::date >= $1::date AND "createdAt"::date <= $2::date`;
      totalBookingsFilter = `WHERE "createdAt"::date >= $1::date AND "createdAt"::date <= $2::date`;
      
      // Users table uses snake_case
      // verifiedUsersFilter = `AND created_at::date >= $1::date AND created_at::date <= $2::date`;
      // ownersFilter = `AND created_at::date >= $1::date AND created_at::date <= $2::date`;
      
      // 🚗 OVERRIDE Cars Used: Count ANY car that started a ride in this date window
      carsUsedFilter = `WHERE "ride_start_time"::date >= $1::date AND "ride_start_time"::date <= $2::date`;
      
      // 🚙 OVERRIDE On Road: Count cars that started a ride in this window AND never came back
      onRoadFilter = `WHERE "ride_start_time"::date >= $1::date AND "ride_start_time"::date <= $2::date AND "ride_end_time" IS NULL`;
      
      queryParams.push(fromDate, toDate);
    }

    // 3. THE SQL QUERY
    const query = `
      SELECT
        (SELECT COUNT(*) FROM cars) AS total_cars,

        (SELECT COUNT(*) FROM cars 
         WHERE approvalstatus = 'pending') AS pending_cars,

        (SELECT COUNT(*) FROM branches) AS total_branches,

        -- 🚗 Cars Used Metric
        (SELECT COUNT(DISTINCT "carId") 
         FROM bookings 
         ${carsUsedFilter}
        ) AS cars_used_today,

        -- 🚙 NEW: Live On Road Metric
        (SELECT COUNT(DISTINCT "carId") 
         FROM bookings 
         ${onRoadFilter}
        ) AS onroad_cars,

        -- Total Bookings Metric
        (SELECT COUNT(*) 
         FROM bookings 
         ${totalBookingsFilter}
        ) AS total_bookings,

        (SELECT COUNT(*) FROM users 
         WHERE is_verified = true
        ) AS verified_users,

        (SELECT COUNT(*) FROM users 
         WHERE role = 'owner'
        ) AS total_owners
    `;

    const result = await pool.query(query, queryParams);
    const data = result.rows[0];

    // 4. THE RESPONSE TO FRONTEND
    res.status(200).json({
      totalCars: parseInt(data.total_cars),
      pendingCars: parseInt(data.pending_cars),
      totalBranches: parseInt(data.total_branches),
      
      carsUsedToday: parseInt(data.cars_used_today),
      
      // 💥 NEW: Send the exact On Road count to the frontend!
      onRoadCars: parseInt(data.onroad_cars),
      
      totalBookings: parseInt(data.total_bookings),
      verifiedUsers: parseInt(data.verified_users),
      totalOwners: parseInt(data.total_owners)
    });

  } catch (err) {
    console.error("Get All Data Error:", err);
    res.status(500).json({ message: "Server error" });
  }
});
router.put("/updateCarImages/:carId", rateLimiter, upload.fields([
  { name: "mainImage", maxCount: 1 },
  { name: "images", maxCount: 5 }
]), async (req, res) => {
  try {
    const { carId } = req.params;
    const carRes = await pool.query(
      `SELECT images FROM ${process.env.cars_table} WHERE id=$1`,
      [carId]
    );

    if (carRes.rows.length === 0) {
      return res.status(404).json({ message: "Car not found" });
    }

    const oldImages = carRes.rows[0].images || [];
    await deleteFromMinio("carimages", oldImages);
    const mainImageFile = req.files?.mainImage?.[0];
    const otherImages = req.files?.images || [];

    let imageNames = [];

    if (!mainImageFile && otherImages.length === 0) {
      return res.status(400).json({ message: "No new images provided" });
    }

    if (mainImageFile) {
      const fileName = generateFileName("main");
      await uploadToMinio("carimages", fileName, mainImageFile.buffer, mainImageFile.mimetype);
      imageNames.push(fileName);
    }

    for (let file of otherImages) {
      const fileName = generateFileName("car");
      await uploadToMinio("carimages", fileName, file.buffer, file.mimetype);
      imageNames.push(fileName);
    }
    const updated = await pool.query(
      `UPDATE ${process.env.cars_table}
       SET images=$1, "updatedAt"=NOW()
       WHERE id=$2
       RETURNING *`,
      [imageNames, carId]
    );

    res.status(200).json({
      message: "Images updated successfully",
      data: updated.rows[0]
    });

  } catch (e) {
    console.error("Update Images Error:", e);
    res.status(500).json({ message: "internal server error", error: e.message });
  }
});
async function deleteFromMinio(bucket, fileNames = []) {
  if (!fileNames.length) return;

  await minioClient.removeObjects(bucket, fileNames);
}


router.get("/getFinancial", async (req, res) => {
  try {
    // 💥 FIXED: Added toDate right here to capture the query string parameter!
    const { fromDate, toDate, carid, ownerid, branchid, status } = req.query;

    // 💥 1. FORCE the query to only look at owner payouts!
    let conditions = [`bi.paid_to = 'owner'`]; 
    let values = [];
    let index = 1;

    // 💥 2. Filter records greater than or equal to fromDate
    if (fromDate) {
      conditions.push(`bi.created_at >= $${index++}`);
      values.push(fromDate);
    }

    // 💥 FIXED: Added the toDate upper boundary conditional constraint block!
    // We cast to ::date and add 1 day or use a less-than logic to capture everything on that final day safely.
    if (toDate) {
      conditions.push(`bi.created_at <= $${index++}::date + INTERVAL '1 day'`);
      values.push(toDate);
    }

    if (carid) {
      conditions.push(`bi."carId" =$${index++}`);
      values.push(carid);
    }

    if (ownerid) {
      conditions.push(`bi.ownerid = $${index++}`);
      values.push(ownerid);
    }

    if (branchid) {
      conditions.push(`bi."branchId" =$${index++}`);
      values.push(branchid);
    }

    if (status) {
      conditions.push(`bi.status = $${index++}`);
      values.push(status);
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const query = `
      SELECT 
        bi.ownerid,
        u.name AS owner_name,      
        u.mobileno AS owner_phone,    
        COUNT(DISTINCT bi.booking_id) AS total_bookings,
        SUM(bi.amount) AS total_payable,
        SUM(
          CASE 
            WHEN EXTRACT(EPOCH FROM (b."dropoffDate" - b."pickupDate")) / 3600 <= 6 THEN 0.5
            ELSE 1
          END 
        ) AS total_trips
      FROM booking_income bi
      JOIN bookings b ON b.id = bi.booking_id
      JOIN users u ON u.id = bi.ownerid 
      ${whereClause}
        AND bi.status = 'pending'
        AND bi.paid_to = 'owner'
      GROUP BY bi.ownerid, u.name, u.mobileno 
      ORDER BY total_payable DESC
    `;

    const result = await pool.query(query, values);

    console.log(`💰 FINANCIAL LEDGER: Found ${result.rowCount} owners to pay.`);
    console.table(result.rows);

    res.status(200).json({
      count: result.rowCount,
      data: result.rows
    });

  } catch (err) {
    console.error("Get Financial Error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/getSuperAdminFinances", rateLimiter, async (req, res) => {
  try {
    const { fromDate, toDate } = req.query; 

    // 💥 UPDATED STRICT FINANCE QUERY
    let queryText = `
      SELECT 
        -- 1. Total Gross Revenue: Adds every 'amount' row together (owner + branch + superadmin)
        COALESCE(SUM(amount), 0) AS total_gross_revenue,
        
        -- 2. Total Owner Payouts: Strictly 'owner' rows
        -- Note: Added status = 'paid' so it only counts money actually sent to them. 
        -- If you want to show ALL owner money including pending, remove "AND status = 'paid'"
        COALESCE(SUM(amount) FILTER (WHERE paid_to = 'owner' AND status = 'paid'), 0) AS total_owner_payouts,
        
        -- 3. Branch Payouts: Strictly 'branch' rows
        COALESCE(SUM(amount) FILTER (WHERE paid_to = 'branch'), 0) AS total_branch_payouts,
        
        -- 4. Total Profit: STRICTLY 'superadmin' money ONLY (Danger zone fixed!)
        COALESCE(SUM(amount) FILTER (WHERE paid_to = 'superadmin'), 0) AS total_profit,
        
        -- Pending dues (Optional, keeping it here just in case you need it on UI)
        COALESCE(SUM(amount) FILTER (WHERE status = 'pending' AND paid_to = 'owner'), 0) AS total_pending_dues
        
      FROM booking_income
    `;

    let queryParams = [];

    // Safe Date Filter
    if (
      fromDate && toDate && 
      fromDate !== 'null' && toDate !== 'null' && 
      fromDate !== 'undefined' && toDate !== 'undefined'
    ) {
      queryText += ` WHERE created_at::date >= $1::date AND created_at::date <= $2::date`;
      queryParams.push(fromDate, toDate);
    }

    const result = await pool.query(queryText, queryParams);
    
    // Parse floats to ensure no weird string decimals hit the frontend
    const data = result.rows[0];
    res.status(200).json({
      message: "Finances fetched successfully",
      data: {
        total_gross_revenue: parseFloat(data.total_gross_revenue),
        total_owner_payouts: parseFloat(data.total_owner_payouts),
        total_branch_payouts: parseFloat(data.total_branch_payouts),
        total_profit: parseFloat(data.total_profit),
        total_pending_dues: parseFloat(data.total_pending_dues)
      }
    });

  } catch (err) {
    console.error("Super Admin Finances Error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});
router.get("/getPaymentHistory", rateLimiter, async (req, res) => {
  try {
    const { branchid, date } = req.query; // date should be 'YYYY-MM-DD'

    // Inside /getPaymentHistory
    const result = await pool.query(
      `
      SELECT  
        bi.ownerid, 
        u.name AS owner_name,
        bi.paid_at::text AS paid_at, -- 💥 1. Cast to raw text!
        COUNT(bi.id) AS total_bookings,
        SUM(bi.amount) AS total_paid,
        SUM(bi.reduced_amount) AS total_reduced_amount,
        STRING_AGG(bi.deduction_reason, ', ') AS deduction_reasons
      FROM booking_income bi
      JOIN users u ON bi.ownerid = u.id
      WHERE bi."branchId" = $1
        AND bi.paid_to = 'owner'
        AND bi.status = 'paid'
        AND DATE(bi.paid_at) = $2 
      GROUP BY bi.ownerid, u.name, bi.paid_at::text -- 💥 2. Group by the text
      ORDER BY bi.paid_at::text DESC
      `,
      [branchid, date]
    );

    res.status(200).json({ message: "History fetched", data: result.rows });

  } catch (err) {
    console.error("History Error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});


// Using POST so we can easily pass the exact timestamp in the body
// Using POST so we can easily pass the exact timestamp in the body
// Using POST so we can easily pass the exact timestamp in the body
router.post("/getOwnerPaidBreakdown", rateLimiter, async (req, res) => {
  try {
    const { ownerId, paidAt } = req.body;

    // 💥 LOG 1: Let's see exactly what the frontend is asking for!
    console.log(`\n--- FETCHING PAID RECEIPT ---`);
    console.log(`Searching for OWNER ID: ${ownerId}`);
    console.log(`Searching for PAID_AT: ${paidAt}`);

    const result = await pool.query(
      `
      SELECT 
        b.id AS booking_id,
        c.model AS car_model,
        b."pickupDate",
        b."dropoffDate",
        
        -- 💥 FETCH INDIVIDUAL AMOUNTS SO WE CAN LOG THEM
        COALESCE(b.advance_paid, 0) AS advance_paid,
        COALESCE(b.ride_start_amount, 0) AS ride_start_amount,
        COALESCE(b.ride_end_amount, 0) AS ride_end_amount,
        COALESCE(b.penalty_amount, 0) AS penalty_amount,
        
        -- 💥 THE FIX: Safely add all 4 payment columns together!
        (
          COALESCE(b.advance_paid, 0) + 
          COALESCE(b.ride_start_amount, 0) + 
          COALESCE(b.ride_end_amount, 0) + 
          COALESCE(b.penalty_amount, 0)
        ) AS total_user_paid,
        
        COALESCE(bi.amount, 0) AS owner_share,
        SUM(bi.reduced_amount) OVER () AS total_reduced_amount,
        bi.deduction_reason
      FROM booking_income bi
      JOIN bookings b ON bi.booking_id = b.id
      JOIN ${process.env.cars_table} c ON bi."carId" = c.id
      WHERE bi.ownerid = $1
        AND bi.paid_to = 'owner'
        AND bi.status = 'paid'
        AND bi.paid_at::text = $2
      ORDER BY b."pickupDate" ASC
      `,
      [ownerId, paidAt]
    );

    console.log(`FOUND ${result.rows.length} RIDES FOR THIS EXACT TIMESTAMP.`);
    
    // 💥 LOG 2: BEAUTIFUL MATH BREAKDOWN IN THE TERMINAL
    result.rows.forEach(row => {
      console.log(`\n▶ MATH CHECK FOR BOOKING ID: ${row.booking_id}`);
      console.log(`  Advance Paid : ₹${row.advance_paid}`);
      console.log(`  Start Amount : ₹${row.ride_start_amount}`);
      console.log(`  End Amount   : ₹${row.ride_end_amount}`);
      console.log(`  Penalty      : ₹${row.penalty_amount}`);
      console.log(`  -----------------------------`);
      console.log(`  TOTAL USER PAID: ₹${row.total_user_paid}`);
      console.log(`  OWNER SHARE    : ₹${row.owner_share}`);
    });

    console.log("\n-----------------------------\n");

    // Send the data to the frontend
    res.status(200).json({ message: "Breakdown fetched", data: result.rows });

  } catch (err) {
    console.error("Paid Breakdown Error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.post("/processOwnerPayout", rateLimiter, async (req, res) => {
  const client = await pool.connect();
  
  // 💥 Now accepting branchId from your frontend
  const { ownerId, branchId, bookingIds, deductionAmount, reason } = req.body;

  try {
    await client.query("BEGIN");

    let remainingDeduction = Number(deductionAmount || 0);
    
    // 💥 One single timestamp so the frontend can group these together as one "Invoice"
    const payoutTime = new Date(); 

    // Loop through the specific bookings we are paying out
    for (const bookingId of bookingIds) {
      
      // 💥 THE LEDGER FILTER: 
      // Strictly grabs ONLY the pending owner row for this specific car/branch
      const incomeRes = await client.query(
        `SELECT id, amount FROM booking_income 
         WHERE booking_id = $1 
           AND ownerid = $2 
           AND "branchId" = $3 
           AND paid_to = 'owner' 
           AND status = 'pending' 
         FOR UPDATE`,
        [bookingId, ownerId, branchId]
      );

      // If the row exists, apply the math and update it
      if (incomeRes.rows.length > 0) {
        const rowId = incomeRes.rows[0].id;
        const ownerAmount = Number(incomeRes.rows[0].amount);
        
        let deductFromThisRow = 0;
        let noteForThisRow = null;

        // 💥 The Waterfall Deduction
        if (remainingDeduction > 0) {
          deductFromThisRow = Math.min(ownerAmount, remainingDeduction);
          remainingDeduction -= deductFromThisRow;
          noteForThisRow = reason; 
        }

        // 💥 Update ONLY the Owner's specific ledger row!
        await client.query(
          `UPDATE booking_income 
           SET 
             status = 'paid', 
             paid_at = $1,
             reduced_amount = $2, 
             deduction_reason = $3 
           WHERE id = $4`,
          [payoutTime, deductFromThisRow, noteForThisRow, rowId]
        );
      }
    }

    await client.query("COMMIT");
    
    res.status(200).json({ 
      message: "Owner payout successful",
      unpaidDeduction: remainingDeduction 
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Payout Error:", error);
    res.status(500).json({ message: "Internal server error" });
  } finally {
    client.release();
  }
});

router.put("/update-branch/:id", rateLimiter, async (req, res) => {
  // const header = req.headers.authorization;

  // if (!header) {
  //   return res.status(401).json({ message: "missing headers" });
  // }

  // const token = header.split(" ")[1];

  // const payload = await veriftJWT(token);
  // if (!payload) {
  //   return res.status(401).json({ message: "invalid token" });
  // }

  try {
    const branchId = req.params.id;

    const {
      name,
      address,
      city,
      state,
      zipCode,
      phone,
      email,
      percentage,
      branchHeadId,
      location_link, 
      isActive
    } = req.body;

    const fields = [];
    const values = [];
    let index = 1;
    let hasUpdates = false; 

    if (name) {
      fields.push(`"name" = $${index++}`);
      values.push(name);
      hasUpdates = true;
    }

    if (address) {
      fields.push(`"address" = $${index++}`);
      values.push(address);
      hasUpdates = true;
    }

    if (city) {
      fields.push(`"city" = $${index++}`);
      values.push(city);
      hasUpdates = true;
    }

    if (state) {
      fields.push(`"state" = $${index++}`);
      values.push(state);
      hasUpdates = true;
    }

    if (zipCode) {
      fields.push(`"zipCode" = $${index++}`);
      values.push(zipCode);
      hasUpdates = true;
    }
 
    if (phone) {
      fields.push(`"phone" = $${index++}`);
      values.push(phone);
      hasUpdates = true;
    }

    if (percentage) {
      fields.push(`"percentage" = $${index++}`);
      values.push(percentage);
      hasUpdates = true;
    }
    if (location_link) {
      fields.push(`"location_link" = $${index++}`);
      values.push(location_link);
      hasUpdates = true;
    }

    if (email) {
      fields.push(`"email" = $${index++}`);
      values.push(email);
      hasUpdates = true;
    }

    if (branchHeadId !== undefined) {
      fields.push(`"branchHeadId" = $${index++}`);
      values.push(branchHeadId);
      hasUpdates = true;
    }

    if (isActive !== undefined) {
      fields.push(`"isActive" = $${index++}`);
      values.push(isActive);
      hasUpdates = true;
    }


    if (!hasUpdates) {
      return res.status(400).json({
        message: "Nothing to change"
      });
    }

    fields.push(`"updatedAt" = NOW()`);

    const query = `
      UPDATE ${process.env.branch_table}
      SET ${fields.join(", ")}
      WHERE "id" = $${index}
      RETURNING *
    `;

    values.push(branchId);

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "Branch not found"
      });
    }

    res.status(200).json({
      message: "Branch updated successfully",
      data: result.rows[0]
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({
      message: "Internal server error",
      error: e.message
    });
  }
});

router.get("/getOwnerPendingBreakdown/:ownerId", rateLimiter, async (req, res) => {
  try {
    const { ownerId } = req.params;
    const { branchId } = req.query; 
    
    console.log(`\n--- FETCHING BREAKDOWN FOR OWNER ID: ${ownerId} ---`);

    const result = await pool.query(
      `
      SELECT 
        b.id AS booking_id,
        c.model AS car_model,
        c.id AS car_id,
        b."pickupDate",
        b."dropoffDate",
        
        -- 💥 FETCH INDIVIDUAL AMOUNTS SO WE CAN LOG THEM
        COALESCE(b.advance_paid, 0) AS advance_paid,
        COALESCE(b.ride_start_amount, 0) AS ride_start_amount,
        COALESCE(b.ride_end_amount, 0) AS ride_end_amount,
        COALESCE(b.penalty_amount, 0) AS penalty_amount,
        
        -- 💥 THE FIX: Safely add all 4 actual payment columns together!
        (
          COALESCE(b.advance_paid, 0) + 
          COALESCE(b.ride_start_amount, 0) + 
          COALESCE(b.ride_end_amount, 0) + 
          COALESCE(b.penalty_amount, 0)
        ) AS total_user_paid,
        
        COALESCE(bi.amount, 0) AS owner_share
      FROM booking_income bi
      JOIN bookings b ON bi.booking_id = b.id
      JOIN ${process.env.cars_table} c ON bi."carId" = c.id
      WHERE bi.ownerid = $1
        AND bi.status = 'pending'
        AND bi.paid_to = 'owner'
        AND bi."branchId" = $2
      ORDER BY b."pickupDate" ASC
      `,
      [ownerId, branchId]
    );

    console.log(`FOUND ${result.rows.length} PENDING TRIPS.`);
    
    // 💥 BEAUTIFUL MATH BREAKDOWN IN THE TERMINAL
    result.rows.forEach(row => {
      console.log(`\n▶ MATH CHECK FOR PENDING BOOKING ID: ${row.booking_id}`);
      console.log(`  Advance Paid : ₹${row.advance_paid}`);
      console.log(`  Start Amount : ₹${row.ride_start_amount}`);
      console.log(`  End Amount   : ₹${row.ride_end_amount}`);
      console.log(`  Penalty      : ₹${row.penalty_amount}`);
      console.log(`  -----------------------------`);
      console.log(`  TOTAL USER PAID: ₹${row.total_user_paid}`);
      console.log(`  OWNER SHARE    : ₹${row.owner_share}`);
    });

    console.log("\n--------------------------------------------------\n");

    res.status(200).json({
      message: "Breakdown fetched successfully",
      data: result.rows
    });

  } catch (err) {
    console.error("Breakdown Error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.put("/changeMyPassword", rateLimiter, async (req, res) => {
    const header = req.headers.authorization;
    if (!header) {
        return res.status(401).json({ message: "Missing headers" });
    }

    const token = header.split(" ")[1];
    if (!token) {
        return res.status(401).json({ message: "Token not found" });
    }

    const payload = await veriftJWT(token);
    if (!payload) {
        return res.status(401).json({ message: "Invalid token" });
    }

    try {
        const { email, otp, newPassword } = req.body;

        if (!email || !otp || !newPassword) {
            return res.status(400).json({ message: "Email, OTP, and new password are required" });
        }

        // 1. Check Redis for the OTP
        const storedotp = await redis.get(`otp:${email}`);

        if (!storedotp) {
            return res.status(400).json({ message: "OTP has expired or does not exist" });
        }

        if (storedotp !== otp) {
            return res.status(400).json({ message: "Invalid OTP" });
        }

        // 2. Hash the new password
        const encrypted_pass = await bcrypt.hash(newPassword, 10);

        // 3. Update the password in the database
        const result = await pool.query(
            `UPDATE ${process.env.Management} 
             SET encrypted_pass = $1 
             WHERE email = $2`,
            [encrypted_pass, email]
        );

        if (result.rowCount === 0) {
            return res.status(500).json({ message: "Failed to update password" });
        }

        // 4. Delete the OTP from Redis so it cannot be used again
        await redis.del(`otp:${email}`);

        return res.status(200).json({ message: "Password successfully changed" });

    } catch (err) {
        console.error("Change Password Error:", err);
        return res.status(500).json({ message: "Internal server error" });
    }
});

module.exports=router 
