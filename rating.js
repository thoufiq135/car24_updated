const express=require("express")
const router=express.Router()
const rateLimiter = require("./rateLimiter")
const {pool,redis,fire_db}=require("./connectdb")
const {veriftJWT,createJwt}=require("./jwt")
const notificationDB=fire_db.ref("notifications") 
router.post("/addRatings/:id", rateLimiter, async (req, res) => {
  try {
    const header = req.headers.authorization;

    if (!header) {
      return res.status(401).json({
        message: "Missing authorization headers",
      });
    }

    const token = header.split(" ")[1];

    if (!token) {
      return res.status(401).json({
        message: "Token not found",
      });
    }

    const payload = await veriftJWT(token);

    if (!payload?.id) {
      return res.status(401).json({
        message: "Invalid or expired token",
      });
    }

    const { stars, des } = req.body;
    const bookingId = req.params.id;

    const car = await pool.query(
      `SELECT "carId" FROM bookings WHERE id = $1`,
      [bookingId]
    );

    if (car.rows.length === 0) {
      return res.status(404).json({
        message: "Booking not found",
      });
    }

    const carId = car.rows[0].carId;

    await pool.query(
      `INSERT INTO ratings
      (booking_id, rating, description, car_id)
      VALUES ($1, $2, $3, $4)`,
      [bookingId, stars, des, carId]
    );

    return res.status(200).json({
      success: true,
      message: "Rating added successfully",
    });

  } catch (err) {
    console.error("❌ add rating failed:", err);

    return res.status(500).json({
      message: "Failed to add rating",
      error: err.message,
    });
  }
});
// ── ONE UNIFIED ROUTE TO RULE THEM ALL ──
// ── ONE UNIFIED ROUTE TO RULE THEM ALL ──
router.get("/fetchUnApprovedRatings", rateLimiter, async (req, res) => {
  try {
    // 1. Verification Section
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

    const { branchId, carId } = req.query;

    if (!branchId) {
      return res.status(400).json({ 
        success: false, 
        message: "branchId query parameter is required" 
      });
    }

    // 💥 FIXED SQL QUERY: Mapped exactly to your camelCase and snake_case schema columns
    let query = `
      SELECT 
        r.id, 
        r.booking_id, 
        r.rating, 
        r.description, 
        r.car_id,
        c.model AS car_name,
        c."licensePlate" AS car_number,
        b."branchId" AS branch_id,
        b."pickupDate" AS ride_start,       -- 👈 Matches your exact schema timestamp column
        b."dropoffDate" AS ride_end,        -- 👈 Matches your exact schema timestamp column
        b.ride_start_time,                  -- 👈 Real trip start tracking metrics
        b.ride_end_time,                    -- 👈 Real trip end tracking metrics
        br.name AS branch_name
      FROM ratings r
      LEFT JOIN cars c ON r.car_id = c.id
      LEFT JOIN bookings b ON r.booking_id = b.id
      LEFT JOIN branches br ON b."branchId" = br.id
      WHERE r.approved = false AND b."branchId" = $1
    `;

    const queryParams = [Number(branchId)];

    // Dynamically handle optional car scoping filters
    if (carId && carId !== 'undefined') {
      query += ` AND r.car_id = $2`;
      queryParams.push(Number(carId));
    }

    query += ` ORDER BY r.id DESC`;

    const ratings = await pool.query(query, queryParams);
    
    return res.status(200).json({ 
      success: true, 
      ratings: ratings.rows 
    });

  } catch (err) {
    console.error("❌ Unified fetch ratings error:", err);
    return res.status(500).json({ message: "Internal Error", error: err.message });
  }
});
router.put("/approveRatings/:id", rateLimiter, async (req, res) => {
  try {
    const header = req.headers.authorization;

    if (!header) {
      return res.status(401).json({
        message: "Missing authorization headers",
      });
    }

    const token = header.split(" ")[1];

    if (!token) {
      return res.status(401).json({
        message: "Token not found",
      });
    }

    const payload = await veriftJWT(token);

    if (!payload?.id) {
      return res.status(401).json({
        message: "Invalid or expired token",
      });
    }

    const ratingId = req.params.id;

    const rating = await pool.query(
      `UPDATE ratings
       SET approved = true
       WHERE id = $1
       RETURNING *`,
      [ratingId]
    );

    if (rating.rows.length === 0) {
      return res.status(404).json({
        message: "Rating not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Rating approved successfully",
      rating: rating.rows[0],
    });

  } catch (err) {
    console.error("❌ approve rating failed:", err);

    return res.status(500).json({
      message: "Failed to approve rating",
      error: err.message,
    });
  }
});
module.exports=router
