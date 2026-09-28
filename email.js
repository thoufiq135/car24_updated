const nodemailer=require("nodemailer")
require("dotenv").config()
const transporter=nodemailer.createTransport({
service:"gmail",
auth:{
user:"car24travelsnlr@gmail.com",
pass:process.env.nodemailer_pass
}
})
async function sendEmail(to,subject,body,attachments = []) {
        await transporter.sendMail({
    from: "car24travelsnlr@gmail.com",
    to,
    subject,
    text: body,
    attachments
  });
}
module.exports=sendEmail; 
