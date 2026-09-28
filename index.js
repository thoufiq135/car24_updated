const express= require("express")
const {connecttodb}=require("./connectdb")
const cors = require("cors");
const userCreate=require("./user")
const uploadPhoto=require("./photoUpload")
const cars=require("./cars")
const owners = require("./owners")
const branch=require("./branch")
const booking=require("./booking")
const roleauth=require("./roleauth")
const generateMoney_test=require("./generateData_test")
const bullBoard = require("./bullBoard");
const notification=require("./notifications")
const ratings = require("./rating")
const startDailySettlementScheduler =require("./shedules/sendExcel");
const rateLimiter = require("./rateLimiter");

const {pool,redis,fire_db}=require("./connectdb")
const {veriftJWT,createJwt}=require("./jwt")
const notificationDB=fire_db.ref("notifications")
try{
    const env=require("dotenv").config()
    console.log("env files loaded")
}catch(e){
    console.log("error at loding env file",e)
}
connecttodb()
const port=3000
const app= express()
app.use(cors({
    origin:[
        "http://localhost:5173",
        "https://www.car24travels.com",
        "https://car24website.vercel.app",
        "https://car24vercel.vercel.app"
    ]
}));
startDailySettlementScheduler().catch(console.error);
console.log("job added")
app.use(express.json())
app.use("/user",userCreate)
app.use("/roleauth",roleauth)
app.use("/PhotoUpload",uploadPhoto)
app.use("/cars",cars)
app.use("/owners",owners)
app.use("/branch",branch)
app.use("/bookingApi",booking)
app.use("/admin/queues", bullBoard.getRouter());
app.use("/api/notifications",notification)
app.use("/api/rating",ratings)
app.use("/testRoute",generateMoney_test)
// app.use('/api/cars', require('./routes/cars'));
// app.use('/api/bookings', require('./routes/bookings'));
// app.use('/api/branches', require('./routes/branches'));
// app.use('/api/users', require('./routes/users'));
// app.use('/api/rides', require('./routes/rides'));
// app.use('/api/payments', require('./routes/payments'));
// app.use('/api/owners', require('./routes/owners'));
// app.use('/api/car-pricing', require('./routes/carPricing'));
// app.use('/api/refunds', require('./routes/refunds'));
app.get("/",(req,res)=>{
    res.send("<h1> hello from car24 server</h1>")
})
app.listen(port,"0.0.0.0",()=>{
    console.log("server is running on ",port)
})
