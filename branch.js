const express=require("express")
const router=express.Router()
const rateLimiter=require("./rateLimiter")
const {pool}=require("./connectdb")
const {createJwt,veriftJWT}=require("./jwt")


router.post("/create-branch", rateLimiter, async (req, res) => {
        const header=req.headers.authorization
if(!header){
  return res.status(401).json({message:"missing headers"})
}

const token = header.split(" ")[1]
const payload=await veriftJWT(token)
if(!payload){
  return res.status(401).json({message:"invalid token"})
}
  try {
    const {
      name,
      address,
      city,
      state,
      zipCode,
      phone,
      email,
      branchHeadId
    } = req.body;
    if (!name || !address || !city || !state || !zipCode || !phone || !email) {
      return res.status(400).json({
        message: "Missing required fields"
      });
    }
    const result = await pool.query(
      `INSERT INTO ${process.env.branch_table} (
        "name",
        "address",
        "city",
        "state",
        "zipCode",
        "phone",
        "email",
        "branchHeadId",
        "isActive",
        "createdAt",
        "updatedAt"
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW()
      )
      RETURNING *`,
      [
        name,
        address,
        city,
        state,
        zipCode,
        phone,
        email,
        branchHeadId || null,
        true
      ]
    );

    res.status(201).json({
      message: "Branch created successfully",
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



module.exports=router