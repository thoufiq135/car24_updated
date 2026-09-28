const express=require("express")
const router=express.Router()
const {pool,redis}=require("./connectdb")
const sendEmail=require("./email")
const rateLimiter=require("./rateLimiter")
const multer = require("multer");
const bcrypt=require("bcrypt")
const uploadToMinio = require("./uploadMinio");
const minioClient = require("./minioConnect");
const {createJwt,veriftJWT}=require("./jwt")
async function CreateSendOTP(email) {
    const otp=Math.floor(100000 + Math.random() * 900000)
    console.log("otp=",otp)
        await redis.set(`otp:${email}`, otp, "EX", 300)
          await sendEmail(email, "OTP Verification", `Your OTP is ${otp} expires in 5 minutes`);
          return true
}
// async function rateLimiter(req,res,next) {
//         const key=`rate:${req.ip}`
//         const request=await redis.get(key)
//         console.log("requests=",request)
//         if (request && request >= 50) {
//     return res.status(429).json({
//       message: "Too many requests. Try again later."
//     });
//   }
// const newRequests = await redis.incr(key)

//     if (newRequests === 1) {
//         await redis.expire(key,60)
//     }
// next()
// } 
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB
  }
});
router.post("/createUser",rateLimiter,upload.single("dp"),async(req,res)=>{
    const {name,username,email,DOB,marriedDate,NativePlace,mobileno,password} = req.body
    // console.log("came to user" )
    if (!name || !email || !password) {
  return res.status(400).json({ message: "Missing required fields" });
}
     const file = req.file;
     if (file && !file.mimetype.startsWith("image/")) {
  return res.status(400).json({ message: "Only image files allowed" });
}
    const encrypted_pass=await bcrypt.hash(password,10)
    const Role="user"
    try{
        const isUser=await pool.query(
            `SELECT * FROM ${process.env.table} WHERE email=$1`
            ,[email]
        )
        if(isUser.rows.length!=0){
            //  user=isUser.rows[0]
            // const payload={
            //     email:email,
            //     id:user.id
            // }
            // const token=await createJwt(payload)
            // if(!token){
            //     res.status(500).json({message:"internal server error"})
            //     return
            // }
            res.status(400).json({message:"user already exists"})
            return
        }
        let dp_bucket = null;
      let dp_file_name = null;
      let dp_url = null;
    if (file) {

  const ext = file.mimetype.split("/")[1];

  const fileName = `dp-${Date.now()}.${ext}`;

  dp_url = await uploadToMinio(
    "profilepics",
    fileName,
    file.buffer,
    file.mimetype
  );

  dp_bucket = "profilepics";

  dp_file_name = fileName;
}
         const result = await pool.query(
        `INSERT INTO ${process.env.table}
        (name, username, email, dob, married_date, native_place, mobileno, encrypted_pass, Role, dp_bucket, dp_file_name)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING *`,
        [
          name, username, email, DOB,
          marriedDate, NativePlace,
          mobileno, encrypted_pass, Role,
          dp_bucket, dp_file_name
        ]
      );

        const mailSend=await CreateSendOTP(email)
        if(!mailSend){
           return res.status(500).json({message:"internal server error"})
        }
        res.status(200).json({message:"OTP send",Email:email})
    }catch(e){


if(e. code=="23505"){
    res.status(400).json({message:"user name already exists"})
    return
}
res.status(500).json({message:`  error at server ${e}`})
    }

})

// CHANGED: router.post instead of router.put
router.post("/updateProfilePic/:id", rateLimiter, upload.single("dp"), async (req, res) => {
    const userId = req.params.id;
    const file = req.file;

    if (!file) {
        return res.status(400).json({ message: "No image file provided" });
    }

    if (!file.mimetype.startsWith("image/")) {
        return res.status(400).json({ message: "Only image files allowed" });
    }

    try {
        // ==========================================
        // 💥 NEW: GET OLD IMAGE INFO & DELETE IT
        // ==========================================
        const userRes = await pool.query(
            `SELECT dp_bucket, dp_file_name FROM ${process.env.table} WHERE id = $1`,
            [userId]
        ); 

        if (userRes.rows.length > 0) {
            const oldDp = userRes.rows[0];
            
            // If they actually had an old image, delete it from MinIO
            if (oldDp.dp_bucket && oldDp.dp_file_name) {
                try {
                    // Make sure minioClient is imported at the top of this file!
                    await minioClient.removeObject(oldDp.dp_bucket, oldDp.dp_file_name);
                    console.log(`Deleted old profile pic: ${oldDp.dp_file_name}`);
                } catch (deleteErr) {
                    // We catch the error here so if the delete fails (e.g., file was already gone), 
                    // it doesn't crash the app and still lets them upload the new one.
                    console.error("Failed to delete old image from MinIO:", deleteErr.message);
                }
            }
        }
        // ==========================================

        // Now proceed with uploading the NEW image...
        const ext = file.mimetype.split("/")[1];
        const fileName = `dp-${Date.now()}.${ext}`;

        // Upload to Minio
        const dp_url = await uploadToMinio(
            "profilepics",
            fileName,
            file.buffer,
            file.mimetype
        );

        const dp_bucket = "profilepics";

        // Update the database with the new image info
        await pool.query(
            `UPDATE ${process.env.table} 
             SET dp_bucket = $1, dp_file_name = $2 
             WHERE id = $3`,
            [dp_bucket, fileName, userId]
        );

        res.status(200).json({ message: "Profile picture updated successfully", dp_url });
    } catch (e) {
        console.error("PROFILE PIC UPLOAD ERROR:", e);
        res.status(500).json({ message: `error at server ${e.message || e}` });
    }
});
router.put("/verifyuserRegister",rateLimiter,async(req,res)=>{
    const {otp,email}=req.body
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
      `UPDATE ${process.env.table}
       SET is_verified = true
       WHERE email = $1`,
      [email]
    );

    await redis.del(`otp:${email}`);
    res.status(200).json({message:"user verified successfully"})
}) 
router.post("/userLogin", rateLimiter, async (req, res) => {
  const { email, password } = req.body;

  // 1. Basic Validation
  if (!email || !password) {
    return res.status(400).json({ message: "Email and password are required" });
  }

  try {
    // 2. Query ONLY the users table
    const result = await pool.query(
      `SELECT * FROM ${process.env.table} WHERE email = $1`,
      [email]
    );

    const user = result.rows[0];

    // 3. User Existence Check
    if (!user) {
      return res.status(400).json({ message: "User not registered" });
    }

    // 💥 THE FIX: Block login if they are pending deletion 💥
    if (user.status === 'pending_deletion') {
      return res.status(403).json({ 
        message: "Your account is deactivated and scheduled for permanent deletion." 
      });
    }

    // 4. Password Verification
    if (user.encrypted_pass) {
      const correctPassword = await bcrypt.compare(password, user.encrypted_pass);
      if (!correctPassword) {
        return res.status(401).json({ message: "Invalid password" });
      }
    }

    // 5. Verification Check (Handling unverified accounts)
    if (!user.is_verified) {
      const tokenPayload = {
        email: user.email,
        id: user.id,
        userType: 'client' 
      };
      
      const token = await createJwt(tokenPayload);
      return res.status(401).json({ Verification_token: token });
    }

    // 6. Successful Login Token
    const tokenPayload = {
      id: user.id,
      name: user.name,
      role: user.role,
      email: user.email,
      userType: 'client' 
    };

    const token = await createJwt(tokenPayload);
    
    if (!token) {
      return res.status(500).json({ message: "JWT creation error" });
    }

    // 7. Success Response
    return res.status(200).json({ Logintoken: token });

  } catch (e) {
    console.error("Error at /userLogin:", e.message);
    return res.status(500).json({ message: "Internal server error" });
  }
});
router.post("/userLoginnn",rateLimiter,async (req,res)=>{
    const {email,password}=req.body
    if(!email&&!password){
        res.status(400).json({message:"email or password is missing"})
        return
    }
    try{
       let user = null;
let userType = null;


const clientResult = await pool.query(
  `SELECT * FROM ${process.env.table} WHERE email=$1`,
  [email]
);

if (clientResult.rows.length > 0) {
  user = clientResult.rows[0];
  userType = "client";
} else {

  const manageResult = await pool.query(
    `SELECT * FROM ${process.env.Management} WHERE email=$1`,
    [email]
  );

  if (manageResult.rows.length > 0) {
    user = manageResult.rows[0];
    userType = "management";
  }
}

if (!user) {
  return res.status(400).json({
    message: "user not registered"
  });
}
    // console.log(user.encrypted_pass)
    if(user.encrypted_pass){
       const correctPassword= await bcrypt.compare(password,user.encrypted_pass)
       if(!correctPassword){
        res.status(401).json({message:"invalid password"})
        return
       }
       
    }
    if(!user. is_verified ){
const tokenPayload={
    email:user.email,
    id:user.id
}
const token =await createJwt(tokenPayload)
if(!token){
        res.status(500).json({message:"jwt key error"})
        return
    }
     res.status(401).json({Verification_token:token})
     return
    }
    const tokenPayload={
        id:user.id,
        name:user.name,
        role:user.role,
        email:user.email
    }
    const token= await createJwt(tokenPayload)
    if(!token){
        res.status(500).json({message:"jwt key error"})
        return
    }
    res.status(200).json({Logintoken:token})

    }catch(e){
        console.log("err at /userLogin ",e)
        res.status(500).json({message:`err at server ${e}`})
        
    }
})
router.get("/SendVerifyOTP",rateLimiter,async(req,res)=>{
const header = req.headers.authorization
const token=header.split(" ")[1]
// console.log(token)
if(!token){
    res.status(401).json({message:"token not recived"})
    return
}
const payload=await veriftJWT(token)
if(!payload){
    res.status(500).json({message:"internal server error"})
    return
}
try{
const mailSend=await CreateSendOTP(payload.email)
if(!mailSend){
    res.status(500).json({message:"internal server error"})
}
        res.status(200).json({message:"reverification OTP send"})
}catch(e){
    res.status(500).json({message:"error at server",e})
}

})

router.post("/resendOTP", rateLimiter, async (req, res) => {
  try {
    // 💥 1. No headers needed! Just grab the email directly from the body.
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    // Optional but recommended: Check if the user actually exists in your DB first
    // const userCheck = await pool.query(`SELECT id FROM users WHERE email=$1`, [email]);
    // if (userCheck.rows.length === 0) return res.status(404).json({ message: "User not found" });

    // 💥 2. Fire off the OTP email!
    const mailSend = await CreateSendOTP(email);
    
    if (!mailSend) {
      return res.status(500).json({ message: "Failed to send OTP email" });
    }

    return res.status(200).json({ message: "Verification OTP sent successfully" });

  } catch (e) {
    console.error("Resend OTP Error:", e);
    return res.status(500).json({ message: "Internal server error" });
  }
});
router.post("/forgotPassOTP",rateLimiter,async(req,res)=>{
    const {email}=req.body
if(!email){
    res.status(400).json({message:"email not recived"})
    return
}
try{
    // console.log(email)
    // console.log(process.env.table)
const data=await pool.query(
    `SELECT * FROM ${process.env.table} WHERE email=$1` ,
    [email]
)
const userData=data.rows[0]
// console.log(userData)
if(userData.length===0){
    res.status(401).json({message:"user not found"})
    return
}
const mailSend=await CreateSendOTP(userData.email)
if(!mailSend){
    res.status(500).json({message:"internal server error"})
}
res.status(200).json({message:"forgot password otp send"})
}catch(e){
    res.status(500).json({message:"internal server error",e})
}
})
router.post("/forgotPassOTPAdmin",rateLimiter,async(req,res)=>{
    const {email}=req.body
if(!email){
    res.status(400).json({message:"email not recived"})
    return
}
try{
    // console.log(email)
    // console.log(process.env.table)
const data=await pool.query(
    `SELECT * FROM management WHERE email=$1` ,
    [email]
)
if (data.rows.length === 0 || !data.rows[0]) {
  res.status(401).json({ message: "user not found" });
  return;
}
const userData = data.rows[0];
const mailSend=await CreateSendOTP(userData.email)
if(!mailSend){
    res.status(500).json({message:"internal server error"})
}
res.status(200).json({message:"forgot password otp send"})
}catch(e){
    res.status(500).json({message:"internal server error",e})
}
})
router.post("/forgotPassOTPVerify",rateLimiter,async(req,res)=>{
    const {otp,email}=req.body
    
   
    // console.log("user otp=",otp)
 const storedotp=await redis.get(`otp:${email}`)
    // console.log(storedotp)
    if(!storedotp){
        // console.log("otp expired")
        res.status(400).json({message:"otp expired"})
        return
    }
    // console.log(storedotp)
if (String(storedotp) !== String(otp)) {
    return res.status(400).json({ message: "OTP invalid" });
}
    const Passpayload={
        email:email,
        change:true
    }
    const changeToken=await createJwt(Passpayload)

    res.status(200).json({changePasswordToken:changeToken})
})
router.post("/forgotPassOTPVerifyAdmin",rateLimiter,async(req,res)=>{
    const {otp,email}=req.body
    
   
    // console.log("user otp=",otp)
 const storedotp=await redis.get(`otp:${email}`)
    // console.log(storedotp)
    if(!storedotp){
        // console.log("otp expired")
        res.status(400).json({message:"otp expired"})
        return
    }
    // console.log(storedotp)
if (String(storedotp) !== String(otp)) {
    return res.status(400).json({ message: "OTP invalid" });
}
    const Passpayload={
        email:email,
        change:true
    }
    const changeToken=await createJwt(Passpayload)

    res.status(200).json({changePasswordToken:changeToken})
})
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
    if(!payload.change){
        res.status(401).json({message:"invalid token"})
        return
    }
const newPass=await bcrypt.hash(pass,10)
    try{
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
router.put("/changePassAdmin", rateLimiter, async (req, res) => {
    // 💥 FIX: Look for the token in the body, not the headers!
    const { pass, tempToken } = req.body;
    
    if (!tempToken) {
        return res.status(401).json({ message: "temporary token not found" });
    }
    
    try {
        const payload = await veriftJWT(tempToken);
        
        if (!payload) {
            return res.status(401).json({ message: "jwt error or expired" });
        }
        
        if (!payload.change) {
            return res.status(401).json({ message: "invalid token type" });
        }
        
        const newPass = await bcrypt.hash(pass, 10);
        
        const result = await pool.query(
            `UPDATE ${process.env.Management} SET encrypted_pass=$1 WHERE email=$2`,
            [newPass, payload.email]
        );
        
        if (result.rowCount === 0) {
            return res.status(500).json({ message: "failed to update password" });
        }
        
        return res.status(200).json({ message: "password successfully changed" });
        
    } catch (e) {
        console.error("Change Pass Error:", e);
        return res.status(500).json({ message: `internal server error ${e.message}` });
    }
});
router.post("/CreateOwnerAccount", rateLimiter, async (req, res) => {
    const { Name, Username, Email, DOB, NativePlace, Mobileno, pass, role } = req.body;
    
    if (!Name || !Username || !Email || !DOB || !NativePlace || !Mobileno || !pass || !role) {
        return res.status(400).json({ message: "data not received" });
    }
    
    const password = await bcrypt.hash(pass, 10);

    try {
        // 💥 FIX 1: Changed 'query' to 'pool.query'
        const isUser = await pool.query(
            `SELECT * FROM ${process.env.table} WHERE email=$1`, [Email]
        );
        
        if (isUser.rows.length !== 0) {
            return res.status(400).json({ message: "user already exists" });
        }
        
        const marriedDate = null;
        const result = await pool.query(
            `INSERT INTO ${process.env.table}
            (name, username, email, dob, married_date, native_place, mobileno, encrypted_pass, Role)
            VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *`,
            [Name, Username, Email, DOB, marriedDate, NativePlace, Mobileno, password, role]
        );
        
        const otp = Math.floor(100000 + Math.random() * 900000);
        await redis.set(`otp:${Email}`, otp, "EX", 300);
        await sendEmail(Email, "OTP Verification", `Your OTP is ${otp} expires in 5 minutes`);
        
        res.status(200).json({ message: "OTP send", Email: Email });
    } catch (e) {
        if (e.code == "23505") {
            return res.status(400).json({ message: "username already exists" });
        }
        res.status(500).json({ message: "internal server error", error: e.message });
    }
});

router.post("/LoginOwnerAccount", rateLimiter, async (req, res) => {
    const { email, password } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ message: "email or password is missing" });
    }
    
    try {
        const isUser = await pool.query(
            `SELECT * FROM ${process.env.table} WHERE email=$1`, [email]  
        );
        
        const owner = isUser.rows[0];
        
        // 💥 FIX 2: Correctly check if owner exists
        if (!owner) {
            return res.status(400).json({ message: "user not found" });
        }
        
        if (owner.role !== "owner") {
            return res.status(401).json({ message: "unauthorized access" });
        }
        
        // 💥 FIX 3: Changed all 'user.' variables to 'owner.'
        const correctPass = await bcrypt.compare(password, owner.encrypted_pass);
        if (!correctPass) {
            return res.status(400).json({ message: "invalid password" });
        }    
        
        if (!owner.is_verified) {
            const payload = {
                email: owner.email,
                id: owner.id
            };
            const token = await createJwt(payload);
            if (!token) {
                return res.status(500).json({ message: "token creation error" });
            }
            return res.status(401).json({ reVerificationToken: token });
        }
        
        const payload = {
            id: owner.id,
            name: owner.name,
            role: owner.role,
            email: owner.email
        };
        
        const token = await createJwt(payload);
        if (!token) {
            return res.status(500).json({ message: "token creation error" });
        }
        
        res.status(200).json({ token: token });
    } catch (e) {
        res.status(500).json({ message: "internal server err at /ownerAccount", error: e.message });
    }
});

router.put("/Admins/addExpoToken",rateLimiter,async(req,res)=>{
    const{token,email}=req.body
    const header=req.headers.authorization
    if(!header){
        res.status(401).json({message:"authorization token not found"})
         return
    }
    const verificationToken=header.split(" ")[1]
    try{
         payload=await veriftJWT(verificationToken)
         if(!payload){
            res.status(401).json({message:"jwt expired"})
            return
         } 
const result=await pool.query(
    `UPDATE management SET expo_token=$1 WHERE id=$2`,
    [token,payload.id]
)
if(!result){
    res.status(500).json({message:"internal server error"})
    return
}
res.status(200).json({message:"updated expo token"})
    }catch(e){
        res.status(500).json({message:"internal server error",e})
    }
})
router.put("/Admins/addExpoToken",rateLimiter,async(req,res)=>{
    const{token,email}=req.body
    const header=req.headers.authorization
    if(!header){
        res.status(401).json({message:"authorization token not found"})
         return
    }
    const verificationToken=header.split(" ")[1]
    try{
         payload=await veriftJWT(verificationToken)
         if(!payload){
            res.status(401).json({message:"jwt expired"})
            return
         } 
const result=await pool.query(
    `UPDATE management SET firebase_token=$1 WHERE id=$2`,
    [token,payload.id]
)
if(!result){
    res.status(500).json({message:"internal server error"})
    return
}
res.status(200).json({message:"updated expo token"})
    }catch(e){
        res.status(500).json({message:"internal server error",e})
    }
})
router.put("/addExpoToken",rateLimiter,async(req,res)=>{
    const{token,email}=req.body
    const header=req.headers.authorization
    if(!header){
        res.status(401).json({message:"authorization token not found"})
         return
    }
    const verificationToken=header.split(" ")[1]
    try{
         payload=await veriftJWT(verificationToken)
         if(!payload){
            res.status(401).json({message:"jwt expired"})
            return
         } 
const result=await pool.query(
    `UPDATE ${process.env.table} SET expo_token=$1 WHERE id=$2`,
    [token,payload.id]
)
if(!result){
    res.status(500).json({message:"internal server error"})
    return
}
res.status(200).json({message:"updated expo token"})
    }catch(e){
        res.status(500).json({message:"internal server error",e})
    }
})
router.put("/addFirebaseToken",rateLimiter,async(req,res)=>{
    const{token,email}=req.body
    const header=req.headers.authorization
    if(!header){
        res.status(401).json({message:"authorization token not found"})
         return
    }
    const verificationToken=header.split(" ")[1]
    try{
         payload=await veriftJWT(verificationToken)
         if(!payload){
            res.status(401).json({message:"jwt expired"})
            return
         } 
const result=await pool.query(
    `UPDATE ${process.env.table} SET firebase_token=$1 WHERE email=$2`,
    [token,email]
)
if(!result){
    res.status(500).json({message:"internal server error"})
    return
}
res.status(200).json({message:"updated firebase token"})
    }catch(e){
        res.status(500).json({message:"internal server error",e})
    }
})
router.put("/UpdateProfile/:id", rateLimiter,async (req, res) => {
  try {
    const { id } = req.params;
    const header=req.headers.authorization
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
    
    const allowedFields = [
      "name",
      "dob",
      "married_date",
      "native_place",
      "mobileno",
      "expo_token",
      "firebase_token",
       "city",
       "state",
       "pincode",
       "address"
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

    const setClause = keys
      .map((key, i) => `${key} = $${i + 1}`)
      .join(", ");

    const values = Object.values(updates);

    const query = `
      UPDATE users
      SET ${setClause}
      WHERE id = $${keys.length + 1}
      RETURNING *
    `;
if(!query){
    res.status(400).json({message:"user not found"})
}
    const result = await pool.query(query, [...values, id]);

    res.status(200).json({message:"updated the fields"});

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});
router.get("/getData", rateLimiter, async (req, res) => {
    try {
        const header = req.headers.authorization;
        if (!header) {
            return res.status(401).json({ message: "token not found" }); 
        }

        const token = header.split(" ")[1];
        const payload = await veriftJWT(token);
        if (!payload) {
            return res.status(401).json({ message: "token invalid" });
        }

        const data = await pool.query(
            `SELECT * FROM ${process.env.table} WHERE email=$1`, [payload.email]
        );

        if (data.rows.length === 0) {
            return res.status(400).json({ message: "user data not found" });
        }

        const userData = data.rows[0];

        // ==========================================
        // NEW: Generate Presigned URL for Profile Pic
        // ==========================================
        let profilePicUrl = null;
        if (userData.dp_bucket && userData.dp_file_name) {
            try {
                if (userData.dp_file_name.startsWith("http://") || userData.dp_file_name.startsWith("https://")) {
                    profilePicUrl = userData.dp_file_name;
                } else {
                    profilePicUrl = await minioClient.presignedGetObject(
                        userData.dp_bucket, 
                        userData.dp_file_name, 
                        24 * 60 * 60 // 24 hours expiry
                    );
                }
            } catch (err) {
                console.error("Failed to generate URL for profile pic:", err.message);
                profilePicUrl = null; // Fallback so the app doesn't crash
            }
        }

        const userdata = {
            id: userData.id,
            name: userData.name,
            username: userData.username,
            email: userData.email,
            dob: userData.dob,
            marriedDate: userData.married_date,
            native_place: userData.native_place,
            mobileno: userData.mobileno,
            role: userData.role,
            created_at: userData.created_at,
            is_verified: userData.is_verified,
            expo_token: userData.expo_token,
            firebase_token: userData.firebase_token,
            is_profile_completed: userData.is_profile_completed,
            address: userData.address,
            aadhar_bucket: userData.aadhar_bucket,
            aadhar_file_name: userData.aadhar_file_name,
            aadhar_masked_bucket: userData.aadhar_masked_bucket,
            aadhar_masked_file_name: userData.aadhar_masked_file_name,
            license_bucket: userData.license_bucket,
            license_file_name: userData.license_file_name,
            license_masked_bucket: userData.license_masked_bucket,
            license_masked_file_name: userData.license_masked_file_name,
            city: userData.city,
            state: userData.state,
            pincode: userData.pincode,
            
            // Adding the newly generated profile picture properties
            dp_bucket: userData.dp_bucket,
            dp_file_name: userData.dp_file_name,
            profile_pic_url: profilePicUrl 
        };

        return res.status(200).json({ userData: userdata });
        
    } catch (error) {
        console.error("❌ Get Data Error:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
});

router.get("/getDocuments", rateLimiter, async (req, res) => {
  try {
    // 1. JWT Auth
    const header = req.headers.authorization;
    if (!header) return res.status(401).json({ message: "Token not found" });
    const token = header.split(" ")[1];
    const payload = await veriftJWT(token);
    if (!payload) return res.status(500).json({ message: "JWT error" });
    
    const userId = payload.id;

    // 2. Get JUST the file names from the DB
    const query = `
      SELECT aadhar_masked_bucket, aadhar_masked_file_name, 
             license_masked_bucket, license_masked_file_name 
      FROM users WHERE id = $1
    `;
    const result = await pool.query(query, [userId]);
    const userData = result.rows[0];

    // 3. Generate URLs ONLY when this route is hit
    let aadhar_url = null;
    let license_url = null;

    if (userData.aadhar_masked_bucket && userData.aadhar_masked_file_name) {
      aadhar_url = await minioClient.presignedGetObject(
        userData.aadhar_masked_bucket, userData.aadhar_masked_file_name, 60 * 60
      );
    }

    if (userData.license_masked_bucket && userData.license_masked_file_name) {
      license_url = await minioClient.presignedGetObject(
        userData.license_masked_bucket, userData.license_masked_file_name, 60 * 60
      );
    }

    // 4. Send the secure links
    res.status(200).json({
      aadhar_url,
      license_url
    });

  } catch (err) {
    console.error("Doc URL Error:", err);
    res.status(500).json({ message: "Server error" });
  }
});
router.get("/getData/:id/:role/:number/:offset",rateLimiter,async(req,res)=>{
    const {id}=req.params
    const {role}=req.params
    const {number}=req.params
    const {offset}=req.params
    const header=req.headers.authorization
    const token=header.split(" ")[1]
    const payload=await veriftJWT(token)
    if(payload.role==="user"){
        res.status(401).json({message:"unauthoratized person"})
        return
    }
    if(payload.role==="owner"){
        res.status(401).json({message:"unauthoratized person"})
        return
    }
    try{
        if(id){
            const data=await pool.query(
        `SELECT * FROM ${process.env.table} WHERE id=$1`,[id]
    )
    if(!data){
        res.status(400).json({message:"user data not found"})
        return
    }
      const userData=data.rows[0]
       if(payload.role==="admin"){
     const userdata={
        name:userData.name,
        username:userData.username,
        email:userData.email,
        dob:userData.dob,
        marriedDate:userData.marriedDate,
        native_place:userData.native_place,
        mobileno :userData.mobileno ,
        role  :userData.role  ,
        is_verified :userData.is_verified ,
        aadhar_url:userData.masked_aadhar_url||"not added aadhar",
        pan_url:userData.masked_pan||"not added pan",
        is_profile_completed:userData.is_profile_completed,
        address:userData.address||"not added address"
    }
    res.status(200).json({data:userdata})
    return
       }else if(payload.role==="superAdmin"){
             const userdata={
        name:userData.name,
        username:userData.username,
        email:userData.email,
        dob:userData.dob,
        marriedDate:userData.marriedDate,
        native_place:userData.native_place,
        mobileno :userData.mobileno ,
        role  :userData.role  ,
        is_verified :userData.is_verified ,
        aadhar_url:userData.aadhar_url||"not added aadhar",
        pan_url:userData.pan_url||"not added pan",
        is_profile_completed:userData.is_profile_completed,
        address:userData.address||"not added address"
    }
    res.status(200).json({data:userdata})
    return
       }
        }
       if (role) {
  const data = await pool.query(
    `SELECT * FROM ${process.env.table} WHERE role=$1 LIMIT $2 OFFSET $3`,
    [role,number,offset]
  );

  if (data.rows.length === 0) {
    return res.status(400).json({ message: "user data not found" });
  }

  const users = data.rows.map((user) => {
    
    if (payload.role === "admin") {
      return {
        name: user.name,
        username: user.username,
        email: user.email,
        dob: user.dob,
        marriedDate: user.marrieddate,
        native_place: user.native_place,
        mobileno: user.mobileno,
        role: user.role,
        is_verified: user.is_verified,
        aadhar_url: user.masked_aadhar_url || "not added aadhar",
        pan_url: user.masked_pan || "not added pan",
        is_profile_completed: user.is_profile_completed,
        address: user.address || "not added address"
      };
    }

    if (payload.role === "superAdmin") {
      return {
        name: user.name,
        username: user.username,
        email: user.email,
        dob: user.dob,
        marriedDate: user.marrieddate,
        native_place: user.native_place,
        mobileno: user.mobileno,
        role: user.role,
        is_verified: user.is_verified,
        aadhar_url: user.aadhar_url || "not added aadhar",
        pan_url: user.pan_url || "not added pan",
        is_profile_completed: user.is_profile_completed,
        address: user.address || "not added address"
      };
    }

  });

  res.status(200).json({ data: users });
  return
}
 const data = await pool.query(
    `SELECT * FROM ${process.env.table}  LIMIT $1 OFFSET $2`,
    [number,offset]
  );

  if (data.rows.length === 0) {
    return res.status(400).json({ message: "user data not found" });
  }

  const users = data.rows.map((user) => {
    
    if (payload.role === "admin") {
      return {
        name: user.name,
        username: user.username,
        email: user.email,
        dob: user.dob,
        marriedDate: user.marrieddate,
        native_place: user.native_place,
        mobileno: user.mobileno,
        role: user.role,
        is_verified: user.is_verified,
        aadhar_url: user.masked_aadhar_url || "not added aadhar",
        pan_url: user.masked_pan || "not added pan",
        is_profile_completed: user.is_profile_completed,
        address: user.address || "not added address"
      };
    }

    if (payload.role === "superAdmin") {
      return {
        name: user.name,
        username: user.username,
        email: user.email,
        dob: user.dob,
        marriedDate: user.marrieddate,
        native_place: user.native_place,
        mobileno: user.mobileno,
        role: user.role,
        is_verified: user.is_verified,
        aadhar_url: user.aadhar_url || "not added aadhar",
        pan_url: user.pan_url || "not added pan",
        is_profile_completed: user.is_profile_completed,
        address: user.address || "not added address"
      };
    }

  });

  res.status(200).json({ data: users });

    }catch(e){
        res.status(500).json({message:"internal server error"})
    }
})


router.delete("/requestAccountDeletion", rateLimiter, async (req, res) => {
  // 1. Extract the token from the headers
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized: No token provided" });
  }

  // Grab the actual token string (removes the "Bearer " part)
  const token = authHeader.split(" ")[1];

  try {
    // 2. Verify and decode the token 
    // (Make sure to import veriftJWT at the top of your file!)
    const decodedToken = await veriftJWT(token);
    
    // 3. Extract the user ID from the decoded payload
    const userId = decodedToken.id;

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized: Invalid token payload" });
    }

    // 4. Update the database using the extracted ID
    // Note: I swapped 'users' to process.env.table to match your other routes!
    await pool.query(
      `UPDATE ${process.env.table} 
       SET 
         status = 'pending_deletion', 
         deletion_requested_at = NOW() 
       WHERE id = $1`,
      [userId]
    );
    
    res.status(200).json({ 
      message: "Account deactivated. It will be permanently deleted in 30 days." 
    });

  } catch (error) {
    console.error("Account Deletion Error:", error);
    
    // Catch JWT-specific errors if the token is fake or expired
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ message: "Unauthorized: Token expired or invalid" });
    }

    res.status(500).json({ message: "Internal server error" });
  }
});

module.exports=router
       
