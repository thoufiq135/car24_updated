const express=require("express")
const router=express.Router()
const rateLimiter = require("./rateLimiter")
const {pool,redis,fire_db}=require("./connectdb")
const {veriftJWT,createJwt}=require("./jwt")
const notificationDB=fire_db.ref("notifications")

async function fetchUnreadAndMarkRead(email) {
  const snap = await notificationDB.orderByChild("to").equalTo(email).once("value");

  const unreadNotifications = [];
  const updates = [];

  snap.forEach((child) => {
    const data = child.val();


      unreadNotifications.push({
        id: child.key,
        ...data,
      });

      updates.push(child.ref.update({ read: true }));
    
  });

  await Promise.all(updates);

  return unreadNotifications;
}
router.get("/getNotifications",rateLimiter,async(req,res)=>{
  try {
    console.log("came to notifications")
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

    const userId = payload.id; 
    const email = payload.email;
console.log("email=",email)
    const notifications = await fetchUnreadAndMarkRead(email);
console.log("got notifications",notifications)
    res.status(200).json({
      success: true,
      notifications,
    });
  } catch (error) {
    console.log(error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch notifications",
    });
  }
})
router.get("/unreadCount", rateLimiter, async (req, res) => {
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

    const email = payload.email;
    
    // Fetch all notifications for this user
    const snap = await notificationDB.orderByChild("to").equalTo(email).once("value");
    
    let unreadCount = 0;
    
    // Loop through and count only the ones that are NOT read
    snap.forEach((child) => {
      const data = child.val();
      // If 'read' is false or undefined, it's an unread message
      if (data.read !== true) {
        unreadCount++;
      }
    });

    // Send the final number back to the frontend
    res.status(200).json({
      success: true,
      count: unreadCount
    });

  } catch (error) {
    console.log(error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch unread count"
    });
  }
});
module.exports=router