
require("dotenv").config();
const Razorpay = require("razorpay");

const razorpayNellore = new Razorpay({
  key_id: process.env.RAZORPAY_NELLORE_KEY_ID,
  key_secret: process.env.RAZORPAY_NELLORE_KEY_SECRET,
});

const razorpayDefault = new Razorpay({
  key_id: process.env.RAZORPAY_DEFAULT_KEY_ID,
  key_secret: process.env.RAZORPAY_DEFAULT_KEY_SECRET,
});

function getRazorpay(branch) {
  if (Number(branch)===5) {
    return razorpayNellore;
  }

  return razorpayDefault;
}

module.exports = { getRazorpay };
