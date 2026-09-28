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
router.post("/addCar/:branchId", rateLimiter, upload.fields([
    { name: "mainImage", maxCount: 1 },
    { name: "images", maxCount: 5 }
]), async (req, res) => {
  // NOTE: Uncomment your JWT verification here in production!
  const header = req.headers.authorization;
  if (!header) {
    return res.status(401).json({ message: "missing authorization headers" });
  }

  const token = header.split(" ")[1];
  const payload = await veriftJWT(token); // Make sure your JWT verify function is imported!

  const userId = payload.id;
  
  if (!payload || !payload.id) {
    return res.status(401).json({ message: "invalid or expired token" });
  }
  const branchId = req.params.branchId;
  const files = req.files;

  if (!req.files || Object.keys(req.files).length === 0) {
      return res.status(400).json({ message: "missing images" });
  }
  
  const mainImageFile = req.files?.mainImage?.[0];
  const otherImages = req.files?.images || [];

  try {
    const branchRes = await pool.query(`SELECT * FROM ${process.env.branch_table} WHERE id=$1`, [branchId]);
    if (branchRes.rows.length === 0) {
      return res.status(400).json({ message: "branch not found" });
    }

    let imageNames = [];
    const { 
      model, year, category, transmission, fuelType, 
      seatingCapacity, features, licensePlate, mileage, colour 
    } = req.body;

    if (!model || !year || !category || !transmission || !fuelType || !seatingCapacity || !colour || !licensePlate) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const plate = licensePlate.toUpperCase().trim();
    
    // 💥 Safely parse features (React Native sends it as a comma-separated string)
    const parsedFeatures = features ? features.split(',').map(f => f.trim()) : [];
    const parsedMileage = parseInt(mileage) || 0;
    const parsedYear = parseInt(year) || new Date().getFullYear();

    const existing = await pool.query(`SELECT id FROM ${process.env.cars_table} WHERE "licensePlate"=$1`, [plate]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ message: "License plate already exists" });
    }

    if (!mainImageFile && otherImages.length === 0) {
      return res.status(400).json({ message: "At least one image required" });
    }

    // Upload Main Image
    if (mainImageFile) {
      const fileName = generateFileName("main");
      await uploadToMinio("carimages", fileName, mainImageFile.buffer, mainImageFile.mimetype);
      imageNames.push(fileName); 
    }

    // Upload Other Images
    for (let file of otherImages) {
      const fileName = generateFileName("car");
      await uploadToMinio("carimages", fileName, file.buffer, file.mimetype);
      imageNames.push(fileName);
    }

    // Save to Database
    const result = await pool.query(
      `INSERT INTO ${process.env.cars_table} (
        "branchId", "ownerid", "model", "year", "category", 
        "transmission", "fuelType", "seatingCapacity", "licensePlate", 
        "mileage", "images", "features", "main_image", 
        "approvalstatus", "status", "isAvailable", "colour", 
        "createdAt", "updatedAt"
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW(),NOW())
      RETURNING *`,
      [
        branchId, userId, model, parsedYear, category, 
        transmission, fuelType, seatingCapacity, plate, 
        parsedMileage, imageNames, parsedFeatures, 0, 
        "pending", "available", false, colour
      ]
    );

    res.status(201).json({ message: "Car created and sent for approval", data: result.rows[0] });

  } catch(e) {
    console.error("Add Car Error:", e);
    res.status(500).json({ message: "internal server error", error: e.message });
  }
});
router.get("/get_pending_cars", rateLimiter, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        c.*,
        u.name AS owner_name,
        u.email AS owner_email,
        u.mobileno AS owner_mobileno,
        u.city AS owner_city,
        u.state AS owner_state
      FROM ${process.env.cars_table} c
      LEFT JOIN users u ON c.ownerid = u.id
      WHERE c.approvalstatus = $1
    `, ["pending"]);

    const carsWithImageUrls = await Promise.all(result.rows.map(async (car) => {
      
      let signedUrls = [];

      if (car.images && car.images.length > 0) {
        signedUrls = await Promise.all(car.images.map(async (fileName) => {
          try {
            return await minioClient.presignedGetObject(
              "carimages",
              fileName,
              24 * 60 * 60
            );
          } catch (err) {
            return null;
          }
        }));
      }

      return {
        ...car,
        images: signedUrls.filter(Boolean)
      };
    }));

    res.status(200).json({
      message: "Pending cars fetched successfully",
      data: carsWithImageUrls
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "internal server error" });
  }
});
router.put("/approve_pending_cars/:carId",rateLimiter,async(req,res)=>{
       const  {carId } = req.params;
     const { status, six, twelve, twentyFour,percentage, pricePerDay } = req.body;

           if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({
        message: "Status must be approved or rejected"
      });
    }
      const header=req.headers.authorization
if(!header){
  return res.status(401).json({message:"missing headers"})
}

const token = header.split(" ")[1]
const payload=await veriftJWT(token)
if(!payload){
  return res.status(401).json({message:"invalid token"})
}
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
  UPDATE ${process.env.cars_table}
  SET 
    approvalstatus = $1,
    "isAvailable" = $2,
    "six_hr_price" = COALESCE($3, "six_hr_price"),
    "twelve_hr_price" = COALESCE($4, "twelve_hr_price"),
    "twentyfour_hr_price" = COALESCE($5, "twentyfour_hr_price"),
    "pricePerDay" = COALESCE($6, "pricePerDay"),
    "percentage"=COALESCE($7, "percentage"),
    "updatedAt" = NOW()
  WHERE id = $8
  RETURNING *
  `,
  [
    status,
    status === "approved", 
    six || null,
    twelve || null,
    twentyFour || null,
    pricePerDay || null,
    percentage, // 💥 ADDED THIS!
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
      
    `;
    // AND c."isAvailable" = true

    let values = [];
    let count = 1;

 

    // data query
if (category) {
  query += ` AND LOWER(c.category::text) = LOWER($${count++})`;
  values.push(category);
}

if (fuelType) {
  query += ` AND LOWER(c."fuelType") = LOWER($${count++})`;
  values.push(fuelType);
}

if (transmission) {
  query += ` AND LOWER(c.transmission::text) = LOWER($${count++})`;
  values.push(transmission);
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
  query += ` AND LOWER(c.colour) LIKE LOWER($${count++})`;
  values.push(`%${colour}%`);
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
          AND b.status IN ('confirmed')
          AND (
            b."pickupDate" < $${count}
            AND b."dropoffDate" > $${count + 1}
          )
        )
      `;
      values.push(dropoffDate, pickupDate);
      count += 2;
    }
    // AND b.status IN ('confirmed', 'ongoing')


    query += ` LIMIT $${count++} OFFSET $${count++}`;
    values.push(limitVal, offset);

    const dataResult = await pool.query(query, values);

    // 💥 NEW: Convert filenames to URLs, but skip existing Unsplash URLs!
    const carsWithImageUrls = await Promise.all(dataResult.rows.map(async (car) => {
      let finalUrls = [];
      
      if (car.images && car.images.length > 0) {
        finalUrls = await Promise.all(car.images.map(async (imgString) => {
          try {
            // Check if it's already a full URL (like your old Unsplash images)
            if (imgString.startsWith("http://") || imgString.startsWith("https://")) {
              return imgString; // Leave it exactly as it is
            }
            
            // Otherwise, it's a MinIO filename! Generate the secure URL.
            return await minioClient.presignedGetObject("carimages", imgString, 24 * 60 * 60);
            
          } catch (err) {
            console.error("Failed to generate URL for:", imgString);
            return null; // Fallback so the app doesn't crash if one image fails
          }
        }));
      }

      return {
        ...car,
        images: finalUrls.filter(url => url !== null) // Strip out any dead links
      };
    }));


    let countQuery = `
      SELECT COUNT(*) 
      FROM cars c
      JOIN branches b ON c."branchId" = b.id
      WHERE c.approvalstatus = 'approved'
      
    `;
    // AND c."isAvailable" = true

    let countValues = [];
    let countIndex = 1;



    if (category) {
  countQuery += ` AND LOWER(c.category::text) = LOWER($${countIndex++})`;
  countValues.push(category);
}

if (fuelType) {
  countQuery += ` AND LOWER(c."fuelType") = LOWER($${countIndex++})`;
  countValues.push(fuelType);
}

if (transmission) {
  countQuery += ` AND LOWER(c.transmission::text) = LOWER($${countIndex++})`;
  countValues.push(transmission);
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
  countQuery += ` AND LOWER(c.colour) LIKE LOWER($${countIndex++})`;
  countValues.push(`%${colour}%`);
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
      data: carsWithImageUrls
    });

  } catch (e) {
    res.status(500).json({
      message: "internal server error",
      error: e.message
    });
  }
});
// GET single car by ID
router.get("/get_car/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      SELECT c.*, b.name as branch_name, b.city as branch_city, b.address as branch_address, b.phone as branch_phone
      FROM ${process.env.cars_table || 'cars'} c
      JOIN ${process.env.branch_table || 'branches'} b ON c."branchId" = b.id
      WHERE c.id = $1 
      AND c.approvalstatus = 'approved'
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Car not found' });
    }
 
    let car = result.rows[0];

    // 💥 THE MAGIC: Convert filenames to URLs for this specific car!
    if (car.images && car.images.length > 0) {
  const finalUrls = await Promise.all(car.images.map(async (imgString) => {
    try {
      // Keep old Unsplash URLs exactly as they are
      if (imgString.startsWith("http://") || imgString.startsWith("https://")) {
        console.log("Existing URL:", imgString); // ✅ log here
        return imgString; 
      }
      
      // Generate secure MinIO URL
      const url = await minioClient.presignedGetObject(
        "carimages",
        imgString,
        24 * 60 * 60
      );

      console.log("Generated MinIO URL:", url); // ✅ now works

      return url;
      
    } catch (err) {
      console.error("Failed to generate URL for:", imgString);
      return null;
    }
  }));
  
  car.images = finalUrls.filter(url => url !== null);

  console.log("Final URLs sent to frontend:", car.images); // ✅ optional
}

    // Send the updated car object to the frontend!
    res.json(car);

  } catch (e) {
    console.error("Get Single Car Error:", e);
    res.status(500).json({ message: 'Internal server error', error: e.message });
  }
});


// branches router
router.get("/get_branches", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM branches ORDER BY city
    `);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ message: 'Internal server error', error: e.message });
  }
});


// In your cars router
router.get("/owner_cars", rateLimiter, async (req, res) => {
  try {
    const { ownerId } = req.query;
    
    if (!ownerId) {
      return res.status(400).json({ message: "Owner ID required" });
    }

    const result = await pool.query(`
      SELECT 
        c.*,
        b.name as branch_name,
        b.city as branch_city,
        -- Count total trips for each car
        (SELECT COUNT(*) FROM bookings bk WHERE bk."carId" = c.id) as total_trips
      FROM ${process.env.cars_table} c
      JOIN branches b ON c."branchId" = b.id
      WHERE c.ownerid = $1
      ORDER BY c."createdAt" DESC
    `, [ownerId]);

    // 💥 THE MAGIC: Convert filenames to Live URLs so the Owner can actually see them!
    const carsWithImageUrls = await Promise.all(result.rows.map(async (car) => {
      if (car.images && car.images.length > 0) {
        const finalUrls = await Promise.all(car.images.map(async (imgString) => {
          try {
            // Keep old Unsplash URLs exactly as they are
            if (imgString.startsWith("http://") || imgString.startsWith("https://")) {
              return imgString; 
            }
            
            // Generate secure MinIO URLs for new uploads
            return await minioClient.presignedGetObject("carimages", imgString, 24 * 60 * 60);
          } catch (err) {
            console.error("Failed to generate URL for:", imgString, "👉 ACTUAL ERROR:", err.message ? err.message : err);
            return null; // Fallback so the app doesn't crash if an image is missing
          }
        }));
        
        // Update the car object with the live URLs
        car.images = finalUrls.filter(url => url !== null);
      }
      return car;
    }));

    // Send the updated cars array to the frontend
    res.json(carsWithImageUrls);

  } catch (e) {
    console.error('owner_cars error:', e.message);
    res.status(500).json({ message: "Internal server error", error: e.message });
  }
});
router.get("/carGps/:carId", rateLimiter, async (req, res) => {
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
    if (!payload) {
      return res.status(401).json({ message: "Invalid or expired token" });
    }

    const { carId } = req.params;

    const result = await pool.query(
      "SELECT licensePlate FROM cars WHERE id = $1",
      [carId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Car not found" });
    }

    const licensePlate = result.rows[0].licenseplate;

    const apiRes = await fetch(
      "https://api.wheelseye.com/currentLoc?accessToken=5592c132-c784-401e-8b37-dcf7ff478f38"
    );

    const data = await apiRes.json();

    const vehicles = data?.data?.list || [];
    const vehicle = vehicles.find(
      (v) =>
        v.vehicleNumber.replace(/\s/g, "").toLowerCase() ===
        licensePlate.replace(/\s/g, "").toLowerCase()
    );

    if (!vehicle) {
      return res.status(404).json({
        message: "Vehicle location not found",
      });
    }

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

    return res.status(500).json({
      message: "internal server error",
      error: e?.message ?? String(e),
    });
  }
});
module.exports=router