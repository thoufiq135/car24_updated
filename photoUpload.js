const express = require("express")
const router = express.Router()
const multer = require("multer")
const rateLimiter = require("./rateLimiter")
const minioClient = require("./minioConnect")
const sharp=require("sharp")
const fs=require("fs")
const {pool}=require("./connectdb")
const vision = require("@google-cloud/vision");
const { veriftJWT } = require("./jwt")
const path = require("path"); 
const client = new vision.ImageAnnotatorClient({
  keyFilename: path.join(__dirname, "car24-4e274-ad5ca10fba97.json") 
});
const upload = multer({ storage: multer.memoryStorage() });
function extractAadhaar(text) {
  const regex = /\b\d{4}\s?\d{4}\s?\d{4}\b/;
  const match = text.match(regex);
  return match ? match[0].replace(/\s/g, "") : null;
}
function extractDL(text) {
  const cleaned = text.replace(/\s/g, "");
  const regex = /[A-Z]{2}\d{2}[A-Z0-9]{10,13}/;
  const match = cleaned.match(regex);
  return match ? match[0] : null; 
}
function maskNumber(num) { 
  if (!num) return null;
  return num.replace(/\d(?=\d{4})/g, "X");
}
function findSensitiveBoxes(annotations, fullNumber) {
  if (!fullNumber) return [];

  const clean = fullNumber.replace(/\s/g, "");

  // last 4 digits (do NOT blur)
  const last4 = clean.slice(-4);

  const boxes = [];

  annotations.forEach(item => {
    const word = item.description?.replace(/\s/g, "");

    if (!word) return;

    // skip last 4 digits
    if (word.includes(last4)) return;

    // match sensitive parts
    if (clean.includes(word)) {
      boxes.push(item.boundingPoly.vertices);
    }
  });

  return boxes;
}
// async function blurRegions(imageBuffer, boxes) {
//   const base = sharp(imageBuffer);
//   const composites = [];

//   for (const box of boxes) {
//     const x = box[0].x || 0;
//     const y = box[0].y || 0;
//     const width = (box[1].x - box[0].x) || 100;
//     const height = (box[2].y - box[0].y) || 40;

//     const blurredPart = await sharp(imageBuffer)
//       .extract({ left: x, top: y, width, height })
//       .blur(20)
//       .toBuffer();

//     composites.push({
//       input: blurredPart,
//       left: x,
//       top: y
//     });
//   }

//   return await base.composite(composites).toBuffer();
// }
async function blurRegions(imageBuffer, boxes) {
  const base = sharp(imageBuffer);
  const meta = await base.metadata();
  const composites = [];

  for (const box of boxes) {
    if (!box?.[0] || !box?.[1] || !box?.[2]) continue;

    const x1 = Number(box[0].x);
    const y1 = Number(box[0].y);
    const x2 = Number(box[1].x);
    const y2 = Number(box[2].y);

    if ([x1, y1, x2, y2].some(v => Number.isNaN(v))) continue;

    let left = Math.floor(Math.min(x1, x2));
    let top = Math.floor(Math.min(y1, y2));
    let width = Math.floor(Math.abs(x2 - x1));
    let height = Math.floor(Math.abs(y2 - y1));

    if (width < 1 || height < 1) continue;

    left = Math.max(0, Math.min(left, meta.width - 1));
    top = Math.max(0, Math.min(top, meta.height - 1));
    width = Math.min(width, meta.width - left);
    height = Math.min(height, meta.height - top);

    if (width < 1 || height < 1) continue;

    const blurredPart = await sharp(imageBuffer)
      .extract({ left, top, width, height })
      .blur(20)
      .toBuffer();

    composites.push({ input: blurredPart, left, top });
  }

  return base.composite(composites).toBuffer();
}
function generateFileName(prefix) {
  return `${prefix}-${Date.now()}.jpg`;
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


router.post(
  "/DocumentUpload",
  rateLimiter,
  upload.fields([
    { name: "license", maxCount: 1 },
    { name: "aadhar", maxCount: 1 }
  ]),
  async (req, res) => {
const header=req.headers.authorization

if(!header){
  return res.status(401).json({message:"missing headers"})
}
const token = header.split(" ")[1]
const payload=await veriftJWT(token)
if(!payload){
  return res.status(500).json({message:"internal server error"})
}
const userId=payload.id

    if (!req.files || Object.keys(req.files).length === 0) {
      return res.status(400).json({ message: "No files uploaded" });
    }
let dbData = {};
    try {
      const licenseFile = req.files?.license?.[0];
      const aadharFile = req.files?.aadhar?.[0];
       let results = {};
  const urls = {};
    if (licenseFile) {
  const [licenseResult] = await client.documentTextDetection({
    image: { content: licenseFile.buffer }
  });

  const text = licenseResult.fullTextAnnotation?.text || "";

  results.license = {
    text,
    annotations: licenseResult.textAnnotations
  };
}
     if (aadharFile) {
  const [aadhaarResult] = await client.documentTextDetection({
    image: { content: aadharFile.buffer }
  });

  const text = aadhaarResult.fullTextAnnotation?.text || "";

  results.aadhar = {
    text,
    annotations: aadhaarResult.textAnnotations
  };
}
if (results.aadhar) {
  const aadhaar = extractAadhaar(results.aadhar.text);

  results.aadhar.aadhaar = aadhaar;
  results.aadhar.maskedAadhaar = maskNumber(aadhaar);
}

if (results.license) {
  const dl = extractDL(results.license.text);

  results.license.dl = dl;
  results.license.maskedDL = maskNumber(dl);
}
const aadhaarNumber = extractAadhaar(results.aadhar?.text || "");
const dlNumber = extractDL(results.license?.text || "");


if (aadharFile && !aadhaarNumber) {
  return res.status(400).json({
    success: false,
    message: "Unable to detect Aadhaar number. Please upload a clear image."
  });
}

if (licenseFile && !dlNumber) {
  return res.status(400).json({
    success: false,
    message: "Unable to detect Driving License number. Please upload a clear image."
  });
}
if (results.aadhar?.aadhaar) {
  const boxes = findSensitiveBoxes(
    results.aadhar.annotations,
    results.aadhar.aadhaar
  );

  results.aadhar.blurredImage = await blurRegions(
    aadharFile.buffer,
    boxes
  );
}
if (results.license?.dl) {
  const boxes = findSensitiveBoxes(
    results.license.annotations,
    results.license.dl
  );

  results.license.blurredImage = await blurRegions(
    licenseFile.buffer,
    boxes
  );
}

if (aadharFile) {
  const fileName = generateFileName("aadhar");

  urls.aadhar = await uploadToMinio(
    "aadhar",
    fileName,
    aadharFile.buffer,
    aadharFile.mimetype
  );
    dbData.aadhar_bucket = "aadhar";
  dbData.aadhar_file_name = fileName;
}
if (licenseFile) {
  const fileName = generateFileName("license");
// console.log("Uploading license...");
// console.log("Buffer exists:", !!licenseFile?.buffer);
// console.log("Mimetype:", licenseFile?.mimetype);
  urls.license = await uploadToMinio(
    "licence",
    fileName,
    licenseFile.buffer,
    licenseFile.mimetype
  );

  dbData.license_bucket = "licence";
  dbData.license_file_name = fileName;
  // console.log("uploaded license")
}
if (results.aadhar?.blurredImage) {
  // console.log("came to masked aadhar")
  const fileName = generateFileName("aadhar-masked");

  urls.aadharMasked = await uploadToMinio(
    "aadharmasked",
    fileName,
    results.aadhar.blurredImage,
    "image/jpeg"
  );
  // console.log("uploaded masked aadhar")
  dbData.aadhar_masked_bucket = "aadharmasked";
  dbData.aadhar_masked_file_name = fileName;
}
if (results.license?.blurredImage) {
  // console.log("running masked license ")
  const fileName = generateFileName("license-masked");

  urls.licenseMasked = await uploadToMinio(
    "licensemasked",
    fileName,
    results.license.blurredImage,
    "image/jpeg"
  );
  // console.log("uploaded masked license")
  dbData.license_masked_bucket = "licensemasked";
  dbData.license_masked_file_name = fileName;
}
await pool.query(
  `UPDATE ${process.env.table} SET
    aadhar_bucket = $1,
    aadhar_file_name = $2,
    aadhar_masked_bucket = $3,
    aadhar_masked_file_name = $4,
    license_bucket = $5,
    license_file_name = $6,
    license_masked_bucket = $7,
    license_masked_file_name = $8,
    is_profile_completed = true
   WHERE id = $9`,
  [
    dbData.aadhar_bucket,
    dbData.aadhar_file_name,
    dbData.aadhar_masked_bucket,
    dbData.aadhar_masked_file_name,
    dbData.license_bucket,
    dbData.license_file_name,
    dbData.license_masked_bucket,
    dbData.license_masked_file_name,
    userId // This is now $9
  ]
);

     res.status(200).json({message:"successfully added aadhar and license"})
    } catch (e) {
      console.log("Error in DocumentUpload:", e);
      res.status(500).json({
        message: "internal server error",
        error: e.message
      });
    }
  }
);

module.exports = router