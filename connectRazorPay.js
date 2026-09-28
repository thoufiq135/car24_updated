require("dotenv").config()
const Razorpay=require("razorpay")
const razorpay=new Razorpay({
 key_id: process.env.RazorpayAPIKey,
  key_secret: process.env.RazorpayKeySecret
})
module.exports=razorpay